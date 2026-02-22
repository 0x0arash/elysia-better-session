import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  createDrizzleSessionAdapter,
  createFileSessionAdapter,
  createMemorySessionAdapter,
  createRedisSessionAdapter,
  type RedisSessionClient
} from '../src'

describe('memory adapter', () => {
  it('stores and expires sessions in memory', async () => {
    let now = 10_000
    const adapter = createMemorySessionAdapter<{ value: number }>({
      now: () => now
    })

    await adapter.set('a', {
      data: { value: 1 },
      expiresAt: now + 50
    })

    const alive = await adapter.get('a')
    expect(alive?.data.value).toBe(1)

    now += 60
    expect(await adapter.get('a')).toBeNull()
  })
})

describe('file adapter', () => {
  it('persists sessions to disk', async () => {
    const tempPath = join(
      process.cwd(),
      '.tmp',
      `session-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    )
    let now = Date.now()

    const first = createFileSessionAdapter<{ value: string }>({
      filePath: tempPath,
      now: () => now
    })

    await first.set('persisted', {
      data: { value: 'ok' },
      expiresAt: now + 1_000
    })

    const second = createFileSessionAdapter<{ value: string }>({
      filePath: tempPath,
      now: () => now
    })

    const loaded = await second.get('persisted')
    expect(loaded?.data.value).toBe('ok')

    now += 2_000
    expect(await second.get('persisted')).toBeNull()

    await rm(tempPath, { force: true })
  })
})

describe('redis adapter', () => {
  it('uses redis-style key/value storage with ttl', async () => {
    let now = 100_000
    const payloads = new Map<string, string>()
    const expires = new Map<string, number>()

    const client: RedisSessionClient = {
      async get(key) {
        const expireAt = expires.get(key)
        if (typeof expireAt === 'number' && expireAt <= now) {
          payloads.delete(key)
          expires.delete(key)
          return null
        }

        return payloads.get(key) ?? null
      },
      async set(key, value) {
        payloads.set(key, value)
      },
      async del(key) {
        payloads.delete(key)
        expires.delete(key)
      },
      async pexpire(key, milliseconds) {
        expires.set(key, now + milliseconds)
      }
    }

    const adapter = createRedisSessionAdapter<{ active: boolean }>({
      client,
      prefix: 'test:',
      now: () => now
    })

    await adapter.set('r1', {
      data: { active: true },
      expiresAt: now + 40
    })

    const loaded = await adapter.get('r1')
    expect(loaded?.data.active).toBe(true)

    now += 45
    expect(await adapter.get('r1')).toBeNull()
  })
})

describe('drizzle adapter', () => {
  it('stores and retrieves sessions through drizzle (single serialized column)', async () => {
    const sqlite = new Database(':memory:')

    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)

    const db = drizzle(sqlite)
    const sessions = sqliteTable('sessions', {
      id: text('id').primaryKey(),
      data: text('data').notNull(),
      expiresAt: integer('expires_at', { mode: 'number' }).notNull()
    })

    let now = 500
    const adapter = createDrizzleSessionAdapter<typeof sessions, { role: string }>({
      db,
      table: sessions,
      columns: {
        id: (table) => table.id,
        data: (table) => table.data,
        expiresAt: (table) => table.expiresAt
      },
      now: () => now,
      serializeExpiresAt: (value) => value,
      deserializeExpiresAt: (value) => Number(value)
    })

    await adapter.set('d1', {
      data: { role: 'admin' },
      expiresAt: now + 30
    })

    const loaded = await adapter.get('d1')
    expect(loaded?.data.role).toBe('admin')

    now += 35
    expect(await adapter.get('d1')).toBeNull()

    sqlite.close()
  })

  it('stores and retrieves sessions through drizzle (typed multi-column mapping)', async () => {
    const sqlite = new Database(':memory:')

    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        visits INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `)

    const db = drizzle(sqlite)
    const sessions = sqliteTable('sessions', {
      id: text('id').primaryKey(),
      userId: text('user_id'),
      visits: integer('visits').notNull(),
      expiresAt: integer('expires_at', { mode: 'number' }).notNull()
    })

    type Session = {
      userId: string | null
      visits: number
    }

    let now = 3_000
    const adapter = createDrizzleSessionAdapter<typeof sessions, Session>({
      db,
      table: sessions,
      columns: {
        id: (table) => table.id,
        expiresAt: (table) => table.expiresAt
      },
      dataColumns: {
        userId: (table) => table.userId,
        visits: (table) => table.visits
      },
      now: () => now,
      serializeColumnsData: (data) => ({
        userId: data.userId,
        visits: data.visits
      }),
      deserializeColumnsData: (raw) => ({
        userId: (raw.userId as string | null) ?? null,
        visits: Number(raw.visits)
      }),
      serializeExpiresAt: (value) => value,
      deserializeExpiresAt: (value) => Number(value)
    })

    await adapter.set('d2', {
      data: {
        userId: 'u-1',
        visits: 7
      },
      expiresAt: now + 25
    })

    const loaded = await adapter.get('d2')
    expect(loaded?.data.userId).toBe('u-1')
    expect(loaded?.data.visits).toBe(7)

    const persistedRows = await db.select().from(sessions)
    expect(persistedRows[0]?.userId).toBe('u-1')
    expect(persistedRows[0]?.visits).toBe(7)

    now += 30
    expect(await adapter.get('d2')).toBeNull()

    sqlite.close()
  })
})
