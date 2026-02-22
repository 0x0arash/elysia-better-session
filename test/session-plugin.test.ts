import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { betterSession, createMemorySessionAdapter } from '../src'

type PluginSession = {
  visits: number
  userId: string | null
}

const cookiePair = (setCookie: string | null): string | null => {
  if (!setCookie) {
    return null
  }

  const [pair] = setCookie.split(';')
  return pair ?? null
}

describe('betterSession plugin', () => {
  it('creates and persists server-side session data', async () => {
    const adapter = createMemorySessionAdapter<PluginSession>()

    const app = new Elysia()
      .use(
        betterSession<PluginSession>({
          adapter,
          ttl: 60_000,
          cookie: {
            name: 'sid',
            secure: false
          },
          initialData: () => ({
            visits: 0,
            userId: null
          })
        })
      )
      .get('/visit', ({ session }) => {
        const visits = (session.get('visits') ?? 0) + 1
        session.set('visits', visits)
        return { visits }
      })

    const first = await app.handle(new Request('http://localhost/visit'))
    expect(first.status).toBe(200)

    const firstBody = (await first.json()) as { visits: number }
    expect(firstBody.visits).toBe(1)

    const firstCookie = cookiePair(first.headers.get('set-cookie'))
    expect(firstCookie).not.toBeNull()

    const second = await app.handle(
      new Request('http://localhost/visit', {
        headers: {
          cookie: firstCookie ?? ''
        }
      })
    )

    const secondBody = (await second.json()) as { visits: number }
    expect(secondBody.visits).toBe(2)
  })

  it('destroys sessions and clears the cookie', async () => {
    const adapter = createMemorySessionAdapter<PluginSession>()

    const app = new Elysia()
      .use(
        betterSession<PluginSession>({
          adapter,
          ttl: 60_000,
          cookie: {
            name: 'sid',
            secure: false
          },
          initialData: () => ({
            visits: 0,
            userId: null
          })
        })
      )
      .post('/login/:userId', ({ params, session }) => {
        session.set('userId', params.userId)
        return { ok: true }
      })
      .post('/logout', async ({ session }) => {
        await session.destroy()
        return { ok: true }
      })
      .get('/me', ({ session }) => ({
        userId: session.get('userId') ?? null
      }))

    const login = await app.handle(new Request('http://localhost/login/abc', { method: 'POST' }))
    const loginCookie = cookiePair(login.headers.get('set-cookie'))
    expect(loginCookie).not.toBeNull()

    const logout = await app.handle(
      new Request('http://localhost/logout', {
        method: 'POST',
        headers: {
          cookie: loginCookie ?? ''
        }
      })
    )

    const expired = logout.headers.get('set-cookie')
    expect(expired).not.toBeNull()
    expect(expired).toContain('Max-Age=0')

    const me = await app.handle(
      new Request('http://localhost/me', {
        headers: {
          cookie: loginCookie ?? ''
        }
      })
    )
    const meBody = (await me.json()) as { userId: string | null }
    expect(meBody.userId).toBeNull()
  })

  it('supports lazy creation with createOnRequest disabled', async () => {
    const adapter = createMemorySessionAdapter<PluginSession>()

    const app = new Elysia()
      .use(
        betterSession<PluginSession>({
          adapter,
          ttl: 60_000,
          createOnRequest: false,
          cookie: {
            name: 'sid',
            secure: false
          },
          initialData: () => ({
            visits: 0,
            userId: null
          })
        })
      )
      .get('/read', ({ session }) => ({
        id: session.id,
        visits: session.get('visits') ?? 0
      }))
      .post('/touch', ({ session }) => {
        session.set('visits', 1)
        return { ok: true }
      })
      .get('/state', ({ session }) => ({
        visits: session.get('visits') ?? 0
      }))

    const firstRead = await app.handle(new Request('http://localhost/read'))
    expect(firstRead.headers.get('set-cookie')).toBeNull()

    const touch = await app.handle(new Request('http://localhost/touch', { method: 'POST' }))
    const touchCookie = cookiePair(touch.headers.get('set-cookie'))
    expect(touchCookie).not.toBeNull()

    const state = await app.handle(
      new Request('http://localhost/state', {
        headers: {
          cookie: touchCookie ?? ''
        }
      })
    )
    const stateBody = (await state.json()) as { visits: number }
    expect(stateBody.visits).toBe(1)
  })
})
