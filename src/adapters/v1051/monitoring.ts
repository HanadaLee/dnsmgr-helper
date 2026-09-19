import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  AutomationDomainOption,
  MonitoringOverview,
  MonitoringTask,
  MonitoringTaskLog,
  PageMeta,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml, requireUpstreamText } from '../../upstream/legacy.js'
import {
  booleanValue,
  countAfterText,
  integerValue,
  objectValue,
  operationMessage,
  optionalDisplayTime,
  pagedOperation,
  parseAutomationDomains,
  parseRecordSnapshot,
  regexpEscape,
  requiredEmbeddedObject,
  requiredPositiveInteger,
  stringValue,
  textAfterBoldLabel,
  type LegacyObject,
} from './automation-common.js'
import { namedElementAttribute, plainText } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()
const IdList = z.array(PositiveId).min(1).max(1000)

const MonitorSortMap = {
  id: 'id',
  recordName: 'rr',
  primaryValue: 'main_value',
  action: 'type',
  checkType: 'checktype',
  intervalSeconds: 'frequency',
  health: 'status',
  active: 'active',
  checkedAt: 'checktimestr',
  addedAt: 'addtimestr',
  remark: 'remark',
} as const

const MonitorSearchMap = {
  domain: 1,
  recordId: 2,
  primaryValue: 3,
  backupValue: 4,
  remark: 5,
} as const

const MonitorActionCode = {
  none: 0,
  disable: 1,
  failover: 2,
  'conditional-enable': 3,
} as const

const MonitorCheckCode = {
  ping: 0,
  tcp: 1,
  http: 2,
} as const

export const MonitoringTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(2048).optional(),
  searchBy: z.enum(Object.keys(MonitorSearchMap) as [keyof typeof MonitorSearchMap]).default('domain'),
  health: z.enum(['healthy', 'failed']).optional(),
  sort: z.enum(Object.keys(MonitorSortMap) as [keyof typeof MonitorSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

const RecordSnapshotSchema = z.object({
  type: z.string().trim().min(1).max(64).optional(),
  lineId: z.string().trim().max(255),
  lineLabel: z.string().trim().max(255).optional(),
  ttl: z.coerce.number().int().min(0).max(2_147_483_647),
}).strict()

export const MonitoringTaskMutationSchema = z.object({
  domainId: PositiveId,
  recordName: z.string().trim().min(1).max(255),
  recordId: z.string().trim().min(1).max(1024),
  action: z.enum(['none', 'disable', 'failover', 'conditional-enable']),
  primaryValue: z.string().trim().min(1).max(4096),
  backupValue: z.string().trim().max(4096).nullable().default(null),
  checkType: z.enum(['ping', 'tcp', 'http']).default('tcp'),
  checkUrl: z.string().trim().max(4096).nullable().default(null),
  tcpPort: z.coerce.number().int().min(1).max(65535).nullable().default(null),
  intervalSeconds: z.coerce.number().int().min(1).max(86_400),
  cycleCount: z.coerce.number().int().min(1).max(1_000_000),
  timeoutSeconds: z.coerce.number().int().min(1).max(86_400),
  useProxy: z.boolean().default(false),
  enableCloudflareProxy: z.boolean().default(false),
  remark: z.string().trim().max(1000).nullable().default(null),
  record: RecordSnapshotSchema,
}).strict().superRefine((value, context) => {
  if (value.action === 'failover') {
    if (!value.backupValue) {
      context.addIssue({ code: 'custom', path: ['backupValue'], message: '切换备用解析时必须填写备用记录值' })
    } else if (value.backupValue === value.primaryValue) {
      context.addIssue({ code: 'custom', path: ['backupValue'], message: '主备记录值不能相同' })
    }
  }
  if (value.action !== 'conditional-enable' && value.checkType === 'tcp' && value.tcpPort === null) {
    context.addIssue({ code: 'custom', path: ['tcpPort'], message: 'TCP 检测必须填写端口' })
  }
  if (value.action !== 'conditional-enable' && value.checkType === 'http') {
    try {
      const url = new URL(value.checkUrl ?? '')
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
    } catch {
      context.addIssue({ code: 'custom', path: ['checkUrl'], message: 'HTTP 检测必须填写完整的 HTTP(S) URL' })
    }
  }
  if (value.action !== 'conditional-enable' && value.checkType !== 'ping' && value.timeoutSeconds > value.intervalSeconds) {
    context.addIssue({
      code: 'custom',
      path: ['timeoutSeconds'],
      message: '最大超时时间不能大于检测间隔',
    })
  }
})

export const MonitoringStatusSchema = z.object({ enabled: z.boolean() }).strict()
export const MonitoringBatchSchema = z.object({
  ids: IdList,
  action: z.enum(['delete', 'retry', 'enable', 'disable']),
}).strict()
export const MonitoringLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  event: z.enum(['failure', 'recovery']).optional(),
}).strict()
export const MonitoringCleanSchema = z.object({
  days: z.coerce.number().int().min(1).max(365_000),
}).strict()
export const MonitoringNotificationsSchema = z.object({
  email: z.boolean(),
  wechat: z.boolean(),
  telegram: z.boolean(),
  robotWebhook: z.boolean(),
  customWebhook: z.boolean(),
}).strict()

