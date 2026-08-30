import { describe, expect, it, vi } from 'vitest'

import { parseConfig } from '../src/config.js'
import { DnsmgrClient, type FetchLike, type UpstreamLogger } from '../src/upstream/client.js'

describe('dnsmgr upstream logging', () => {
  it('logs request metadata and response status without credentials or cookie values', async () => {
    const entries: Array<{ bindings: Record<string, unknown>; message: string }> = []
    const logger: UpstreamLogger = {
      info: (bindings, message) => entries.push({ bindings, message }),
      warn: (bindings, message) => entries.push({ bindings, message }),
    }
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('cookie')).toBe('user_token=sensitive-session')
      expect(headers.get('x-requested-with')).toBe('XMLHttpRequest')
      expect(headers.get('accept')).toBe('application/json, text/html;q=0.9')
      return new Response('', {
        status: 302,
        headers: {
          location: '/login',
          'set-cookie': 'user_token=replacement-session; Path=/',
        },
      })
    }) as unknown as FetchLike
    const config = parseConfig({
      server: {
        environment: 'test',
        host: '127.0.0.1',
        port: 19102,
        publicUrl: 'https://dns.test/',
      },
      upstream: { url: 'http://127.0.0.1:19101/' },
      cas: { enabled: false },
      legacySso: {},
      database: { enabled: false },
    })
    const client = new DnsmgrClient(config, fetcher)

    await client.postForm(
      '/login',
      new URLSearchParams({ username: 'hanada', password: 'managed-secret' }),
      {
        cookie: 'user_token=sensitive-session',
        requestId: 'req-test',
        logger,
      },
    )

    expect(entries).toEqual([
      {
        message: 'dnsmgr upstream request',
        bindings: {
          parentRequestId: 'req-test',
          method: 'POST',
          path: '/login',
          upstreamHost: '127.0.0.1:19101',
          hasSessionCookie: true,
          requestMode: 'ajax',
        },
      },
      {
        message: 'dnsmgr upstream response',
        bindings: expect.objectContaining({
          parentRequestId: 'req-test',
          method: 'POST',
          path: '/login',
          requestMode: 'ajax',
          statusCode: 302,
          redirectPath: '/login',
          setCookieCount: 1,
        }),
      },
    ])
    const renderedLogs = JSON.stringify(entries)
    expect(renderedLogs).not.toContain('managed-secret')
    expect(renderedLogs).not.toContain('sensitive-session')
    expect(renderedLogs).not.toContain('replacement-session')
  })

  it('requests HTML documents without marking them as AJAX', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(init?.method).toBe('GET')
      expect(headers.get('accept')).toBe('text/html, application/xhtml+xml')
      expect(headers.get('x-requested-with')).toBeNull()
      expect(headers.get('cookie')).toBe('user_token=legacy-session')
      return new Response('<html>dashboard</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }) as unknown as FetchLike
    const config = parseConfig({
      server: {
        environment: 'test',
        host: '127.0.0.1',
        port: 19102,
        publicUrl: 'https://dns.test/',
      },
      upstream: { url: 'http://127.0.0.1:19101/' },
      cas: { enabled: false },
      legacySso: {},
      database: { enabled: false },
    })
    const client = new DnsmgrClient(config, fetcher)

    const result = await client.getHtml('/', { cookie: 'user_token=legacy-session' })

    expect(result.status).toBe(200)
    expect(result.contentType).toContain('text/html')
  })
})
