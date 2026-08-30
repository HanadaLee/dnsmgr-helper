export function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!cookieHeader) return cookies

  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1) continue
    const key = item.slice(0, separator).trim()
    const rawValue = item.slice(separator + 1).trim()
    if (!key) continue

    try {
      cookies.set(key, decodeURIComponent(rawValue))
    } catch {
      cookies.set(key, rawValue)
    }
  }

  return cookies
}
