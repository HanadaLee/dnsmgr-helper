import type { FastifyRequest } from 'fastify'

import type { AppConfig } from './config.js'
import { parseCookieHeader, singleCookieHeader } from './auth/cookies.js'
import type { RequestContext } from './upstream/client.js'

export function upstreamRequestMetadata(request: FastifyRequest): RequestContext {
  return {
    forwardedFor: request.ip,
    requestId: request.id,
    logger: request.log,
  }
}

export function upstreamContext(request: FastifyRequest, config: AppConfig): RequestContext {
  const cookies = parseCookieHeader(request.headers.cookie)
  const legacyToken = cookies.get(config.legacySso.bridgeCookie)
    ?? cookies.get(config.legacySso.sessionCookie)
  return {
    ...upstreamRequestMetadata(request),
    ...(legacyToken
      ? { cookie: singleCookieHeader(config.legacySso.sessionCookie, legacyToken) }
      : {}),
  }
}
