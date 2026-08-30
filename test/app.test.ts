import { SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadConfig, type AppConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

function config(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DNSMGR_UPSTREAM_URL: 'http://legacy.test/internal/',
    DNSMGR_UPSTREAM_HOST: 'dns.internal.test',
    DNSMGR_UPSTREAM_VERSION: '1051',
    DNSMGR_CAS_LOGIN_PATH: '/sso/login',
    DNSMGR_CAS_LOGOUT_PATH: '/sso/logout',
    DNSMGR_REQUIRE_CAS_JWT: 'false',
    ...overrides,
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

describe('service endpoints', () => {
  it('reports health without contacting dnsmgr', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher)

    const response = await app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: { service: 'dnsmgr-helper', adapter: 'v1051' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('turns an upstream login redirect into a JSON 401', async () => {
    const app = await appWith(fakeFetch(() => new Response(null, {
      status: 302,
      headers: { location: '/login' },
    })))

    const response = await app.inject({ method: 'GET', url: '/api/web/v1/session' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { loginPath: '/sso/login' },
    })
    expect(response.headers['cache-control']).toBe('private, no-store')
  })

  it('reports but refuses an unsupported configured upstream version', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher, config({ DNSMGR_UPSTREAM_VERSION: '9999' }))

    const compatibility = await app.inject({
      method: 'GET',
      url: '/api/web/v1/compatibility',
    })
    const domains = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains',
      headers: { cookie: 'user_token=session' },
    })

    expect(compatibility.statusCode).toBe(200)
    expect(compatibility.json()).toMatchObject({
      data: {
        configuredUpstreamVersion: '9999',
        adapter: 'v1051',
        supported: false,
      },
    })
    expect(domains.statusCode).toBe(503)
    expect(domains.json()).toMatchObject({
      code: 'UPSTREAM_VERSION_UNSUPPORTED',
      details: { supportedVersions: ['1051'] },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('session compatibility', () => {
  it('requires a working dnsmgr cookie and enriches it with a verified CAS profile', async () => {
    const secret = 'unit-test-cas-secret-at-least-32-bytes'
    const token = await new SignJWT({
      name: 'hanada',
      email: 'hanada@example.test',
      display_name: 'Hanada',
      avatar: 'https://cdn.example.test/avatar.png',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(secret))

    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/')
      const headers = new Headers(init.headers)
      expect(headers.get('cookie')).toContain('user_token=legacy-session')
      expect(headers.get('host')).toBe('dns.internal.test')

      return new Response(`
        <html><body>
          <span class="hidden-xs">legacy-admin</span>
          <small>2025-01-02 03:04:05</small>
          <a href="/">后台首页</a>
          <a href="/domain">域名管理</a>
          <a href="/account">域名账户</a>
          <a href="/domain/category">域名分类</a>
          <a href="/dmonitor/overview">容灾切换</a>
          <a href="/schedule/stask">定时切换</a>
          <a href="/cert/certorder">证书</a>
          <a href="/optimizeip/opiplist">优选</a>
          <a href="/system/cronset">设置</a>
          <a href="/user">用户</a>
          <a href="/log">日志</a>
          <a href="/setpwd">密码</a>
          <script src="//auth.example.test/app/dnsmgr.php?ver=1051"></script>
        </body></html>
      `, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    const app = await appWith(fetcher, config({
      DNSMGR_CAS_JWT_SECRET: secret,
      DNSMGR_REQUIRE_CAS_JWT: 'true',
    }))

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/session',
      headers: { cookie: `user_token=legacy-session; resty_cas_jwt=${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      code: 'OK',
      data: {
        authenticated: true,
        user: {
          name: 'hanada',
          displayName: 'Hanada',
          email: 'hanada@example.test',
          type: 'user',
        },
        capabilities: { dashboard: true, domains: true, systemSettings: true },
        sso: { profileVerified: true, loginPath: '/sso/login', logoutPath: '/sso/logout' },
        upstream: { configuredVersion: '1051', detectedVersion: '1051', adapter: 'v1051' },
      },
    })
  })

  it('rejects a valid legacy cookie when enforced CAS proof is missing', async () => {
    const secret = 'unit-test-cas-secret-at-least-32-bytes'
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await appWith(fetcher, config({
      DNSMGR_CAS_JWT_SECRET: secret,
      DNSMGR_REQUIRE_CAS_JWT: 'true',
    }))

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains',
      headers: { cookie: 'user_token=still-valid' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { loginPath: '/sso/login' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('v1051 list translation', () => {
  it('maps stable domain query names to the legacy form and normalizes rows', async () => {
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/domain/data')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toMatchObject({
        offset: '10',
        limit: '10',
        sortName: 'recordcount',
        sortOrder: 'asc',
        kw: 'example',
        type: 'cloudflare',
        status: '2',
      })

      return Response.json({
        total: '12',
        rows: [{
          id: '42',
          name: 'example.com',
          aid: '7',
          type: 'cloudflare',
          typename: 'Cloudflare',
          aremark: '主账号',
          recordcount: '18',
          addtime: '2025-02-03 04:05:06',
          expiretime: '2027-02-03 00:00:00',
          checkstatus: '1',
          is_notice: '1',
          is_hide: '0',
          is_sso: 0,
          category_name: '生产',
          remark: '主域名',
          password: 'must-not-leak',
          api_token: 'must-not-leak',
        }],
      })
    })
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains?page=2&pageSize=10&q=example&provider=cloudflare&expiryStatus=expired&sort=recordCount&order=asc',
      headers: { cookie: 'user_token=session' },
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
    const fetcher = fakeFetch((url, init) => {
      expect(url.pathname).toBe('/internal/record/data/9')
      const form = new URLSearchParams(String(init.body))
      expect(Object.fromEntries(form)).toMatchObject({
        offset: '2',
        limit: '2',
        sortName: 'Name',
        sortOrder: 'asc',
        status: '1',
      })

      return Response.json([
        { RecordId: 'r1', Name: '@', Type: 'A', Value: '192.0.2.1', Line: '0', LineName: '默认', TTL: 600, Status: '1' },
        { RecordId: 'r2', Name: 'www', Type: 'CNAME', Value: 'example.com', Line: '0', LineName: '默认', TTL: 600, Status: '1' },
        { RecordId: 'r3', Name: 'mail', Type: 'MX', Value: 'mx.example.com', Line: '0', LineName: '默认', TTL: '300', MX: '10', Status: '1' },
        { RecordId: 'r4', Name: '_verify', Type: 'TXT', Value: 'value', Line: 'oversea', LineName: '境外', Status: '0' },
      ])
    })
    const app = await appWith(fetcher)

    const response = await app.inject({
      method: 'GET',
      url: '/api/web/v1/domains/9/records?page=2&pageSize=2&status=enabled',
      headers: { cookie: 'user_token=session' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      code: 'OK',
      data: [
        {
          id: 'r3',
          name: 'mail',
          type: 'MX',
          value: 'mx.example.com',
          line: { id: '0', label: '默认' },
          ttl: 300,
          mxPriority: 10,
          status: 'enabled',
        },
        {
          id: 'r4',
          name: '_verify',
          type: 'TXT',
          value: 'value',
          line: { id: 'oversea', label: '境外' },
          status: 'disabled',
        },
      ],
      meta: { page: 2, pageSize: 2, total: 4 },
    })
  })
})
