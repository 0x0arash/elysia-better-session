# elysia-better-session

Server-side session plugin for Elysia with pluggable storage adapters.

It stores session data in your backend store, and only keeps a session id in a cookie.

## Features

- Server-side sessions for Elysia.
- Typed session data.
- Adapter architecture (`SessionStoreAdapter`).
- Built-in adapters:
  - memory
  - file
  - redis (Bun Redis client)
  - drizzle
- Configurable cookie behavior.
- Rolling and non-rolling expiration support.
- Eager or lazy session creation (`createOnRequest`).

## Installation

```bash
bun add elysia-better-session
```

If you use specific adapters, add their dependencies as needed:

- `drizzle-orm` for the Drizzle adapter.
- Redis server/client setup for the Redis adapter.

## Quick Start

```ts
import { Elysia } from 'elysia'
import { betterSession, createMemorySessionAdapter } from 'elysia-better-session'

type AppSession = {
  userId: string | null
  visits: number
}

const app = new Elysia()
  .use(
    betterSession<AppSession>({
      adapter: createMemorySessionAdapter(),
      ttl: 1000 * 60 * 60 * 24,
      cookie: {
        name: 'sid',
        secure: false
      },
      initialData: () => ({
        userId: null,
        visits: 0
      })
    })
  )
  .get('/', ({ session }) => {
    session.set('visits', (session.get('visits') ?? 0) + 1)

    return {
      visits: session.get('visits'),
      userId: session.get('userId')
    }
  })
```

## Session Lifecycle

The plugin adds `session` to request context.

- Reads existing session by cookie id.
- Creates new session data when no valid session is found.
- Persists updates automatically after each request.
- Updates cookie expiration on write.
- Clears cookie when `session.destroy()` is called.

### Eager vs Lazy Session Creation

Use `createOnRequest` to control when a new session is created.

- `createOnRequest: true` (default):
  - A session id is created on first request.
  - A cookie/store write is performed even on read-only requests.
- `createOnRequest: false`:
  - No session id is created until session is mutated, regenerated, or explicitly saved.
  - `session.id` can be `null` before first write.

## API

### `betterSession(options)`

Main Elysia plugin factory.

`SessionPluginOptions<TSession>`:

- `adapter: SessionStoreAdapter<TSession>` (required)
- `ttl?: number` in ms, default `7 days`
- `rolling?: boolean`, default `true`
- `createOnRequest?: boolean`, default `true`
- `cookie?: SessionCookieOptions`
- `generateId?: () => string`, default `crypto.randomUUID()`
- `initialData?: () => TSession`, default `() => ({})`

### `session` Context API

`SessionContext<TSession>` methods:

- `id: string | null`
- `isNew: boolean`
- `data: Readonly<TSession>`
- `get(key)`
- `has(key)`
- `set(key, value)`
- `assign(patch)`
- `replace(next)`
- `update(asyncOrSyncUpdater)`
- `delete(key)`
- `regenerate()`
- `destroy()`
- `save()`

Notes:

- `save()` forces persistence immediately in the current request.
- `destroy()` removes the backend record and clears the cookie.
- `regenerate()` rotates session id and keeps current data.

### Adapter Contract

Custom adapters implement:

```ts
export interface SessionStoreAdapter<TSession> {
  get(id: string): Promise<{ data: TSession; expiresAt: number } | null>
  set(id: string, session: { data: TSession; expiresAt: number }): Promise<void>
  delete(id: string): Promise<void>
}
```

## Built-in Adapters

## Memory Adapter

```ts
import { createMemorySessionAdapter } from 'elysia-better-session'

const adapter = createMemorySessionAdapter()
```

Best for development and tests. Data is process-local and ephemeral.

Options:

- `now?: () => number`
- `clone?: <T>(value: T) => T`

## File Adapter

```ts
import { createFileSessionAdapter } from 'elysia-better-session'

const adapter = createFileSessionAdapter({
  filePath: './.data/sessions.json',
  pretty: true
})
```

Stores sessions in a JSON file. Suitable for local/dev workloads.

Options:

- `filePath: string` (required)
- `now?: () => number`
- `pretty?: boolean`
- `clone?: <T>(value: T) => T`

Notes:

- Uses an in-process operation queue to serialize file writes.
- Not designed for multi-process shared writes.

## Redis Adapter (Bun Redis Client)

```ts
import { createRedisSessionAdapter } from 'elysia-better-session'

const adapter = createRedisSessionAdapter({
  url: 'redis://127.0.0.1:6379',
  prefix: 'app:session:'
})
```

By default, it tries to use Bun's Redis client from `globalThis.Bun`.
You can pass a custom client via `client`.

Options:

- `client?: RedisSessionClient`
- `url?: string`
- `prefix?: string` default `session:`
- `now?: () => number`
- `useNativeTtl?: boolean` default `true`

`RedisSessionClient` contract:

