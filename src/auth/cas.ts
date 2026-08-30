import { randomUUID } from 'node:crypto'

import { jwtVerify, SignJWT } from 'jose'

import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import { cookieValues } from './cookies.js'

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

export type CasSessionVerification =
  | { status: 'disabled'; candidateCount: 0 }
  | { status: 'missing'; candidateCount: 0 }
  | { status: 'invalid'; candidateCount: number }
  | { status: 'valid'; candidateCount: number; profile: CasProfile }

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

export async function verifyCasSession(
  cookieHeader: string | undefined,
  config: AppConfig,
): Promise<CasSessionVerification> {
  const key = sessionKey(config)
  if (!config.cas.enabled || !key) return { status: 'disabled', candidateCount: 0 }

  const candidates = cookieValues(cookieHeader, config.cas.sessionCookie)
  if (candidates.length === 0) return { status: 'missing', candidateCount: 0 }

  for (const token of candidates) {
    try {
      const result = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
      })
      const name = optionalClaim(result.payload, 'name')
      if (!name || result.payload.sub !== name) continue

      const email = optionalClaim(result.payload, 'email')
      const displayName = optionalClaim(result.payload, 'displayName')
      const avatar = optionalClaim(result.payload, 'avatar')
      const profile = {
        name,
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {}),
        ...(avatar ? { avatar } : {}),
      }

      return { status: 'valid', candidateCount: candidates.length, profile }
    } catch {
      // A browser can send same-name host-only and domain cookies together.
      // Try every candidate before rejecting the request.
    }
  }

  return { status: 'invalid', candidateCount: candidates.length }
}

export async function verifyCasProfile(
  cookieHeader: string | undefined,
  config: AppConfig,
): Promise<CasProfile | undefined> {
  const verification = await verifyCasSession(cookieHeader, config)
  return verification.status === 'valid' ? verification.profile : undefined
}
