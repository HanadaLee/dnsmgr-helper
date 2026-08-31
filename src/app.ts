import helmet from '@fastify/helmet'
import formbody from '@fastify/formbody'
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
import { clearDashboardCache, getDashboardOverview } from './adapters/v1051/dashboard.js'
import {
  createCertificateAccount,
  deleteCertificateAccount,
  getCertificateAccount,
  getCertificateAccountTypes,
  listCertificateAccounts,
  updateCertificateAccount,
} from './adapters/v1051/certificate-accounts.js'
import {
  checkCertificateCname,
  createCertificateCname,
  deleteCertificateCname,
  getCertificateCnameForm,
  listCertificateCnames,
  updateCertificateCname,
} from './adapters/v1051/certificate-cnames.js'
import {
  batchOperateCertificateDeployments,
  createCertificateDeployment,
  deleteCertificateDeployment,
  getCertificateDeployment,
  getCertificateDeploymentForm,
  getCertificateDeploymentLog,
  listCertificateDeployments,
  processCertificateDeployment,
  resetCertificateDeployment,
  setCertificateDeploymentStatus,
  updateCertificateDeployment,
} from './adapters/v1051/certificate-deployments.js'
import {
  batchOperateCertificateOrders,
  createCertificateOrder,
  deleteCertificateOrder,
  getCertificateArtifacts,
  getCertificateOrder,
  getCertificateOrderForm,
  getCertificateOrderLog,
  listCertificateOrders,
  processCertificateOrder,
  resetCertificateOrder,
  revokeCertificateOrder,
  setCertificateAutoRenew,
  updateCertificateOrder,
} from './adapters/v1051/certificate-orders.js'
import {
  getCertificateSettings,
  updateCertificateSettings,
} from './adapters/v1051/certificate-settings.js'
import {
  batchAddCloudflareCustomHostnames,
  batchDeleteCloudflareCustomHostnames,
  batchUpdateCloudflareCustomHostnames,
  createCloudflareCustomHostname,
  deleteCloudflareCustomHostname,
  deleteCloudflareFallbackOrigin,
  getCloudflareDcvDelegationUuid,
  getCloudflareDomainDefaultLine,
  getCloudflareFallbackOrigin,
  getCloudflareTxtTargets,
  listCloudflareCustomHostnames,
  refreshCloudflareCustomHostname,
  setCloudflareFallbackOrigin,
  updateCloudflareCustomHostname,
} from './adapters/v1051/cloudflare-hostnames.js'
import {
  createCloudflareTunnel,
  createCloudflareTunnelCidrRoute,
  createCloudflareTunnelHostnameRoute,
  deleteCloudflareTunnel,
  deleteCloudflareTunnelCidrRoute,
  deleteCloudflareTunnelHostnameRoute,
  deleteCloudflareTunnelPublicHostname,
  getCloudflareTunnelToken,
  listCloudflareTunnelCidrRoutes,
  listCloudflareTunnelHostnameRoutes,
  listCloudflareTunnelPublicHostnames,
  listCloudflareTunnels,
  saveCloudflareTunnelPublicHostname,
} from './adapters/v1051/cloudflare-tunnels.js'
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
  getDomainExpirySettings,
  listDomainCategories,
  queueDomainExpiryRefresh,
  refreshDomainExpiry,
  updateDomain,
  updateDomainCategory,
  updateDomainExpirySettings,
} from './adapters/v1051/domain-actions.js'
import { getDomain, listDomains, listRecords } from './adapters/v1051/domains.js'
import { listAuditLogs } from './adapters/v1051/logs.js'
import {
  batchOperateMonitoringTasks,
  cleanMonitoringLogs,
  createMonitoringTask,
  deleteMonitoringTask,
  getMonitoringForm,
  getMonitoringOverview,
  getMonitoringTask,
  getMonitoringWorkerStatus,
  listMonitoringTaskLogs,
  listMonitoringTasks,
  setMonitoringTaskStatus,
  updateMonitoringNotifications,
  updateMonitoringTask,
} from './adapters/v1051/monitoring.js'
import { executeLegacyOperation, listLegacyOperations } from './adapters/v1051/operations.js'
import {
  createOptimizeIpTask,
  deleteOptimizeIpTask,
  getOptimizeIpSettings,
  getOptimizeIpTask,
  getOptimizeIpTaskForm,
  getOptimizeIpWorkerStatus,
  listOptimizeIpTasks,
  queryOptimizeIpAccount,
  runOptimizeIpTask,
  setOptimizeIpTaskStatus,
  updateOptimizeIpSettings,
  updateOptimizeIpTask,
} from './adapters/v1051/optimize-ip.js'
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
import {
  batchOperateScheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  getScheduledTaskForm,
  listScheduledTasks,
  setScheduledTaskStatus,
  updateScheduledTask,
} from './adapters/v1051/schedules.js'
import { sessionFromUpstream } from './adapters/v1051/session.js'
import { getDashboardReleaseInfo } from './adapters/v1051/release-check.js'
import {
  bindTotp,
  changePassword,
  disableTotp,
  generateTotpEnrollment,
  getProfileSecurity,
  setLegacyTheme,
} from './adapters/v1051/profile.js'
import {
  forwardCron,
  forwardPublicApi,
  forwardQuickLogin,
  forwardWorkerStatus,
} from './adapters/v1051/public-compat.js'
import {
  getCronSettings,
  getLoginSettings,
  getNotificationSettings,
  getProxySettings,
  testNotification,
  testProxy,
  updateCronSettings,
  updateLoginSettings,
  updateNotificationSettings,
  updateProxySettings,
} from './adapters/v1051/system-settings.js'
import {
  createUser,
  deleteUser,
  getUser,
  getUserFormOptions,
  listUsers,
  setUserStatus,
  updateUser,
} from './adapters/v1051/users.js'
import { casLoginUrl, casLogoutUrl, CasClient, safeReturnTo } from './auth/cas-client.js'
import { createCasSession, createDomainSession, verifyCasSession } from './auth/cas.js'
import { cookieValues, serializeHttpOnlyCookie } from './auth/cookies.js'
import { LegacySsoService } from './auth/legacy-sso.js'
import { loadConfig, type AppConfig } from './config.js'
import type { CasProfile } from './contracts.js'
import { DatabaseClient } from './database/client.js'
import { ApiError, registerErrorHandler } from './errors.js'
import { upstreamContext, upstreamRequestMetadata } from './request-context.js'
import { DnsmgrClient, type FetchLike, type UpstreamResult } from './upstream/client.js'
import { authenticationError } from './upstream/legacy.js'

