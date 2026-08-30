import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  DnsRecord,
  DomainAlias,
  DomainRecordLog,
  PageMeta,
  RecordGroup,
  RecordLine,
  RecordOptions,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { normalizeRecord } from './domains.js'
import { embeddedJsonAssignment, integerInputAttribute, plainText } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const RecordId = z.string().trim().min(1).max(1024)
const RecordName = z.string().trim().min(1).max(255)
const RecordType = z.string().trim().min(1).max(32).transform((value) => value.toUpperCase())
const RecordValue = z.string().trim().min(1).max(16_384)
const LineId = z.string().trim().min(1).max(255)

export const RecordSnapshotSchema = z.object({
  id: RecordId,
  name: RecordName,
  type: RecordType,
  value: RecordValue,
  lineId: LineId,
  ttl: z.coerce.number().int().min(0).max(2_147_483_647).default(600),
  mxPriority: z.coerce.number().int().min(0).max(65_535).default(1),
  weight: z.coerce.number().int().min(0).max(100).default(0),
  remark: z.string().trim().max(1000).nullable().optional(),
}).strict()

export const CreateRecordSchema = z.object({
  name: RecordName,
  type: RecordType,
  value: RecordValue,
  lineId: LineId,
  ttl: z.coerce.number().int().min(1).max(2_147_483_647).default(600),
  mxPriority: z.coerce.number().int().min(0).max(65_535).default(1),
  weight: z.coerce.number().int().min(0).max(100).default(0),
  remark: z.string().trim().max(1000).nullable().optional(),
}).strict()

export const UpdateRecordSchema = CreateRecordSchema.extend({
  current: RecordSnapshotSchema.optional(),
}).strict()

export const RecordStatusSchema = z.object({
  enabled: z.boolean(),
  current: RecordSnapshotSchema.optional(),
}).strict()

export const RecordRemarkSchema = z.object({
  remark: z.string().trim().max(1000).nullable(),
}).strict()

export const RecordCheckSchema = z.object({
  name: RecordName,
  type: RecordType,
  value: z.string().trim().max(16_384).default(''),
}).strict()

const SnapshotList = z.array(RecordSnapshotSchema).min(1).max(1000)

export const BatchRecordOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), enabled: z.boolean(), records: SnapshotList }).strict(),
  z.object({ action: z.literal('delete'), records: SnapshotList }).strict(),
  z.object({
    action: z.literal('remark'),
    remark: z.string().trim().max(1000).nullable(),
    records: SnapshotList,
  }).strict(),
  z.object({
    action: z.literal('group'),
    groupId: z.string().trim().max(255),
    records: SnapshotList,
  }).strict(),
  z.object({
    action: z.literal('value'),
    type: RecordType,
    value: RecordValue,
    records: SnapshotList,
  }).strict(),
  z.object({
    action: z.literal('line'),
    lineId: LineId,
    records: SnapshotList,
  }).strict(),
])

export const BulkCreateRecordsSchema = z.object({
  recordsText: z.string().trim().min(1).max(1024 * 1024),
  type: RecordType.optional(),
  lineId: LineId.nullable().optional(),
  ttl: z.coerce.number().int().min(1).max(2_147_483_647).default(600),
  mxPriority: z.coerce.number().int().min(0).max(65_535).default(1),
  remark: z.string().trim().max(1000).nullable().optional(),
  proxied: z.boolean().default(false),
}).strict()

export const QuickEditRecordSchema = z.object({
  name: RecordName,
  type: RecordType,
  value: RecordValue,
  ttl: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
  mxPriority: z.coerce.number().int().min(0).max(65_535).default(0),
}).strict()

export const RecordLookupQuerySchema = z.object({ name: RecordName }).strict()

export const RecordLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict()

export const WeightedSetsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
}).strict()

export const UpdateWeightedSetSchema = z.object({
  subdomain: RecordName,
  type: RecordType,
  lineId: LineId,
  enabled: z.boolean(),
  weights: z.record(RecordId, z.coerce.number().int().min(0).max(100)).default({}),
}).strict().superRefine((value, context) => {
  if (value.enabled && Object.keys(value.weights).length === 0) {
    context.addIssue({ code: 'custom', path: ['weights'], message: '启用权重时至少设置一条记录权重' })
  }
})

export const SetWeightedStatusSchema = z.object({
  subdomain: RecordName,
  enabled: z.boolean(),
  type: RecordType.optional(),
  lineId: LineId.optional(),
}).strict()

export const DomainAliasSchema = z.object({
  name: z.string().trim().min(1).max(253),
}).strict()

type LegacyObject = Record<string, unknown>

