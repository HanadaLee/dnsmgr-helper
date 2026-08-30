import helmet from '@fastify/helmet'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'

import { sessionFromUpstream } from './adapters/v1051/session.js'
import { getDomain, listDomains, listRecords } from './adapters/v1051/domains.js'
import { verifyCasProfile } from './auth/cas.js'
import { loadConfig, type AppConfig } from './config.js'
import type { CasProfile } from './contracts.js'
import { ApiError, registerErrorHandler } from './errors.js'
import { upstreamContext } from './request-context.js'
import { DnsmgrClient, type FetchLike } from './upstream/client.js'
import { authenticationError } from './upstream/legacy.js'

export type BuildAppOptions = {
  config?: AppConfig
  fetcher?: FetchLike
  logger?: boolean
}

const ADAPTER_VERSION = '1051'

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== 'test',
    trustProxy: true,
  })
  const client = new DnsmgrClient(config, options.fetcher)
  const casProfiles = new WeakMap<object, CasProfile | undefined>()

  await app.register(helmet, {
    contentSecurityPolicy: false,
  })

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/web/')) {
      reply.header('cache-control', 'private, no-store')
      reply.header('vary', 'Cookie')
    }
  })

  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/web/v1/')) return
    if (request.url.startsWith('/api/web/v1/compatibility')) return
    if (config.upstreamVersion !== ADAPTER_VERSION) {
      throw new ApiError(
        503,
        'UPSTREAM_VERSION_UNSUPPORTED',
        `当前 helper 不支持 dnsmgr ${config.upstreamVersion}`,
        { supportedVersions: [ADAPTER_VERSION] },
      )
    }

    const profile = await verifyCasProfile(request.headers.cookie, config)
    casProfiles.set(request, profile)
    if (config.requireCasJwt && !profile) throw authenticationError(config)
  })

  app.get('/healthz', async () => ({
    code: 'OK',
    data: {
      service: 'dnsmgr-helper',
      adapter: `v${ADAPTER_VERSION}`,
    },
  }))

  app.get('/api/web/v1/compatibility', async () => ({
    code: 'OK',
    data: {
      configuredUpstreamVersion: config.upstreamVersion,
      adapter: `v${ADAPTER_VERSION}`,
      supported: config.upstreamVersion === ADAPTER_VERSION,
      features: {
        session: true,
        domainsRead: true,
        recordsRead: true,
        domainDetailRead: true,
        mutations: false,
      },
      sso: {
        casJwtEnforced: config.requireCasJwt,
      },
    },
  }))

  app.get('/api/web/v1/session', async (request) => {
    const context = upstreamContext(request)
    const upstream = await client.get('/', context)
    const casProfile = casProfiles.get(request)
    return {
      code: 'OK',
      data: sessionFromUpstream(upstream, casProfile, config),
    }
  })

  app.get('/api/web/v1/domains', async (request) => {
    const result = await listDomains(client, config, upstreamContext(request), request.query)
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/domains/:domainId', async (request) => {
    const params = z.object({ domainId: z.coerce.number().int().positive() }).parse(request.params)
    const result = await getDomain(client, config, upstreamContext(request), params.domainId)
    return { code: 'OK', data: result }
  })

  app.get('/api/web/v1/domains/:domainId/records', async (request) => {
    const params = z.object({ domainId: z.coerce.number().int().positive() }).parse(request.params)
    const result = await listRecords(
      client,
      config,
      upstreamContext(request),
      params.domainId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  registerErrorHandler(app)
  return app
}
