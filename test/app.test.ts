import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp, requestUrlForLog } from '../src/app.js'
import { createCasSession, verifyCasProfile } from '../src/auth/cas.js'
import { parseConfig, type AppConfig } from '../src/config.js'
import type { CasProfile } from '../src/contracts.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

describe('request log redaction', () => {
  it('redacts public login tokens and ticket values without hiding ordinary query fields', () => {
    expect(requestUrlForLog('/quicklogin?domain=example.com&token=secret')).toBe('/quicklogin?[redacted]')
    expect(requestUrlForLog('/cas/callback?returnTo=%2F&ticket=ST-secret')).toBe('/cas/callback?returnTo=%2F&ticket=[redacted]')
    expect(requestUrlForLog('/api/web/v1/domains?page=2')).toBe('/api/web/v1/domains?page=2')
  })
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
      bridgeCookie: 'dnsmgr_helper_legacy_session',
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
  return `${appConfig.cas.sessionCookie}=${encodeURIComponent(helperToken)}; ${appConfig.legacySso.bridgeCookie}=${encodeURIComponent(legacyToken)}`
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
    expect(cookies.join('\n')).toContain('dnsmgr_helper_legacy_session=legacy-user-session')
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

  it('restarts login without showing an error page when CAS rejects an expired ticket', async () => {
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

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/login?returnTo=%2F')
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
    expect(cookies).toContain('dnsmgr_helper_legacy_session=')
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
  it('returns the assigned domain when the original site redirects a domain-only user', async () => {
    const appConfig = config()
    const cookie = await authenticatedCookies(appConfig)
    const fetcher = fakeFetch(() => new Response('', {
      status: 302,
      headers: { location: '/record/42' },
    }))
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/session',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        user: { type: 'domain', domainId: 42 },
        capabilities: { dashboard: false, domains: true, domainAccounts: false },
      },
    })
  })

  it('requires a helper CAS session and forwards only the legacy cookie upstream', async () => {
    const appConfig = config()
    const cookie = await authenticatedCookies(appConfig)
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/')
      const headers = new Headers(init.headers)
      expect(headers.get('cookie')).toBe('user_token=legacy-session')
      expect(headers.get('host')).toBe('dns.internal.test')
      expect(headers.get('accept')).toBe('text/html, application/xhtml+xml')
      expect(headers.get('x-requested-with')).toBeNull()

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
        sso: { profileVerified: true, loginPath: '/login', logoutPath: '/logout' },
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
      details: { loginPath: '/login' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts a valid helper session when a stale same-name cookie follows it', async () => {
    const appConfig = config()
    const validHelperToken = await createCasSession(profile, appConfig)
    const cookie = [
      `${appConfig.cas.sessionCookie}=${encodeURIComponent(validHelperToken)}`,
      `${appConfig.cas.sessionCookie}=stale-session`,
      `${appConfig.legacySso.bridgeCookie}=legacy-session`,
    ].join('; ')
    const fetcher = fakeFetch((_url, init) => {
      expect(new Headers(init.headers).get('cookie')).toBe('user_token=legacy-session')
      return new Response('<span class="hidden-xs">hanada</span>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/session',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { user: { name: 'hanada' }, sso: { profileVerified: true } },
    })
  })

  it('prefers the helper bridge cookie over a stale original dnsmgr cookie', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((_url, init) => {
      expect(new Headers(init.headers).get('cookie')).toBe('user_token=bridge-session')
      return new Response('<span class="hidden-xs">hanada</span>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    })
    const app = await appWith(fetcher, appConfig)
    const cookie = [
      await authenticatedCookies(appConfig, 'bridge-session'),
      `${appConfig.legacySso.sessionCookie}=stale-session`,
    ].join('; ')

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/session',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { user: { name: 'hanada' } } })
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
        kw: 'example', aid: '7', type: 'cloudflare', status: '2',
      })

      return Response.json({
        total: '12',
        rows: [{
          id: '42', name: 'example.com', aid: '7', type: 'cloudflare',
          typename: 'Cloudflare', aremark: '主账号', recordcount: '18',
          addtime: '2025-02-03 04:05:06', regtime: '2024-01-02 03:04:05',
          expiretime: '2027-02-03 00:00:00', cid: '3',
          checkstatus: '1', is_notice: '1', is_hide: '0', is_sso: 0,
          category_name: '生产', remark: '主域名', password: 'must-not-leak',
        }],
      })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains?page=2&pageSize=10&q=example&accountId=7&provider=cloudflare&expiryStatus=expired&sort=recordCount&order=asc',
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
        registeredAt: '2024-01-02 03:04:05',
        expiresAt: '2027-02-03 00:00:00',
        expiryLookup: 'ready',
        noticeEnabled: true,
        hidden: false,
        ssoEnabled: false,
        categoryId: 3,
        category: '生产',
        remark: '主域名',
      }],
      meta: { page: 2, pageSize: 10, total: 12 },
    })
  })

  it.each([
    ['registeredAt', 'regtime'],
    ['noticeEnabled', 'is_notice'],
    ['hidden', 'is_hide'],
    ['domainLoginEnabled', 'is_sso'],
    ['provider', 'typename'],
    ['category', 'category_name'],
    ['remark', 'remark'],
  ])('maps the domain %s sort key to %s', async (sort, legacySort) => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/domain/data')
      const form = new URLSearchParams(String(init.body))
      expect(form.get('sortName')).toBe(legacySort)
      return Response.json({ total: 0, rows: [] })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: `/api/web/v1/domains?sort=${sort}&order=desc`,
      headers: { cookie: await authenticatedCookies(appConfig, 'session') },
    })

    expect(response.statusCode).toBe(200)
  })

  it('reads and writes domain expiry reminder settings through fixed keys', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/domain/expirenotice')
      if (init.method === 'GET') {
        return new Response(`<input name="expire_noticedays" value="7,14">
          <select name="expire_notice_mail" default="1"></select>
          <select name="expire_notice_wxtpl" default="0"></select>
          <select name="expire_notice_tgbot" default="1"></select>
          <select name="expire_notice_webhook" default="0"></select>
          <select name="expire_notice_custom_webhook" default="1"></select>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        expire_noticedays: '3,10',
        expire_notice_mail: '0',
        expire_notice_wxtpl: '1',
        expire_notice_tgbot: '0',
        expire_notice_webhook: '1',
        expire_notice_custom_webhook: '0',
      })
      return Response.json({ code: 0, msg: '设置保存成功！' })
    })
    const app = await appWith(fetcher, appConfig)
    const headers = { cookie: await authenticatedCookies(appConfig, 'session') }
    const read = await app.inject({ method: 'GET', url: '/api/web/v1/domains/expiry-settings', headers })
    expect(read.statusCode).toBe(200)
    expect(read.json()).toEqual({
      code: 'OK',
      data: {
        reminderDays: [7, 14],
        notifications: { email: true, wechat: false, telegram: true, robotWebhook: false, customWebhook: true },
      },
    })

    const write = await app.inject({
      method: 'PUT', url: '/api/web/v1/domains/expiry-settings', headers,
      payload: {
        reminderDays: [3, 10],
        notifications: { email: false, wechat: true, telegram: false, robotWebhook: true, customWebhook: false },
      },
    })
    expect(write.statusCode).toBe(200)
    expect(write.json()).toEqual({ code: 'OK', message: '设置保存成功！' })
  })

  it('applies stable paging when a DNS provider returns a client-side array', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/record/data/9')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toMatchObject({
        offset: '2', limit: '2', sortName: 'Name', sortOrder: 'asc', groupid: 'group-1', status: '1',
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
      url: '/api/web/v1/domains/9/records?page=2&pageSize=2&groupId=group-1&status=enabled',
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

describe('full legacy operation bridge', () => {
  it('forwards an allowlisted action with validated path parameters and PHP form encoding', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/record/batch/42')
      const headers = new Headers(init.headers)
      expect(headers.get('cookie')).toBe('user_token=legacy-operation-session')
      expect(headers.get('x-requested-with')).toBe('XMLHttpRequest')
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({
        action: 'group',
        groupid: '7',
      })
      expect(new URLSearchParams(String(init.body)).getAll('recordids[]')).toEqual(['r-1', 'r-2'])
      return Response.json({ code: 0, msg: '成功移动2条解析记录' })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/v1/actions/records.batchOperate',
      headers: { cookie: await authenticatedCookies(appConfig, 'legacy-operation-session') },
      payload: {
        path: { domainId: 42 },
        form: { action: 'group', groupid: 7, recordids: ['r-1', 'r-2'] },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: null,
      message: '成功移动2条解析记录',
    })
  })

  it('rejects unknown actions and invalid dynamic ids before contacting dnsmgr', async () => {
    const appConfig = config()
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher, appConfig)
    const cookie = await authenticatedCookies(appConfig)

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/web/v1/actions/not.registered',
      headers: { cookie },
      payload: {},
    })
    const invalidId = await app.inject({
      method: 'POST',
      url: '/api/web/v1/actions/records.create',
      headers: { cookie },
      payload: { path: { domainId: '../login' }, form: {} },
    })
    const inheritedName = await app.inject({
      method: 'POST',
      url: '/api/web/v1/actions/toString',
      headers: { cookie },
      payload: {},
    })

    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ code: 'ACTION_NOT_FOUND' })
    expect(invalidId.statusCode).toBe(422)
    expect(invalidId.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(inheritedName.statusCode).toBe(404)
    expect(inheritedName.json()).toMatchObject({ code: 'ACTION_NOT_FOUND' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('maps a legacy business failure to the stable API error envelope', async () => {
    const appConfig = config()
    const app = await appWith(fakeFetch(() => Response.json({
      code: -1,
      msg: '该分类下存在域名，无法删除',
    })), appConfig)

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/v1/actions/domainCategories.delete',
      headers: { cookie: await authenticatedCookies(appConfig) },
      payload: { form: { id: 3 } },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({
      code: 'OPERATION_FAILED',
      message: '该分类下存在域名，无法删除',
      details: { upstreamCode: -1 },
    })
  })
})

describe('typed domain management API', () => {
  it('normalizes domain-account rows without leaking provider credentials', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/account/data')
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        offset: '0',
        limit: '10',
        sortName: 'name',
        sortOrder: 'asc',
        kw: 'cloud',
      })
      return Response.json({
        total: 1,
        rows: [{
          id: 7,
          type: 'cloudflare',
          typename: 'Cloudflare',
          icon: 'cloudflare.ico',
          name: 'admin@example.test',
          config: '{"api_token":"must-not-leak"}',
          remark: '生产',
          addtime: '2026-08-31 12:00:00',
        }],
      })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domain-accounts?pageSize=10&q=cloud&sort=name&order=asc',
      headers: { cookie: await authenticatedCookies(appConfig) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: [{
        id: 7,
        provider: { type: 'cloudflare', label: 'Cloudflare', icon: 'cloudflare.ico' },
        name: 'admin@example.test',
        remark: '生产',
        addedAt: '2026-08-31 12:00:00',
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(response.body).not.toContain('must-not-leak')
    expect(response.body).not.toContain('config')
  })

  it('translates account creation into the exact validated legacy JSON config form', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/account/add')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toEqual({
        type: 'cloudflare',
        name: 'admin@example.test',
        config: '{"email":"admin@example.test","api_token":"secret","proxy":"0"}',
        remark: '生产',
      })
      return Response.json({ code: 0, msg: '添加域名账户成功！' })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/v1/domain-accounts',
      headers: { cookie: await authenticatedCookies(appConfig) },
      payload: {
        providerType: 'cloudflare',
        name: 'admin@example.test',
        config: { email: 'admin@example.test', api_token: 'secret', proxy: '0' },
        remark: '生产',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ code: 'OK', message: '添加域名账户成功！' })
  })

  it('merges a partial domain patch with current state before calling the legacy edit action', async () => {
    const appConfig = config()
    let requestNumber = 0
    const fetcher = fakeFetch((url, init) => {
      requestNumber += 1
      if (requestNumber === 1) {
        expect(url.pathname).toBe('/internal/domain/data')
        return Response.json({ total: 1, rows: [{
          id: 42,
          aid: 7,
          cid: 3,
          name: 'example.com',
          type: 'cloudflare',
          typename: 'Cloudflare',
          recordcount: 2,
          is_hide: 0,
          is_sso: 1,
          is_notice: 1,
          expiretime: '2027-01-01 00:00:00',
          remark: '原备注',
          checkstatus: 1,
        }] })
      }
      expect(url.pathname).toBe('/internal/domain/op/act/edit')
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
        id: '42',
        is_hide: '1',
        is_sso: '1',
        is_notice: '1',
        cid: '3',
        expiretime: '2027-01-01 00:00:00',
        remark: '原备注',
      })
      return Response.json({ code: 0, msg: '修改域名配置成功！' })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/web/v1/domains/42',
      headers: { cookie: await authenticatedCookies(appConfig) },
      payload: { hidden: true },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ code: 'OK', message: '修改域名配置成功！' })
    expect(requestNumber).toBe(2)
  })

  it('normalizes domain categories and translates assignment arrays', async () => {
    const appConfig = config()
    let requestNumber = 0
    const fetcher = fakeFetch((url, init) => {
      requestNumber += 1
      if (requestNumber === 1) {
        expect(url.pathname).toBe('/internal/domain/category/data')
        return Response.json({
          total: 1,
          rows: [{ id: 3, name: '生产', sort: 10, domain_count: 4, remark: '线上', addtime: '2026-01-01' }],
        })
      }
      expect(url.pathname).toBe('/internal/domain/setcategory')
      const form = new URLSearchParams(String(init.body))
      expect(form.getAll('ids[]')).toEqual(['42', '43'])
      expect(form.get('cid')).toBe('3')
      return Response.json({ code: 0, msg: '成功设置2个域名的分类！' })
    })
    const app = await appWith(fetcher, appConfig)
    const cookie = await authenticatedCookies(appConfig)

    const list = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domain-categories?pageSize=20',
      headers: { cookie },
    })
    const assignment = await app.inject({
      method: 'PATCH',
      url: '/api/web/v1/domain-category-assignment',
      headers: { cookie },
      payload: { ids: [42, 43], categoryId: 3 },
    })

    expect(list.json()).toEqual({
      code: 'OK',
      data: [{ id: 3, name: '生产', sort: 10, domainCount: 4, remark: '线上', addedAt: '2026-01-01' }],
      meta: { page: 1, pageSize: 20, total: 1 },
    })
    expect(assignment.json()).toEqual({ code: 'OK', message: '成功设置2个域名的分类！' })
  })
})

describe('typed record management API', () => {
  it('loads domain context for a domain-scoped session through its authorized record page', async () => {
    const appConfig = config()
    let requestNumber = 0
    const fetcher = fakeFetch((url, init) => {
      requestNumber += 1
      if (requestNumber === 1) {
        expect(url.pathname).toBe('/internal/domain/data')
        expect(init.method).toBe('POST')
        return Response.json({ total: 0, rows: [] })
      }

      expect(url.pathname).toBe('/internal/record/42')
      const headers = new Headers(init.headers)
      expect(headers.get('accept')).toBe('text/html, application/xhtml+xml')
      expect(headers.get('x-requested-with')).toBeNull()
      return new Response(`<html><head><title>解析管理 - example.com</title></head><body><script>
        var recordLine = [{"id":"0","name":"默认"}];
        var dnsconfig = {"type":"cloudflare","name":"Cloudflare"};
      </script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains/42',
      headers: { cookie: await authenticatedCookies(appConfig) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: {
        id: 42,
        name: 'example.com',
        provider: { type: 'cloudflare', label: 'Cloudflare' },
        recordCount: 0,
        expiryLookup: 'unknown',
        noticeEnabled: false,
        hidden: false,
        ssoEnabled: true,
      },
    })
    expect(requestNumber).toBe(2)
  })

  it('loads versioned record-page state in document mode and exposes stable capabilities', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/record/42')
      const headers = new Headers(init.headers)
      expect(headers.get('accept')).toBe('text/html, application/xhtml+xml')
      expect(headers.get('x-requested-with')).toBeNull()
      return new Response(`<html><input name="ttl" value="600" min="1"><script>
        var recordLine = [{"id":"0","name":"默认","parent":""}];
        var dnsconfig = {"type":"cloudflare","remark":1,"status":true,"redirect":true,"log":true,"weight":false,"page":true,"sort":false};
      </script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains/42/record-options',
      headers: { cookie: await authenticatedCookies(appConfig) },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      code: 'OK',
      data: {
        providerType: 'cloudflare',
        minTtl: 1,
        lines: [{ id: '0', label: '默认' }],
        capabilities: { redirectRecords: true, customHostnames: true, clientPaging: true },
      },
    })
  })

  it('maps stable record creation and batch editing to provider-compatible legacy forms', async () => {
    const appConfig = config()
    let requestNumber = 0
    const fetcher = fakeFetch((url, init) => {
      requestNumber += 1
      const form = new URLSearchParams(String(init.body))
      if (requestNumber === 1) {
        expect(url.pathname).toBe('/internal/record/add/42')
        expect(Object.fromEntries(form)).toEqual({
          name: 'www', type: 'A', value: '192.0.2.1', line: '0', ttl: '600',
          mx: '1', weight: '0', remark: 'web',
        })
        return Response.json({ code: 0, msg: '添加解析记录成功！' })
      }
      expect(url.pathname).toBe('/internal/record/batchedit/42')
      expect(form.get('action')).toBe('line')
      expect(form.get('line')).toBe('oversea')
      expect(JSON.parse(String(form.get('recordinfo')))).toEqual([{
        RecordId: 'r1', Name: 'www', Type: 'A', Value: '192.0.2.1', Line: '0',
        TTL: 600, MX: 1, Weight: 0, Remark: 'web',
      }])
      return Response.json({ code: 0, msg: '批量修改解析线路，成功1条，失败0条' })
    })
    const app = await appWith(fetcher, appConfig)
    const cookie = await authenticatedCookies(appConfig)

    const create = await app.inject({
      method: 'POST',
      url: '/api/web/v1/domains/42/records',
      headers: { cookie },
      payload: {
        name: 'www', type: 'a', value: '192.0.2.1', lineId: '0',
        ttl: 600, mxPriority: 1, weight: 0, remark: 'web',
      },
    })
    const batch = await app.inject({
      method: 'POST',
      url: '/api/web/v1/domains/42/records/batch',
      headers: { cookie },
      payload: {
        action: 'line',
        lineId: 'oversea',
        records: [{
          id: 'r1', name: 'www', type: 'A', value: '192.0.2.1', lineId: '0',
          ttl: 600, mxPriority: 1, weight: 0, remark: 'web',
        }],
      },
    })

    expect(create.json()).toEqual({ code: 'OK', message: '添加解析记录成功！' })
    expect(batch.json()).toEqual({ code: 'OK', message: '批量修改解析线路，成功1条，失败0条' })
  })

  it('preserves the deleted record snapshot so dnsmgr can write a complete audit log', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/record/delete/42')
      const form = new URLSearchParams(String(init.body))
      expect(form.get('recordid')).toBe('r1')
      expect(JSON.parse(String(form.get('recordinfo')))).toEqual({
        RecordId: 'r1', Name: 'www', Type: 'A', Value: ['192.0.2.1', '192.0.2.2'], Line: '0',
        TTL: 600, MX: 1, Weight: 0, Remark: 'web',
      })
      return Response.json({ code: 0, msg: '删除解析记录成功！' })
    })
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/web/v1/domains/42/records/r1',
      headers: { cookie: await authenticatedCookies(appConfig) },
      payload: {
        current: {
          id: 'r1', name: 'www', type: 'A', value: '192.0.2.1,192.0.2.2',
          values: ['192.0.2.1', '192.0.2.2'], lineId: '0',
          ttl: 600, mxPriority: 1, weight: 0, remark: 'web',
        },
      },
    })

    expect(response.json()).toEqual({ code: 'OK', message: '删除解析记录成功！' })
  })

  it('rejects malformed typed record writes before any upstream request', async () => {
    const appConfig = config()
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher, appConfig)

    const response = await app.inject({
      method: 'POST',
      url: '/api/web/v1/domains/42/records',
      headers: { cookie: await authenticatedCookies(appConfig) },
      payload: { name: 'www', type: 'A', value: '', lineId: '0', ttl: 0, unexpected: true },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('normalizes groups, provider logs, weighted sets and aliases through typed routes', async () => {
    const appConfig = config()
    const fetcher = fakeFetch((url, init) => {
      if (url.pathname === '/internal/record/groups/42') {
        return Response.json({ code: 0, data: [{ id: '', name: '全部记录' }, { id: 'g1', name: '生产(2)' }] })
      }
      if (url.pathname === '/internal/record/log/42') {
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ offset: '0', limit: '10' })
        return Response.json({ total: 1, rows: [{ time: '2026-08-31 12:00:00', data: '<b>更新记录</b>' }] })
      }
      if (url.pathname === '/internal/record/weight/data/42') {
        return Response.json({ total: 1, rows: [{
          id: 'set-1', rr: 'www', SubDomain: 'www.example.com', Type: 'A',
          RecordCount: 2, Open: 1,
          LineAlgorithms: { LineAlgorithm: [{ Line: '0', Open: 1 }, { Line: 'oversea', Open: 0 }] },
        }] })
      }
      if (url.pathname === '/internal/record/alias/42' && url.searchParams.get('act') === null) {
        expect(new Headers(init.headers).get('x-requested-with')).toBeNull()
        return new Response(`<html><table><tr data-id="8"><td>alias.example.com</td><td>正常</td><td>删除</td></tr></table></html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (url.pathname === '/internal/record/weight/42/act/update') {
        const form = new URLSearchParams(String(init.body))
        expect(form.get('subdomain')).toBe('www')
        expect(form.get('status')).toBe('1')
        expect(form.getAll('weight[r1]')).toEqual(['60'])
        expect(form.getAll('weight[r2]')).toEqual(['40'])
        return Response.json({ code: 0, msg: '成功修改2条解析记录权重' })
      }
      if (url.pathname === '/internal/record/alias/42' && url.searchParams.get('act') === 'add') {
        expect(new URLSearchParams(String(init.body)).get('alias')).toBe('new.example.com')
        return Response.json({ code: 0, msg: '添加域名别名成功' })
      }
      throw new Error(`unexpected request: ${url.href}`)
    })
    const app = await appWith(fetcher, appConfig)
    const cookie = await authenticatedCookies(appConfig)

    const groups = await app.inject({
      method: 'GET', url: '/api/web/v1/domains/42/record-groups', headers: { cookie },
    })
    const logs = await app.inject({
      method: 'GET', url: '/api/web/v1/domains/42/record-logs?pageSize=10', headers: { cookie },
    })
    const weights = await app.inject({
      method: 'GET', url: '/api/web/v1/domains/42/weighted-records?pageSize=10', headers: { cookie },
    })
    const aliases = await app.inject({
      method: 'GET', url: '/api/web/v1/domains/42/aliases', headers: { cookie },
    })
    const updateWeights = await app.inject({
      method: 'PUT',
      url: '/api/web/v1/domains/42/weighted-records',
      headers: { cookie },
      payload: {
        subdomain: 'www', type: 'A', lineId: '0', enabled: true,
        weights: { r1: 60, r2: 40 },
      },
    })
    const addAlias = await app.inject({
      method: 'POST',
      url: '/api/web/v1/domains/42/aliases',
      headers: { cookie },
      payload: { name: 'new.example.com' },
    })

    expect(groups.json()).toEqual({
      code: 'OK', data: [{ id: '', name: '全部记录' }, { id: 'g1', name: '生产(2)' }],
    })
    expect(logs.json()).toEqual({
      code: 'OK',
      data: [{ time: '2026-08-31 12:00:00', action: '更新记录' }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(weights.json()).toEqual({
      code: 'OK',
      data: [{
        id: 'www.example.com:A', lookupName: 'www', subdomain: 'www.example.com', type: 'A',
        recordCount: 2, enabled: true,
        lineAlgorithms: [{ lineId: '0', enabled: true }, { lineId: 'oversea', enabled: false }],
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(aliases.json()).toEqual({
      code: 'OK', data: [{ id: 8, name: 'alias.example.com', status: 'active' }],
    })
    expect(updateWeights.json()).toEqual({ code: 'OK', message: '成功修改2条解析记录权重' })
    expect(addAlias.json()).toEqual({ code: 'OK', message: '添加域名别名成功' })
  })
})
