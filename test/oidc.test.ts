import { exportJWK, generateKeyPair as generateJoseKeyPair, SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp, requestUrlForLog } from '../src/app.js'
import { createCasSession, createOidcSession, verifyCasSession } from '../src/auth/cas.js'
import { OIDC_LOGOUT_COOKIE, OIDC_STATE_COOKIE } from '../src/auth/oidc-client.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
const issuer = 'https://id.test'
const domain = 'https://dns.test'

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

function config(requiredProvider: 'any' | 'cas' | 'oidc' = 'any') {
  return parseConfig({
    server: { environment: 'test', publicUrl: `${domain}/` },
    upstream: { url: 'http://legacy.test/internal/' },
    cas: { enabled: true, baseUrl: 'https://cas.test/cas/app/', sessionSecret: 'old-cas-session-secret-at-least-32-characters' },
    oidc: { enabled: true, issuer, clientId: 'dnsmgr', clientSecret: 'client-secret' },
    auth: { requiredProvider },
    legacySso: { adminUser: 'admin', managedPassword: 'managed-password' },
    database: { enabled: false },
  })
}

function cookies(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const value = response.headers['set-cookie']
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : [])
}

function cookieHeader(response: { headers: Record<string, string | string[] | number | undefined> }) {
  return cookies(response).map((cookie) => cookie.split(';')[0]).join('; ')
}

function casSuccessXml() {
  return '<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>hanada</cas:user></cas:authenticationSuccess></cas:serviceResponse>'
}