function objectValue(value: unknown): LegacyObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as LegacyObject
    : undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return undefined
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function boolValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function remarkMode(value: unknown): 'none' | 'separate' | 'inline' {
  return Number(value) === 1 ? 'separate' : Number(value) === 2 ? 'inline' : 'none'
}

function operationMessage(message: string | undefined) {
  return message ? { message } : {}
}

function legacySnapshot(snapshot: z.infer<typeof RecordSnapshotSchema>): LegacyObject {
  return {
    RecordId: snapshot.id,
    Name: snapshot.name,
    Type: snapshot.type,
    Value: snapshot.value,
    Line: snapshot.lineId,
    TTL: snapshot.ttl,
    MX: snapshot.mxPriority,
    Weight: snapshot.weight,
    Remark: snapshot.remark ?? '',
  }
}

function recordMutationForm(body: z.infer<typeof CreateRecordSchema>) {
  return {
    name: body.name,
    type: body.type,
    value: body.value,
    line: body.lineId,
    ttl: body.ttl,
    mx: body.mxPriority,
    weight: body.weight,
    remark: body.remark ?? '',
  }
}

export function recordOptionsFromHtml(html: string): RecordOptions {
  const rawLines = embeddedJsonAssignment(html, 'recordLine')
  const rawConfig = objectValue(embeddedJsonAssignment(html, 'dnsconfig'))
  if (!Array.isArray(rawLines) || !rawConfig) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的解析配置格式不兼容')
  }
  const lines = rawLines.flatMap((raw): RecordLine[] => {
    const line = objectValue(raw)
    const id = stringValue(line?.id)
    const label = plainText(line?.name)
    if (!line || id === undefined || !label) return []
    const parent = stringValue(line.parent)
    return [{ id, label, ...(parent ? { parent } : {}) }]
  })
  if (!lines.length) throw new ApiError(502, 'UPSTREAM_INVALID_RECORD_LINES', '原 dnsmgr 未返回可用解析线路')

  const providerType = stringValue(rawConfig.type) ?? 'unknown'
  const redirectRecords = boolValue(rawConfig.redirect)
  const recordTypes = ['A', 'CNAME', 'AAAA', 'NS', 'MX', 'SRV', 'TXT', 'CAA']
  if (redirectRecords) recordTypes.push('REDIRECT_URL', 'FORWARD_URL')
  if (providerType === 'powerdns') recordTypes.push('LOC', 'PTR', 'LUA')

  return {
    providerType,
    minTtl: Math.max(1, integerInputAttribute(html, 'ttl', 'min') ?? 1),
    lines,
    recordTypes,
    capabilities: {
      recordRemark: remarkMode(rawConfig.remark),
      recordStatus: boolValue(rawConfig.status),
      redirectRecords,
      recordLogs: boolValue(rawConfig.log),
      recordWeight: boolValue(rawConfig.weight),
      clientPaging: boolValue(rawConfig.page),
      recordSorting: boolValue(rawConfig.sort),
      recordGroups: providerType === 'aliyun' || providerType === 'dnspod',
      weightedSets: providerType === 'aliyun',
      domainAliases: providerType === 'dnspod',
      customHostnames: providerType === 'cloudflare',
    },
  }
}

export async function getRecordOptions(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
): Promise<RecordOptions> {
  const html = requireUpstreamHtml(await client.getHtml(`/record/${domainId}`, context), config)
  if (html.includes('域名不存在')) throw new ApiError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
  return recordOptionsFromHtml(html)
}

export async function createRecord(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = CreateRecordSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.create', {
    path: { domainId },
    form: recordMutationForm(body),
  })
  return operationMessage(result.message)
}

export async function updateRecord(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  recordId: string,
  rawBody: unknown,
) {
  const body = UpdateRecordSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.update', {
    path: { domainId },
    form: {
      recordid: recordId,
      ...recordMutationForm(body),
      ...(body.current ? { recordinfo: JSON.stringify(legacySnapshot(body.current)) } : {}),
    },
  })
  return operationMessage(result.message)
}

export async function deleteRecord(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  recordId: string,
) {
  const result = await executeLegacyOperation(client, config, context, 'records.delete', {
    path: { domainId },
    form: { recordid: recordId },
  })
  return operationMessage(result.message)
}

export async function setRecordStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  recordId: string,
  rawBody: unknown,
) {
  const body = RecordStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.setStatus', {
    path: { domainId },
    form: {
      recordid: recordId,
      status: body.enabled ? 1 : 0,
      ...(body.current ? { recordinfo: JSON.stringify(legacySnapshot(body.current)) } : {}),
    },
  })
  return operationMessage(result.message)
}

