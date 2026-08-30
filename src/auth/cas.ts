import { jwtVerify } from 'jose'

import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import { parseCookieHeader } from './cookies.js'

function optionalClaim(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export async function verifyCasProfile(
  cookieHeader: string | undefined,
  config: AppConfig,
): Promise<CasProfile | undefined> {
  if (!config.casJwtSecret) return undefined

  const token = parseCookieHeader(cookieHeader).get(config.casJwtCookie)
  if (!token) return undefined

  try {
    const result = await jwtVerify(token, new TextEncoder().encode(config.casJwtSecret), {
      algorithms: ['HS256'],
    })
    const name = optionalClaim(result.payload, 'name')
    if (!name) return undefined

    const email = optionalClaim(result.payload, 'email')
    const displayName = optionalClaim(result.payload, 'display_name')
    const avatar = optionalClaim(result.payload, 'avatar')

    return {
      name,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
      ...(avatar ? { avatar } : {}),
    }
  } catch {
    return undefined
  }
}
