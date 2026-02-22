import { Elysia } from 'elysia'
import { betterSession, createMemorySessionAdapter } from '../src'

type AppSession = {
  userId: string | null
  visits: number
}

const adapter = createMemorySessionAdapter<AppSession>()

const app = new Elysia()
  .use(
    betterSession<AppSession>({
      adapter,
      ttl: 1000 * 60 * 60 * 24,
      cookie: {
        name: 'app.sid',
        secure: false
      },
      initialData: () => ({
        userId: null,
        visits: 0
      })
    })
  )
  .get('/', ({ session }) => {
    const visits = (session.get('visits') ?? 0) + 1
    session.set('visits', visits)

    return {
      message: 'Session is active.',
      visits,
      userId: session.get('userId')
    }
  })
  .post('/login/:userId', ({ params, session }) => {
    session.set('userId', params.userId)
    return {
      ok: true
    }
  })
  .post('/logout', async ({ session }) => {
    await session.destroy()
    return {
      ok: true
    }
  })
  .listen(3000)

console.log(`Session example server is running at ${app.server?.url}`)
