import type { FastifyRequest } from 'fastify'

import type { AppConfig } from './config.js'
import { parseCookieHeader, singleCookieHeader } from './auth/cookies.js'
import { DNSMGR_BRIDGE_COOKIE, DNSMGR_SESSION_COOKIE } from './dnsmgr-constants.js'
import type { RequestContext } from './upstream/client.js'

export function upstreamRequestMetadata(request: FastifyRequest): RequestContext {
  return {
    forwardedFor: request.ip,
    ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
    requestId: request.id,
    logger: request.log,
  }
}

export function upstreamContext(request: FastifyRequest, config: AppConfig): RequestContext {
  const cookies = parseCookieHeader(request.headers.cookie)
  const legacyToken = cookies.get(DNSMGR_BRIDGE_COOKIE)
    ?? cookies.get(DNSMGR_SESSION_COOKIE)
  return {
    ...upstreamRequestMetadata(request),
    ...(legacyToken
      ? { cookie: singleCookieHeader(DNSMGR_SESSION_COOKIE, legacyToken) }
      : {}),
  }
}
