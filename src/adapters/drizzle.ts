import { eq } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import type { JsonObject, SessionStoreAdapter } from '../types.js'

type DrizzleDatabase = {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  delete: (...args: any[]) => any
}

type SessionKey<TSession extends JsonObject> = Extract<keyof TSession, string>
type DrizzleColumnValues<TSession extends JsonObject> = {
  [K in SessionKey<TSession>]: unknown
}

/** Typed mapping between session object keys and table columns. */
export type DrizzleSessionColumnMap<
  TTable extends object = Record<string, unknown>,
  TSession extends JsonObject = JsonObject
> = {
  [K in SessionKey<TSession>]: (table: TTable) => AnyColumn
}

/** Options for the Drizzle session adapter. */
export interface DrizzleSessionAdapterOptions<
  TTable extends object = Record<string, unknown>,
  TSession extends JsonObject = JsonObject
> {
  /** Drizzle database instance. */
  db: DrizzleDatabase
  /** Drizzle table schema that stores sessions. */
  table: TTable
  /** Core columns used by the adapter. */
  columns: {
    /** Session id column selector. */
    id: (table: TTable) => AnyColumn
    /** Session expiration column selector. */
    expiresAt: (table: TTable) => AnyColumn
    /**
     * Serialized session data column selector.
     * Use this mode when storing the full session in one column.
     */
    data?: (table: TTable) => AnyColumn
  }
  /**
   * Typed mapping of session keys to table columns.
   * Use this mode when storing session fields across multiple columns.
   */
  dataColumns?: DrizzleSessionColumnMap<TTable, TSession>
  /** Time source used for expiration checks. */
  now?: () => number
  /** Serializer used before writing `session.data` in single-column mode. */
  serializeData?: (data: TSession) => unknown
  /** Parser used after reading stored session data in single-column mode. */
  deserializeData?: (raw: unknown) => TSession
  /** Serializer used before writing session fields in multi-column mode. */
  serializeColumnsData?: (data: TSession) => DrizzleColumnValues<TSession>
  /** Parser used after reading session fields in multi-column mode. */
  deserializeColumnsData?: (raw: DrizzleColumnValues<TSession>) => TSession
  /** Serializer used before writing `expiresAt` (ms timestamp). */
  serializeExpiresAt?: (expiresAt: number) => unknown
  /** Parser used after reading the stored expiration value. */
  deserializeExpiresAt?: (raw: unknown) => number
}

const getColumnKey = <TTable extends object>(
  selector: (table: TTable) => AnyColumn
): string => {
  let resolvedKey: string | null = null

  const probe = new Proxy(
    {},
    {
      get(_target, property) {
        resolvedKey = String(property)
        return {}
      }
    }
  ) as TTable

  selector(probe)

  if (!resolvedKey) {
    throw new Error('Unable to resolve Drizzle column key from selector.')
  }

  return resolvedKey
}

const toTimestamp = (value: unknown): number => {
  if (typeof value === 'number') {
    return value
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) {
      return asNumber
    }

    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  throw new Error(`Unable to parse expiresAt value "${String(value)}".`)
}

/** Creates a Drizzle-backed session adapter. */
export const createDrizzleSessionAdapter = <
  TTable extends object,
  TSession extends JsonObject = JsonObject
