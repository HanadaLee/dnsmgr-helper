import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { AutomationDomainOption, PageMeta, ScheduledDnsTask } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import {
  booleanValue,
  integerValue,
  operationMessage,
  optionalDisplayTime,
  pagedOperation,
  parseAutomationDomains,
  parseRecordSnapshot,
  requiredEmbeddedObject,
  requiredPositiveInteger,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()
const IdList = z.array(PositiveId).min(1).max(1000)

const ScheduleSortMap = {
  id: 'id',
  recordName: 'rr',
  execution: 'type',
  action: 'switchtype',
  active: 'active',
  lastRunAt: 'updatetimestr',
  nextRunAt: 'nexttimestr',
  addedAt: 'addtimestr',
  remark: 'remark',
} as const

const ScheduleSearchMap = {
  domain: 1,
  recordId: 2,
  value: 3,
  remark: 4,
} as const

const ExecutionCode = { once: 0, recurring: 1 } as const
const CycleCode = { daily: 0, weekly: 1, monthly: 2 } as const
const ActionCode = { update: 0, enable: 1, disable: 2, delete: 3 } as const
const LineModeCode = { unchanged: '', 'dns-only': '0', proxied: '1' } as const

export const ScheduledTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(2048).optional(),
  searchBy: z.enum(Object.keys(ScheduleSearchMap) as [keyof typeof ScheduleSearchMap]).default('domain'),
  execution: z.enum(['once', 'recurring']).optional(),
  sort: z.enum(Object.keys(ScheduleSortMap) as [keyof typeof ScheduleSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

const ScheduleRecordSchema = z.object({
  value: z.string().trim().max(4096).optional(),
  lineId: z.string().trim().max(255),
  lineLabel: z.string().trim().max(255).optional(),
  ttl: z.coerce.number().int().min(0).max(2_147_483_647),
}).strict()

export const ScheduledTaskMutationSchema = z.object({
  domainId: PositiveId,
  recordName: z.string().trim().min(1).max(255),
  recordId: z.string().trim().min(1).max(1024),
  execution: z.enum(['once', 'recurring']),
  cycle: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
  action: z.enum(['update', 'enable', 'disable', 'delete']),
  switchDate: z.coerce.string().trim().max(16).default(''),
  switchTime: z.string().trim().min(1).max(64),
  value: z.string().trim().max(4096).nullable().default(null),
  lineMode: z.enum(['unchanged', 'dns-only', 'proxied']).default('unchanged'),
  remark: z.string().trim().max(1000).nullable().default(null),
  record: ScheduleRecordSchema,
}).strict().superRefine((value, context) => {
  if (value.action === 'update' && !value.value) {
    context.addIssue({ code: 'custom', path: ['value'], message: '修改解析时必须填写记录值' })
  }
  if (value.execution === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value.switchTime)) {
      context.addIssue({ code: 'custom', path: ['switchTime'], message: '单次任务时间格式必须为本地日期时间' })
    }
    return
  }

  if (value.action === 'delete') {
    context.addIssue({ code: 'custom', path: ['action'], message: '删除解析只允许使用单次任务' })
  }
  const timeMatch = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.switchTime)
  if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) {
    context.addIssue({ code: 'custom', path: ['switchTime'], message: '周期任务时间格式必须为 HH:mm' })
  }
  const switchDate = Number(value.switchDate)
  if (value.cycle === 'weekly' && (!Number.isInteger(switchDate) || switchDate < 0 || switchDate > 6)) {
    context.addIssue({ code: 'custom', path: ['switchDate'], message: '每周任务日期必须为 0 到 6' })
  }
  if (value.cycle === 'monthly' && (!Number.isInteger(switchDate) || switchDate < 1 || switchDate > 31)) {
    context.addIssue({ code: 'custom', path: ['switchDate'], message: '每月任务日期必须为 1 到 31' })
  }
})

export const ScheduledTaskStatusSchema = z.object({ enabled: z.boolean() }).strict()
export const ScheduledTaskBatchSchema = z.object({
  ids: IdList,
  action: z.enum(['delete', 'enable', 'disable']),
}).strict()

function executionType(value: unknown): ScheduledDnsTask['execution'] {
  const code = integerValue(value)
  return code === 0 ? 'once' : code === 1 ? 'recurring' : 'unknown'
}

function scheduleCycle(value: unknown): ScheduledDnsTask['cycle'] {
  const code = integerValue(value)
  return code === 0 ? 'daily' : code === 1 ? 'weekly' : code === 2 ? 'monthly' : 'unknown'
}

function scheduleAction(value: unknown): ScheduledDnsTask['action'] {
  const code = integerValue(value)
  return code === 0 ? 'update' : code === 1 ? 'enable' : code === 2 ? 'disable' : code === 3 ? 'delete' : 'unknown'
}

function lineMode(value: unknown): ScheduledDnsTask['lineMode'] {
  if (value === undefined || value === null || value === '') return 'unchanged'
  const text = String(value)
  return text === '0' ? 'dns-only' : text === '1' ? 'proxied' : 'unknown'
}

