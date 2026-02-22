import type { SameSite, SessionCookieOptions } from './types.js'

const defaultCookie = {
  name: 'sid',
  path: '/',
  secure: false,
  httpOnly: true,
  sameSite: 'lax' as SameSite
}

const formatSameSite = (sameSite: SameSite): string => {
  switch (sameSite) {
    case 'strict':
      return 'Strict'
    case 'none':
      return 'None'
    default:
      return 'Lax'
  }
}

export const normalizeCookieOptions = (
  cookie?: SessionCookieOptions
): Required<Omit<SessionCookieOptions, 'domain'>> & Pick<SessionCookieOptions, 'domain'> => ({
  name: cookie?.name ?? defaultCookie.name,
  path: cookie?.path ?? defaultCookie.path,
  domain: cookie?.domain,
  secure: cookie?.secure ?? defaultCookie.secure,
  httpOnly: cookie?.httpOnly ?? defaultCookie.httpOnly,
  sameSite: cookie?.sameSite ?? defaultCookie.sameSite
})

export const parseCookies = (cookieHeader: string | null): Record<string, string> => {
  if (!cookieHeader) {
    return {}
  }

  const pairs = cookieHeader.split(';')
  const result: Record<string, string> = {}

  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index < 0) {
      continue
    }

    const rawName = pair.slice(0, index).trim()
    const rawValue = pair.slice(index + 1).trim()

    if (!rawName) {
      continue
    }

    try {
      result[rawName] = decodeURIComponent(rawValue)
    } catch {
      result[rawName] = rawValue
    }
  }

  return result
}

const withCookieAttributes = (
  name: string,
  value: string,
  expiresAt: number,
  cookie: Required<Omit<SessionCookieOptions, 'domain'>> & Pick<SessionCookieOptions, 'domain'>
): string => {
  const segments = [`${name}=${encodeURIComponent(value)}`]

  segments.push(`Path=${cookie.path}`)
  segments.push(`SameSite=${formatSameSite(cookie.sameSite)}`)
  segments.push(`Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`)
  segments.push(`Expires=${new Date(expiresAt).toUTCString()}`)

  if (cookie.httpOnly) {
    segments.push('HttpOnly')
  }

  if (cookie.secure) {
    segments.push('Secure')
  }

  if (cookie.domain) {
    segments.push(`Domain=${cookie.domain}`)
  }

  return segments.join('; ')
}

export const serializeSessionCookie = (
  name: string,
  value: string,
  expiresAt: number,
  cookie: Required<Omit<SessionCookieOptions, 'domain'>> & Pick<SessionCookieOptions, 'domain'>
): string => withCookieAttributes(name, value, expiresAt, cookie)

export const serializeExpiredCookie = (
  name: string,
  cookie: Required<Omit<SessionCookieOptions, 'domain'>> & Pick<SessionCookieOptions, 'domain'>
): string => withCookieAttributes(name, '', 0, cookie)
