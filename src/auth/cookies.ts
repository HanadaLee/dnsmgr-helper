function decodeCookieValue(rawValue: string): string {
  try {
    return decodeURIComponent(rawValue)
  } catch {
    return rawValue
  }
}

function cookiePairs(cookieHeader: string | undefined): Array<[string, string]> {
  const cookies: Array<[string, string]> = []
  if (!cookieHeader) return cookies

  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1) continue
    const key = item.slice(0, separator).trim()
    const rawValue = item.slice(separator + 1).trim()
    if (!key) continue
    cookies.push([key, decodeCookieValue(rawValue)])
  }

  return cookies
}

export function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  return new Map(cookiePairs(cookieHeader))
}

export function cookieValues(cookieHeader: string | undefined, name: string): string[] {
  return cookiePairs(cookieHeader)
    .filter(([cookieName]) => cookieName === name)
    .map(([, value]) => value)
}

export type CookieOptions = {
  maxAge: number
  secure: boolean
  sameSite: 'strict' | 'lax' | 'none'
  domain?: string
}

function encodedCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}`
}

export function serializeHttpOnlyCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const sameSite = { strict: 'Strict', lax: 'Lax', none: 'None' }[options.sameSite]
  const parts = [
    encodedCookie(name, value),
    'Path=/',
    `Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
  ]
  if (options.maxAge <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  if (options.secure) parts.push('Secure')
  if (options.domain) parts.push(`Domain=${options.domain}`)
  return parts.join('; ')
}

export function singleCookieHeader(name: string, value: string): string {
  return encodedCookie(name, value)
}