function monitorAction(value: unknown): MonitoringTask['action'] {
  const code = integerValue(value)
  if (code === 0) return 'none'
  if (code === 1) return 'disable'
  if (code === 2) return 'failover'
  if (code === 3) return 'conditional-enable'
  return 'unknown'
}

function monitorCheckType(value: unknown): MonitoringTask['checkType'] {
  const code = integerValue(value)
  if (code === 0) return 'ping'
  if (code === 1) return 'tcp'
  if (code === 2) return 'http'
  return 'unknown'
}

function normalizeMonitoringTask(row: LegacyObject): MonitoringTask {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_MONITORING_TASK',
    '原 dnsmgr 返回了无法识别的监控任务',
  )
  const domainId = requiredPositiveInteger(
    row.did,
    'UPSTREAM_INVALID_MONITORING_TASK',
    '原 dnsmgr 返回了无法识别的监控任务',
  )
  const recordName = stringValue(row.rr)
  const recordId = stringValue(row.recordid)
  if (!recordName || !recordId) {
    throw new ApiError(502, 'UPSTREAM_INVALID_MONITORING_TASK', '原 dnsmgr 返回了无法识别的监控任务')
  }

  const backupValue = stringValue(row.backup_value)
  const checkUrl = stringValue(row.checkurl)
  const tcpPort = integerValue(row.tcpport)
  const checkedAt = optionalDisplayTime(row.checktimestr)
  const addedAt = optionalDisplayTime(row.addtimestr) ?? optionalDisplayTime(row.addtime)
  const remark = stringValue(row.remark)
  const record = parseRecordSnapshot(row.recordinfo)
  const status = integerValue(row.status)

  return {
    id,
    domainId,
    domain: stringValue(row.domain) ?? '',
    recordName,
    recordId,
    action: monitorAction(row.type),
    primaryValue: stringValue(row.main_value) ?? '',
    ...(backupValue ? { backupValue } : {}),
    checkType: monitorCheckType(row.checktype),
    ...(checkUrl ? { checkUrl } : {}),
    ...(tcpPort === undefined ? {} : { tcpPort }),
    intervalSeconds: Math.max(0, integerValue(row.frequency) ?? 0),
    cycleCount: Math.max(0, integerValue(row.cycle) ?? 0),
    timeoutSeconds: Math.max(0, integerValue(row.timeout) ?? 0),
    useProxy: booleanValue(row.proxy),
    enableCloudflareProxy: booleanValue(row.cdn),
    active: booleanValue(row.active),
    health: status === 0 ? 'healthy' : status === 1 ? 'failed' : 'unknown',
    ...(checkedAt ? { checkedAt } : {}),
    ...(addedAt ? { addedAt } : {}),
    ...(remark ? { remark } : {}),
    ...(record ? { record } : {}),
  }
}

function formValue(value: string | undefined): string {
  return value ?? ''
}

