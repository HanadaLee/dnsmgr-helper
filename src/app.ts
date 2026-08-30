import helmet from '@fastify/helmet'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'

import { getDomain, listDomains, listRecords } from './adapters/v1051/domains.js'
import { sessionFromUpstream } from './adapters/v1051/session.js'
import { casLoginUrl, casLogoutUrl, CasClient, safeReturnTo } from './auth/cas-client.js'
import { createCasSession, verifyCasProfile } from './auth/cas.js'
import { serializeHttpOnlyCookie } from './auth/cookies.js'
import { LegacySsoService } from './auth/legacy-sso.js'
import { loadConfig, type AppConfig } from './config.js'
import type { CasProfile } from './contracts.js'
import { DatabaseClient } from './database/client.js'
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
const AuthQuerySchema = z.object({ returnTo: z.string().optional() })
const CallbackQuerySchema = z.object({
  ticket: z.string().trim().min(1).max(2048),
  returnTo: z.string().optional(),
})

function redirect(reply: FastifyReply, location: string) {
  return reply.code(302).header('location', location).send()
}

function cookieOptions(config: AppConfig, maxAge: number) {
  return {
    maxAge,
    secure: config.cas.cookieSecure,
    sameSite: config.cas.cookieSameSite,
    ...(config.cas.cookieDomain ? { domain: config.cas.cookieDomain } : {}),
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? await loadConfig()
  const app = Fastify({
    logger: options.logger ?? config.server.environment !== 'test',
    trustProxy: true,
  })
  const client = new DnsmgrClient(config, options.fetcher)
  const casClient = new CasClient(config, options.fetcher)
  const legacySso = new LegacySsoService(config, client)
  const database = new DatabaseClient(config.database)
  const casProfiles = new WeakMap<object, CasProfile | undefined>()

  await app.register(helmet, {
    contentSecurityPolicy: false,
  })

  app.addHook('onClose', async () => database.close())

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/web/')
      || request.url.startsWith('/cas/')
      || request.url.startsWith('/login')
      || request.url.startsWith('/logout')) {
      reply.header('cache-control', 'private, no-store')
      reply.header('vary', 'Cookie')
    }
  })

  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/api/web/v1/')) return
    if (request.url.startsWith('/api/web/v1/compatibility')) return
    if (config.upstream.version !== ADAPTER_VERSION) {
      throw new ApiError(
        503,
        'UPSTREAM_VERSION_UNSUPPORTED',
        `当前 helper 不支持 dnsmgr ${config.upstream.version}`,
        { supportedVersions: [ADAPTER_VERSION] },
      )
    }

    const profile = await verifyCasProfile(request.headers.cookie, config)
    casProfiles.set(request, profile)
    if (config.cas.enabled && !profile) throw authenticationError(config)
  })

  app.get('/healthz', async () => ({
    code: 'OK',
    data: {
      service: 'dnsmgr-helper',
      adapter: `v${ADAPTER_VERSION}`,
      casEnabled: config.cas.enabled,
      databaseEnabled: database.enabled,
    },
  }))

  app.get('/readyz', async (_request, reply) => {
    const databaseStatus = await database.status()
    if (databaseStatus.enabled && !databaseStatus.connected) {
      app.log.warn({ error: databaseStatus.error }, 'database readiness check failed')
      reply.code(503)
    }
    return {
      code: databaseStatus.enabled && !databaseStatus.connected ? 'NOT_READY' : 'OK',
      data: {
        service: 'dnsmgr-helper',
        database: {
          enabled: databaseStatus.enabled,
          connected: databaseStatus.connected,
        },
      },
    }
  })

  app.get('/api/web/v1/compatibility', async () => ({
    code: 'OK',
    data: {
      configuredUpstreamVersion: config.upstream.version,
      adapter: `v${ADAPTER_VERSION}`,
      supported: config.upstream.version === ADAPTER_VERSION,
      features: {
        session: true,
        domainsRead: true,
        recordsRead: true,
        domainDetailRead: true,
        mutations: false,
        databaseAccess: database.enabled,
      },
      sso: {
        owner: config.cas.enabled ? 'dnsmgr-helper' : 'disabled',
        casEnabled: config.cas.enabled,
      },
    },
  }))

  const loginHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = AuthQuerySchema.parse(request.query)
    return redirect(reply, casLoginUrl(config, safeReturnTo(query.returnTo)).href)
  }

  const callbackHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = CallbackQuerySchema.parse(request.query)
    const returnTo = safeReturnTo(query.returnTo)
    const profile = await casClient.validate(query.ticket, returnTo)
    const legacyToken = await legacySso.loginOrRegister(profile)
    const helperSession = await createCasSession(profile, config)
    const sessionMaxAge = config.cas.sessionTtlSeconds

    reply.header('set-cookie', [
      serializeHttpOnlyCookie(
        config.cas.sessionCookie,
        helperSession,
        cookieOptions(config, sessionMaxAge),
      ),
      serializeHttpOnlyCookie(
        config.legacySso.sessionCookie,
        legacyToken,
        cookieOptions(config, sessionMaxAge),
      ),
    ])
    return redirect(reply, returnTo)
  }

  const logoutHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('set-cookie', [
      serializeHttpOnlyCookie(config.cas.sessionCookie, '', cookieOptions(config, 0)),
      serializeHttpOnlyCookie(config.legacySso.sessionCookie, '', cookieOptions(config, 0)),
    ])
    if (!config.cas.enabled) return redirect(reply, config.cas.logoutRedirectPath)
    return redirect(reply, casLogoutUrl(config).href)
  }

  app.get(config.cas.loginPath, loginHandler)
  app.get(config.cas.callbackPath, callbackHandler)
  app.get(config.cas.logoutPath, logoutHandler)
  if (config.cas.loginPath !== '/login') app.get('/login', loginHandler)
  if (config.cas.loginPath !== '/cas/register') app.get('/cas/register', loginHandler)
  if (config.cas.logoutPath !== '/logout') app.get('/logout', logoutHandler)

  app.get('/api/web/v1/session', async (request) => {
    const context = upstreamContext(request, config)
    const upstream = await client.get('/', context)
    const casProfile = casProfiles.get(request)
    return {
      code: 'OK',
      data: sessionFromUpstream(upstream, casProfile, config),
    }
  })

  app.get('/api/web/v1/domains', async (request) => {
    const result = await listDomains(client, config, upstreamContext(request, config), request.query)
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/domains/:domainId', async (request) => {
    const params = z.object({ domainId: z.coerce.number().int().positive() }).parse(request.params)
    const result = await getDomain(client, config, upstreamContext(request, config), params.domainId)
    return { code: 'OK', data: result }
  })

  app.get('/api/web/v1/domains/:domainId/records', async (request) => {
    const params = z.object({ domainId: z.coerce.number().int().positive() }).parse(request.params)
    const result = await listRecords(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  registerErrorHandler(app)
  return app
}
