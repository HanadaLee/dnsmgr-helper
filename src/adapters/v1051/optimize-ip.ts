import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { AutomationDomainOption, OptimizeIpSettings, OptimizeIpTask, PageMeta } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml, requireUpstreamText } from '../../upstream/legacy.js'
import {
  booleanValue,
  integerValue,
  operationMessage,
  optionalDisplayTime,
  pagedOperation,
  requiredEmbeddedObject,
  requiredPositiveInteger,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { namedElementAttribute, namedSelectOptions } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()

const OptimizeSortMap = {
  id: 'id',
  recordName: 'rr',
  cdnProvider: 'cdn_type',
  recordCount: 'recordnum',
  ipVersions: 'ip_type',
  active: 'active',
  lastRunAt: 'updatetime',
  status: 'status',
} as const

const OptimizeSearchMap = { domain: 1, remark: 2 } as const
const DataSourceCode = { wetest: 0, hostmonit: 1, xingpingcn: 2 } as const
const LineStrategyCode = { 'carrier-lines': 0, 'default-unicom-mobile': 1 } as const
const CdnProviderCode = { cloudflare: 1, cloudfront: 2, gcore: 3, edgeone: 4 } as const

export const OptimizeIpSettingsMutationSchema = z.object({
  dataSource: z.enum(['wetest', 'hostmonit', 'xingpingcn']).optional(),
  apiKey: z.string().trim().max(1024).optional(),
  proxyUrl: z.string().trim().max(4096).optional(),
  intervalMinutes: z.coerce.number().int().min(10).max(525_600).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: '至少提供一个要修改的设置',
})

export const OptimizeIpAccountQuerySchema = z.object({
  dataSource: z.enum(['wetest', 'hostmonit']),
  apiKey: z.string().trim().min(1).max(1024),
}).strict()

export const OptimizeIpTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(2048).optional(),
  searchBy: z.enum(Object.keys(OptimizeSearchMap) as [keyof typeof OptimizeSearchMap]).default('domain'),
  status: z.enum(['success', 'failed']).optional(),
  sort: z.enum(Object.keys(OptimizeSortMap) as [keyof typeof OptimizeSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

export const OptimizeIpTaskMutationSchema = z.object({
  domainId: PositiveId,
  recordName: z.string().trim().min(1).max(255),
  lineStrategy: z.enum(['carrier-lines', 'default-unicom-mobile']),
  ipVersions: z.array(z.enum(['v4', 'v6'])).min(1).max(2),
  cdnProvider: z.enum(['cloudflare', 'cloudfront', 'gcore', 'edgeone']),
  recordCount: z.coerce.number().int().min(1).max(50),
  ttl: z.coerce.number().int().min(1).max(3600),
  remark: z.string().trim().max(1000).nullable().default(null),
}).strict().superRefine((value, context) => {
  if (new Set(value.ipVersions).size !== value.ipVersions.length) {
    context.addIssue({ code: 'custom', path: ['ipVersions'], message: 'IP 版本不能重复' })
  }
})

export const OptimizeIpTaskStatusSchema = z.object({ enabled: z.boolean() }).strict()

function dataSource(value: unknown): OptimizeIpSettings['dataSource'] {
  const code = integerValue(value)
  if (code === 0) return 'wetest'
  if (code === 1) return 'hostmonit'
  if (code === 2) return 'xingpingcn'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 返回了未知的优选 IP 数据接口')
}

function lineStrategy(value: unknown): OptimizeIpTask['lineStrategy'] {
  const code = integerValue(value)
  return code === 0 ? 'carrier-lines' : code === 1 ? 'default-unicom-mobile' : 'unknown'
}

function cdnProvider(value: unknown): OptimizeIpTask['cdnProvider'] {
  const code = integerValue(value)
  return code === 1
    ? 'cloudflare'
    : code === 2
      ? 'cloudfront'
      : code === 3
        ? 'gcore'
        : code === 4
          ? 'edgeone'
          : 'unknown'
}

function normalizeIpVersions(value: unknown): Array<'v4' | 'v6'> {
  return (stringValue(value) ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is 'v4' | 'v6' => item === 'v4' || item === 'v6')
    .filter((item, index, values) => values.indexOf(item) === index)
}

function normalizeOptimizeIpTask(row: LegacyObject): OptimizeIpTask {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_OPTIMIZE_IP_TASK',
    '原 dnsmgr 返回了无法识别的优选 IP 任务',
  )
  const domainId = requiredPositiveInteger(
    row.did,
    'UPSTREAM_INVALID_OPTIMIZE_IP_TASK',
    '原 dnsmgr 返回了无法识别的优选 IP 任务',
  )
  const recordName = stringValue(row.rr)
  if (!recordName) {
    throw new ApiError(502, 'UPSTREAM_INVALID_OPTIMIZE_IP_TASK', '原 dnsmgr 返回了无法识别的优选 IP 任务')
  }
  const statusCode = integerValue(row.status)
  const lastRunAt = optionalDisplayTime(row.updatetime)
  const addedAt = optionalDisplayTime(row.addtime)
  const lastError = stringValue(row.errmsg)
  const remark = stringValue(row.remark)
  return {
    id,
    domainId,
    domain: stringValue(row.domain) ?? '',
    recordName,
    lineStrategy: lineStrategy(row.type),
    ipVersions: normalizeIpVersions(row.ip_type),
    cdnProvider: cdnProvider(row.cdn_type),
    recordCount: Math.max(0, integerValue(row.recordnum) ?? 0),
    ttl: Math.max(0, integerValue(row.ttl) ?? 0),
    active: booleanValue(row.active),
    status: statusCode === 0
      ? 'never-run'
      : statusCode === 1
        ? 'success'
        : statusCode === 2
          ? 'failed'
          : 'unknown',
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(lastError ? { lastError } : {}),
    ...(addedAt ? { addedAt } : {}),
    ...(remark ? { remark } : {}),
  }
}

function optimizeIpTaskForm(rawBody: unknown) {
  const body = OptimizeIpTaskMutationSchema.parse(rawBody)
  return {
    did: body.domainId,
    rr: body.recordName,
    type: LineStrategyCode[body.lineStrategy],
    ip_type: body.ipVersions.join(','),
    cdn_type: CdnProviderCode[body.cdnProvider],
    recordnum: body.recordCount,
    ttl: body.ttl,
    remark: body.remark ?? '',
  }
}

function optimizeIpDomains(html: string): AutomationDomainOption[] {
  return namedSelectOptions(html, 'did').flatMap((option): AutomationDomainOption[] => {
    const id = Number(option.value)
    return Number.isSafeInteger(id) && id > 0 && option.label
      ? [{ id, name: option.label, providerType: 'unknown' }]
      : []
  })
}

export async function getOptimizeIpSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<OptimizeIpSettings> {
  const html = requireUpstreamHtml(await client.getHtml('/optimizeip/opipset', context), config)
  const source = namedElementAttribute(html, 'select', 'optimize_ip_api', 'default') ?? '0'
  const interval = Number(namedElementAttribute(html, 'input', 'optimize_ip_min', 'value') ?? '30')
  if (!Number.isSafeInteger(interval) || interval < 1) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的优选 IP 设置格式不兼容')
  }
  return {
    dataSource: dataSource(source),
    apiKey: namedElementAttribute(html, 'input', 'optimize_ip_key', 'value') ?? '',
    proxyUrl: namedElementAttribute(html, 'input', 'optimize_ip_proxy', 'value') ?? '',
    intervalMinutes: interval,
  }
}

export async function updateOptimizeIpSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = OptimizeIpSettingsMutationSchema.parse(rawBody)
  const form: Record<string, unknown> = {}
  if (body.dataSource !== undefined) form.optimize_ip_api = DataSourceCode[body.dataSource]
  if (body.apiKey !== undefined) form.optimize_ip_key = body.apiKey
  if (body.proxyUrl !== undefined) form.optimize_ip_proxy = body.proxyUrl
  if (body.intervalMinutes !== undefined) form.optimize_ip_min = body.intervalMinutes
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.updateSettings', { form })
  return operationMessage(result.message)
}

