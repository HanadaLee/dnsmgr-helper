import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CertificateArtifacts,
  CertificateOrderDetail,
  CertificateOrderSummary,
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
import { plainText } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()
const IdList = z.array(PositiveId).min(1).max(1000)

const OrderSortMap = {
  id: 'id',
  accountType: 'typename',
  keyType: 'keytype',
  autoRenew: 'isauto',
  issuedAt: 'issuetime',
  expiresAt: 'end_day',
  status: 'status',
} as const

const OrderStatusFilter = {
  pending: '0',
  'awaiting-validation': '1',
  validating: '2',
  issued: '3',
  revoked: '4',
  failed: '5',
  expiring: '6',
  expired: '7',
} as const

export const CertificateOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  id: PositiveId.optional(),
  domain: z.string().trim().max(253).optional(),
  accountId: PositiveId.optional(),
  accountType: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  status: z.enum(Object.keys(OrderStatusFilter) as [keyof typeof OrderStatusFilter]).optional(),
  sort: z.enum(Object.keys(OrderSortMap) as [keyof typeof OrderSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

const ManagedOrderSchema = z.object({
  mode: z.literal('managed'),
  accountId: PositiveId,
  keyType: z.enum(['RSA', 'ECC']),
  keySize: z.coerce.number().int(),
  domains: z.array(z.string().trim().min(1).max(253)).min(1).max(100),
}).strict().superRefine((value, context) => {
  const valid = value.keyType === 'RSA'
    ? value.keySize === 2048 || value.keySize === 3072
    : value.keySize === 256 || value.keySize === 384
  if (!valid) {
    context.addIssue({ code: 'custom', path: ['keySize'], message: '密钥长度与签名算法不匹配' })
  }
  if (new Set(value.domains.map((domain) => domain.toLowerCase())).size !== value.domains.length) {
    context.addIssue({ code: 'custom', path: ['domains'], message: '绑定域名不能重复' })
  }
})

const ManualOrderSchema = z.object({
  mode: z.literal('manual'),
  certificate: z.string().trim().min(1).max(2 * 1024 * 1024),
  privateKey: z.string().trim().min(1).max(2 * 1024 * 1024),
}).strict()

export const CertificateOrderMutationSchema = z.discriminatedUnion('mode', [
  ManagedOrderSchema,
  ManualOrderSchema,
])

export const CertificateAutoRenewSchema = z.object({ enabled: z.boolean() }).strict()
export const CertificateOrderBatchSchema = z.object({
  ids: IdList,
  action: z.enum(['delete', 'reset', 'enable', 'disable']),
}).strict()
export const CertificateProcessSchema = z.object({ reset: z.boolean().default(false) }).strict()
export const ProcessLogQuerySchema = z.object({
  processId: z.string().regex(/^[a-f0-9]{32}$/i),
}).strict()

type CertificateAccountOption = { id: number; label: string; type: string }

function accountOptionsFromHtml(html: string): CertificateAccountOption[] {
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : []
}

function failureStage(value: unknown): CertificateOrderSummary['failureStage'] | undefined {
  const code = integerValue(value)
  if (code === undefined || code >= 0) return undefined
  if (code === -1) return 'purchase'
  if (code === -2) return 'create'
  if (code === -3) return 'add-dns'
  if (code === -4) return 'check-dns'
  if (code === -5) return 'validate'
  if (code === -6) return 'rejected'
  if (code === -7) return 'issue'
  return 'unknown'
}

function orderStatus(value: unknown): CertificateOrderSummary['status'] {
  const code = integerValue(value)
  if (code !== undefined && code < 0) return 'failed'
  if (code === 0) return 'pending'
  if (code === 1) return 'awaiting-validation'
  if (code === 2) return 'validating'
  if (code === 3) return 'issued'
  if (code === 4) return 'revoked'
  return 'unknown'
}

function normalizeCertificateOrder(row: LegacyObject): CertificateOrderSummary {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_CERTIFICATE_ORDER',
    '原 dnsmgr 返回了无法识别的证书订单',
  )
  const accountId = integerValue(row.aid) ?? 0
  const type = stringValue(row.type)
  const typeLabel = plainText(row.typename) ?? type
  const accountRemark = stringValue(row.aremark)
  const keyType = stringValue(row.keytype)
  const keySize = integerValue(row.keysize)
  if (!keyType || keySize === undefined || keySize <= 0) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_ORDER', '原 dnsmgr 返回了无法识别的证书订单')
  }
  const stage = failureStage(row.status)
  const issuer = stringValue(row.issuer)
  const retryAt = stringValue(row.retrytime)
  const processId = stringValue(row.processid)
  const issuedAt = stringValue(row.issuetime)
  const expiresAt = stringValue(row.expiretime)
  const remainingDays = integerValue(row.end_day)
  const addedAt = stringValue(row.addtime)
  const updatedAt = stringValue(row.updatetime)
  const error = plainText(row.error)
  return {
    id,
    mode: accountId > 0 ? 'managed' : 'manual',
    ...(accountId > 0
      ? {
          account: {
            id: accountId,
            type: type ?? 'unknown',
            label: typeLabel ?? type ?? '未知账户',
            ...(accountRemark ? { remark: accountRemark } : {}),
          },
        }
      : {}),
    domains: stringArray(row.domains),
    keyType,
    keySize,
    ...(issuer ? { issuer } : {}),
    autoRenew: booleanValue(row.isauto),
    status: orderStatus(row.status),
    ...(stage ? { failureStage: stage } : {}),
    processing: booleanValue(row.islock),
    ...(retryAt ? { retryAt } : {}),
    ...(processId ? { processId } : {}),
    ...(issuedAt ? { issuedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(remainingDays === undefined ? {} : { remainingDays }),
    ...(addedAt ? { addedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(error ? { error } : {}),
  }
}

function orderListForm(query: z.output<typeof CertificateOrdersQuerySchema>) {
  return {
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
    sortName: OrderSortMap[query.sort],
    sortOrder: query.order,
    ...(query.id ? { id: query.id } : {}),
    ...(query.domain ? { domain: query.domain } : {}),
    ...(query.accountId ? { aid: query.accountId } : {}),
    ...(query.accountType ? { type: query.accountType } : {}),
    ...(query.status ? { status: OrderStatusFilter[query.status] } : {}),
  }
}

export async function listCertificateOrders(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: CertificateOrderSummary[]; meta: PageMeta }> {
  const query = CertificateOrdersQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.list', {
    form: orderListForm(query),
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的证书订单列表格式不兼容',
    normalizeCertificateOrder,
  )
}

export async function getCertificateOrderForm(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const html = requireUpstreamHtml(await client.getHtml('/cert/order/add', context), config)
  return {
    accounts: accountOptionsFromHtml(html),
    keyOptions: {
      RSA: [2048, 3072],
      ECC: [256, 384],
    },
    defaults: { mode: 'managed' as const, keyType: 'RSA' as const, keySize: 2048 },
  }
}

export async function getCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
): Promise<CertificateOrderDetail> {
  const [listResult, formResult] = await Promise.all([
    executeLegacyOperation(client, config, context, 'certificateOrders.list', {
      form: { id: orderId, offset: 0, limit: 1, sortName: 'id', sortOrder: 'desc' },
    }),
    client.getHtml(`/cert/order/edit?id=${orderId}`, context),
  ])
  const rows = Array.isArray(listResult.data) ? listResult.data : []
  const row = objectValue(rows[0])
  if (!row) throw new ApiError(404, 'CERTIFICATE_ORDER_NOT_FOUND', '证书订单不存在')
  const summary = normalizeCertificateOrder(row)
  const html = requireUpstreamHtml(formResult, config)
  const info = requiredEmbeddedObject(
    html,
    'info',
    /证书订单不存在/,
    'CERTIFICATE_ORDER_NOT_FOUND',
    '证书订单不存在',
  )
  if (summary.mode !== 'manual') return summary
  const certificate = stringValue(info.fullchain)
  const privateKey = stringValue(info.privatekey)
  return {
    ...summary,
    ...(certificate ? { certificate } : {}),
    ...(privateKey ? { privateKey } : {}),
  }
}

function orderMutationForm(rawBody: unknown) {
  const body = CertificateOrderMutationSchema.parse(rawBody)
  if (body.mode === 'manual') {
    return { aid: -1, fullchain: body.certificate, privatekey: body.privateKey }
  }
  return {
    aid: body.accountId,
    keytype: body.keyType,
    keysize: body.keySize,
    domains: body.domains,
  }
}

export async function createCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.create', {
    form: orderMutationForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.update', {
    form: { id: orderId, ...orderMutationForm(rawBody) },
  })
  return operationMessage(result.message)
}

