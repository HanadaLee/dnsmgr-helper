import type { AppConfig } from '../../config.js'
import type { DashboardOverview } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { integerValue, objectValue, operationMessage } from './automation-common.js'
import { tableCellAfterLabel } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

function count(row: Record<string, unknown>, key: string): number {
  const value = integerValue(row[key])
  if (value === undefined || value < 0) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的仪表盘统计格式不兼容')
  }
  return value
}

function serverInformation(html: string): DashboardOverview['server'] {
  const frameworkVersion = tableCellAfterLabel(html, '框架版本')
  const phpVersion = tableCellAfterLabel(html, 'PHP版本')
  const databaseVersion = tableCellAfterLabel(html, '数据库版本')
  const webServer = tableCellAfterLabel(html, 'Web服务器')
  const serverTime = tableCellAfterLabel(html, '服务器时间')
  return {
    ...(frameworkVersion ? { frameworkVersion } : {}),
    ...(phpVersion ? { phpVersion } : {}),
    ...(databaseVersion ? { databaseVersion } : {}),
    ...(webServer ? { webServer } : {}),
    ...(serverTime ? { serverTime } : {}),
  }
}

export async function getDashboardOverview(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<DashboardOverview> {
  const [statsResult, dashboardResult] = await Promise.all([
    executeLegacyOperation(client, config, context, 'dashboard.stats', {}),
    client.getHtml('/', context),
  ])
  const stats = objectValue(statsResult.data)
  if (!stats) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的仪表盘统计格式不兼容')
  }
  const html = requireUpstreamHtml(dashboardResult, config)

  return {
    totals: {
      domains: count(stats, 'domains'),
      monitoringTasks: count(stats, 'tasks'),
      certificateOrders: count(stats, 'certs'),
      certificateDeployments: count(stats, 'deploys'),
    },
    monitoring: {
      workerRunning: count(stats, 'dmonitor_state') === 1,
      active: count(stats, 'dmonitor_active'),
      healthy: count(stats, 'dmonitor_status_0'),
      failed: count(stats, 'dmonitor_status_1'),
    },
    optimizeIp: {
      active: count(stats, 'optimizeip_active'),
      succeeded: count(stats, 'optimizeip_status_1'),
      failed: count(stats, 'optimizeip_status_2'),
    },
    certificates: {
      issued: count(stats, 'certorder_status_3'),
      failed: count(stats, 'certorder_status_5'),
      expiringSoon: count(stats, 'certorder_status_6'),
      expired: count(stats, 'certorder_status_7'),
    },
    deployments: {
      pending: count(stats, 'certdeploy_status_0'),
      succeeded: count(stats, 'certdeploy_status_1'),
      failed: count(stats, 'certdeploy_status_2'),
    },
    server: serverInformation(html),
  }
}

export async function clearDashboardCache(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const result = await executeLegacyOperation(client, config, context, 'dashboard.clearCache', {})
  return operationMessage(result.message)
}