function monitoringTaskForm(rawBody: unknown) {
  const body = MonitoringTaskMutationSchema.parse(rawBody)
  return {
    did: body.domainId,
    rr: body.recordName,
    recordid: body.recordId,
    type: MonitorActionCode[body.action],
    main_value: body.primaryValue,
    backup_value: body.backupValue ?? '',
    checktype: MonitorCheckCode[body.checkType],
    checkurl: body.checkUrl ?? '',
    tcpport: body.tcpPort ?? '',
    frequency: body.intervalSeconds,
    cycle: body.cycleCount,
    timeout: body.timeoutSeconds,
    proxy: body.useProxy,
    cdn: body.enableCloudflareProxy,
    remark: body.remark ?? '',
    recordinfo: JSON.stringify({
      Type: body.record.type ?? '',
      Line: body.record.lineId,
      LineName: formValue(body.record.lineLabel),
      TTL: body.record.ttl,
    }),
  }
}

export async function listMonitoringTasks(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: MonitoringTask[]; meta: PageMeta }> {
  const query = MonitoringTasksQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: MonitorSortMap[query.sort],
      sortOrder: query.order,
      type: MonitorSearchMap[query.searchBy],
      ...(query.q ? { kw: query.q } : {}),
      ...(query.health ? { status: query.health === 'healthy' ? 0 : 1 } : {}),
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的监控任务列表格式不兼容',
    normalizeMonitoringTask,
  )
}

function taskMetric(html: string, label: string): number {
  return countAfterText(html, label) ?? 0
}

export async function getMonitoringTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
): Promise<MonitoringTask> {
  const [formResult, infoResult] = await Promise.all([
    client.getHtml(`/dmonitor/task/edit?id=${taskId}`, context),
    client.getHtml(`/dmonitor/task/info/${taskId}`, context),
  ])
  const formHtml = requireUpstreamHtml(formResult, config)
  const infoHtml = requireUpstreamHtml(infoResult, config)
  const row = requiredEmbeddedObject(
    formHtml,
    'info',
    /切换策略不存在/,
    'MONITORING_TASK_NOT_FOUND',
    '监控任务不存在',
  )
  const task = normalizeMonitoringTask(row)
  const domain = parseAutomationDomains(formHtml).find((item) => item.id === task.domainId)
  return {
    ...task,
    ...(domain ? { domain: domain.name } : {}),
    alertsLast24Hours: taskMetric(infoHtml, '24H告警次数'),
    switchesLast24Hours: taskMetric(infoHtml, '切换次数'),
  }
}