export async function deleteCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.delete', {
    form: { id: orderId },
  })
  return operationMessage(result.message)
}

export async function setCertificateAutoRenew(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
  rawBody: unknown,
) {
  const body = CertificateAutoRenewSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.setAuto', {
    form: { id: orderId, isauto: body.enabled },
  })
  return operationMessage(result.message)
}

async function simpleOrderAction(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
  operation: 'certificateOrders.reset' | 'certificateOrders.revoke',
) {
  const result = await executeLegacyOperation(client, config, context, operation, {
    form: { id: orderId },
  })
  return operationMessage(result.message)
}

export async function resetCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
) {
  return simpleOrderAction(client, config, context, orderId, 'certificateOrders.reset')
}

export async function revokeCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
) {
  return simpleOrderAction(client, config, context, orderId, 'certificateOrders.revoke')
}

export async function processCertificateOrder(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
  rawBody: unknown,
) {
  const body = CertificateProcessSchema.parse(rawBody ?? {})
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.process', {
    form: { id: orderId, reset: body.reset },
  })
  return operationMessage(result.message)
}

export async function batchOperateCertificateOrders(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CertificateOrderBatchSchema.parse(rawBody)
  const act = body.action === 'enable' ? 'open' : body.action === 'disable' ? 'close' : body.action
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.operate', {
    form: { ids: body.ids, act },
  })
  return operationMessage(result.message)
}