describe('OIDC and CAS shared login', () => {
  it('uses authorization code, PKCE and verified ID Token to enter the same dnsmgr user', async () => {
    const { publicKey, privateKey } = await generateJoseKeyPair('RS256')
    const publicJwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
    const usedNames: string[] = []
    let nonce = ''
    let username: string | undefined = 'hanada'
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input)
      if (url.pathname === '/.well-known/openid-configuration') return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        end_session_endpoint: `${issuer}/logout`,
      })
      if (url.pathname === '/keys') return Response.json({ keys: [publicJwk] })
      if (url.pathname === '/token') {
        const form = new URLSearchParams(String(init?.body))
        expect(form.get('grant_type')).toBe('authorization_code')
        expect(form.get('code_verifier')).toBeTruthy()
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Basic /)
        return Response.json({ id_token: await new SignJWT({ nonce, ...(username ? { preferred_username: username } : {}), name: 'Hanada' })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(issuer).setAudience('dnsmgr').setSubject('stable-subject')
          .setIssuedAt().setExpirationTime('5m').sign(privateKey) })
      }
      if (url.hostname === 'cas.test') return new Response(casSuccessXml(), { headers: { 'content-type': 'application/xml' } })
      if (url.pathname === '/internal/login') {
        const name = new URLSearchParams(String(init?.body)).get('username') ?? ''
        usedNames.push(name)
        return Response.json({ code: 0 }, { headers: { 'set-cookie': `user_token=${name}-session; Path=/` } })
      }
      throw new Error(`Unexpected request: ${url.href}`)
    }) as FetchLike
    const settings = config()
    const app = await buildApp({ config: settings, fetcher, logger: false })
    apps.push(app)

    const chooser = await app.inject({ method: 'GET', url: '/login?returnTo=%2Fdomains' })
    expect(chooser.statusCode).toBe(200)
    expect(chooser.body).toContain('OIDC 登录')
    expect(chooser.body).toContain('CAS 登录')

    const start = await app.inject({ method: 'GET', url: '/oidc/login?returnTo=%2Fdomains' })
    expect(start.statusCode).toBe(302)
    const authorize = new URL(String(start.headers.location))
    nonce = authorize.searchParams.get('nonce') ?? ''
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${domain}/oidc/callback`)
    const loginState = authorize.searchParams.get('state') ?? ''
    const stateCookie = cookieHeader(start)
    expect(stateCookie).toContain(`${OIDC_STATE_COOKIE}=`)

    const invalid = await app.inject({ method: 'GET', url: '/oidc/callback?code=good&state=wrong', headers: { cookie: stateCookie } })
    expect(invalid.statusCode).toBe(401)
    const expectedNonce = nonce
    nonce = 'wrong-nonce'
    const invalidNonce = await app.inject({ method: 'GET', url: `/oidc/callback?code=good&state=${encodeURIComponent(loginState)}`, headers: { cookie: stateCookie } })
    expect(invalidNonce.statusCode).toBe(401)
    nonce = expectedNonce
    username = undefined
    const missingUsername = await app.inject({ method: 'GET', url: `/oidc/callback?code=good&state=${encodeURIComponent(loginState)}`, headers: { cookie: stateCookie } })
    expect(missingUsername.statusCode).toBe(401)
    expect(usedNames).toEqual([])
    username = 'hanada'

    const oidc = await app.inject({
      method: 'GET', url: `/oidc/callback?code=good&state=${encodeURIComponent(loginState)}`,
      headers: { cookie: stateCookie },
    })
    expect(oidc.statusCode).toBe(302)
    expect(oidc.headers.location).toBe('/domains')
    expect(cookies(oidc).join('\n')).toContain('user_token=hanada-session')
    const verified = await verifyCasSession(cookieHeader(oidc), settings)
    expect(verified).toMatchObject({ status: 'valid', method: 'oidc', profile: { name: 'hanada' } })

    const cas = await app.inject({ method: 'GET', url: '/cas/callback?ticket=ST-valid' })
    expect(cas.statusCode).toBe(302)
    expect(await verifyCasSession(cookieHeader(cas), settings)).toMatchObject({ status: 'valid', method: 'cas', profile: { name: 'hanada' } })
    expect(usedNames).toEqual(['hanada', 'hanada'])

    const logout = await app.inject({ method: 'GET', url: '/logout', headers: { cookie: cookieHeader(oidc) } })
    const logoutUrl = new URL(String(logout.headers.location))
    expect(logoutUrl.pathname).toBe('/logout')
    expect(logoutUrl.searchParams.get('client_id')).toBe('dnsmgr')
    expect(logoutUrl.searchParams.get('id_token_hint')).toBeTruthy()
    expect(logoutUrl.searchParams.get('post_logout_redirect_uri')).toBe(`${domain}/oidc/logged-out`)
    const done = await app.inject({
      method: 'GET', url: `/oidc/logged-out?state=${encodeURIComponent(logoutUrl.searchParams.get('state') ?? '')}`,
      headers: { cookie: cookieHeader(logout) },
    })
    expect(done.headers.location).toBe('/?signed_out=1')
    expect(cookies(logout).join('\n')).toContain(`${OIDC_LOGOUT_COOKIE}=`)
    const signedOutPage = await app.inject({ method: 'GET', url: '/login', headers: { cookie: cookieHeader(done) } })
    expect(signedOutPage.statusCode).toBe(200)
    expect(signedOutPage.body).toContain('已退出登录')
  })

  it('enforces the configured provider for existing helper sessions and direct login', async () => {
    const casOnly = config('cas')
    const oidcOnly = config('oidc')
    const fetcher = (async () => { throw new Error('No external call expected') }) as FetchLike
    const casApp = await buildApp({ config: casOnly, fetcher, logger: false })
    const oidcApp = await buildApp({ config: oidcOnly, fetcher, logger: false })
    apps.push(casApp, oidcApp)
    const profile = { name: 'hanada' }
    const oidcSession = await createOidcSession(profile, casOnly)
    const casSession = await createCasSession(profile, oidcOnly)

    const rejectedOidc = await casApp.inject({ method: 'GET', url: '/api/web/v1/domains', headers: { cookie: `${casOnly.auth.sessionCookie}=${oidcSession}` } })
    const rejectedCas = await oidcApp.inject({ method: 'GET', url: '/api/web/v1/domains', headers: { cookie: `${oidcOnly.auth.sessionCookie}=${casSession}` } })
    expect(rejectedOidc.statusCode).toBe(401)
    expect(rejectedCas.statusCode).toBe(401)
    expect((await casApp.inject({ method: 'GET', url: '/oidc/login' })).statusCode).toBe(403)
    expect((await oidcApp.inject({ method: 'GET', url: '/cas/login' })).statusCode).toBe(403)
    expect((await casApp.inject({ method: 'GET', url: '/login' })).headers.location).toContain('/cas/login')
    expect((await oidcApp.inject({ method: 'GET', url: '/login' })).headers.location).toContain('/oidc/login')
  })

  it('redacts authorization codes and states from request logs', () => {
    expect(requestUrlForLog('/oidc/callback?code=secret&state=secret')).toBe('/oidc/callback?code=[redacted]&state=[redacted]')
  })
})
