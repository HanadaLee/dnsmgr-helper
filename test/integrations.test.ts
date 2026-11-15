import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })

async function integrationApp(handler: (url: URL, init: RequestInit) => Response) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {}))
  const config = parseConfig({ server: { environment: 'test', publicUrl: 'https://dns.test/' },
    upstream: { url: 'http://legacy.test/internal/' }, cas: { enabled: false }, legacySso: {}, database: {} })
  const app = await buildApp({ config, fetcher: fetcher as FetchLike, logger: false })
  apps.push(app)
  return { app, fetcher }
}

describe('original dnsmgr integration endpoints', () => {
  it('preserves the exact signed QQ callback body and signature headers, without browser cookies', async () => {
    const raw = '{ "op": 0, "d": { "text": "测试消息" } }\n'
    const { app } = await integrationApp((url, init) => {
      expect(url.pathname).toBe('/internal/qqbot/webhook')
      expect(init.body).toBe(raw)
      const headers = new Headers(init.headers)
      expect(headers.get('x-bot-appid')).toBe('app-id')
      expect(headers.get('x-signature-timestamp')).toBe('1234567890')
      expect(headers.get('x-signature-ed25519')).toBe('signature')
      expect(headers.has('cookie')).toBe(false)
      expect(headers.has('authorization')).toBe(false)
      return new Response('invalid signature', { status: 401 })
    })
    const result = await app.inject({ method: 'POST', url: '/qqbot/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-bot-appid': 'app-id', 'x-signature-timestamp': '1234567890',
        'x-signature-ed25519': 'signature', cookie: 'user_token=do-not-forward', authorization: 'do-not-forward' } })
    expect(result.statusCode).toBe(401)
    expect(result.body).toBe('invalid signature')
    expect(result.headers['cache-control']).toBe('private, no-store')
  })

  it('relays QQ challenge validation and MCP JSON bodies without re-encoding', async () => {
    const { app } = await integrationApp((url, init) => {
      if (url.pathname.endsWith('/qqbot/webhook')) return Response.json({ plain_token: 'challenge', signature: 'signed' })
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer 12:secret')
      expect(init.body).toBe('{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }')
      return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } })
    })
    expect((await app.inject({ method: 'POST', url: '/qqbot/webhook', payload: { op: 13, d: { plain_token: 'challenge' } } })).json())
      .toEqual({ plain_token: 'challenge', signature: 'signed' })
    const result = await app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json',
      authorization: 'Bearer 12:secret', origin: 'https://dns.test' }, payload: '{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }' })
    expect(result.statusCode).toBe(200)
    expect(result.json().result.protocolVersion).toBe('2025-03-26')
  })

  it('leaves MCP authentication and method failures to the original middleware', async () => {
    const { app } = await integrationApp((_url, init) => new Response('{"jsonrpc":"2.0","error":{"code":-32001}}', {
      status: new Headers(init.headers).has('authorization') ? 405 : 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="dnsmgr-mcp"', allow: 'POST' },
    }))
    const unauthenticated = await app.inject({ method: 'POST', url: '/mcp', payload: {} })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.headers['www-authenticate']).toBe('Bearer realm="dnsmgr-mcp"')
    const get = await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer 12:secret' } })
    expect(get.statusCode).toBe(405)
    expect(get.headers.allow).toBe('POST')
  })

  it.each(['https://evil.test', 'null', 'https://dns.test.evil.test', 'http://dns.test'])('rejects a foreign MCP Origin before upstream access: %s', async (origin) => {
    const { app, fetcher } = await integrationApp(() => Response.json({}))
    expect((await app.inject({ method: 'POST', url: '/mcp', headers: { origin }, payload: {} })).statusCode).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not change normal browser JSON parsing or create an arbitrary proxy', async () => {
    const { app, fetcher } = await integrationApp(() => Response.json({ code: 0 }))
    expect((await app.inject({ method: 'POST', url: '/qqbot/other', payload: {} })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/web/v1/certificate-deployments', payload: {} })).statusCode).toBe(422)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