export async function queryOptimizeIpAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = OptimizeIpAccountQuerySchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.queryAccount', {
    form: {
      optimize_ip_api: DataSourceCode[body.dataSource],
      optimize_ip_key: body.apiKey,
    },
  })
  return operationMessage(result.message)
}

export async function listOptimizeIpTasks(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: OptimizeIpTask[]; meta: PageMeta }> {
  const query = OptimizeIpTasksQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.tasks.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: OptimizeSortMap[query.sort],
      sortOrder: query.order,
      type: OptimizeSearchMap[query.searchBy],
      ...(query.q ? { kw: query.q } : {}),
      ...(query.status ? { status: query.status === 'success' ? 1 : 2 } : {}),
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的优选 IP 任务列表格式不兼容',
    normalizeOptimizeIpTask,
  )
}

export async function getOptimizeIpTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
): Promise<OptimizeIpTask> {
  const html = requireUpstreamHtml(
    await client.getHtml(`/optimizeip/opipform/edit?id=${taskId}`, context),
    config,
  )
  const row = requiredEmbeddedObject(
    html,
    'info',
    /任务不存在/,
    'OPTIMIZE_IP_TASK_NOT_FOUND',
    '优选 IP 任务不存在',
  )
  const task = normalizeOptimizeIpTask(row)
  const domain = optimizeIpDomains(html).find((item) => item.id === task.domainId)
  return { ...task, ...(domain ? { domain: domain.name } : {}) }
}

export async function getOptimizeIpTaskForm(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const html = requireUpstreamHtml(await client.getHtml('/optimizeip/opipform/add', context), config)
  const source = /\boptimize_ip_api\s*:\s*['"]([012])['"]/.exec(html)?.[1]
  if (source === undefined) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 页面缺少优选 IP 数据接口状态')
  }
  return {
    dataSource: dataSource(source),
    domains: optimizeIpDomains(html),
    excludedProviderTypes: ['cloudflare'],
    defaults: {
      lineStrategy: 'carrier-lines' as const,
      ipVersions: ['v4'] as Array<'v4' | 'v6'>,
      cdnProvider: 'cloudflare' as const,
      recordCount: 2,
      ttl: 600,
      remark: null,
    },
  }
}

export async function getOptimizeIpWorkerStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const state = requireUpstreamText(await client.get('/optimizeip/status', context), config).toLowerCase()
  if (state !== 'ok' && state !== 'error') {
    throw new ApiError(502, 'UPSTREAM_INVALID_STATUS', '原 dnsmgr 返回了无法识别的优选 IP 任务状态')
  }
  return { running: state === 'ok' }
}

export async function createOptimizeIpTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.tasks.create', {
    form: optimizeIpTaskForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateOptimizeIpTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.tasks.update', {
    form: { id: taskId, ...optimizeIpTaskForm(rawBody) },
  })
  return operationMessage(result.message)
}

export async function setOptimizeIpTaskStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawBody: unknown,
) {
  const body = OptimizeIpTaskStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.tasks.setActive', {
    form: { id: taskId, active: body.enabled },
  })
  return operationMessage(result.message)
}

export async function deleteOptimizeIpTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.tasks.delete', {
    form: { id: taskId },
  })
  return operationMessage(result.message)
}

export async function runOptimizeIpTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'optimizeIp.tasks.run', {
    form: { id: taskId },
  })
  return operationMessage(result.message)
}
