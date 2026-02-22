import { Elysia } from 'elysia'
import {
  normalizeCookieOptions,
  parseCookies,
  serializeExpiredCookie,
  serializeSessionCookie
} from './cookie.js'
import type {
  JsonObject,
  SessionContext,
  SessionPluginOptions,
  StoredSession
} from './types.js'

const DEFAULT_TTL = 1000 * 60 * 60 * 24 * 7
const AUTO_SAVE = Symbol('better-session:auto-save')

type HeaderValue = string | string[] | undefined
type MutableHeaders = Record<string, HeaderValue>
type PersistMode = 'auto' | 'manual'
type InternalSession<TSession extends JsonObject> = SessionContext<TSession> & {
  [AUTO_SAVE]: (mode: PersistMode) => Promise<void>
}

const createSessionId = (): string => crypto.randomUUID()

const appendSetCookie = (headers: MutableHeaders, cookieValue: string): void => {
  const existing = headers['set-cookie']

  if (!existing) {
    headers['set-cookie'] = cookieValue
    return
  }

  headers['set-cookie'] = Array.isArray(existing)
    ? [...existing, cookieValue]
    : [existing, cookieValue]
}

/**
 * Elysia plugin that adds server-side session management with pluggable storage.
 *
 * The plugin exposes `session` on request context and persists changes automatically
 * after each handler. Pass `createOnRequest: false` to enable lazy session creation.
 */
export const betterSession = <TSession extends JsonObject = JsonObject>(
  options: SessionPluginOptions<TSession>
) => {
  const ttl = options.ttl ?? DEFAULT_TTL
  const rolling = options.rolling ?? true
  const createOnRequest = options.createOnRequest ?? true
  const adapter = options.adapter
  const cookie = normalizeCookieOptions(options.cookie)
  const generateId = options.generateId ?? createSessionId
  const initialData = options.initialData ?? (() => ({}) as TSession)

  if (ttl <= 0) {
    throw new Error('Session TTL must be greater than zero.')
  }

  return new Elysia({
    name: 'better-session',
    seed: {
      ttl,
      rolling,
      createOnRequest,
      cookieName: cookie.name
    }
  })
    .resolve({ as: 'scoped' }, async ({ request, set }) => {
      const headers = ((set.headers ??= {}) as MutableHeaders)
      const incomingCookies = parseCookies(request.headers.get('cookie'))
      const incomingId = incomingCookies[cookie.name]
      const now = Date.now()

      const stored = incomingId ? await adapter.get(incomingId) : null

      if (!stored) {
        if (incomingId) {
          appendSetCookie(headers, serializeExpiredCookie(cookie.name, cookie))
        }
      }

      const state = {
        id: stored ? incomingId ?? null : createOnRequest ? generateId() : null,
        data: stored ? stored.data : initialData(),
        expiresAt: stored ? stored.expiresAt : now + ttl,
        isNew: !stored,
        destroyed: false,
        revision: 0,
        savedRevision: 0,
        committed: false
      }

      const ensureId = (): string => {
        if (!state.id) {
          state.id = generateId()
          state.isNew = true
        }

        return state.id
      }

      const markDirty = (): void => {
        state.revision += 1
        state.committed = false
      }

      const persist = async (mode: PersistMode): Promise<void> => {
        if (state.committed) {
          return
        }

        if (state.destroyed) {
          if (state.id) {
            await adapter.delete(state.id)
          }

          if (incomingId || state.id) {
            appendSetCookie(headers, serializeExpiredCookie(cookie.name, cookie))
          }

          state.savedRevision = state.revision
          state.committed = true
          return
        }

        const dirty = state.savedRevision !== state.revision

        const shouldWrite =
          state.isNew
            ? createOnRequest || Boolean(state.id) || dirty || mode === 'manual'
            : dirty || (rolling && Boolean(incomingId))

        if (!shouldWrite) {
          state.committed = true
          return
        }

        const id = ensureId()
        state.expiresAt = Date.now() + ttl
        const toStore: StoredSession<TSession> = {
          data: state.data,
          expiresAt: state.expiresAt
        }

        await adapter.set(id, toStore)

        appendSetCookie(
          headers,
          serializeSessionCookie(cookie.name, id, state.expiresAt, cookie)
        )

        state.isNew = false
        state.savedRevision = state.revision
        state.committed = true
      }

      const session: InternalSession<TSession> = {
        get id() {
          return state.id
        },
        get isNew() {
          return state.isNew
        },
        get data() {
          return state.data
        },
        get(key) {
          return state.data[key]
        },
        has(key) {
          return Object.prototype.hasOwnProperty.call(state.data, key)
        },
        set(key, value) {
          state.data[key] = value
          markDirty()
        },
        assign(patch) {
          Object.assign(state.data, patch)
          markDirty()
        },
        replace(next) {
          state.data = next
          markDirty()
        },
        async update(updater) {
          state.data = await updater(state.data)
          markDirty()
        },
        delete(key) {
          delete state.data[key]
          markDirty()
        },
        async regenerate() {
          if (state.destroyed) {
            throw new Error('Cannot regenerate a destroyed session.')
          }

          const previousId = state.id
          const nextId = generateId()
          state.id = nextId
          state.isNew = true
          markDirty()

          if (previousId !== nextId) {
            if (previousId) {
              await adapter.delete(previousId)
            }
          }

          return nextId
        },
        async destroy() {
          if (state.destroyed) {
            return
          }

          state.destroyed = true
          markDirty()
          await persist('manual')
        },
        async save() {
          await persist('manual')
        },
        [AUTO_SAVE]: persist
      }

      return {
        session
      }
    })
    .onAfterHandle({ as: 'scoped' }, async ({ session }) => {
      await (session as InternalSession<JsonObject>)[AUTO_SAVE]('auto')
    })
}