export async function getMonitoringForm(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<{
  supportPing: boolean
  domains: AutomationDomainOption[]
  defaults: Omit<z.input<typeof MonitoringTaskMutationSchema>, 'domainId' | 'recordName' | 'recordId' | 'primaryValue' | 'record'>
}> {
  const html = requireUpstreamHtml(await client.getHtml('/dmonitor/task/add', context), config)
  const supportPing = /\bvar\s+support_ping\s*=\s*['"]1['"]\s*;/.test(html)
  return {
    supportPing,
    domains: parseAutomationDomains(html),
    defaults: {
      action: 'disable',
      backupValue: null,
      checkType: 'tcp',
      checkUrl: null,
      tcpPort: 80,
      intervalSeconds: 5,
      cycleCount: 3,
      timeoutSeconds: 2,
      useProxy: false,
      enableCloudflareProxy: false,
      remark: null,
    },
  }
}

function infoBoxValue(html: string, label: string): string {
  const match = new RegExp(
    `<span[^>]*class=["'][^"']*info-box-text[^"']*["'][^>]*>\\s*${regexpEscape(label)}\\s*</span>[\\s\\S]*?<span[^>]*class=["'][^"']*info-box-number[^"']*["'][^>]*>([\\s\\S]*?)</span>`,
    'i',
  ).exec(html)
  const value = match ? plainText(match[1]) : undefined
  if (!value) throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', `原 dnsmgr 页面缺少 ${label}`)
  return value
}

function notificationValue(html: string, name: string): boolean {
  return namedElementAttribute(html, 'select', name, 'default') === '1'
}

export async function getMonitoringOverview(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<MonitoringOverview> {
  const html = requireUpstreamHtml(await client.getHtml('/dmonitor/overview', context), config)
  const workerState = infoBoxValue(html, '运行状态')
  const runCountToday = Number(infoBoxValue(html, '今日运行次数'))
  const alertsLast24Hours = Number(infoBoxValue(html, '24H告警次数'))
  const switchesLast24Hours = Number(infoBoxValue(html, '24H切换次数'))
  if (![runCountToday, alertsLast24Hours, switchesLast24Hours].every(Number.isFinite)) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的监控概览格式不兼容')
  }
  const lastRunAt = textAfterBoldLabel(html, '上次运行时间')
  const lastError = textAfterBoldLabel(html, '上次运行错误信息')
  const swoole = textAfterBoldLabel(html, 'Swoole组件')
  return {
    workerRunning: workerState.includes('正在运行'),
    runCountToday,
    alertsLast24Hours,
    switchesLast24Hours,
    ...(lastRunAt && lastRunAt !== '无' ? { lastRunAt } : {}),
    ...(lastError ? { lastError } : {}),
    swooleInstalled: Boolean(swoole?.includes('已安装')),
    notifications: {
      email: notificationValue(html, 'notice_mail'),
      wechat: notificationValue(html, 'notice_wxtpl'),
      telegram: notificationValue(html, 'notice_tgbot'),
      robotWebhook: notificationValue(html, 'notice_webhook'),
      customWebhook: notificationValue(html, 'notice_custom_webhook'),
    },
  }
}

export async function getMonitoringWorkerStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const state = requireUpstreamText(await client.get('/dmtask/status', context), config).toLowerCase()
  if (state !== 'ok' && state !== 'error') {
    throw new ApiError(502, 'UPSTREAM_INVALID_STATUS', '原 dnsmgr 返回了无法识别的监控进程状态')
  }
  return { running: state === 'ok' }
}

export async function createMonitoringTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.create', {
    form: monitoringTaskForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateMonitoringTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.update', {
    form: { id: taskId, ...monitoringTaskForm(rawBody) },
  })
  return operationMessage(result.message)
}

export async function setMonitoringTaskStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawBody: unknown,
) {
  const body = MonitoringStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.setActive', {
    form: { id: taskId, active: body.enabled },
  })
  return operationMessage(result.message)
}

export async function deleteMonitoringTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.delete', {
    form: { id: taskId },
  })
  return operationMessage(result.message)
}

export async function batchOperateMonitoringTasks(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = MonitoringBatchSchema.parse(rawBody)
  const act = body.action === 'enable' ? 'open' : body.action === 'disable' ? 'close' : body.action
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.operate', {
    form: { ids: body.ids, act },
  })
  return operationMessage(result.message)
}

export async function listMonitoringTaskLogs(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawQuery: unknown,
): Promise<{ data: MonitoringTaskLog[]; meta: PageMeta }> {
  const query = MonitoringLogsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'monitoring.tasks.logs', {
    path: { taskId },
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      action: query.event === 'failure' ? 1 : query.event === 'recovery' ? 2 : 0,
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的监控日志格式不兼容',
    (row): MonitoringTaskLog => {
      const id = requiredPositiveInteger(
        row.id,
        'UPSTREAM_INVALID_MONITORING_LOG',
        '原 dnsmgr 返回了无法识别的监控日志',
      )
      const action = integerValue(row.action)
      const time = stringValue(row.date)
      const error = stringValue(row.errmsg)
      return {
        id,
        event: action === 1 ? 'failure' : action === 2 ? 'recovery' : 'unknown',
        ...(time ? { time } : {}),
        ...(error ? { error } : {}),
      }
    },
  )
}

export async function cleanMonitoringLogs(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = MonitoringCleanSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'monitoring.clean', {
    form: { days: body.days },
  })
  return operationMessage(result.message)
}

export async function updateMonitoringNotifications(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = MonitoringNotificationsSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'system.settings.update', {
    form: {
      notice_mail: body.email,
      notice_wxtpl: body.wechat,
      notice_tgbot: body.telegram,
      notice_webhook: body.robotWebhook,
      notice_custom_webhook: body.customWebhook,
    },
  })
  return operationMessage(result.message)
}