export type BuildAppOptions = {
  config?: AppConfig
  fetcher?: FetchLike
  logger?: boolean
}

export function requestUrlForLog(rawUrl: string | undefined): string {
  if (!rawUrl) return ''
  const queryAt = rawUrl.indexOf('?')
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)
  if (pathname === '/quicklogin' && queryAt !== -1) return '/quicklogin?[redacted]'
  return rawUrl.replace(/([?&]ticket=)[^&]*/gi, '$1[redacted]')
}

function requestLogSerializer(request: FastifyRequest) {
  return {
    method: request.method,
    url: requestUrlForLog(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.raw.socket.remotePort ?? 0,
  }
}

const ADAPTER_VERSION = '1051'
const AuthQuerySchema = z.object({ returnTo: z.string().optional() })
const CallbackQuerySchema = z.object({
  ticket: z.string().trim().min(1).max(2048),
  returnTo: z.string().optional(),
})
const DomainIdParamsSchema = z.object({ domainId: z.coerce.number().int().positive() })
const UserIdParamsSchema = z.object({ userId: z.coerce.number().int().positive() })
const PublicApiIdParamsSchema = z.object({ id: z.coerce.number().int().positive() })
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
const TaskIdParamsSchema = z.object({ taskId: z.coerce.number().int().positive() })
const CertificateOrderIdParamsSchema = z.object({ orderId: z.coerce.number().int().positive() })
const CertificateDeploymentIdParamsSchema = z.object({ deploymentId: z.coerce.number().int().positive() })
const CertificateCnameIdParamsSchema = z.object({ cnameId: z.coerce.number().int().positive() })
const CloudflareHostnameIdParamsSchema = z.object({
  domainId: z.coerce.number().int().positive(),
  hostnameId: z.string().trim().min(1).max(128),
})
const CloudflareTunnelIdParamsSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  tunnelId: z.string().trim().min(1).max(128),
})

function redirect(reply: FastifyReply, location: string) {
  return reply.code(302).header('location', location).send()
}

