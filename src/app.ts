import helmet from '@fastify/helmet'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  createDomainAccount,
  deleteDomainAccount,
  getDnsProviderDefinitions,
  getDomainAccount,
  listAvailableDomains,
  listDomainAccounts,
  updateDomainAccount,
} from './adapters/v1051/accounts.js'
import {
  assignDomainCategory,
  batchDeleteDomains,
  batchImportDomains,
  batchSetDomainNotice,
  batchUpdateDomainRemark,
  createDomain,
  createDomainCategory,
  deleteDomain,
  deleteDomainCategory,
  listDomainCategories,
  queueDomainExpiryRefresh,
  refreshDomainExpiry,
  updateDomain,
  updateDomainCategory,
} from './adapters/v1051/domain-actions.js'
import { getDomain, listDomains, listRecords } from './adapters/v1051/domains.js'
import { executeLegacyOperation, listLegacyOperations } from './adapters/v1051/operations.js'
import {
  batchOperateRecords,
  bulkCreateRecords,
  checkRecord,
  createDomainAlias,
  createRecord,
  deleteDomainAlias,
  deleteRecord,
  getRecordOptions,
  listDomainAliases,
  listRecordGroups,
  listRecordLogs,
  listWeightedRecordSets,
  lookupRecords,
  quickEditRecordByName,
  setRecordRemark,
  setRecordStatus,
  setWeightedRecordStatus,
  updateRecord,
  updateWeightedRecordSet,
} from './adapters/v1051/record-actions.js'
import { sessionFromUpstream } from './adapters/v1051/session.js'
import { casLoginUrl, casLogoutUrl, CasClient, safeReturnTo } from './auth/cas-client.js'
import { createCasSession, verifyCasSession } from './auth/cas.js'
import { cookieValues, serializeHttpOnlyCookie } from './auth/cookies.js'
import { LegacySsoService } from './auth/legacy-sso.js'
import { loadConfig, type AppConfig } from './config.js'
import type { CasProfile } from './contracts.js'
import { DatabaseClient } from './database/client.js'
import { ApiError, registerErrorHandler } from './errors.js'
import { upstreamContext, upstreamRequestMetadata } from './request-context.js'
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
const DomainIdParamsSchema = z.object({ domainId: z.coerce.number().int().positive() })
const AccountIdParamsSchema = z.object({ accountId: z.coerce.number().int().positive() })
const CategoryIdParamsSchema = z.object({ categoryId: z.coerce.number().int().positive() })
const RecordIdParamsSchema = z.object({
  domainId: z.coerce.number().int().positive(),
  recordId: z.string().trim().min(1).max(1024),
})
const AliasIdParamsSchema = z.object({
  domainId: z.coerce.number().int().positive(),
  aliasId: z.coerce.number().int().positive(),
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
        `当前服务不支持 dnsmgr ${config.upstream.version}`,
        { supportedVersions: [ADAPTER_VERSION] },
      )
    }

    const verification = await verifyCasSession(request.headers.cookie, config)
    const profile = verification.status === 'valid' ? verification.profile : undefined
    casProfiles.set(request, profile)
    if (config.cas.enabled && !profile) {
      request.log.warn({
        casSessionStatus: verification.status,
        helperSessionCookieCount: verification.candidateCount,
        bridgeSessionCookiePresent:
          cookieValues(request.headers.cookie, config.legacySso.bridgeCookie).length > 0,
        legacySessionCookiePresent:
          cookieValues(request.headers.cookie, config.legacySso.sessionCookie).length > 0,
      }, 'CAS session cookie rejected')
      throw authenticationError(config, 'helper-session')
    }
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
        domainAccountsTyped: true,
        domainCategoriesTyped: true,
        domainMutationsTyped: true,
        recordMutationsTyped: true,
        advancedRecordsTyped: true,
        actionTransport: true,
        actionCount: listLegacyOperations().length,
        databaseAccess: database.enabled,
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
    const legacyToken = await legacySso.loginOrRegister(profile, upstreamRequestMetadata(request))
    const helperSession = await createCasSession(profile, config)
    const sessionMaxAge = config.cas.sessionTtlSeconds

    reply.header('set-cookie', [
      serializeHttpOnlyCookie(
        config.cas.sessionCookie,
        helperSession,
        cookieOptions(config, sessionMaxAge),
      ),
      serializeHttpOnlyCookie(
        config.legacySso.bridgeCookie,
        legacyToken,
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
      serializeHttpOnlyCookie(config.legacySso.bridgeCookie, '', cookieOptions(config, 0)),
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
    const upstream = await client.getHtml('/', context)
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

  app.post('/api/web/v1/domains', async (request) => ({
    code: 'OK',
    ...await createDomain(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/domains/import', async (request) => ({
    code: 'OK',
    ...await batchImportDomains(client, config, upstreamContext(request, config), request.body),
  }))

  app.patch('/api/web/v1/domains/batch-remark', async (request) => ({
    code: 'OK',
    ...await batchUpdateDomainRemark(client, config, upstreamContext(request, config), request.body),
  }))

  app.patch('/api/web/v1/domains/batch-notice', async (request) => ({
    code: 'OK',
    ...await batchSetDomainNotice(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/domains/batch-delete', async (request) => ({
    code: 'OK',
    ...await batchDeleteDomains(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/domains/expiry-refresh', async (request) => ({
    code: 'OK',
    ...await queueDomainExpiryRefresh(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/domains/:domainId', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const result = await getDomain(client, config, upstreamContext(request, config), params.domainId)
    return { code: 'OK', data: result }
  })

  app.patch('/api/web/v1/domains/:domainId', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateDomain(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/domains/:domainId', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteDomain(client, config, upstreamContext(request, config), params.domainId),
    }
  })

  app.post('/api/web/v1/domains/:domainId/refresh-expiry', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await refreshDomainExpiry(client, config, upstreamContext(request, config), params.domainId),
    }
  })

  app.get('/api/web/v1/domains/:domainId/records', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const result = await listRecords(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/domains/:domainId/record-options', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const data = await getRecordOptions(client, config, upstreamContext(request, config), params.domainId)
    return { code: 'OK', data }
  })

  app.get('/api/web/v1/domains/:domainId/record-lookup', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const data = await lookupRecords(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
      request.query,
    )
    return { code: 'OK', data }
  })

  app.post('/api/web/v1/domains/:domainId/records', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await createRecord(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/domains/:domainId/records/bulk', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await bulkCreateRecords(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/domains/:domainId/records/batch', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await batchOperateRecords(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.patch('/api/web/v1/domains/:domainId/records/by-name', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await quickEditRecordByName(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/domains/:domainId/record-groups', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const data = await listRecordGroups(client, config, upstreamContext(request, config), params.domainId)
    return { code: 'OK', data }
  })

  app.get('/api/web/v1/domains/:domainId/record-logs', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const result = await listRecordLogs(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/domains/:domainId/weighted-records', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const result = await listWeightedRecordSets(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.put('/api/web/v1/domains/:domainId/weighted-records', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateWeightedRecordSet(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.patch('/api/web/v1/domains/:domainId/weighted-records/status', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setWeightedRecordStatus(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/domains/:domainId/aliases', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const data = await listDomainAliases(client, config, upstreamContext(request, config), params.domainId)
    return { code: 'OK', data }
  })

  app.post('/api/web/v1/domains/:domainId/aliases', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await createDomainAlias(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/domains/:domainId/aliases/:aliasId', async (request) => {
    const params = AliasIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteDomainAlias(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.aliasId,
      ),
    }
  })

  app.patch('/api/web/v1/domains/:domainId/records/:recordId', async (request) => {
    const params = RecordIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateRecord(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.recordId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/domains/:domainId/records/:recordId', async (request) => {
    const params = RecordIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteRecord(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.recordId,
      ),
    }
  })

  app.patch('/api/web/v1/domains/:domainId/records/:recordId/status', async (request) => {
    const params = RecordIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setRecordStatus(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.recordId,
        request.body,
      ),
    }
  })

  app.patch('/api/web/v1/domains/:domainId/records/:recordId/remark', async (request) => {
    const params = RecordIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setRecordRemark(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.recordId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/domains/:domainId/records/:recordId/check', async (request) => {
    const params = RecordIdParamsSchema.parse(request.params)
    const data = await checkRecord(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
      params.recordId,
      request.body,
    )
    return { code: 'OK', data }
  })

  app.get('/api/web/v1/domain-account-providers', async (request) => {
    const data = await getDnsProviderDefinitions(client, config, upstreamContext(request, config))
    return { code: 'OK', data }
  })

  app.get('/api/web/v1/domain-accounts', async (request) => {
    const result = await listDomainAccounts(client, config, upstreamContext(request, config), request.query)
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/domain-accounts', async (request) => ({
    code: 'OK',
    ...await createDomainAccount(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/domain-accounts/:accountId/available-domains', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    const result = await listAvailableDomains(
      client,
      config,
      upstreamContext(request, config),
      params.accountId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/domain-accounts/:accountId', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    const data = await getDomainAccount(client, config, upstreamContext(request, config), params.accountId)
    return { code: 'OK', data }
  })

  app.put('/api/web/v1/domain-accounts/:accountId', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateDomainAccount(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/domain-accounts/:accountId', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteDomainAccount(client, config, upstreamContext(request, config), params.accountId),
    }
  })

  app.get('/api/web/v1/domain-categories', async (request) => {
    const result = await listDomainCategories(client, config, upstreamContext(request, config), request.query)
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/domain-categories', async (request) => ({
    code: 'OK',
    ...await createDomainCategory(client, config, upstreamContext(request, config), request.body),
  }))

  app.put('/api/web/v1/domain-categories/:categoryId', async (request) => {
    const params = CategoryIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateDomainCategory(
        client,
        config,
        upstreamContext(request, config),
        params.categoryId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/domain-categories/:categoryId', async (request) => {
    const params = CategoryIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteDomainCategory(
        client,
        config,
        upstreamContext(request, config),
        params.categoryId,
      ),
    }
  })

  app.patch('/api/web/v1/domain-category-assignment', async (request) => ({
    code: 'OK',
    ...await assignDomainCategory(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/actions', async () => ({
    code: 'OK',
    data: listLegacyOperations(),
  }))

  app.post('/api/web/v1/actions/:operationId', async (request) => {
    const params = z.object({ operationId: z.string().trim().min(1).max(128) }).parse(request.params)
    const result = await executeLegacyOperation(
      client,
      config,
      upstreamContext(request, config),
      params.operationId,
      request.body,
    )
    return { code: 'OK', ...result }
  })

  registerErrorHandler(app)
  return app
}
