import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { DnsRecord, DomainSummary, PageMeta } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml, requireUpstreamJson } from '../../upstream/legacy.js'
import { embeddedJsonAssignment, plainText } from './html-state.js'

const DomainSortMap = {
  id: 'id',
  name: 'name',
  recordCount: 'recordcount',
  addedAt: 'addtime',
  registeredAt: 'regtime',
  expiresAt: 'expiretime',
  noticeEnabled: 'is_notice',
  hidden: 'is_hide',
  domainLoginEnabled: 'is_sso',
  provider: 'typename',
  category: 'category_name',
  remark: 'remark',
} as const

const RecordSortMap = {
  name: 'Name',
  type: 'Type',
  line: 'LineName',
  value: 'Value',
  updatedAt: 'UpdateTime',
} as const

export const DomainsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
  accountId: z.coerce.number().int().positive().optional(),
  provider: z.string().trim().max(32).optional(),
  expiryStatus: z.enum(['expiring', 'expired']).optional(),
  categoryId: z.coerce.number().int().min(0).optional(),
  sort: z.enum(Object.keys(DomainSortMap) as [keyof typeof DomainSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export const RecordsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
  subdomain: z.string().trim().max(255).optional(),
  value: z.string().trim().max(2048).optional(),
  type: z.string().trim().max(32).optional(),
  line: z.string().trim().max(255).optional(),
  groupId: z.string().trim().max(255).optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
  sort: z.enum(Object.keys(RecordSortMap) as [keyof typeof RecordSortMap]).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
})

type LegacyRow = Record<string, unknown>