function relayUpstream(reply: FastifyReply, result: UpstreamResult) {
  reply.code(result.status)
  reply.header('content-type', result.contentType || 'text/plain; charset=utf-8')
  if (result.location) reply.header('location', result.location)
  return reply.send(result.text)
}

function upstreamCookieValue(result: UpstreamResult, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`(?:^|,\\s*)${escapedName}=([^;,]*)`, 'i')
  for (const setCookie of result.setCookies) {
    const value = expression.exec(setCookie)?.[1]
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

function isDomainLoginRedirect(location: string | undefined): boolean {
  if (!location) return false
  try {
    return /^\/record\/\d+\/?$/.test(new URL(location, 'https://dnsmgr.invalid').pathname)
  } catch {
    return false
  }
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
    logger: options.logger ?? (config.server.environment === 'test'
      ? false
      : { serializers: { req: requestLogSerializer } }),
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
  await app.register(formbody)

  app.addHook('onClose', async () => database.close())

  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')
      || request.url.startsWith('/cas/')
      || request.url.startsWith('/login')
      || request.url.startsWith('/logout')
      || request.url.startsWith('/quicklogin')) {
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
        monitoringTyped: true,
        schedulesTyped: true,
        optimizeIpTyped: true,
        certificatesTyped: true,
        cloudflareTyped: true,
        administrationTyped: true,
        publicApiCompatible: true,
        quickLoginCompatible: true,
        cronCompatible: true,
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
    let profile: CasProfile
    try {
      profile = await casClient.validate(query.ticket, returnTo)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CAS_TICKET_INVALID') {
        return redirect(reply, `/login?${new URLSearchParams({ returnTo })}`)
      }
      throw error
    }
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
  if (config.cas.logoutPath !== '/logout') app.get('/logout', logoutHandler)

  const publicApiContext = (request: FastifyRequest) => upstreamRequestMetadata(request)
  const relayPublicApi = async (
    request: FastifyRequest,
    reply: FastifyReply,
    path: string,
  ) => relayUpstream(
    reply,
    await forwardPublicApi(client, publicApiContext(request), path, request.body),
  )

  app.post('/api/domain', async (request, reply) => relayPublicApi(request, reply, '/api/domain'))
  app.post('/api/domain/:id', async (request, reply) => {
    const params = PublicApiIdParamsSchema.parse(request.params)
    return relayPublicApi(request, reply, `/api/domain/${params.id}`)
  })
  app.post('/api/record/data/:id', async (request, reply) => {
    const params = PublicApiIdParamsSchema.parse(request.params)
    return relayPublicApi(request, reply, `/api/record/data/${params.id}`)
  })
  for (const action of ['add', 'update', 'delete', 'status', 'remark', 'batch'] as const) {
    app.post(`/api/record/${action}/:id`, async (request, reply) => {
      const params = PublicApiIdParamsSchema.parse(request.params)
      return relayPublicApi(request, reply, `/api/record/${action}/${params.id}`)
    })
  }
  app.post('/api/cert/order', async (request, reply) => relayPublicApi(request, reply, '/api/cert/order'))

  app.get('/cron', async (request, reply) => relayUpstream(
    reply,
    await forwardCron(client, publicApiContext(request), request.query),
  ))
  app.get('/quicklogin', async (request, reply) => {
    const { domain, result } = await forwardQuickLogin(
      client,
      publicApiContext(request),
      request.query,
    )
    const legacyToken = isDomainLoginRedirect(result.location)
      ? upstreamCookieValue(result, config.legacySso.sessionCookie)
      : undefined
    if (legacyToken) {
      const maxAge = config.cas.sessionTtlSeconds
      const cookies = [
        serializeHttpOnlyCookie(
          config.legacySso.bridgeCookie,
          legacyToken,
          cookieOptions(config, maxAge),
        ),
        serializeHttpOnlyCookie(
          config.legacySso.sessionCookie,
          legacyToken,
          cookieOptions(config, maxAge),
        ),
      ]
      if (config.cas.enabled) {
        cookies.unshift(serializeHttpOnlyCookie(
          config.cas.sessionCookie,
          await createDomainSession(domain, config),
          cookieOptions(config, maxAge),
        ))
      }
      reply.header('set-cookie', cookies)
    }
    return relayUpstream(reply, result)
  })
  for (const path of ['/dmtask/status', '/optimizeip/status'] as const) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: path,
      handler: async (request, reply) => relayUpstream(
        reply,
        await forwardWorkerStatus(client, publicApiContext(request), path),
      ),
    })
  }

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

  app.get('/api/web/v1/domains/expiry-settings', async (request) => ({
    code: 'OK',
    data: await getDomainExpirySettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/domains/expiry-settings', async (request) => ({
    code: 'OK',
    ...await updateDomainExpirySettings(client, config, upstreamContext(request, config), request.body),
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
        request.body,
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

  app.get('/api/web/v1/monitoring/overview', async (request) => ({
    code: 'OK',
    data: await getMonitoringOverview(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/monitoring/worker-status', async (request) => ({
    code: 'OK',
    data: await getMonitoringWorkerStatus(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/monitoring/notifications', async (request) => ({
    code: 'OK',
    ...await updateMonitoringNotifications(
      client,
      config,
      upstreamContext(request, config),
      request.body,
    ),
  }))

  app.post('/api/web/v1/monitoring/logs/clean', async (request) => ({
    code: 'OK',
    ...await cleanMonitoringLogs(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/monitoring/form', async (request) => ({
    code: 'OK',
    data: await getMonitoringForm(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/monitoring/tasks', async (request) => {
    const result = await listMonitoringTasks(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/monitoring/tasks', async (request) => ({
    code: 'OK',
    ...await createMonitoringTask(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/monitoring/tasks/batch', async (request) => ({
    code: 'OK',
    ...await batchOperateMonitoringTasks(
      client,
      config,
      upstreamContext(request, config),
      request.body,
    ),
  }))

  app.get('/api/web/v1/monitoring/tasks/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getMonitoringTask(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
      ),
    }
  })

  app.put('/api/web/v1/monitoring/tasks/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateMonitoringTask(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/monitoring/tasks/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteMonitoringTask(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
      ),
    }
  })

  app.patch('/api/web/v1/monitoring/tasks/:taskId/status', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setMonitoringTaskStatus(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/monitoring/tasks/:taskId/logs', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    const result = await listMonitoringTaskLogs(
      client,
      config,
      upstreamContext(request, config),
      params.taskId,
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/schedules/form', async (request) => ({
    code: 'OK',
    data: await getScheduledTaskForm(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/schedules', async (request) => {
    const result = await listScheduledTasks(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/schedules', async (request) => ({
    code: 'OK',
    ...await createScheduledTask(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/schedules/batch', async (request) => ({
    code: 'OK',
    ...await batchOperateScheduledTasks(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/schedules/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getScheduledTask(client, config, upstreamContext(request, config), params.taskId),
    }
  })

  app.put('/api/web/v1/schedules/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateScheduledTask(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/schedules/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteScheduledTask(client, config, upstreamContext(request, config), params.taskId),
    }
  })

  app.patch('/api/web/v1/schedules/:taskId/status', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setScheduledTaskStatus(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/optimize-ip/settings', async (request) => ({
    code: 'OK',
    data: await getOptimizeIpSettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/optimize-ip/settings', async (request) => ({
    code: 'OK',
    ...await updateOptimizeIpSettings(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/optimize-ip/account-balance', async (request) => ({
    code: 'OK',
    ...await queryOptimizeIpAccount(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/optimize-ip/form', async (request) => ({
    code: 'OK',
    data: await getOptimizeIpTaskForm(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/optimize-ip/worker-status', async (request) => ({
    code: 'OK',
    data: await getOptimizeIpWorkerStatus(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/optimize-ip/tasks', async (request) => {
    const result = await listOptimizeIpTasks(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/optimize-ip/tasks', async (request) => ({
    code: 'OK',
    ...await createOptimizeIpTask(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/optimize-ip/tasks/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getOptimizeIpTask(client, config, upstreamContext(request, config), params.taskId),
    }
  })

  app.put('/api/web/v1/optimize-ip/tasks/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateOptimizeIpTask(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/optimize-ip/tasks/:taskId', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteOptimizeIpTask(client, config, upstreamContext(request, config), params.taskId),
    }
  })

  app.patch('/api/web/v1/optimize-ip/tasks/:taskId/status', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setOptimizeIpTaskStatus(
        client,
        config,
        upstreamContext(request, config),
        params.taskId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/optimize-ip/tasks/:taskId/run', async (request) => {
    const params = TaskIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await runOptimizeIpTask(client, config, upstreamContext(request, config), params.taskId),
    }
  })

  app.get('/api/web/v1/certificate-account-types', async (request) => ({
    code: 'OK',
    data: await getCertificateAccountTypes(client, config, upstreamContext(request, config), request.query),
  }))

  app.get('/api/web/v1/certificate-accounts', async (request) => {
    const result = await listCertificateAccounts(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/certificate-accounts', async (request) => ({
    code: 'OK',
    ...await createCertificateAccount(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/certificate-accounts/:accountId', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCertificateAccount(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        request.query,
      ),
    }
  })

  app.put('/api/web/v1/certificate-accounts/:accountId', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateCertificateAccount(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/certificate-accounts/:accountId', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCertificateAccount(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        request.query,
      ),
    }
  })

  app.get('/api/web/v1/certificate-orders/form', async (request) => ({
    code: 'OK',
    data: await getCertificateOrderForm(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/certificate-orders', async (request) => {
    const result = await listCertificateOrders(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/certificate-orders', async (request) => ({
    code: 'OK',
    ...await createCertificateOrder(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/certificate-orders/batch', async (request) => ({
    code: 'OK',
    ...await batchOperateCertificateOrders(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/certificate-orders/:orderId', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCertificateOrder(client, config, upstreamContext(request, config), params.orderId),
    }
  })

  app.put('/api/web/v1/certificate-orders/:orderId', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateCertificateOrder(
        client,
        config,
        upstreamContext(request, config),
        params.orderId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/certificate-orders/:orderId', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCertificateOrder(client, config, upstreamContext(request, config), params.orderId),
    }
  })

  app.get('/api/web/v1/certificate-orders/:orderId/artifacts', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCertificateArtifacts(client, config, upstreamContext(request, config), params.orderId),
    }
  })

  app.get('/api/web/v1/certificate-orders/:orderId/log', async (request) => {
    CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCertificateOrderLog(client, config, upstreamContext(request, config), request.query),
    }
  })

  app.patch('/api/web/v1/certificate-orders/:orderId/auto-renew', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setCertificateAutoRenew(
        client,
        config,
        upstreamContext(request, config),
        params.orderId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/certificate-orders/:orderId/reset', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await resetCertificateOrder(client, config, upstreamContext(request, config), params.orderId),
    }
  })

  app.post('/api/web/v1/certificate-orders/:orderId/revoke', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await revokeCertificateOrder(client, config, upstreamContext(request, config), params.orderId),
    }
  })

  app.post('/api/web/v1/certificate-orders/:orderId/process', async (request) => {
    const params = CertificateOrderIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await processCertificateOrder(
        client,
        config,
        upstreamContext(request, config),
        params.orderId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/certificate-deployments/form', async (request) => ({
    code: 'OK',
    data: await getCertificateDeploymentForm(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/certificate-deployments', async (request) => {
    const result = await listCertificateDeployments(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/certificate-deployments', async (request) => ({
    code: 'OK',
    ...await createCertificateDeployment(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/certificate-deployments/batch', async (request) => ({
    code: 'OK',
    ...await batchOperateCertificateDeployments(
      client,
      config,
      upstreamContext(request, config),
      request.body,
    ),
  }))

  app.get('/api/web/v1/certificate-deployments/:deploymentId', async (request) => {
    const params = CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCertificateDeployment(
        client,
        config,
        upstreamContext(request, config),
        params.deploymentId,
      ),
    }
  })

  app.put('/api/web/v1/certificate-deployments/:deploymentId', async (request) => {
    const params = CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateCertificateDeployment(
        client,
        config,
        upstreamContext(request, config),
        params.deploymentId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/certificate-deployments/:deploymentId', async (request) => {
    const params = CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCertificateDeployment(
        client,
        config,
        upstreamContext(request, config),
        params.deploymentId,
      ),
    }
  })

  app.patch('/api/web/v1/certificate-deployments/:deploymentId/status', async (request) => {
    const params = CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setCertificateDeploymentStatus(
        client,
        config,
        upstreamContext(request, config),
        params.deploymentId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/certificate-deployments/:deploymentId/reset', async (request) => {
    const params = CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await resetCertificateDeployment(
        client,
        config,
        upstreamContext(request, config),
        params.deploymentId,
      ),
    }
  })

  app.post('/api/web/v1/certificate-deployments/:deploymentId/process', async (request) => {
    const params = CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await processCertificateDeployment(
        client,
        config,
        upstreamContext(request, config),
        params.deploymentId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/certificate-deployments/:deploymentId/log', async (request) => {
    CertificateDeploymentIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCertificateDeploymentLog(client, config, upstreamContext(request, config), request.query),
    }
  })

  app.get('/api/web/v1/certificate-cnames/form', async (request) => ({
    code: 'OK',
    data: await getCertificateCnameForm(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/certificate-cnames', async (request) => {
    const result = await listCertificateCnames(
      client,
      config,
      upstreamContext(request, config),
      request.query,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/certificate-cnames', async (request) => ({
    code: 'OK',
    ...await createCertificateCname(client, config, upstreamContext(request, config), request.body),
  }))

  app.put('/api/web/v1/certificate-cnames/:cnameId', async (request) => {
    const params = CertificateCnameIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateCertificateCname(
        client,
        config,
        upstreamContext(request, config),
        params.cnameId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/certificate-cnames/:cnameId', async (request) => {
    const params = CertificateCnameIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCertificateCname(client, config, upstreamContext(request, config), params.cnameId),
    }
  })

  app.post('/api/web/v1/certificate-cnames/:cnameId/check', async (request) => {
    const params = CertificateCnameIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await checkCertificateCname(client, config, upstreamContext(request, config), params.cnameId),
    }
  })

  app.get('/api/web/v1/certificate-settings', async (request) => ({
    code: 'OK',
    data: await getCertificateSettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/certificate-settings', async (request) => ({
    code: 'OK',
    ...await updateCertificateSettings(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    const result = await listCloudflareCustomHostnames(
      client,
      config,
      upstreamContext(request, config),
      params.domainId,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await createCloudflareCustomHostname(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames/batch-add', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await batchAddCloudflareCustomHostnames(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.put('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames/batch', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await batchUpdateCloudflareCustomHostnames(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames/batch-delete', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await batchDeleteCloudflareCustomHostnames(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.put('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames/:hostnameId', async (request) => {
    const params = CloudflareHostnameIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateCloudflareCustomHostname(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.hostnameId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames/:hostnameId', async (request) => {
    const params = CloudflareHostnameIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCloudflareCustomHostname(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.hostnameId,
        request.body,
      ),
    }
  })

  app.post('/api/web/v1/cloudflare/domains/:domainId/custom-hostnames/:hostnameId/refresh', async (request) => {
    const params = CloudflareHostnameIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await refreshCloudflareCustomHostname(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        params.hostnameId,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/domains/:domainId/txt-targets', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCloudflareTxtTargets(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.query,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/domains/:domainId/fallback-origin', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCloudflareFallbackOrigin(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
      ),
    }
  })

  app.put('/api/web/v1/cloudflare/domains/:domainId/fallback-origin', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setCloudflareFallbackOrigin(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/cloudflare/domains/:domainId/fallback-origin', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCloudflareFallbackOrigin(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/domains/:domainId/dcv-delegation', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCloudflareDcvDelegationUuid(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/domains/:domainId/default-line', async (request) => {
    const params = DomainIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCloudflareDomainDefaultLine(
        client,
        config,
        upstreamContext(request, config),
        params.domainId,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/accounts/:accountId/tunnels', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    const result = await listCloudflareTunnels(
      client,
      config,
      upstreamContext(request, config),
      params.accountId,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/cloudflare/accounts/:accountId/tunnels', async (request) => {
    const params = AccountIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await createCloudflareTunnel(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCloudflareTunnel(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/token', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getCloudflareTunnelToken(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    const result = await listCloudflareTunnelPublicHostnames(
      client,
      config,
      upstreamContext(request, config),
      params.accountId,
      params.tunnelId,
    )
    return { code: 'OK', ...result }
  })

  app.put('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await saveCloudflareTunnelPublicHostname(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCloudflareTunnelPublicHostname(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    const result = await listCloudflareTunnelCidrRoutes(
      client,
      config,
      upstreamContext(request, config),
      params.accountId,
      params.tunnelId,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await createCloudflareTunnelCidrRoute(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCloudflareTunnelCidrRoute(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    const result = await listCloudflareTunnelHostnameRoutes(
      client,
      config,
      upstreamContext(request, config),
      params.accountId,
      params.tunnelId,
    )
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await createCloudflareTunnelHostnameRoute(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes', async (request) => {
    const params = CloudflareTunnelIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteCloudflareTunnelHostnameRoute(
        client,
        config,
        upstreamContext(request, config),
        params.accountId,
        params.tunnelId,
        request.body,
      ),
    }
  })

  app.get('/api/web/v1/dashboard', async (request) => ({
    code: 'OK',
    data: await getDashboardOverview(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/dashboard/release', async (request) => ({
    code: 'OK',
    data: await getDashboardReleaseInfo(config, options.fetcher ?? fetch, request.log),
  }))

  app.post('/api/web/v1/dashboard/cache/clear', async (request) => ({
    code: 'OK',
    ...await clearDashboardCache(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/users/form', async (request) => ({
    code: 'OK',
    data: await getUserFormOptions(client, config, upstreamContext(request, config)),
  }))

  app.get('/api/web/v1/users', async (request) => {
    const result = await listUsers(client, config, upstreamContext(request, config), request.query)
    return { code: 'OK', ...result }
  })

  app.post('/api/web/v1/users', async (request) => ({
    code: 'OK',
    ...await createUser(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/users/:userId', async (request) => {
    const params = UserIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      data: await getUser(client, config, upstreamContext(request, config), params.userId),
    }
  })

  app.put('/api/web/v1/users/:userId', async (request) => {
    const params = UserIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await updateUser(
        client,
        config,
        upstreamContext(request, config),
        params.userId,
        request.body,
      ),
    }
  })

  app.patch('/api/web/v1/users/:userId/status', async (request) => {
    const params = UserIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await setUserStatus(
        client,
        config,
        upstreamContext(request, config),
        params.userId,
        request.body,
      ),
    }
  })

  app.delete('/api/web/v1/users/:userId', async (request) => {
    const params = UserIdParamsSchema.parse(request.params)
    return {
      code: 'OK',
      ...await deleteUser(client, config, upstreamContext(request, config), params.userId),
    }
  })

  app.get('/api/web/v1/logs', async (request) => {
    const result = await listAuditLogs(client, config, upstreamContext(request, config), request.query)
    return { code: 'OK', ...result }
  })

  app.get('/api/web/v1/profile/security', async (request) => ({
    code: 'OK',
    data: await getProfileSecurity(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/profile/password', async (request) => ({
    code: 'OK',
    ...await changePassword(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/profile/totp/enrollment', async (request) => ({
    code: 'OK',
    data: await generateTotpEnrollment(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/profile/totp', async (request) => ({
    code: 'OK',
    ...await bindTotp(client, config, upstreamContext(request, config), request.body),
  }))

  app.delete('/api/web/v1/profile/totp', async (request) => ({
    code: 'OK',
    ...await disableTotp(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/profile/legacy-theme', async (request) => ({
    code: 'OK',
    ...await setLegacyTheme(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/system/login-settings', async (request) => ({
    code: 'OK',
    data: await getLoginSettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/system/login-settings', async (request) => ({
    code: 'OK',
    ...await updateLoginSettings(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/system/notifications', async (request) => ({
    code: 'OK',
    data: await getNotificationSettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/system/notifications', async (request) => ({
    code: 'OK',
    ...await updateNotificationSettings(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/system/notifications/test', async (request) => ({
    code: 'OK',
    ...await testNotification(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/system/proxy', async (request) => ({
    code: 'OK',
    data: await getProxySettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/system/proxy', async (request) => ({
    code: 'OK',
    ...await updateProxySettings(client, config, upstreamContext(request, config), request.body),
  }))

  app.post('/api/web/v1/system/proxy/test', async (request) => ({
    code: 'OK',
    ...await testProxy(client, config, upstreamContext(request, config), request.body),
  }))

  app.get('/api/web/v1/system/cron', async (request) => ({
    code: 'OK',
    data: await getCronSettings(client, config, upstreamContext(request, config)),
  }))

  app.put('/api/web/v1/system/cron', async (request) => ({
    code: 'OK',
    ...await updateCronSettings(client, config, upstreamContext(request, config), request.body),
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
