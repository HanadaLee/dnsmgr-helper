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
  const secret = config.auth.sessionSecret
  return secret ? new TextEncoder().encode(secret) : undefined
}

export type CasSessionVerification =
  | { status: 'disabled'; candidateCount: 0 }
  | { status: 'missing'; candidateCount: 0 }
  | { status: 'invalid'; candidateCount: number }
  | { status: 'valid'; candidateCount: number; profile: CasProfile; method: 'cas' | 'oidc' | 'domain' }

async function createSignedSession(
  profile: CasProfile,
  config: AppConfig,
  sessionKind: 'cas' | 'oidc' | 'domain',
): Promise<string> {
  const key = sessionKey(config)
  if ((!config.cas.enabled && !config.oidc.enabled) || !key) throw new Error('统一登录 Session 未启用')

  const expiresAt = Math.floor(Date.now() / 1000) + config.auth.sessionTtlSeconds
  return new SignJWT({
    name: profile.name,
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(profile.avatar ? { avatar: profile.avatar } : {}),
    sessionKind,
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

export async function createCasSession(profile: CasProfile, config: AppConfig): Promise<string> {
  return createSignedSession(profile, config, 'cas')
}

export async function createOidcSession(profile: CasProfile, config: AppConfig): Promise<string> {
  return createSignedSession(profile, config, 'oidc')
}

export async function createDomainSession(domain: string, config: AppConfig): Promise<string> {
  return createSignedSession({ name: domain, displayName: domain }, config, 'domain')
}

export async function verifyCasSession(
  cookieHeader: string | undefined,
  config: AppConfig,
): Promise<CasSessionVerification> {
  const key = sessionKey(config)
  if ((!config.cas.enabled && !config.oidc.enabled) || !key) return { status: 'disabled', candidateCount: 0 }

  const candidates = cookieValues(cookieHeader, config.auth.sessionCookie)
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
      const method = result.payload.sessionKind === 'oidc' ? 'oidc'
        : result.payload.sessionKind === 'domain' ? 'domain' : 'cas'
      if (method === 'cas' && !config.cas.enabled) continue
      if (method === 'oidc' && !config.oidc.enabled) continue
      if (method !== 'domain' && config.auth.requiredProvider !== 'any'
        && method !== config.auth.requiredProvider) continue

      const email = optionalClaim(result.payload, 'email')
      const displayName = optionalClaim(result.payload, 'displayName')
      const avatar = optionalClaim(result.payload, 'avatar')
      const profile = {
        name,
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {}),
        ...(avatar ? { avatar } : {}),
      }

      return { status: 'valid', candidateCount: candidates.length, profile, method }
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
