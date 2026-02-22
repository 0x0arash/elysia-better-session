import type { JsonObject, SessionStoreAdapter, StoredSession } from '../types.js'

/** Options for the in-memory session adapter. */
export interface MemorySessionAdapterOptions {
  /** Time source used for expiration checks. */
  now?: () => number
  /** Deep clone strategy for stored payloads. */
  clone?: <TValue>(value: TValue) => TValue
}

const defaultClone = <TValue>(value: TValue): TValue => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as TValue
}

/** Creates a process-local in-memory session adapter. */
export const createMemorySessionAdapter = <TSession extends JsonObject = JsonObject>(
  options: MemorySessionAdapterOptions = {}
): SessionStoreAdapter<TSession> => {
  const now = options.now ?? Date.now
  const clone = options.clone ?? defaultClone
  const sessions = new Map<string, StoredSession<TSession>>()

  return {
    async get(id) {
      const existing = sessions.get(id)
      if (!existing) {
        return null
      }

      if (existing.expiresAt <= now()) {
        sessions.delete(id)
        return null
      }

      return clone(existing)
    },
    async set(id, session) {
      sessions.set(id, clone(session))
    },
    async delete(id) {
      sessions.delete(id)
    }
  }
}
