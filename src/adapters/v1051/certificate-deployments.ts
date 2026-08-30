import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CertificateAccountTypeDefinition,
  CertificateDeploymentDetail,
  CertificateDeploymentSummary,
  PageMeta,
  ProcessLog,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import {
  booleanValue,
  integerValue,
  objectValue,
  operationMessage,
  pagedOperation,
  requiredEmbeddedObject,
  requiredPositiveInteger,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { normalizeDynamicFields, parseConfigObject, safeConfigObject, safeIcon } from './dynamic-fields.js'
import { embeddedJsonAssignment, namedSelectOptions, plainText } from './html-state.js'
import { normalizeProcessLog, ProcessLogQuerySchema } from './certificate-orders.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()
const IdList = z.array(PositiveId).min(1).max(1000)

const DeploymentSortMap = {
  id: 'id',
  accountType: 'typename',
  remark: 'remark',
  active: 'active',
  lastRunAt: 'lasttime',
  status: 'status',
} as const

const DeploymentStatusFilter = {
  pending: '0',
  succeeded: '1',
  failed: '-1',
} as const

export const CertificateDeploymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  domain: z.string().trim().max(253).optional(),
  orderId: PositiveId.optional(),
  accountId: PositiveId.optional(),
  accountType: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  status: z.enum(Object.keys(DeploymentStatusFilter) as [keyof typeof DeploymentStatusFilter]).optional(),
  remark: z.string().trim().max(1000).optional(),
  sort: z.enum(Object.keys(DeploymentSortMap) as [keyof typeof DeploymentSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

export const CertificateDeploymentMutationSchema = z.object({
  accountId: PositiveId,
  orderId: PositiveId,
  config: z.record(z.string().min(1).max(255), z.unknown()),
  remark: z.string().trim().max(1000).nullable().optional(),
}).strict()

export const CertificateDeploymentStatusSchema = z.object({ enabled: z.boolean() }).strict()
export const CertificateDeploymentBatchSchema = z.object({
  ids: IdList,
  action: z.enum(['delete', 'reset', 'enable', 'disable', 'assign-certificate']),
  orderId: PositiveId.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'assign-certificate' && value.orderId === undefined) {
    context.addIssue({ code: 'custom', path: ['orderId'], message: '批量更换证书时必须选择证书订单' })
  }
})

export const CertificateDeploymentProcessSchema = z.object({
  reset: z.boolean().default(false),
}).strict()

type DeploymentAccountOption = { id: number; type: string; label: string }
type DeploymentOrderOption = { id: number; label: string }

function accountOptionsFromHtml(html: string): DeploymentAccountOption[] {
  const select = /<select\b(?=[^>]*\bname\s*=\s*["']aid["'])[^>]*>([\s\S]*?)<\/select>/i.exec(html)?.[1]
  if (!select) return []
  return Array.from(select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)).flatMap((match) => {
    const attributes = match[1] ?? ''
    const id = Number(/\bvalue\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1])
    const type = /\bdata-type\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1]
    const label = plainText(match[2])
    return Number.isSafeInteger(id) && id > 0 && type && label ? [{ id, type, label }] : []
  })
}

function orderOptionsFromHtml(html: string): DeploymentOrderOption[] {
  return namedSelectOptions(html, 'oid').flatMap(({ value, label }) => {
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 && label ? [{ id, label }] : []
  })
}

function deploymentTypesFromHtml(html: string): CertificateAccountTypeDefinition[] {
  const typeList = objectValue(embeddedJsonAssignment(html, 'typeList'))
  if (!typeList) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的证书部署类型格式不兼容')
  }
  return Object.entries(typeList).flatMap(([type, raw]): CertificateAccountTypeDefinition[] => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(type)) return []
    const definition = objectValue(raw)
    const label = plainText(definition?.name)
    if (!definition || !label) return []
    const icon = safeIcon(definition.icon)
    const description = plainText(definition.desc)
    const note = plainText(definition.note)
    const taskNote = plainText(definition.tasknote)
    return [{
      type,
      kind: 'deployment',
      label,
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
      ...(note ? { note } : {}),
      fields: normalizeDynamicFields(definition.inputs),
      taskFields: normalizeDynamicFields(definition.taskinputs),
      ...(taskNote ? { taskNote } : {}),
    }]
  })
}

function deploymentStatus(row: LegacyObject): CertificateDeploymentSummary['status'] {
  const status = integerValue(row.status)
  if (status === 0 && booleanValue(row.islock)) return 'processing'
  if (status === 0) return 'pending'
  if (status === 1) return 'succeeded'
  if (status !== undefined && status < 0) return 'failed'
  return 'unknown'
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : []
}

function normalizeCertificateDeployment(row: LegacyObject): CertificateDeploymentSummary {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT',
    '原 dnsmgr 返回了无法识别的自动部署任务',
  )
  const accountId = requiredPositiveInteger(
    row.aid,
    'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT',
    '原 dnsmgr 返回了无法识别的自动部署任务',
  )
  const orderId = requiredPositiveInteger(
    row.oid,
    'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT',
    '原 dnsmgr 返回了无法识别的自动部署任务',
  )
  const accountType = stringValue(row.type) ?? 'unknown'
  const accountName = stringValue(row.aname)
  const accountRemark = stringValue(row.aremark)
  const sourceType = stringValue(row.certtype)
  const sourceLabel = plainText(row.certtypename) ?? sourceType ?? '手动续期'
  const processId = stringValue(row.processid)
  const lastRunAt = stringValue(row.lasttime)
  const addedAt = stringValue(row.addtime)
  const error = plainText(row.error)
  const remark = stringValue(row.remark)
  return {
    id,
    account: {
      id: accountId,
      type: accountType,
      label: plainText(row.typename) ?? accountType,
      ...(accountName ? { name: accountName } : {}),
      ...(accountRemark ? { remark: accountRemark } : {}),
    },
    order: {
      id: orderId,
      ...(sourceType ? { sourceType } : {}),
      sourceLabel,
      domains: stringArray(row.domains),
    },
    active: booleanValue(row.active),
    status: deploymentStatus(row),
    ...(processId ? { processId } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(addedAt ? { addedAt } : {}),
    ...(error ? { error } : {}),
    ...(remark ? { remark } : {}),
  }
}

