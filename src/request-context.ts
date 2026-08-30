import type { FastifyRequest } from 'fastify'

import type { AppConfig } from './config.js'
import { parseCookieHeader, singleCookieHeader } from './auth/cookies.js'
import type { RequestContext } from './upstream/client.js'

export function upstreamContext(request: FastifyRequest, config: AppConfig): RequestContext {
  const legacyToken = parseCookieHeader(request.headers.cookie)
    .get(config.legacySso.sessionCookie)
  return {
    ...(legacyToken
      ? { cookie: singleCookieHeader(config.legacySso.sessionCookie, legacyToken) }
      : {}),
    forwardedFor: request.ip,
  }
}
