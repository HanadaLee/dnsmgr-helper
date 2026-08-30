import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

function testConfig() {
  return parseConfig({
    server: { environment: 'test', publicUrl: 'https://dns.test/' },
    upstream: { url: 'http://legacy.test/internal/' },
    cas: { enabled: false },
    legacySso: {},
    database: {},
  })
}

function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    return handler(url, init ?? {})
  }) as FetchLike
}

async function appWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const app = await buildApp({ config: testConfig(), fetcher: fakeFetch(handler), logger: false })
  apps.push(app)
  return app
}

function json(value: unknown) {
  return Response.json(value)
}

function form(init: RequestInit) {
  return new URLSearchParams(String(init.body))
}

const headers = { cookie: 'user_token=legacy-cloudflare-session' }

const hostnameRow = {
  id: 'host-1',
  hostname: 'app.example.com',
  custom_origin_server: 'origin.example.com',
  status: 'active',
  ssl_status: 'pending_validation',
  ssl_method: 'txt',
  ssl_min_tls_version: '1.2',
  ssl_type: 'dv',
  ssl_validation_status: 'pending',
  verification_status: 'pending',
  created_on: '2026-08-31T00:00:00Z',
  validation_errors: 'ownership failed | certificate pending',
  ownership_verification: {
    type: 'txt', name: '_cf-custom-hostname.app.example.com', value: 'ownership-token', status: 'pending',
  },
  ownership_verification_http: { http_url: 'http://app.example.com/.well-known/cf', http_body: 'body-token' },
  ssl_validation_records: [{
    status: 'pending', txt_name: '_acme-challenge.app.example.com', txt_value: 'ssl-token',
    cname_name: '', cname_target: '', http_url: '', http_body: '', emails: ['admin@example.com'],
  }],
}

