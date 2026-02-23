/** Primitive JSON value. */
export type JsonPrimitive = string | number | boolean | null
/** JSON array value. */
export type JsonArray = JsonValue[]
/** Any valid JSON value. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject
/** JSON object value. */
export type JsonObject = { [key: string]: JsonValue }

/** Session data persisted by an adapter. */
export interface StoredSession<TSession extends JsonObject = JsonObject> {
  /** Session payload object. */
  data: TSession
  /** Absolute expiration time in milliseconds since Unix epoch. */
  expiresAt: number
}

/** Persistence contract implemented by all session adapters. */
export interface SessionStoreAdapter<TSession extends JsonObject = JsonObject> {
  /** Load a session by id, or return `null` when missing/expired. */
  get(id: string): Promise<StoredSession<TSession> | null>
  /** Persist a session payload by id. */
  set(id: string, session: StoredSession<TSession>): Promise<void>
  /** Delete a session by id. */
  delete(id: string): Promise<void>
}

/** Cookie SameSite mode. */
export type SameSite = 'strict' | 'lax' | 'none'

/** Cookie settings for the session id cookie. */
export interface SessionCookieOptions {
  /** Cookie name. Defaults to `sid`. */
  name?: string
  /** Cookie path. Defaults to `/`. */
  path?: string
  /** Optional cookie domain. */
  domain?: string
  /** Sets the `Secure` cookie attribute. */
  secure?: boolean
  /** Sets the `HttpOnly` cookie attribute. */
  httpOnly?: boolean
  /** Sets the `SameSite` cookie attribute. */
  sameSite?: SameSite
}

/** Configuration for the `betterSession` plugin. */
export interface SessionPluginOptions<TSession extends JsonObject = JsonObject> {
  /** Backing store adapter implementation. */
  adapter: SessionStoreAdapter<TSession>
  /** Session TTL in milliseconds. Defaults to 7 days. */
  ttl?: number
  /** Refresh expiration for existing sessions on read requests. Defaults to `true`. */
  rolling?: boolean
  /** Create session ids eagerly on first request. Defaults to `true`. */
  createOnRequest?: boolean
  /** Cookie settings for the session id cookie. */
  cookie?: SessionCookieOptions
  /** Custom session id factory. Defaults to `crypto.randomUUID()`. */
  generateId?: () => string
  /** Initial session data factory when no session exists. */
  initialData?: () => TSession
}

/** Async-safe updater for replacing session data. */
export type SessionUpdater<TSession extends JsonObject> = (
  current: TSession
) => TSession | Promise<TSession>

/** Request-scoped session API exposed by the plugin. */
export interface SessionContext<TSession extends JsonObject = JsonObject> {
  /** Session id, or `null` when lazy mode has not materialized a session yet. */
  readonly id: string | null
  /** `true` until the session is first persisted. */
  readonly isNew: boolean
  /** Readonly view of session data. */
  readonly data: Readonly<TSession>
  /** Read one key from session data. */
  get<TKey extends keyof TSession>(key: TKey): TSession[TKey]
  /** Check whether a key exists in session data. */
  has(key: keyof TSession): boolean
  /** Set one key and mark session dirty. */
  set<TKey extends keyof TSession>(key: TKey, value: TSession[TKey]): void
  /** Merge a partial object into session data. */
  assign(patch: Partial<TSession>): void
  /** Replace the full session data object. */
  replace(next: TSession): void
  /** Replace session data from an async/sync updater function. */
  update(updater: SessionUpdater<TSession>): Promise<void>
  /** Remove one key from session data. */
  delete(key: keyof TSession): void
  /** Rotate to a new session id while keeping data. */
  regenerate(): Promise<string>
  /** Delete the session from storage and clear cookie. */
  destroy(): Promise<void>
  /** Force persistence immediately for this request. */
  save(): Promise<void>
}