export function normalizeProcessLog(value: unknown): ProcessLog {
  const object = objectValue(value)
  const content = typeof object?.data === 'string' ? object.data : undefined
  const modifiedAt = Number(object?.time)
  if (content === undefined || !Number.isFinite(modifiedAt)) {
    throw new ApiError(502, 'UPSTREAM_INVALID_PROCESS_LOG', '原 dnsmgr 返回了无法识别的任务日志')
  }
  return { content, modifiedAt }
}

export async function getCertificateOrderLog(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<ProcessLog> {
  const query = ProcessLogQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.logs', {
    form: { processid: query.processId },
  })
  return normalizeProcessLog(result.data)
}

export async function getCertificateArtifacts(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  orderId: number,
): Promise<CertificateArtifacts> {
  const result = await executeLegacyOperation(client, config, context, 'certificateOrders.info', {
    form: { id: orderId },
  })
  const data = objectValue(result.data)
  const id = Number(data?.id)
  const certificate = typeof data?.crt === 'string' ? data.crt : undefined
  const privateKey = typeof data?.key === 'string' ? data.key : undefined
  const pfxBase64 = typeof data?.pfx === 'string' ? data.pfx : undefined
  if (!Number.isSafeInteger(id) || id <= 0 || !certificate || !privateKey || !pfxBase64) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE', '原 dnsmgr 返回了无法识别的证书内容')
  }
  const issuedAt = stringValue(data?.issuetime)
  const expiresAt = stringValue(data?.expiretime)
  return {
    id,
    domains: stringArray(data?.domains),
    certificate,
    privateKey,
    pfxBase64,
    pfxPassword: '123456',
    ...(issuedAt ? { issuedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}
