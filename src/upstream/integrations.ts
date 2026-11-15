import type { FastifyInstance } from 'fastify'

import type { AppConfig } from '../config.js'
import { upstreamRequestMetadata } from '../request-context.js'
import type { DnsmgrClient } from './client.js'

// These fixed endpoints authenticate at dnsmgr using API keys or signed bodies,
// not browser sessions. Never re-encode a QQ callback: its signature covers bytes.
export async function registerIntegrations(app: FastifyInstance, client: DnsmgrClient, config: AppConfig) {
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json')
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => done(null, body))
    for (const path of ['/mcp', '/qqbot/webhook'] as const) {
      scope.route({
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        url: path,
        handler: async (request, reply) => {
          if (path === '/mcp' && request.headers.origin) {
            let allowed = false
            try { allowed = new URL(request.headers.origin).origin === config.server.publicUrl.origin } catch { /* invalid origins are denied */ }
            if (!allowed) return reply.code(403).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed' } })
          }
          const headers = new Headers()
          for (const name of ['content-type', 'accept', ...(path === '/mcp'
            ? ['authorization', 'mcp-protocol-version', 'mcp-session-id']
            : ['x-bot-appid', 'x-signature-timestamp', 'x-signature-ed25519'])]) {
            const value = request.headers[name]
            if (typeof value === 'string') headers.set(name, value)
          }
          const result = await client.integrationRequest(path, {
            method: request.method,
            headers,
            ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: typeof request.body === 'string' ? request.body : '' }),
          }, upstreamRequestMetadata(request))
          reply.code(result.status).header('content-type', result.contentType || 'text/plain; charset=utf-8').header('cache-control', 'private, no-store')
          for (const name of ['www-authenticate', 'allow', 'retry-after', 'mcp-session-id']) {
            const value = result.headers.get(name)
            if (value) reply.header(name, value)
          }
          return reply.send(result.text)
        },
      })
    }
  })
}