function stringParam(form: URLSearchParams, key: string, value: unknown) {
  if (value !== undefined && value !== null && value !== '') form.set(key, String(value))
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function legacyRows(payload: unknown): { rows: LegacyRow[]; total: number; clientPaged: boolean } {
  if (Array.isArray(payload)) {
    return {
      rows: payload.filter((row): row is LegacyRow => Boolean(row) && typeof row === 'object'),
      total: payload.length,
      clientPaged: true,
    }
  }

  if (!payload || typeof payload !== 'object') {
    throw new ApiError(502, 'UPSTREAM_INVALID_PAYLOAD', '原 dnsmgr 列表响应格式不兼容')
  }

  const object = payload as LegacyRow
  const sourceRows = Array.isArray(object.rows) ? object.rows : []
  const rows = sourceRows.filter((row): row is LegacyRow => Boolean(row) && typeof row === 'object')
  const numericTotal = numberValue(object.total)

  return {
    rows,
    total: numericTotal === undefined ? rows.length : Math.max(0, numericTotal),
    clientPaged: false,
  }
}

function pagedRows(
  payload: unknown,
  page: number,
  pageSize: number,
): { rows: LegacyRow[]; total: number } {
  const normalized = legacyRows(payload)
  if (!normalized.clientPaged) return normalized

  const offset = (page - 1) * pageSize
  return {
    rows: normalized.rows.slice(offset, offset + pageSize),
    total: normalized.total,
  }
}

function normalizeDomain(row: LegacyRow): DomainSummary {
  const id = numberValue(row.id)
  const name = optionalString(row.name)
  if (id === undefined || !Number.isInteger(id) || id <= 0 || !name) {
    throw new ApiError(502, 'UPSTREAM_INVALID_DOMAIN', '原 dnsmgr 返回了无法识别的域名数据')
  }

  const providerType = optionalString(row.type) ?? 'unknown'
  const providerLabel = providerType.toLowerCase() === 'cloudflare'
    ? 'CloudFlare'
    : optionalString(row.typename) ?? providerType
  const accountId = numberValue(row.aid)
  const accountLabel = optionalString(row.aremark)
  const checkStatus = numberValue(row.checkstatus)
  const expiryLookup = checkStatus === 0
    ? 'pending'
    : checkStatus === 1
      ? 'ready'
      : checkStatus === 2
        ? 'failed'
        : 'unknown'

  const recordCount = numberValue(row.recordcount)
  const addedAt = optionalString(row.addtime)
  const registeredAt = optionalString(row.regtime)
  const expiresAt = optionalString(row.expiretime)
  const category = optionalString(row.category_name)
  const categoryId = numberValue(row.cid)
  const remark = optionalString(row.remark)

  return {
    id,
    name,
    provider: {
      type: providerType,
      label: providerLabel,
      ...(accountId === undefined ? {} : { accountId }),
      ...(accountLabel ? { accountLabel } : {}),
    },
    recordCount: recordCount === undefined ? 0 : Math.max(0, Math.trunc(recordCount)),
    ...(addedAt ? { addedAt } : {}),
    ...(registeredAt ? { registeredAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    expiryLookup,
    noticeEnabled: booleanValue(row.is_notice),
    hidden: booleanValue(row.is_hide),
    ssoEnabled: booleanValue(row.is_sso),
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(category ? { category } : {}),
    ...(remark ? { remark } : {}),
  }
}

export function domainFromRecordPage(html: string, domainId: number): DomainSummary {
  if (/域名不存在/.test(plainText(html) ?? '')) {
    throw new ApiError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
  }

  const title = /<title\b[^>]*>\s*解析管理\s*-\s*([\s\S]*?)<\/title>/i.exec(html)
  const name = plainText(title?.[1])
  const rawConfig = embeddedJsonAssignment(html, 'dnsconfig')
  if (!name || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的域名解析页面格式不兼容')
  }

  const providerType = optionalString((rawConfig as LegacyRow).type)
  if (!providerType) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的域名解析页面缺少 DNS 服务商信息')
  }

  return {
    id: domainId,
    name,
    provider: {
      type: providerType,
      label: plainText((rawConfig as LegacyRow).name) ?? providerType,
    },
    recordCount: 0,
    expiryLookup: 'unknown',
    noticeEnabled: false,
    hidden: false,
    ssoEnabled: true,
  }
}

export function normalizeRecord(row: LegacyRow): DnsRecord {
  const id = optionalString(row.RecordId)
  if (!id) {
    throw new ApiError(502, 'UPSTREAM_INVALID_RECORD', '原 dnsmgr 返回了无法识别的解析记录')
  }

  const lineId = optionalString(row.Line) ?? ''
  const rawStatus = optionalString(row.Status)
  const ttl = numberValue(row.TTL)
  const mxPriority = numberValue(row.MX)
  const weight = numberValue(row.Weight)
  const mode = numberValue(row.Mode)
  const parentId = optionalString(row.ParentId ?? row.parentid)
  const childCount = numberValue(row.Count)
  const remark = optionalString(row.Remark)
  const updatedAt = optionalString(row.UpdateTime)

  const rawValues = Array.isArray(row.Value)
    ? row.Value.map((value) => optionalString(value) ?? '').filter(Boolean)
    : undefined
  const rawValue = rawValues?.join(',') ?? optionalString(row.Value) ?? ''

  return {
    id,
    name: optionalString(row.Name) ?? '@',
    type: optionalString(row.Type) ?? 'UNKNOWN',
    value: rawValue,
    ...(rawValues ? { values: rawValues } : {}),
    line: {
      id: lineId,
      label: optionalString(row.LineName) ?? (lineId || '默认'),
    },
    ...(ttl === undefined ? {} : { ttl }),
    ...(mxPriority === undefined ? {} : { mxPriority }),
    ...(weight === undefined ? {} : { weight }),
    ...(mode === undefined ? {} : { mode: Math.trunc(mode) }),
    ...(parentId ? { parentId } : {}),
    ...(childCount === undefined ? {} : { childCount: Math.max(0, Math.trunc(childCount)) }),
    ...(remark ? { remark } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    status: rawStatus === '1' ? 'enabled' : rawStatus === '0' ? 'disabled' : 'unknown',
  }
}

export async function listDomains(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: DomainSummary[]; meta: PageMeta }> {
  const query = DomainsQuerySchema.parse(rawQuery)
  const form = new URLSearchParams()
  form.set('offset', String((query.page - 1) * query.pageSize))
  form.set('limit', String(query.pageSize))
  form.set('sortName', DomainSortMap[query.sort])
  form.set('sortOrder', query.order)
  stringParam(form, 'kw', query.q)
  stringParam(form, 'aid', query.accountId)
  stringParam(form, 'type', query.provider)
  stringParam(form, 'status', query.expiryStatus === 'expiring' ? '1' : query.expiryStatus === 'expired' ? '2' : undefined)
  stringParam(form, 'cid', query.categoryId)

  const payload = requireUpstreamJson(
    await client.postForm('/domain/data', form, context),
    config,
  )
  const result = pagedRows(payload, query.page, query.pageSize)
  return {
    data: result.rows.map(normalizeDomain),
    meta: { page: query.page, pageSize: query.pageSize, total: result.total },
  }
}

export async function getDomain(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
): Promise<DomainSummary> {
  const form = new URLSearchParams({
    id: String(domainId),
    offset: '0',
    limit: '1',
  })
  const payload = requireUpstreamJson(
    await client.postForm('/domain/data', form, context),
    config,
  )
  const row = legacyRows(payload).rows[0]
  if (row) return normalizeDomain(row)

  // Domain-scoped quick-login sessions cannot access /domain/data in dnsmgr 1.0.5.1,
  // but they can access their permission-checked /record/:id page. Recover only the
  // minimal read-only context needed by the separated record-management screen.
  const html = requireUpstreamHtml(await client.getHtml(`/record/${domainId}`, context), config)
  return domainFromRecordPage(html, domainId)
}

export async function listRecords(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawQuery: unknown,
): Promise<{ data: DnsRecord[]; meta: PageMeta }> {
  const query = RecordsQuerySchema.parse(rawQuery)
  const form = new URLSearchParams()
  form.set('offset', String((query.page - 1) * query.pageSize))
  form.set('limit', String(query.pageSize))
  form.set('sortName', RecordSortMap[query.sort])
  form.set('sortOrder', query.order)
  stringParam(form, 'keyword', query.q)
  stringParam(form, 'subdomain', query.subdomain)
  stringParam(form, 'value', query.value)
  stringParam(form, 'type', query.type)
  stringParam(form, 'line', query.line)
  stringParam(form, 'groupid', query.groupId)
  stringParam(form, 'status', query.status === 'enabled' ? '1' : query.status === 'disabled' ? '0' : undefined)

  const payload = requireUpstreamJson(
    await client.postForm(`/record/data/${domainId}`, form, context),
    config,
  )
  const result = pagedRows(payload, query.page, query.pageSize)
  return {
    data: result.rows.map(normalizeRecord),
    meta: { page: query.page, pageSize: query.pageSize, total: result.total },
  }
}