export async function setRecordRemark(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  recordId: string,
  rawBody: unknown,
) {
  const body = RecordRemarkSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.setRemark', {
    path: { domainId },
    form: { recordid: recordId, remark: body.remark ?? '' },
  })
  return operationMessage(result.message)
}

export async function checkRecord(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  recordId: string,
  rawBody: unknown,
) {
  const body = RecordCheckSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.check', {
    path: { domainId },
    form: { recordid: recordId, name: body.name, type: body.type, value: body.value },
  })
  const data = objectValue(result.data)
  if (!data) throw new ApiError(502, 'UPSTREAM_INVALID_RECORD_CHECK', '原 dnsmgr 返回了无法识别的检测结果')
  const status = stringValue(data.status)
  if (status !== 'active' && status !== 'mismatch' && status !== 'not_found') {
    throw new ApiError(502, 'UPSTREAM_INVALID_RECORD_CHECK', '原 dnsmgr 返回了无法识别的检测结果')
  }
  const actual = Array.isArray(data.actual)
    ? data.actual.flatMap((value): string[] => {
      const normalized = stringValue(value)
      return normalized ? [normalized] : []
    })
    : []
  const expected = stringValue(data.expected)
  const message = plainText(data.message)
  return {
    status,
    actual,
    ...(expected ? { expected } : {}),
    ...(message ? { message } : {}),
  }
}

export async function batchOperateRecords(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = BatchRecordOperationSchema.parse(rawBody)
  const recordinfo = JSON.stringify(body.records.map(legacySnapshot))
  let operationId: 'records.batchOperate' | 'records.batchEdit' = 'records.batchOperate'
  let form: Record<string, unknown>

  switch (body.action) {
    case 'status':
      form = { action: body.enabled ? 'open' : 'pause', recordinfo }
      break
    case 'delete':
      form = { action: 'delete', recordinfo }
      break
    case 'remark':
      form = { action: 'remark', recordinfo, remark: body.remark ?? '' }
      break
    case 'group':
      form = { action: 'group', recordinfo, groupid: body.groupId }
      break
    case 'value':
      operationId = 'records.batchEdit'
      form = { action: 'value', recordinfo, type: body.type, value: body.value }
      break
    case 'line':
      operationId = 'records.batchEdit'
      form = { action: 'line', recordinfo, line: body.lineId }
      break
  }

  const result = await executeLegacyOperation(client, config, context, operationId, {
    path: { domainId },
    form,
  })
  return operationMessage(result.message)
}

export async function bulkCreateRecords(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = BulkCreateRecordsSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.batchAdd', {
    path: { domainId },
    form: {
      record: body.recordsText,
      type: body.type ?? '',
      ...(body.lineId ? { line: body.lineId } : {}),
      ttl: body.ttl,
      mx: body.mxPriority,
      remark: body.remark ?? '',
      proxy: body.proxied,
    },
  })
  return operationMessage(result.message)
}

export async function quickEditRecordByName(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = QuickEditRecordSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'records.crossDomainBatchEdit', {
    form: {
      id: domainId,
      name: body.name,
      type: body.type,
      value: body.value,
      ttl: body.ttl,
      mx: body.mxPriority,
    },
  })
  return operationMessage(result.message)
}

export async function lookupRecords(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawQuery: unknown,
): Promise<DnsRecord[]> {
  const query = RecordLookupQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'records.lookup', {
    form: { id: domainId, rr: query.name },
  })
  const rows = Array.isArray(result.data)
    ? result.data.flatMap((row): LegacyObject[] => objectValue(row) ? [row as LegacyObject] : [])
    : []
  return rows.map(normalizeRecord)
}

export async function listRecordGroups(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
): Promise<RecordGroup[]> {
  const result = await executeLegacyOperation(client, config, context, 'records.groups', {
    path: { domainId },
  })
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.flatMap((raw): RecordGroup[] => {
    const row = objectValue(raw)
    const id = typeof row?.id === 'string'
      ? row.id.trim()
      : typeof row?.id === 'number' || typeof row?.id === 'bigint'
        ? String(row.id)
        : undefined
    const name = plainText(row?.name)
    return row && id !== undefined && name ? [{ id, name }] : []
  })
}

export async function listRecordLogs(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawQuery: unknown,
): Promise<{ data: DomainRecordLog[]; meta: PageMeta }> {
  const query = RecordLogsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'records.logs', {
    path: { domainId },
    form: { offset: (query.page - 1) * query.pageSize, limit: query.pageSize },
  })
  const rows = Array.isArray(result.data) ? result.data : []
  const data = rows.flatMap((raw): DomainRecordLog[] => {
    const row = objectValue(raw)
    const action = plainText(row?.data)
    if (!row || !action) return []
    const time = stringValue(row.time)
    return [{ ...(time ? { time } : {}), action }]
  })
  return {
    data,
    meta: { page: query.page, pageSize: query.pageSize, total: result.meta?.total ?? data.length },
  }
}