```ts
interface RedisSessionClient {
  get(key: string): Promise<string | null> | string | null
  set(key: string, value: string): Promise<unknown> | unknown
  del(key: string): Promise<unknown> | unknown
  pexpire?(key: string, milliseconds: number): Promise<unknown> | unknown
}
```

## Drizzle Adapter

The Drizzle adapter supports 2 session-data strategies:

- single serialized column (`columns.data`)
- typed multi-column mapping (`dataColumns`)

Configure exactly one strategy.

### Strategy A: Single Serialized Column

```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createDrizzleSessionAdapter } from 'elysia-better-session'

const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  expiresAt: integer('expires_at', { mode: 'number' }).notNull()
})

const adapter = createDrizzleSessionAdapter<typeof sessions, { userId: string | null }>({
  db,
  table: sessions,
  columns: {
    id: (table) => table.id,
    expiresAt: (table) => table.expiresAt,
    data: (table) => table.data
  },
  serializeData: (data) => JSON.stringify(data),
  deserializeData: (raw) => JSON.parse(String(raw)),
  serializeExpiresAt: (ms) => ms,
  deserializeExpiresAt: (raw) => Number(raw)
})
```

### Strategy B: Typed Multi-Column Session Data

```ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { createDrizzleSessionAdapter } from 'elysia-better-session'

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
  serializeColumnsData: (data) => ({
    userId: data.userId,
    visits: data.visits
  }),
  deserializeColumnsData: (raw) => ({
    userId: (raw.userId as string | null) ?? null,
    visits: Number(raw.visits)
  }),
  serializeExpiresAt: (ms) => ms,
  deserializeExpiresAt: (raw) => Number(raw)
})
```

Options:

- `db`
- `table`
- `columns.id`
- `columns.expiresAt`
- `columns.data?` (single-column mode only)
- `dataColumns?` (multi-column mode only)
- `now?: () => number`
- `serializeData?` and `deserializeData?` (single-column mode)
- `serializeColumnsData?` and `deserializeColumnsData?` (multi-column mode)
- `serializeExpiresAt?`
- `deserializeExpiresAt?`

Notes:

- Default `serializeData` uses `JSON.stringify`.
- Default `deserializeData` parses strings and otherwise casts.
- Default `serializeColumnsData` and `deserializeColumnsData` use identity casting.
- Default `serializeExpiresAt` writes a `Date`.
- Default `deserializeExpiresAt` accepts number, `Date`, numeric string, or parseable date string.

## Cookie Options

`SessionCookieOptions`:

- `name?: string` default `sid`
- `path?: string` default `/`
- `domain?: string`
- `secure?: boolean` default `false`
- `httpOnly?: boolean` default `true`
- `sameSite?: 'strict' | 'lax' | 'none'` default `lax`

The plugin does not infer environment-specific cookie behavior. Set `secure` explicitly per deployment.

## Typed Usage Patterns

## Strongly Typed Session Payload

```ts
type Session = {
  userId: string | null
  roles: string[]
}

betterSession<Session>({
  adapter,
  initialData: () => ({ userId: null, roles: [] })
})
```

## Lazy Session Example

```ts
betterSession({
  adapter,
  createOnRequest: false
})
```

With lazy creation, read-only routes do not create a cookie/session record until changed or explicitly saved.

## Custom Adapter Example

```ts
import type { SessionStoreAdapter, StoredSession } from 'elysia-better-session'

function createMyAdapter<T>(): SessionStoreAdapter<T> {
  const store = new Map<string, StoredSession<T>>()

  return {
    async get(id) {
      const item = store.get(id)
      if (!item) return null
      if (item.expiresAt <= Date.now()) {
        store.delete(id)
        return null
      }
      return item
    },
    async set(id, session) {
      store.set(id, session)
    },
    async delete(id) {
      store.delete(id)
    }
  }
}
```

## Development

Install dependencies:

```bash
bun install
```

Run example server:

```bash
bun run dev
```

Run tests:

```bash
bun test
```

Typecheck:

```bash
bun run typecheck
```

Build:

```bash
bun run build
```

## Publishing (Maintainers)

1. Make sure package name/version in `package.json` are ready for release.
2. Run checks and production build:

```bash
bun run prepublishOnly
```

3. Authenticate and publish:

```bash
npm login
npm publish --access public
```

Notes:

- This package publishes `dist/`, `README.md`, and `LICENSE`.
- Runtime dependency for Elysia is declared as a peer dependency, so consumer projects must install `elysia`.

## Repository Structure

```text
src/
  plugin.ts            # core plugin
  types.ts             # public types
  adapters/            # built-in adapters
example/
  server.ts            # runnable usage example
test/
  *.test.ts            # plugin and adapter tests
```

## Behavior Notes and Caveats

- Expiration is enforced by adapter reads plus stored `expiresAt`.
- Redis adapter can additionally apply native TTL via `PEXPIRE`.
- File adapter is not cross-process lock-safe.
- Drizzle adapter currently performs `delete + insert` on `set`.
- Session data should be JSON-serializable unless your adapter serializer handles custom formats.

## License

MIT
