import { randomUUID } from 'node:crypto'

import { jwtVerify, SignJWT } from 'jose'

import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import { parseCookieHeader } from './cookies.js'

const SESSION_ISSUER = 'dnsmgr-helper'
const SESSION_AUDIENCE = 'dnsmgr-web'

function optionalClaim(payload: Record<string, unknown>, name: string): string | undefined {
  const value = payload[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function sessionKey(config: AppConfig): Uint8Array | undefined {
  const secret = config.cas.sessionSecret
  return secret ? new TextEncoder().encode(secret) : undefined
}

export async function createCasSession(profile: CasProfile, config: AppConfig): Promise<string> {
  const key = sessionKey(config)
  if (!config.cas.enabled || !key) throw new Error('CAS Session 未启用')

  const expiresAt = Math.floor(Date.now() / 1000) + config.cas.sessionTtlSeconds
  return new SignJWT({
    name: profile.name,
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(profile.name)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key)
}

export async function verifyCasProfile(
  cookieHeader: string | undefined,
  config: AppConfig,
): Promise<CasProfile | undefined> {
  const key = sessionKey(config)
  if (!config.cas.enabled || !key) return undefined

  const token = parseCookieHeader(cookieHeader).get(config.cas.sessionCookie)
  if (!token) return undefined

  try {
    const result = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    })
    const name = optionalClaim(result.payload, 'name')
    if (!name || result.payload.sub !== name) return undefined

    const email = optionalClaim(result.payload, 'email')
    const displayName = optionalClaim(result.payload, 'displayName')
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