export type WeightedRecordSet = {
  id: string
  lookupName: string
  subdomain: string
  type: string
  recordCount: number
  enabled: boolean
  lineAlgorithms: Array<{ lineId: string; enabled: boolean }>
}

function normalizeWeightedSet(raw: unknown): WeightedRecordSet | undefined {
  const row = objectValue(raw)
  const id = stringValue(row?.id)
  const subdomain = stringValue(row?.SubDomain)
  const type = stringValue(row?.Type)
  if (!row || !id || !subdomain || !type) return undefined
  const algorithmsObject = objectValue(row.LineAlgorithms)
  const algorithms = Array.isArray(algorithmsObject?.LineAlgorithm)
    ? algorithmsObject.LineAlgorithm
    : algorithmsObject?.LineAlgorithm ? [algorithmsObject.LineAlgorithm] : []
  const lineAlgorithms = algorithms.flatMap((rawAlgorithm): Array<{ lineId: string; enabled: boolean }> => {
    const algorithm = objectValue(rawAlgorithm)
    const lineId = stringValue(algorithm?.Line)
    return algorithm && lineId !== undefined ? [{ lineId, enabled: boolValue(algorithm.Open) }] : []
  })
  const count = numberValue(row.RecordCount)
  return {
    id,
    lookupName: stringValue(row.rr) ?? subdomain,
    subdomain,
    type,
    recordCount: count === undefined ? 0 : Math.max(0, Math.trunc(count)),
    enabled: boolValue(row.Open),
    lineAlgorithms,
  }
}

export async function listWeightedRecordSets(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawQuery: unknown,
): Promise<{ data: WeightedRecordSet[]; meta: PageMeta }> {
  const query = WeightedSetsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'recordWeights.list', {
    path: { domainId },
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      ...(query.q ? { keyword: query.q } : {}),
    },
  })
  const rows = Array.isArray(result.data) ? result.data : []
  const data = rows.flatMap((row): WeightedRecordSet[] => {
    const normalized = normalizeWeightedSet(row)
    return normalized ? [normalized] : []
  })
  return {
    data,
    meta: { page: query.page, pageSize: query.pageSize, total: result.meta?.total ?? data.length },
  }
}

export async function updateWeightedRecordSet(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = UpdateWeightedSetSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'recordWeights.update', {
    path: { domainId },
    form: {
      subdomain: body.subdomain,
      status: body.enabled,
      type: body.type,
      line: body.lineId,
      weight: body.weights,
    },
  })
  return operationMessage(result.message)
}

export async function setWeightedRecordStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = SetWeightedStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'recordWeights.setStatus', {
    path: { domainId },
    form: {
      subdomain: body.subdomain,
      status: body.enabled,
      ...(body.type ? { type: body.type } : {}),
      ...(body.lineId ? { line: body.lineId } : {}),
    },
  })
  return operationMessage(result.message)
}

export function domainAliasesFromHtml(html: string): DomainAlias[] {
  const rows = Array.from(html.matchAll(/<tr\b[^>]*\bdata-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi))
  return rows.flatMap((match): DomainAlias[] => {
    const id = Number(match[1])
    const cells = Array.from((match[2] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi))
    const name = plainText(cells[0]?.[1])
    if (!Number.isSafeInteger(id) || id <= 0 || !name) return []
    const statusText = plainText(cells[1]?.[1]) ?? ''
    const status = statusText.includes('正常')
      ? 'active'
      : statusText.includes('封禁')
        ? 'blocked'
        : statusText.includes('DNS不正确')
          ? 'dns_error'
          : 'unknown'
    return [{ id, name, status }]
  })
}

export async function listDomainAliases(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
): Promise<DomainAlias[]> {
  const html = requireUpstreamHtml(await client.getHtml(`/record/alias/${domainId}`, context), config)
  if (html.includes('域名不存在')) throw new ApiError(404, 'DOMAIN_NOT_FOUND', '域名不存在')
  return domainAliasesFromHtml(html)
}

export async function createDomainAlias(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = DomainAliasSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domainAliases.create', {
    path: { domainId },
    form: { alias: body.name },
  })
  return operationMessage(result.message)
}

export async function deleteDomainAlias(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  aliasId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainAliases.delete', {
    path: { domainId },
    form: { alias_id: aliasId },
  })
  return operationMessage(result.message)
}