function normalizeScheduledTask(row: LegacyObject): ScheduledDnsTask {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_SCHEDULED_TASK',
    '原 dnsmgr 返回了无法识别的计划任务',
  )
  const domainId = requiredPositiveInteger(
    row.did,
    'UPSTREAM_INVALID_SCHEDULED_TASK',
    '原 dnsmgr 返回了无法识别的计划任务',
  )
  const recordName = stringValue(row.rr)
  const recordId = stringValue(row.recordid)
  const switchTime = stringValue(row.switchtime)
  if (!recordName || !recordId || !switchTime) {
    throw new ApiError(502, 'UPSTREAM_INVALID_SCHEDULED_TASK', '原 dnsmgr 返回了无法识别的计划任务')
  }
  const switchDate = stringValue(row.switchdate)
  const value = stringValue(row.value)
  const lastRunAt = optionalDisplayTime(row.updatetimestr)
  const nextRunAt = optionalDisplayTime(row.nexttimestr)
  const addedAt = optionalDisplayTime(row.addtimestr) ?? optionalDisplayTime(row.addtime)
  const remark = stringValue(row.remark)
  const record = parseRecordSnapshot(row.recordinfo)
  return {
    id,
    domainId,
    domain: stringValue(row.domain) ?? '',
    recordName,
    recordId,
    execution: executionType(row.type),
    cycle: scheduleCycle(row.cycle),
    action: scheduleAction(row.switchtype),
    ...(switchDate ? { switchDate } : {}),
    switchTime,
    ...(value ? { value } : {}),
    lineMode: lineMode(row.line),
    active: booleanValue(row.active),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(addedAt ? { addedAt } : {}),
    ...(remark ? { remark } : {}),
    ...(record ? { record } : {}),
  }
}

function scheduledTaskForm(rawBody: unknown) {
  const body = ScheduledTaskMutationSchema.parse(rawBody)
  return {
    did: body.domainId,
    rr: body.recordName,
    recordid: body.recordId,
    type: ExecutionCode[body.execution],
    cycle: CycleCode[body.cycle],
    switchtype: ActionCode[body.action],
    switchdate: body.execution === 'recurring' ? body.switchDate : '',
    switchtime: body.switchTime,
    value: body.value ?? '',
    line: LineModeCode[body.lineMode],
    remark: body.remark ?? '',
    recordinfo: JSON.stringify({
      Value: body.record.value ?? '',
      Line: body.record.lineId,
      LineName: body.record.lineLabel ?? '',
      TTL: body.record.ttl,
    }),
  }
}

export async function listScheduledTasks(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: ScheduledDnsTask[]; meta: PageMeta }> {
  const query = ScheduledTasksQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'schedules.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: ScheduleSortMap[query.sort],
      sortOrder: query.order,
      type: ScheduleSearchMap[query.searchBy],
      ...(query.q ? { kw: query.q } : {}),
      ...(query.execution ? { stype: ExecutionCode[query.execution] } : {}),
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的计划任务列表格式不兼容',
    normalizeScheduledTask,
  )
}

export async function getScheduledTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
): Promise<ScheduledDnsTask> {
  const html = requireUpstreamHtml(
    await client.getHtml(`/schedule/stask/edit?id=${taskId}`, context),
    config,
  )
  const row = requiredEmbeddedObject(
    html,
    'info',
    /切换策略不存在/,
    'SCHEDULED_TASK_NOT_FOUND',
    '计划任务不存在',
  )
  const task = normalizeScheduledTask(row)
  const domain = parseAutomationDomains(html).find((item) => item.id === task.domainId)
  return { ...task, ...(domain ? { domain: domain.name } : {}) }
}

export async function getScheduledTaskForm(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<{
  domains: AutomationDomainOption[]
  defaults: Omit<z.input<typeof ScheduledTaskMutationSchema>, 'domainId' | 'recordName' | 'recordId' | 'switchTime' | 'record'>
}> {
  const html = requireUpstreamHtml(await client.getHtml('/schedule/stask/add', context), config)
  return {
    domains: parseAutomationDomains(html),
    defaults: {
      execution: 'once',
      cycle: 'daily',
      action: 'update',
      switchDate: '',
      value: null,
      lineMode: 'unchanged',
      remark: null,
    },
  }
}

export async function createScheduledTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'schedules.create', {
    form: scheduledTaskForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateScheduledTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'schedules.update', {
    form: { id: taskId, ...scheduledTaskForm(rawBody) },
  })
  return operationMessage(result.message)
}

export async function setScheduledTaskStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
  rawBody: unknown,
) {
  const body = ScheduledTaskStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'schedules.setActive', {
    form: { id: taskId, active: body.enabled },
  })
  return operationMessage(result.message)
}

export async function deleteScheduledTask(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  taskId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'schedules.delete', {
    form: { id: taskId },
  })
  return operationMessage(result.message)
}

export async function batchOperateScheduledTasks(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = ScheduledTaskBatchSchema.parse(rawBody)
  const act = body.action === 'enable' ? 'open' : body.action === 'disable' ? 'close' : body.action
  const result = await executeLegacyOperation(client, config, context, 'schedules.operate', {
    form: { ids: body.ids, act },
  })
  return operationMessage(result.message)
}
