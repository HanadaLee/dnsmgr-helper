import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { createCasSession, verifyCasProfile } from '../src/auth/cas.js'
import { parseConfig, type AppConfig } from '../src/config.js'
import type { CasProfile } from '../src/contracts.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

type ConfigOverrides = {
  server?: Record<string, unknown>
  upstream?: Record<string, unknown>
  cas?: Record<string, unknown>
  legacySso?: Record<string, unknown>
  database?: Record<string, unknown>
}

function config(overrides: ConfigOverrides = {}): AppConfig {
  const base = {
    server: {
      environment: 'test',
      host: '127.0.0.1',
      port: 3001,
      publicUrl: 'https://dns.test/',
    },
    upstream: {
      url: 'http://legacy.test/internal/',
      host: 'dns.internal.test',
      version: '1051',
      requestTimeoutMs: 15_000,
    },
    cas: {
      enabled: true,
      baseUrl: 'https://cas.test/cas/app/',
      validationUrl: '',
      validationHost: '',
      loginPath: '/cas/login',
      callbackPath: '/cas/callback',
      logoutPath: '/cas/logout',
      logoutRedirectPath: '/',
      sessionCookie: 'dnsmgr_helper_session',
      sessionSecret: 'unit-test-helper-session-secret-at-least-32-bytes',
      sessionTtlSeconds: 3600,
      requestTimeoutMs: 15_000,
      cookieSecure: true,
      cookieSameSite: 'lax',
      cookieDomain: '',
      attributes: {
        user: 'user',
        email: 'email',
        displayName: 'displayName',
        avatar: 'avatar',
      },
    },
    legacySso: {
      adminUser: 'admin',
      managedPassword: 'unit-test-managed-password',
      loginPath: '/login',
      registerPath: '/user/op/act/add',
      sessionCookie: 'user_token',
    },
    database: {
      enabled: false,
      host: '127.0.0.1',
      port: 3306,
      socketPath: '',
      user: 'dnsmgr_helper',
      password: '',
      name: 'dnsmgr',
      connectionLimit: 2,
      connectTimeoutMs: 1000,
      ssl: false,
    },
  }

  return parseConfig({
    server: { ...base.server, ...overrides.server },
    upstream: { ...base.upstream, ...overrides.upstream },
    cas: { ...base.cas, ...overrides.cas },
    legacySso: { ...base.legacySso, ...overrides.legacySso },
    database: { ...base.database, ...overrides.database },
  })
}

async function appWith(fetcher: FetchLike, appConfig = config()) {
  const app = await buildApp({ config: appConfig, fetcher, logger: false })
  apps.push(app)
  return app
}

function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    return handler(url, init ?? {})
  }) as FetchLike
}

const profile: CasProfile = {
  name: 'hanada',
  email: 'hanada@example.test',
  displayName: 'Hanada',
  avatar: 'https://cdn.example.test/avatar.png',
}

async function authenticatedCookies(appConfig: AppConfig, legacyToken = 'legacy-session') {
  const helperToken = await createCasSession(profile, appConfig)
  return `${appConfig.cas.sessionCookie}=${encodeURIComponent(helperToken)}; ${appConfig.legacySso.sessionCookie}=${encodeURIComponent(legacyToken)}`
}