describe('typed Cloudflare API', () => {
  it('covers custom hostnames, verification targets, fallback, DCV and DNS line metadata', async () => {
    const mutationPaths: string[] = []
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/cloudflare/hostnames/data/42') {
        return json({ code: 0, total: 1, rows: [hostnameRow] })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/add/42') {
        mutationPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({
          hostname: 'app.example.com', custom_origin_server: 'origin.example.com',
          ssl_method: 'txt', min_tls_version: '1.2',
        })
        return json({ code: 0, msg: '创建成功', data: hostnameRow })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/update/42') {
        mutationPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({
          hostname_id: 'host-1', custom_origin_server: '', ssl_method: 'http', min_tls_version: '1.3',
        })
        return json({ code: 0, msg: '更新成功', data: { ...hostnameRow, custom_origin_server: '', ssl_method: 'http' } })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/refresh/42') {
        mutationPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({ hostname_id: 'host-1' })
        return json({ code: 0, msg: '已刷新', data: hostnameRow })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/delete/42') {
        mutationPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({ hostname_id: 'host-1', hostname: 'app.example.com' })
        return json({ code: 0, msg: '删除成功' })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/batch_add/42') {
        mutationPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({
          hostnames: 'app.example.com\napi.example.com', custom_origin_server: '',
          ssl_method: 'txt', min_tls_version: '1.0',
        })
        return json({ code: 0, msg: '批量添加成功' })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/batch_update/42') {
        mutationPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({
          hostname_ids: 'host-1,host-2', custom_origin_server: 'origin.example.com',
          ssl_method: '', min_tls_version: '1.2',
        })
        return json({ code: 0, msg: '批量修改成功' })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/batch_delete/42') {
        mutationPaths.push(url.pathname)
        expect(form(init).getAll('hostname_ids[]')).toEqual(['host-1', 'host-2'])
        return json({ code: 0, msg: '批量删除成功' })
      }
      if (url.pathname === '/internal/cloudflare/hostnames/txttargets/42') {
        expect(form(init).get('hostname')).toBe('_acme-challenge.app.example.com')
        return json({ code: 0, data: {
          hostname: '_acme-challenge.app.example.com',
          candidates: [{
            domain_id: 42, domain_name: 'example.com', record_name: '_acme-challenge.app',
            account_id: 7, account_type: 'cloudflare', account_type_name: 'Cloudflare',
            account_display_name: '生产账户', is_current_domain: true,
          }],
        } })
      }
      if (url.pathname === '/internal/cloudflare/fallback/get/42') {
        return json({ code: 0, data: { origin: 'fallback.example.com' } })
      }
      if (url.pathname === '/internal/cloudflare/fallback/set/42') {
        expect(form(init).get('origin')).toBe('new-origin.example.com')
        return json({ code: 0, msg: 'Fallback 已更新', data: { origin: 'new-origin.example.com' } })
      }
      if (url.pathname === '/internal/cloudflare/fallback/delete/42') {
        return json({ code: 0, msg: 'Fallback 已清空' })
      }
      if (url.pathname === '/internal/cloudflare/dcv_delegation_uuid/42') {
        return json({ code: 0, data: { uuid: '12345678-abcd-ef00-1234-56789abcdef0' } })
      }
      if (url.pathname === '/internal/cloudflare/get_domain_default_line') {
        expect(form(init).get('domain_id')).toBe('42')
        return json({ code: 0, data: {
          default_line: '0',
          lines: [
            { value: '0', label: '默认', parent: '', is_default: true },
            { value: 'oversea', label: '境外', parent: 'region', is_default: false },
          ],
        } })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const list = await app.inject({
      method: 'GET', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames', headers,
    })
    const create = await app.inject({
      method: 'POST', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames', headers,
      payload: {
        hostname: 'app.example.com', customOrigin: 'origin.example.com',
        validationMethod: 'txt', minTlsVersion: '1.2',
      },
    })
    const update = await app.inject({
      method: 'PUT', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames/host-1', headers,
      payload: { customOrigin: null, validationMethod: 'http', minTlsVersion: '1.3' },
    })
    const refresh = await app.inject({
      method: 'POST', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames/host-1/refresh', headers,
    })
    const remove = await app.inject({
      method: 'DELETE', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames/host-1', headers,
      payload: { hostname: 'app.example.com' },
    })
    const batchAdd = await app.inject({
      method: 'POST', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames/batch-add', headers,
      payload: { hostnames: ['app.example.com', 'api.example.com'] },
    })
    const batchUpdate = await app.inject({
      method: 'PUT', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames/batch', headers,
      payload: { ids: ['host-1', 'host-2'], customOrigin: 'origin.example.com', minTlsVersion: '1.2' },
    })
    const batchDelete = await app.inject({
      method: 'POST', url: '/api/web/v1/cloudflare/domains/42/custom-hostnames/batch-delete', headers,
      payload: { ids: ['host-1', 'host-2'] },
    })
    const txtTargets = await app.inject({
      method: 'GET',
      url: '/api/web/v1/cloudflare/domains/42/txt-targets?hostname=_acme-challenge.app.example.com',
      headers,
    })
    const fallback = await app.inject({
      method: 'GET', url: '/api/web/v1/cloudflare/domains/42/fallback-origin', headers,
    })
    const fallbackSet = await app.inject({
      method: 'PUT', url: '/api/web/v1/cloudflare/domains/42/fallback-origin', headers,
      payload: { origin: 'new-origin.example.com' },
    })
    const fallbackDelete = await app.inject({
      method: 'DELETE', url: '/api/web/v1/cloudflare/domains/42/fallback-origin', headers,
    })
    const dcv = await app.inject({
      method: 'GET', url: '/api/web/v1/cloudflare/domains/42/dcv-delegation', headers,
    })
    const lines = await app.inject({
      method: 'GET', url: '/api/web/v1/cloudflare/domains/42/default-line', headers,
    })
    const invalidOrigin = await app.inject({
      method: 'PUT', url: '/api/web/v1/cloudflare/domains/42/fallback-origin', headers,
      payload: { origin: '192.0.2.10' },
    })

    expect(list.json()).toEqual({
      code: 'OK',
      data: [{
        id: 'host-1', hostname: 'app.example.com', customOrigin: 'origin.example.com', status: 'active',
        createdAt: '2026-08-31T00:00:00Z',
        validationErrors: ['ownership failed', 'certificate pending'],
        ownershipVerification: {
          type: 'txt', name: '_cf-custom-hostname.app.example.com', value: 'ownership-token',
          status: 'pending', httpUrl: 'http://app.example.com/.well-known/cf', httpBody: 'body-token',
        },
        ssl: {
          status: 'pending_validation', method: 'txt', minTlsVersion: '1.2', type: 'dv',
          validationStatus: 'pending',
          validationRecords: [{
            status: 'pending', txtName: '_acme-challenge.app.example.com', txtValue: 'ssl-token',
            emails: ['admin@example.com'],
          }],
        },
      }],
      meta: { page: 1, pageSize: 1, total: 1 },
    })
    expect(create.json()).toMatchObject({ code: 'OK', message: '创建成功', data: { id: 'host-1' } })
    expect(update.json()).toMatchObject({ code: 'OK', message: '更新成功', data: { ssl: { method: 'http' } } })
    expect(refresh.json()).toMatchObject({ code: 'OK', message: '已刷新', data: { id: 'host-1' } })
    for (const response of [remove, batchAdd, batchUpdate, batchDelete]) expect(response.statusCode).toBe(200)
    expect(txtTargets.json()).toEqual({
      code: 'OK', data: {
        hostname: '_acme-challenge.app.example.com',
        candidates: [{
          domainId: 42, domainName: 'example.com', recordName: '_acme-challenge.app', accountId: 7,
          accountType: 'cloudflare', accountTypeName: 'Cloudflare', accountDisplayName: '生产账户', currentDomain: true,
        }],
      },
    })
    expect(fallback.json()).toEqual({ code: 'OK', data: { origin: 'fallback.example.com' } })
    expect(fallbackSet.json()).toEqual({
      code: 'OK', message: 'Fallback 已更新', data: { origin: 'new-origin.example.com' },
    })
    expect(fallbackDelete.json()).toEqual({ code: 'OK', message: 'Fallback 已清空' })
    expect(dcv.json()).toEqual({ code: 'OK', data: { uuid: '12345678-abcd-ef00-1234-56789abcdef0' } })
    expect(lines.json()).toEqual({
      code: 'OK', data: {
        defaultLine: '0',
        lines: [
          { value: '0', label: '默认', default: true },
          { value: 'oversea', label: '境外', parent: 'region', default: false },
        ],
      },
    })
    expect(invalidOrigin.statusCode).toBe(422)
    expect(mutationPaths).toHaveLength(7)
  })

  it('covers Tunnel lifecycle, sensitive token, public hostnames, CIDR and hostname routes', async () => {
    const actionPaths: string[] = []
    const tunnel = {
      id: 'tunnel-1', name: 'edge-prod', status: 'healthy', connection_count: 2,
      created_at: '2026-08-01T00:00:00Z', deleted_at: '', conns_active_at: '2026-08-31T00:00:00Z',
    }
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/cloudflare/tunnels/data/7') {
        return json({ code: 0, total: 1, rows: [tunnel], account_id: 'cf-account-id' })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/add/7') {
        actionPaths.push(url.pathname)
        expect(form(init).get('name')).toBe('edge-prod')
        return json({ code: 0, msg: 'Tunnel 创建成功', data: tunnel })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/delete/7') {
        actionPaths.push(url.pathname)
        expect(form(init).get('tunnel_id')).toBe('tunnel-1')
        return json({ code: 0, msg: 'Tunnel 删除成功' })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/token/7') {
        expect(form(init).get('tunnel_id')).toBe('tunnel-1')
        return json({ code: 0, data: { token: 'secret-tunnel-token' } })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/publichostnames/data/7') {
        expect(form(init).get('tunnel_id')).toBe('tunnel-1')
        return json({ code: 0, total: 1, rows: [{
          hostname: 'app.example.com', path: '/api/*', service: 'http://127.0.0.1:8080',
          zone_name: 'example.com', zone_id: 'zone-1',
        }] })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/publichostnames/save/7') {
        actionPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({
          tunnel_id: 'tunnel-1', hostname: 'app.example.com', service: 'http://127.0.0.1:8080', path: '/api/*',
        })
        return json({ code: 0, msg: 'Public Hostname 保存成功' })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/publichostnames/delete/7') {
        actionPaths.push(url.pathname)
        expect(form(init).get('hostname')).toBe('app.example.com')
        return json({ code: 0, msg: 'Public Hostname 删除成功' })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/cidr/data/7') {
        return json({ code: 0, total: 1, rows: [{
          id: 'route-1', network: '10.0.0.0/8', comment: 'private', virtual_network_id: 'vn-1',
          tunnel_id: 'tunnel-1', created_at: '2026-08-31T00:00:00Z',
        }] })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/cidr/add/7') {
        actionPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({ tunnel_id: 'tunnel-1', network: '10.0.0.0/8', comment: 'private' })
        return json({ code: 0, msg: 'CIDR 创建成功', data: {
          id: 'route-1', network: '10.0.0.0/8', comment: 'private', tunnel_id: 'tunnel-1',
        } })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/cidr/delete/7') {
        actionPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({ tunnel_id: 'tunnel-1', route_id: 'route-1' })
        return json({ code: 0, msg: 'CIDR 删除成功' })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/hostnameroutes/data/7') {
        return json({ code: 0, total: 1, rows: [{
          id: 'hostname-route-1', hostname: 'internal.example.com', comment: 'private hostname',
          tunnel_id: 'tunnel-1', created_at: '2026-08-31T00:00:00Z',
        }] })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/hostnameroutes/add/7') {
        actionPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({
          tunnel_id: 'tunnel-1', hostname: 'internal.example.com', comment: 'private hostname',
        })
        return json({ code: 0, msg: '主机名路由创建成功', data: {
          id: 'hostname-route-1', hostname: 'internal.example.com', comment: 'private hostname', tunnel_id: 'tunnel-1',
        } })
      }
      if (url.pathname === '/internal/cloudflare/tunnels/hostnameroutes/delete/7') {
        actionPaths.push(url.pathname)
        expect(Object.fromEntries(form(init))).toEqual({ tunnel_id: 'tunnel-1', route_id: 'hostname-route-1' })
        return json({ code: 0, msg: '主机名路由删除成功' })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const base = '/api/web/v1/cloudflare/accounts/7/tunnels'
    const list = await app.inject({ method: 'GET', url: base, headers })
    const create = await app.inject({ method: 'POST', url: base, headers, payload: { name: 'edge-prod' } })
    const token = await app.inject({ method: 'GET', url: `${base}/tunnel-1/token`, headers })
    const publicList = await app.inject({ method: 'GET', url: `${base}/tunnel-1/public-hostnames`, headers })
    const publicSave = await app.inject({
      method: 'PUT', url: `${base}/tunnel-1/public-hostnames`, headers,
      payload: { hostname: 'app.example.com', service: 'http://127.0.0.1:8080', path: '/api/*' },
    })
    const publicDelete = await app.inject({
      method: 'DELETE', url: `${base}/tunnel-1/public-hostnames`, headers,
      payload: { hostname: 'app.example.com', path: '/api/*' },
    })
    const cidrList = await app.inject({ method: 'GET', url: `${base}/tunnel-1/cidr-routes`, headers })
    const cidrCreate = await app.inject({
      method: 'POST', url: `${base}/tunnel-1/cidr-routes`, headers,
      payload: { network: '10.0.0.0/8', comment: 'private' },
    })
    const cidrDelete = await app.inject({
      method: 'DELETE', url: `${base}/tunnel-1/cidr-routes`, headers, payload: { routeId: 'route-1' },
    })
    const hostnameRouteList = await app.inject({ method: 'GET', url: `${base}/tunnel-1/hostname-routes`, headers })
    const hostnameRouteCreate = await app.inject({
      method: 'POST', url: `${base}/tunnel-1/hostname-routes`, headers,
      payload: { hostname: 'internal.example.com', comment: 'private hostname' },
    })
    const hostnameRouteDelete = await app.inject({
      method: 'DELETE', url: `${base}/tunnel-1/hostname-routes`, headers,
      payload: { routeId: 'hostname-route-1' },
    })
    const remove = await app.inject({ method: 'DELETE', url: `${base}/tunnel-1`, headers })
    const invalidCidr = await app.inject({
      method: 'POST', url: `${base}/tunnel-1/cidr-routes`, headers,
      payload: { network: '10.0.0.0/99' },
    })

    expect(list.json()).toEqual({
      code: 'OK',
      data: [{
        id: 'tunnel-1', name: 'edge-prod', status: 'healthy', connectionCount: 2,
        createdAt: '2026-08-01T00:00:00Z', activeAt: '2026-08-31T00:00:00Z',
      }],
      meta: { page: 1, pageSize: 1, total: 1 },
    })
    expect(create.json()).toMatchObject({ code: 'OK', message: 'Tunnel 创建成功', data: { id: 'tunnel-1' } })
    expect(token.json()).toEqual({
      code: 'OK', data: {
        token: 'secret-tunnel-token', command: 'cloudflared tunnel run --token secret-tunnel-token',
      },
    })
    expect(publicList.json()).toMatchObject({
      code: 'OK', data: [{ hostname: 'app.example.com', zoneName: 'example.com', zoneId: 'zone-1' }],
    })
    expect(cidrList.json()).toMatchObject({
      code: 'OK', data: [{ id: 'route-1', network: '10.0.0.0/8', virtualNetworkId: 'vn-1' }],
    })
    expect(cidrCreate.json()).toMatchObject({ code: 'OK', data: { id: 'route-1', network: '10.0.0.0/8' } })
    expect(hostnameRouteList.json()).toMatchObject({
      code: 'OK', data: [{ id: 'hostname-route-1', hostname: 'internal.example.com' }],
    })
    expect(hostnameRouteCreate.json()).toMatchObject({
      code: 'OK', data: { id: 'hostname-route-1', hostname: 'internal.example.com' },
    })
    for (const response of [publicSave, publicDelete, cidrDelete, hostnameRouteDelete, remove]) {
      expect(response.statusCode).toBe(200)
    }
    expect(invalidCidr.statusCode).toBe(422)
    expect(actionPaths).toHaveLength(8)
  })
})