>(
  options: DrizzleSessionAdapterOptions<TTable, TSession>
): SessionStoreAdapter<TSession> => {
  const { db, table, columns } = options
  const now = options.now ?? Date.now
  const serializeData = options.serializeData ?? ((data: TSession) => JSON.stringify(data))
  const deserializeData =
    options.deserializeData ??
    ((raw: unknown) => {
      if (typeof raw === 'string') {
        return JSON.parse(raw) as TSession
      }

      return raw as TSession
    })
  const serializeColumnsData =
    options.serializeColumnsData ??
    ((data: TSession) => data as unknown as DrizzleColumnValues<TSession>)
  const deserializeColumnsData =
    options.deserializeColumnsData ??
    ((raw: DrizzleColumnValues<TSession>) => raw as unknown as TSession)
  const serializeExpiresAt =
    options.serializeExpiresAt ?? ((expiresAt: number) => new Date(expiresAt))
  const deserializeExpiresAt = options.deserializeExpiresAt ?? toTimestamp
  const idColumn = columns.id(table)
  const expiresAtColumn = columns.expiresAt(table)
  const idKey = getColumnKey(columns.id)
  const expiresAtKey = getColumnKey(columns.expiresAt)

  const hasSerializedColumn = typeof columns.data === 'function'
  const hasDataColumns = Boolean(options.dataColumns)

  if (hasSerializedColumn === hasDataColumns) {
    throw new Error(
      'Configure exactly one Drizzle session data strategy: use either `columns.data` or `dataColumns`.'
    )
  }

  if (hasDataColumns) {
    const dataColumns = options.dataColumns as DrizzleSessionColumnMap<TTable, TSession>
    const dataColumnEntries = Object.entries(dataColumns) as Array<
      [SessionKey<TSession>, (table: TTable) => AnyColumn]
    >
    const dataColumnSelectors = Object.fromEntries(
      dataColumnEntries.map(([sessionKey, selector]) => [sessionKey, selector(table)])
    ) as Record<string, AnyColumn>
    const dataColumnKeys = Object.fromEntries(
      dataColumnEntries.map(([sessionKey, selector]) => [sessionKey, getColumnKey(selector)])
    ) as Record<SessionKey<TSession>, string>

    return {
      async get(id) {
        const rows = (await db
          .select({
            ...dataColumnSelectors,
            expiresAt: expiresAtColumn
          })
          .from(table)
          .where(eq(idColumn, id))
          .limit(1)) as Array<Record<string, unknown> & { expiresAt: unknown }>

        const row = rows[0]
        if (!row) {
          return null
        }

        const expiresAt = deserializeExpiresAt(row.expiresAt)
        if (expiresAt <= now()) {
          await db.delete(table).where(eq(idColumn, id))
          return null
        }

        const rawData = {} as DrizzleColumnValues<TSession>
        for (const [sessionKey] of dataColumnEntries) {
          rawData[sessionKey] = row[sessionKey]
        }

        return {
          data: deserializeColumnsData(rawData),
          expiresAt
        }
      },
      async set(id, session) {
        const encodedData = serializeColumnsData(session.data)
        const payload: Record<string, unknown> = {
          [idKey]: id,
          [expiresAtKey]: serializeExpiresAt(session.expiresAt)
        }

        for (const [sessionKey, columnKey] of Object.entries(dataColumnKeys) as Array<
          [SessionKey<TSession>, string]
        >) {
          payload[columnKey] = encodedData[sessionKey]
        }

        await db.delete(table).where(eq(idColumn, id))
        await db.insert(table).values(payload)
      },
      async delete(id) {
        await db.delete(table).where(eq(idColumn, id))
      }
    }
  }

  const dataColumnSelector = columns.data
  if (!dataColumnSelector) {
    throw new Error('`columns.data` is required when `dataColumns` is not provided.')
  }

  const dataColumn = dataColumnSelector(table)

  return {
    async get(id) {
      const rows = (await db
        .select({
          data: dataColumn,
          expiresAt: expiresAtColumn
        })
        .from(table)
        .where(eq(idColumn, id))
        .limit(1)) as Array<{
        data: unknown
        expiresAt: unknown
      }>

      const row = rows[0]
      if (!row) {
        return null
      }

      const expiresAt = deserializeExpiresAt(row.expiresAt)
      if (expiresAt <= now()) {
        await db.delete(table).where(eq(idColumn, id))
        return null
      }

      return {
        data: deserializeData(row.data),
        expiresAt
      }
    },
    async set(id, session) {
      const payload = {
        [idKey]: id,
        [getColumnKey(dataColumnSelector)]: serializeData(session.data),
        [expiresAtKey]: serializeExpiresAt(session.expiresAt)
      } as Record<string, unknown>

      await db.delete(table).where(eq(idColumn, id))
      await db.insert(table).values(payload)
    },
    async delete(id) {
      await db.delete(table).where(eq(idColumn, id))
    }
  }
}