function casSuccessXml(name = 'hanada') {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
      <cas:authenticationSuccess>
        <cas:user>${name}</cas:user>
        <cas:attributes>
          <cas:email>${name}@example.test</cas:email>
          <cas:displayName>Hanada</cas:displayName>
          <cas:avatar>https://cdn.example.test/avatar.png</cas:avatar>
        </cas:attributes>
      </cas:authenticationSuccess>
    </cas:serviceResponse>`
}

function responseCookies(response: {
  headers: Record<string, string | string[] | number | undefined>
}): string[] {
  const value = response.headers['set-cookie']
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

describe('service and static configuration', () => {
  it('reports health and disabled database readiness without external calls', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher)

    const health = await app.inject({ method: 'GET', url: '/healthz' })
    const readiness = await app.inject({ method: 'GET', url: '/readyz' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({
      code: 'OK',
      data: {
        service: 'dnsmgr-helper',
        adapter: 'v1051',
        casEnabled: true,
        databaseEnabled: false,
      },
    })
    expect(readiness.json()).toMatchObject({
      code: 'OK',
      data: { database: { enabled: false, connected: false } },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports but refuses an unsupported configured upstream version', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher, config({ upstream: { version: '9999' } }))

    const compatibility = await app.inject({ method: 'GET', url: '/api/web/v1/compatibility' })
    const domains = await app.inject({ method: 'GET', url: '/api/web/v1/domains' })

    expect(compatibility.json()).toMatchObject({
      data: { configuredUpstreamVersion: '9999', adapter: 'v1051', supported: false },
    })
    expect(domains.statusCode).toBe(503)
    expect(domains.json()).toMatchObject({ code: 'UPSTREAM_VERSION_UNSUPPORTED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('helper-owned CAS flow', () => {
  it('redirects login to CAS with an exact helper callback service', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/cas/login?returnTo=%2Fdomains%3Fq%3Dexample',
    })

    expect(response.statusCode).toBe(302)
    const location = new URL(String(response.headers.location))
    expect(location.href.startsWith('https://cas.test/cas/app/login?')).toBe(true)
    expect(location.searchParams.get('service')).toBe(
      'https://dns.test/cas/callback?returnTo=%2Fdomains%3Fq%3Dexample',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects an external return target before constructing the CAS service URL', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/cas/login?returnTo=%2F%2Fevil.example%2Fsteal',
    })

    const location = new URL(String(response.headers.location))
    expect(location.searchParams.get('service')).toBe(
      'https://dns.test/cas/callback?returnTo=%2F',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('validates CAS, logs an existing dnsmgr user in and issues both cookies', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      if (url.hostname === 'cas.test') {
        expect(url.pathname).toBe('/cas/app/serviceValidate')
        expect(url.searchParams.get('ticket')).toBe('ST-valid')
        expect(url.searchParams.get('service')).toBe(
          'https://dns.test/cas/callback?returnTo=%2Fdomains',
        )
        return new Response(casSuccessXml(), { headers: { 'content-type': 'application/xml' } })
      }

      expect(url.pathname).toBe('/internal/login')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toEqual({
        username: 'hanada',
        password: 'unit-test-managed-password',
      })
      return Response.json({ code: 0 }, {
        headers: { 'set-cookie': 'user_token=legacy-user-session; Path=/; HttpOnly' },
      })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/cas/callback?ticket=ST-valid&returnTo=%2Fdomains',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/domains')
    const cookies = responseCookies(response)
    expect(cookies.join('\n')).toContain('dnsmgr_helper_session=')
    expect(cookies.join('\n')).toContain('user_token=legacy-user-session')
    expect(cookies.join('\n')).toContain('HttpOnly')
    expect(cookies.join('\n')).toContain('Secure')

    const cookieHeader = cookies.map((cookie) => cookie.split(';')[0]).join('; ')
    await expect(verifyCasProfile(cookieHeader, appConfig)).resolves.toMatchObject(profile)
  })

  it('creates a missing dnsmgr user with the configured administrator and retries login', async () => {
    let userLoginCount = 0
    const fetcher = fakeFetch((url, init) => {
      if (url.hostname === 'cas.test') {
        return new Response(casSuccessXml(), { headers: { 'content-type': 'application/xml' } })
      }

      const form = new URLSearchParams(String(init.body))
      if (url.pathname === '/internal/login' && form.get('username') === 'hanada') {
        userLoginCount += 1
        if (userLoginCount === 1) return Response.json({ code: -1 })
        return Response.json({ code: 0 }, {
          headers: { 'set-cookie': 'user_token=created-user-session; Path=/' },
        })
      }
      if (url.pathname === '/internal/login' && form.get('username') === 'admin') {
        return Response.json({ code: 0 }, {
          headers: { 'set-cookie': 'user_token=admin-session; Path=/' },
        })
      }
      if (url.pathname === '/internal/user/op/act/add') {
        expect(new Headers(init.headers).get('cookie')).toBe('user_token=admin-session')
        expect(Object.fromEntries(form)).toMatchObject({
          action: 'add',
          username: 'hanada',
          password: 'unit-test-managed-password',
          level: '1',
        })
        return Response.json({ code: 0 })
      }
      throw new Error(`unexpected request: ${url.href}`)
    })
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/cas/callback?ticket=ST-new&returnTo=%2F',
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/')
    expect(responseCookies(response).join('\n')).toContain('user_token=created-user-session')
    expect(userLoginCount).toBe(2)
  })

  it('does not contact dnsmgr when CAS rejects the ticket', async () => {
    const fetcher = vi.fn(fakeFetch((url) => {
      expect(url.hostname).toBe('cas.test')
      return new Response(`
        <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
          <cas:authenticationFailure code="INVALID_TICKET">invalid</cas:authenticationFailure>
        </cas:serviceResponse>
      `, { headers: { 'content-type': 'application/xml' } })
    })) as unknown as FetchLike
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/cas/callback?ticket=ST-invalid&returnTo=%2F',
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ code: 'CAS_TICKET_INVALID' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('clears helper and legacy cookies before redirecting to CAS logout', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher)

    const response = await app.inject({ method: 'GET', url: '/cas/logout' })

    expect(response.statusCode).toBe(302)
    const location = new URL(String(response.headers.location))
    expect(location.pathname).toBe('/cas/app/logout')
    expect(location.searchParams.get('service')).toBe('https://dns.test/')
    const cookies = responseCookies(response).join('\n')
    expect(cookies).toContain('dnsmgr_helper_session=')
    expect(cookies).toContain('user_token=')
    expect(cookies).toContain('Max-Age=0')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('supports disabling CAS and then relies only on the legacy session', async () => {
    const appConfig = config({
      cas: { enabled: false, baseUrl: '', validationUrl: '', sessionSecret: '' },
    })
    const fetcher = fakeFetch((_url, init) => {
      expect(new Headers(init.headers).get('cookie')).toBe('user_token=legacy-only')
      return Response.json({ total: 0, rows: [] })
    })
    const app = await appWith(fetcher, appConfig)

    const domains = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains',
      headers: { cookie: 'user_token=legacy-only' },
    })
    const login = await app.inject({ method: 'GET', url: '/cas/login' })

    expect(domains.statusCode).toBe(200)
    expect(login.statusCode).toBe(503)
    expect(login.json()).toMatchObject({ code: 'CAS_DISABLED' })
  })
})

describe('session compatibility', () => {
  it('requires a helper CAS session and forwards only the legacy cookie upstream', async () => {
    const appConfig = config()
    const cookie = await authenticatedCookies(appConfig)
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/')
      const headers = new Headers(init.headers)
      expect(headers.get('cookie')).toBe('user_token=legacy-session')
      expect(headers.get('host')).toBe('dns.internal.test')

      return new Response(`
        <html><body>
          <span class="hidden-xs">legacy-admin</span>
          <small>2025-01-02 03:04:05</small>
          <a href="/">后台首页</a><a href="/domain">域名管理</a>
          <a href="/system/cronset">设置</a><a href="/log">日志</a><a href="/setpwd">密码</a>
          <script src="//auth.example.test/app/dnsmgr.php?ver=1051"></script>
        </body></html>
      `, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/session',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        user: { name: 'hanada', displayName: 'Hanada', type: 'user' },
        capabilities: { dashboard: true, domains: true, systemSettings: true },
        sso: { profileVerified: true, loginPath: '/cas/login', logoutPath: '/cas/logout' },
      },
    })
  })

  it('rejects a valid legacy cookie when the helper CAS session is missing', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains',
      headers: { cookie: 'user_token=still-valid' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { loginPath: '/cas/login' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('v1051 list translation', () => {
  it('maps stable domain query names to the legacy form and normalizes rows', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/domain/data')
      expect(new Headers(init.headers).get('cookie')).toBe('user_token=session')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toMatchObject({
        offset: '10', limit: '10', sortName: 'recordcount', sortOrder: 'asc',
        kw: 'example', type: 'cloudflare', status: '2',
      })

      return Response.json({
        total: '12',
        rows: [{
          id: '42', name: 'example.com', aid: '7', type: 'cloudflare',
          typename: 'Cloudflare', aremark: '主账号', recordcount: '18',
          addtime: '2025-02-03 04:05:06', expiretime: '2027-02-03 00:00:00',
          checkstatus: '1', is_notice: '1', is_hide: '0', is_sso: 0,
          category_name: '生产', remark: '主域名', password: 'must-not-leak',
        }],
      })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains?page=2&pageSize=10&q=example&provider=cloudflare&expiryStatus=expired&sort=recordCount&order=asc',
      headers: { cookie: await authenticatedCookies(appConfig, 'session') },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: [{
        id: 42,
        name: 'example.com',
        provider: { type: 'cloudflare', label: 'Cloudflare', accountId: 7, accountLabel: '主账号' },
        recordCount: 18,
        addedAt: '2025-02-03 04:05:06',
        expiresAt: '2027-02-03 00:00:00',
        expiryLookup: 'ready',
        noticeEnabled: true,
        hidden: false,
        ssoEnabled: false,
        category: '生产',
        remark: '主域名',
      }],
      meta: { page: 2, pageSize: 10, total: 12 },
    })
  })

  it('applies stable paging when a DNS provider returns a client-side array', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/record/data/9')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toMatchObject({
        offset: '2', limit: '2', sortName: 'Name', sortOrder: 'asc', status: '1',
      })
      return Response.json([
        { RecordId: 'r1', Name: '@', Type: 'A', Value: '192.0.2.1', Line: '0', LineName: '默认', TTL: 600, Status: '1' },
        { RecordId: 'r2', Name: 'www', Type: 'CNAME', Value: 'example.com', Line: '0', LineName: '默认', TTL: 600, Status: '1' },
        { RecordId: 'r3', Name: 'mail', Type: 'MX', Value: 'mx.example.com', Line: '0', LineName: '默认', TTL: '300', MX: '10', Status: '1' },
        { RecordId: 'r4', Name: '_verify', Type: 'TXT', Value: 'value', Line: 'oversea', LineName: '境外', Status: '0' },
      ])
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains/9/records?page=2&pageSize=2&status=enabled',
      headers: { cookie: await authenticatedCookies(appConfig, 'session') },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: [
        { id: 'r3', name: 'mail', type: 'MX', value: 'mx.example.com', line: { id: '0', label: '默认' }, ttl: 300, mxPriority: 10, status: 'enabled' },
        { id: 'r4', name: '_verify', type: 'TXT', value: 'value', line: { id: 'oversea', label: '境外' }, status: 'disabled' },
      ],
      meta: { page: 2, pageSize: 2, total: 4 },
    })
  })
})
