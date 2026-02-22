import type { JsonObject, SessionStoreAdapter, StoredSession } from '../types.js'

/** Minimal Redis client contract required by the adapter. */
export interface RedisSessionClient {
  /** Get a raw value by key. */
  get(key: string): Promise<string | null> | string | null
  /** Set a raw value by key. */
  set(key: string, value: string): Promise<unknown> | unknown
  /** Delete a key. */
  del(key: string): Promise<unknown> | unknown
  /** Set key expiration in milliseconds. */
  pexpire?(key: string, milliseconds: number): Promise<unknown> | unknown
}

/** Options for the Redis session adapter. */
export interface RedisSessionAdapterOptions {
  /** Custom Redis client. When omitted, Bun's global Redis client is used. */
  client?: RedisSessionClient
  /** Redis URL used when constructing Bun's client. */
  url?: string
  /** Key prefix for session records. Defaults to `session:`. */
  prefix?: string
  /** Time source used for expiration checks. */
  now?: () => number
  /** Also set Redis native key TTL with `PEXPIRE`. Defaults to `true`. */
  useNativeTtl?: boolean
}

const defaultClone = <TValue>(value: TValue): TValue => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as TValue
}

const createBunRedisClient = (url?: string): RedisSessionClient => {
  const globalState = globalThis as unknown as {
    RedisClient?: new (url?: string) => RedisSessionClient
    Bun?: {
      RedisClient?: new (url?: string) => RedisSessionClient
      redis?: RedisSessionClient
    }
  }

  if (globalState.Bun?.redis) {
    return globalState.Bun.redis
  }

  if (globalState.Bun?.RedisClient) {
    return new globalState.Bun.RedisClient(url)
  }

  if (globalState.RedisClient) {
    return new globalState.RedisClient(url)
  }

  throw new Error(
    "Unable to find Bun's Redis client. Pass a client via options.client or run under Bun."
  )
}

/** Creates a Redis-backed session adapter. */
export const createRedisSessionAdapter = <TSession extends JsonObject = JsonObject>(
  options: RedisSessionAdapterOptions = {}
): SessionStoreAdapter<TSession> => {
  const prefix = options.prefix ?? 'session:'
  const now = options.now ?? Date.now
  const useNativeTtl = options.useNativeTtl ?? true
  const client = options.client ?? createBunRedisClient(options.url)

  const getKey = (id: string): string => `${prefix}${id}`

  return {
    async get(id) {
      const key = getKey(id)
      const payload = await client.get(key)
      if (!payload) {
        return null
      }

      let parsed: StoredSession<TSession>

      try {
        parsed = JSON.parse(payload) as StoredSession<TSession>
      } catch {
        await client.del(key)
        return null
      }

      if (parsed.expiresAt <= now()) {
        await client.del(key)
        return null
      }

      return defaultClone(parsed)
    },
    async set(id, session) {
      const key = getKey(id)
      const ttl = session.expiresAt - now()

      if (ttl <= 0) {
        await client.del(key)
        return
      }

      await client.set(key, JSON.stringify(session))

      if (useNativeTtl && typeof client.pexpire === 'function') {
        await client.pexpire(key, ttl)
      }
    },
    async delete(id) {
      await client.del(getKey(id))
    }
  }
}