export async function listCertificateDeployments(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: CertificateDeploymentSummary[]; meta: PageMeta }> {
  const query = CertificateDeploymentsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: DeploymentSortMap[query.sort],
      sortOrder: query.order,
      ...(query.domain ? { domain: query.domain } : {}),
      ...(query.orderId ? { oid: query.orderId } : {}),
      ...(query.accountId ? { aid: query.accountId } : {}),
      ...(query.accountType ? { type: query.accountType } : {}),
      ...(query.status ? { status: DeploymentStatusFilter[query.status] } : {}),
      ...(query.remark ? { remark: query.remark } : {}),
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的自动部署任务列表格式不兼容',
    normalizeCertificateDeployment,
  )
}

export async function getCertificateDeploymentForm(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const html = requireUpstreamHtml(await client.getHtml('/cert/deploy/add', context), config)
  return {
    accounts: accountOptionsFromHtml(html),
    orders: orderOptionsFromHtml(html),
    accountTypes: deploymentTypesFromHtml(html),
  }
}

export async function getCertificateDeployment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
): Promise<CertificateDeploymentDetail> {
  const html = requireUpstreamHtml(
    await client.getHtml(`/cert/deploy/edit?id=${deploymentId}`, context),
    config,
  )
  const info = requiredEmbeddedObject(
    html,
    'info',
    /自动部署任务不存在/,
    'CERTIFICATE_DEPLOYMENT_NOT_FOUND',
    '自动部署任务不存在',
  )
  const id = requiredPositiveInteger(
    info.id,
    'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT',
    '原 dnsmgr 返回了无法识别的自动部署任务',
  )
  const accountId = requiredPositiveInteger(
    info.aid,
    'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT',
    '原 dnsmgr 返回了无法识别的自动部署任务',
  )
  const orderId = requiredPositiveInteger(
    info.oid,
    'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT',
    '原 dnsmgr 返回了无法识别的自动部署任务',
  )
  const accountType = stringValue(info.type)
  if (!accountType) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_DEPLOYMENT', '原 dnsmgr 返回了无法识别的自动部署任务')
  }
  const remark = stringValue(info.remark)
  return {
    id,
    accountId,
    accountType,
    orderId,
    config: parseConfigObject(info.config ?? {}, '自动部署任务配置不是有效 JSON'),
    ...(remark ? { remark } : {}),
  }
}

function deploymentMutationForm(rawBody: unknown) {
  const body = CertificateDeploymentMutationSchema.parse(rawBody)
  return {
    aid: body.accountId,
    oid: body.orderId,
    config: JSON.stringify(safeConfigObject(body.config)),
    remark: body.remark ?? '',
  }
}

export async function createCertificateDeployment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.create', {
    form: deploymentMutationForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateCertificateDeployment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.update', {
    form: { id: deploymentId, ...deploymentMutationForm(rawBody) },
  })
  return operationMessage(result.message)
}

async function simpleDeploymentAction(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
  operation: 'certificateDeployments.delete' | 'certificateDeployments.reset',
) {
  const result = await executeLegacyOperation(client, config, context, operation, {
    form: { id: deploymentId },
  })
  return operationMessage(result.message)
}

export async function deleteCertificateDeployment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
) {
  return simpleDeploymentAction(client, config, context, deploymentId, 'certificateDeployments.delete')
}

export async function resetCertificateDeployment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
) {
  return simpleDeploymentAction(client, config, context, deploymentId, 'certificateDeployments.reset')
}

export async function setCertificateDeploymentStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
  rawBody: unknown,
) {
  const body = CertificateDeploymentStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.setActive', {
    form: { id: deploymentId, active: body.enabled },
  })
  return operationMessage(result.message)
}

export async function processCertificateDeployment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  deploymentId: number,
  rawBody: unknown,
) {
  const body = CertificateDeploymentProcessSchema.parse(rawBody ?? {})
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.process', {
    form: { id: deploymentId, reset: body.reset },
  })
  return operationMessage(result.message)
}

export async function batchOperateCertificateDeployments(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CertificateDeploymentBatchSchema.parse(rawBody)
  const act = body.action === 'enable'
    ? 'open'
    : body.action === 'disable'
      ? 'close'
      : body.action === 'assign-certificate'
        ? 'cert'
        : body.action
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.operate', {
    form: {
      ids: body.ids,
      act,
      ...(body.action === 'assign-certificate' ? { certid: body.orderId } : {}),
    },
  })
  return operationMessage(result.message)
}

export async function getCertificateDeploymentLog(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<ProcessLog> {
  const query = ProcessLogQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'certificateDeployments.logs', {
    form: { processid: query.processId },
  })
  return normalizeProcessLog(result.data)
}
