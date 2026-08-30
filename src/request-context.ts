import type { FastifyRequest } from 'fastify'

import type { RequestContext } from './upstream/client.js'

export function upstreamContext(request: FastifyRequest): RequestContext {
  return {
    ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
    forwardedFor: request.ip,
  }
}
