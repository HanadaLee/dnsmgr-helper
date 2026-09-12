import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  AxisNowAccount,
  AxisNowDomain,
  AxisNowDomainOptions,
  AxisNowEip,
  AxisNowEipOptions,
  AxisNowRule,
  AxisNowRuleAutomation,
  AxisNowRuleAutomationLog,
  AxisNowRuleOptions,
  AxisNowRuleProbeStatus,
  AxisNowTag,
  PageMeta,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml, requireUpstreamJson } from '../../upstream/legacy.js'
import { toLegacyForm } from './operations.js'
import { embeddedJsonAssignment, plainText } from './html-state.js'

const UuidSchema = z.string().trim().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  'UUID 格式无效',
).transform((value) => value.toLowerCase())

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
  accountId: z.coerce.number().int().positive().optional(),
  sort: z.string().trim().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

const NullableText = z.string().trim().max(255).nullable().optional()
const AccountId = z.coerce.number().int().positive()

const AutomationPoolSchema = z.record(z.string().min(1).max(64), z.unknown())

export const AxisNowRuleAutomationMutationSchema = z.object({
  accountId: AccountId,
  ruleUuid: UuidSchema,
  tideEnabled: z.boolean().default(false),
  tideStart: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '潮汐开始时间格式无效').default('09:00'),
  tideEnd: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '潮汐结束时间格式无效').default('18:00'),
  tidePool: AutomationPoolSchema.nullable().optional(),
  failoverEnabled: z.boolean().default(false),
  failoverPool: AutomationPoolSchema.nullable().optional(),
  failureThreshold: z.coerce.number().int().min(1).max(10).default(3),
  checkIntervalMinutes: z.coerce.number().int().min(1).max(60).default(5),
}).strict().superRefine((value, context) => {
  if (value.tideEnabled && !value.tidePool) {
    context.addIssue({ code: 'custom', path: ['tidePool'], message: '开启潮汐调度时必须填写潮汐地址池' })
  }
  if (value.failoverEnabled && !value.failoverPool) {
    context.addIssue({ code: 'custom', path: ['failoverPool'], message: '开启备份调度时必须填写故障备份地址池' })
  }
  if (value.tideEnabled && value.tideStart === value.tideEnd) {
    context.addIssue({ code: 'custom', path: ['tideEnd'], message: '潮汐调度的开始和结束时间不能相同' })
  }
})

const AxisNowDomainFields = {
  accountId: AccountId,
  providerSource: z.enum(['platform', 'self-hosted']),
  dnsProviderUuid: UuidSchema,
  dnsZoneUuid: UuidSchema.nullable().optional(),
  recordType: z.enum(['A', 'CNAME']),
  name: z.string().trim().max(50).nullable().optional(),
  description: NullableText,
  shareDefault: z.boolean().optional(),
  exposeEips: z.boolean().optional(),
}

export const AxisNowDomainMutationSchema = z.object({
  ...AxisNowDomainFields,
  domain: z.string().trim().min(1).max(253),
}).strict()

export const AxisNowDomainUpdateMutationSchema = z.object(AxisNowDomainFields).strict()

export const AxisNowRuleMutationSchema = z.object({
  accountId: AccountId,
  domainUuid: UuidSchema,
  geoIsp: z.string().trim().min(1).max(255).default('default'),
  name: z.string().trim().max(100).nullable().optional(),
  description: NullableText,
  status: z.enum(['active', 'paused']).default('active'),
  poolType: z.enum(['all_valid_eips', 'eip_tag', 'eip', 'ip', 'domain']),
  poolValues: z.array(z.string().trim().min(1).max(253)).max(1000).default([]),
  advancedPool: z.string().trim().max(100_000).nullable().optional(),
  electionStrategy: z.enum(['random', 'priority_order', 'quality_optimized']),
  quantity: z.coerce.number().int().min(1).max(10),
  triggerInterval: z.union([z.literal(5), z.literal(10)]).default(5),
  ttl: z.coerce.number().int().min(0).max(2_592_000).default(0),
  edgeProbeTemplateUuid: UuidSchema.nullable().optional(),
}).strict()

export const AxisNowEipCreateSchema = z.object({
  accountId: AccountId,
  targetType: z.enum(['edge', 'cluster']),
  targetUuid: UuidSchema,
  tagUuids: z.array(UuidSchema).max(500).default([]),
  addresses: z.string().trim().min(1).max(100_000),
}).strict()

export const AxisNowEipUpdateSchema = z.object({
  accountId: AccountId,
  targetType: z.enum(['edge', 'cluster']),
  targetUuid: UuidSchema,
  tagUuids: z.array(UuidSchema).max(500).default([]),
  address: z.string().trim().min(1).max(255),
}).strict()

export const AxisNowEipDeleteSchema = z.object({
  accountId: AccountId,
  uuids: z.array(UuidSchema).min(1).max(1000),
}).strict()

export const AxisNowTagMutationSchema = z.object({
  accountId: AccountId,
  name: z.string().trim().min(1).max(50),
  description: NullableText,
}).strict()

type LegacyObject = Record<string, unknown>

const geoCountryKeys = ['country_code', 'countryCode', 'country'] as const
const geoProvinceKeys = [
  'province_code', 'provinceCode',
  'region_code', 'regionCode',
  'subdivision_code', 'subdivisionCode',
  'state_code', 'stateCode',
  'province', 'region', 'subdivision', 'state',
] as const
const geoValueKeys = ['code', 'value', 'id', 'name', 'label'] as const

function objectValue(value: unknown): LegacyObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as LegacyObject
    : undefined
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value.trim() : undefined
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return undefined
}

function nestedStringValues(value: unknown): string[] {
  const direct = stringValue(value)
  if (direct) return [direct]
  const object = objectValue(value)
  if (!object) return []
  return geoValueKeys.flatMap((key) => {
    const nested = stringValue(object[key])
    return nested ? [nested] : []
  })
}

function geoFieldValues(geo: LegacyObject, keys: readonly string[]): string[] {
  return keys.flatMap((key) => nestedStringValues(geo[key]))
}

function geoFieldValue(geo: LegacyObject, keys: readonly string[]): string | undefined {
  return geoFieldValues(geo, keys)[0]
}

function isSpecialRegionValue(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s_./-]+/g, '')
  return normalized === 'hk' || normalized === 'hkg' || normalized === 'hongkong' || normalized === '香港' || normalized === '91' || normalized === '910000' || normalized.includes('hongkong')
    || normalized === 'mo' || normalized === 'mac' || normalized === 'macao' || normalized === 'macau' || normalized === '澳门' || normalized === '92' || normalized === '920000' || normalized.includes('macao') || normalized.includes('macau')
    || normalized === 'tw' || normalized === 'twn' || normalized === 'taiwan' || normalized === '台湾' || normalized === '71' || normalized === '710000' || normalized.includes('taiwan')
    || normalized.endsWith('hk') || normalized.endsWith('mo') || normalized.endsWith('tw')
}

function geoProvinceValue(geo: LegacyObject): string | undefined {
  const values = geoFieldValues(geo, geoProvinceKeys)
  return values.find(isSpecialRegionValue) ?? values[0]
}

function geoFieldValueFromNested(geo: LegacyObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = nestedStringValues(geo[key])[0]
    if (value) return value
  }
  return undefined
}

function normalizeGeo(value: unknown): { countryCode?: string; provinceCode?: string; cityName?: string; ispName?: string } {
  const geo = objectValue(value) ?? {}
  const nested = [geo.geo, geo.location, geo.address, geo.region_info, geo.subdivision_info]
    .map((item) => objectValue(item))
    .find((item): item is LegacyObject => Boolean(item))
  const countryCode = geoFieldValue(geo, geoCountryKeys) ?? (nested ? geoFieldValue(nested, geoCountryKeys) : undefined)
  const provinceCandidates = [geoProvinceValue(geo), nested ? geoProvinceValue(nested) : undefined].filter((item): item is string => Boolean(item))
  const provinceCode = provinceCandidates.find(isSpecialRegionValue) ?? provinceCandidates[0]
  const cityName = geoFieldValueFromNested(geo, ['city_name', 'cityName', 'city']) ?? (nested ? geoFieldValueFromNested(nested, ['city_name', 'cityName', 'city']) : undefined)
  const ispName = geoFieldValueFromNested(geo, ['isp_name', 'ispName', 'isp']) ?? (nested ? geoFieldValueFromNested(nested, ['isp_name', 'ispName', 'isp']) : undefined)
  return {
    ...(countryCode ? { countryCode } : {}),
    ...(provinceCode ? { provinceCode } : {}),
    ...(cityName ? { cityName } : {}),
    ...(ispName ? { ispName } : {}),
  }
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function optionalNumberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => stringValue(item) ? [stringValue(item)!] : [])
    : []
}

function normalizeProbeStatuses(value: unknown): AxisNowRuleProbeStatus[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((value) => {
    const row = objectValue(value)
    const address = stringValue(row?.address)
    if (!row || !address) return []
    const status = stringValue(row.status) ?? ''
    return [{
      address,
      status,
    }]
  })
}

function requiredString(value: unknown, message: string): string {
  const result = stringValue(value)
  if (!result) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_DATA', message)
  return result
}

function upstreamError(payload: LegacyObject): never {
  const message = plainText(payload.msg) ?? plainText(payload.message) ?? 'AxisNow 操作失败'
  throw new ApiError(422, 'AXISNOW_OPERATION_FAILED', message, {
    upstreamCode: payload.code,
  })
}

async function getPayload(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  path: string,
): Promise<LegacyObject> {
  const payload = objectValue(requireUpstreamJson(await client.get(path, context), config))
  if (!payload) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_DATA', '原 dnsmgr 返回了无法识别的 AxisNow 数据')
  if ('code' in payload && Number(payload.code) !== 0) upstreamError(payload)
  return payload
}

async function postPayload(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  path: string,
  form: Record<string, unknown>,
): Promise<LegacyObject> {
  const result = await client.postForm(path, toLegacyForm(form), context)
  const payload = objectValue(requireUpstreamJson(result, config))
  if (!payload) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_DATA', '原 dnsmgr 返回了无法识别的 AxisNow 数据')
  if ('code' in payload && Number(payload.code) !== 0) upstreamError(payload)
  return payload
}

function operationResult(payload: LegacyObject): { message: string; data?: unknown } {
  const message = plainText(payload.msg) ?? plainText(payload.message) ?? '操作成功'
  return Object.hasOwn(payload, 'data') ? { message, data: payload.data } : { message }
}

function pageMeta(query: z.infer<typeof ListQuerySchema>, payload: LegacyObject, rows: unknown[]): PageMeta {
  return {
    page: query.page,
    pageSize: query.pageSize,
    total: numberValue(payload.total, rows.length),
  }
}

function listForm(query: z.infer<typeof ListQuerySchema>, allowedSort: ReadonlySet<string>) {
  return {
    offset: (query.page - 1) * query.pageSize,
    limit: query.pageSize,
    sortName: query.sort && allowedSort.has(query.sort) ? query.sort : '',
    sortOrder: query.order,
    ...(query.q ? { kw: query.q } : {}),
    ...(query.accountId ? { account_id: query.accountId } : {}),
  }
}

function normalizeDomain(value: unknown): AxisNowDomain {
  const row = objectValue(value)
  if (!row) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_DOMAIN', '原 dnsmgr 返回了无法识别的 AxisNow 调度域名')
  const providerSource = row.provider_source === 'platform' ? 'platform' : 'self-hosted'
  const recordType = String(row.record_type ?? '').toUpperCase() === 'CNAME' ? 'CNAME' : 'A'
  const dnsZoneUuid = stringValue(row.dns_zone_uuid)
  const providerType = stringValue(row.provider_type)
  const name = stringValue(row.name)
  const description = stringValue(row.description)
  const status = stringValue(row.status)
  const createdAt = stringValue(row.created_at)
  const updatedAt = stringValue(row.updated_at)
  return {
    uuid: requiredString(row.uuid, 'AxisNow 调度域名缺少 UUID'),
    accountId: numberValue(row.account_id),
    accountName: stringValue(row.account_name) ?? '-',
    domain: requiredString(row.domain, 'AxisNow 调度域名缺少域名'),
    providerSource,
    recordType,
    dnsProviderUuid: stringValue(row.dns_provider_uuid) ?? '',
    ...(dnsZoneUuid ? { dnsZoneUuid } : {}),
    ...(providerType ? { providerType } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    eipCount: numberValue(row.eips_count),
    ruleCount: numberValue(row.dns_rules_count),
    shareDefault: booleanValue(row.share_default),
    exposeEips: booleanValue(row.expose_eips),
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function normalizeRule(value: unknown): AxisNowRule {
  const row = objectValue(value)
  if (!row) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_RULE', '原 dnsmgr 返回了无法识别的 AxisNow 路由规则')
  const name = stringValue(row.name)
  const description = stringValue(row.description)
  const strategy = stringValue(row.strategy)
  const poolSummary = stringValue(row.pool_summary)
  const createdAt = stringValue(row.created_at)
  const updatedAt = stringValue(row.updated_at)
  const resolvedUpdatedAt = stringValue(row.resolved_updated_at)
  const probeTemplateUuid = stringValue(row.probe_template_uuid)
  const probeState = stringValue(row.probe_state)
  const automation = objectValue(row.automation)
  const automationActivePool = stringValue(automation?.active_pool)
  const automationFailoverState = stringValue(automation?.failover_state)
  const automationHealthState = stringValue(automation?.last_health_state)
  const automationLastError = stringValue(automation?.last_error)
  const poolGroups = Array.isArray(row.pool_groups)
    ? row.pool_groups.flatMap((value) => {
      const group = objectValue(value)
      if (!group) return []
      return [{
        type: stringValue(group.type) ?? 'unknown',
        typeName: stringValue(group.type_name) ?? '地址',
        count: numberValue(group.count),
        items: stringList(group.items),
      }]
    })
    : []
  const normalizeAddresses = (value: unknown) => Array.isArray(value)
    ? value.flatMap((value) => {
      const address = objectValue(value)
      const addressValue = stringValue(address?.address)
      if (!address || !addressValue) return []
      const score = optionalNumberValue(address.score)
      const addressStatus = stringValue(address.status)
      const addressGeo = normalizeGeo(address)
      const ispName = addressGeo.ispName
      const providerName = stringValue(address.provider_name)
      return [{
        address: addressValue,
        ...(score !== undefined ? { score } : {}),
        ...(addressStatus ? { status: addressStatus } : {}),
        qualityFiltered: booleanValue(address.quality_filtered),
        ...(addressGeo.countryCode ? { countryCode: addressGeo.countryCode } : {}),
        ...(addressGeo.provinceCode ? { provinceCode: addressGeo.provinceCode } : {}),
        ...(ispName ? { ispName } : {}),
        ...(providerName ? { providerName } : {}),
        tagNames: stringList(address.tag_names),
      }]
    })
    : []
  const poolAddresses = normalizeAddresses(row.pool_addresses)
  const resolvedAddresses = normalizeAddresses(row.resolved_addresses)
  const strategyQuantity = optionalNumberValue(row.strategy_quantity)
  const strategyInterval = optionalNumberValue(row.strategy_interval)
  return {
    uuid: requiredString(row.uuid, 'AxisNow 路由规则缺少 UUID'),
    accountId: numberValue(row.account_id),
    accountName: stringValue(row.account_name) ?? '-',
    domainUuid: stringValue(row.dns_domain_uuid) ?? '',
    type: stringValue(row.type) ?? '-',
    geoIsp: stringValue(row.geo_isp) ?? 'default',
    geoIspName: stringValue(row.geo_isp_name) ?? stringValue(row.geo_isp) ?? '默认线路',
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    status: row.status === 'paused' ? 'paused' : 'active',
    ...(strategy ? { strategy } : {}),
    ...(poolSummary ? { poolSummary } : {}),
    poolGroups,
    poolAddresses,
    poolAddressCount: numberValue(row.pool_address_count),
    poolTruncated: booleanValue(row.pool_truncated),
    ...(strategyQuantity !== undefined ? { strategyQuantity } : {}),
    ...(strategyInterval !== undefined ? { strategyInterval } : {}),
    resolvedAddresses,
    probeStatuses: normalizeProbeStatuses(row.probe_statuses),
    ...(probeTemplateUuid ? { probeTemplateUuid } : {}),
    ...(probeState ? { probeState } : {}),
    action: objectValue(row.action) ?? {},
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(resolvedUpdatedAt ? { resolvedUpdatedAt } : {}),
    ...(automation ? {
      automation: {
        configured: booleanValue(automation.configured),
        ...(automation.tide_enabled !== undefined ? { tideEnabled: booleanValue(automation.tide_enabled) } : {}),
        ...(automation.failover_enabled !== undefined ? { failoverEnabled: booleanValue(automation.failover_enabled) } : {}),
        ...(automationActivePool ? { activePool: automationActivePool } : {}),
        ...(automationFailoverState ? { failoverState: automationFailoverState } : {}),
        ...(automation.fail_count !== undefined ? { failCount: numberValue(automation.fail_count) } : {}),
        ...(automation.failure_threshold !== undefined ? { failureThreshold: numberValue(automation.failure_threshold) } : {}),
        ...(automationHealthState ? { lastHealthState: automationHealthState } : {}),
        ...(automation.last_switch_at !== undefined ? { lastSwitchAt: numberValue(automation.last_switch_at) } : {}),
        ...(automationLastError ? { lastError: automationLastError } : {}),
      },
    } : {}),
  }
}

function normalizeAutomationLog(value: unknown): AxisNowRuleAutomationLog {
  const row = objectValue(value) ?? {}
  const status = stringValue(row.status)
  const createdAt = stringValue(row.created_at)
  return {
    id: numberValue(row.id),
    action: stringValue(row.action) ?? 'unknown',
    status: status === 'success' ? 'success' : status === 'failed' ? 'failed' : 'unknown',
    message: stringValue(row.message) ?? '',
    ...(createdAt ? { createdAt } : {}),
  }
}

function normalizeAutomation(value: unknown): AxisNowRuleAutomation {
  const row = objectValue(value)
  if (!row) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_AUTOMATION', '原 dnsmgr 返回了无法识别的 AxisNow 自动调度配置')
  const primaryPool = objectValue(row.primary_pool)
  if (!primaryPool) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_AUTOMATION', 'AxisNow 自动调度缺少主地址池')
  const tidePool = objectValue(row.tide_pool)
  const failoverPool = objectValue(row.failover_pool)
  const probeTemplateUuid = stringValue(row.probe_template_uuid)
  const probeState = stringValue(row.probe_state)
  const logs = Array.isArray(row.logs) ? row.logs.map(normalizeAutomationLog) : []
  const ruleType = stringValue(row.rule_type) ?? 'A'
  return {
    configured: booleanValue(row.configured),
    ruleUuid: requiredString(row.rule_uuid, 'AxisNow 自动调度缺少规则 UUID'),
    domainUuid: requiredString(row.domain_uuid, 'AxisNow 自动调度缺少域名 UUID'),
    ruleType,
    geoIsp: stringValue(row.geo_isp) ?? 'default',
    primaryPool,
    tideEnabled: booleanValue(row.tide_enabled),
    tideStart: stringValue(row.tide_start) ?? '09:00',
    tideEnd: stringValue(row.tide_end) ?? '18:00',
    ...(tidePool ? { tidePool } : {}),
    failoverEnabled: booleanValue(row.failover_enabled),
    ...(failoverPool ? { failoverPool } : {}),
    failureThreshold: numberValue(row.failure_threshold, 3),
    checkIntervalMinutes: Math.max(1, numberValue(row.check_interval_minutes, 5)),
    activePool: stringValue(row.active_pool) ?? 'primary',
    failoverState: stringValue(row.failover_state) ?? 'armed',
    failCount: numberValue(row.fail_count),
    lastCheckAt: numberValue(row.last_check_at),
    lastHealthState: stringValue(row.last_health_state) ?? '',
    lastSwitchAt: numberValue(row.last_switch_at),
    lastError: stringValue(row.last_error) ?? '',
    hasProbeTemplate: booleanValue(row.has_probe_template),
    probeStatuses: normalizeProbeStatuses(row.probe_statuses),
    ...(probeTemplateUuid ? { probeTemplateUuid } : {}),
    ...(probeState ? { probeState } : {}),
    logs,
  }
}

function normalizeEip(value: unknown): AxisNowEip {
  const row = objectValue(value)
  if (!row) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_EIP', '原 dnsmgr 返回了无法识别的 AxisNow EIP')
  const geo = normalizeGeo(row.geo ?? row)
  const edgeUuid = stringValue(row.edge_uuid)
  const clusterUuid = stringValue(row.cluster_uuid)
  const subscriptionStatus = stringValue(row.subscription_status)
  const createdAt = stringValue(row.created_at)
  const updatedAt = stringValue(row.updated_at)
  return {
    uuid: requiredString(row.uuid, 'AxisNow EIP 缺少 UUID'),
    accountId: numberValue(row.account_id),
    accountName: stringValue(row.account_name) ?? '-',
    address: requiredString(row.address, 'AxisNow EIP 缺少地址'),
    canManage: row.can_manage === undefined ? true : booleanValue(row.can_manage),
    dataOrigin: row.data_origin === 'subscribed' ? 'subscribed' : 'own',
    ownerType: row.owner_type === 'cluster' ? 'cluster' : 'edge',
    ...(edgeUuid ? { edgeUuid } : {}),
    ...(clusterUuid ? { clusterUuid } : {}),
    tagUuids: stringList(row.tag_uuids),
    tagNames: stringList(row.tag_names),
    referencedCount: numberValue(row.routing_referenced_count),
    providerName: stringValue(row.provider_name) ?? '-',
    geo,
    ...(subscriptionStatus ? { subscriptionStatus } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function normalizeTag(value: unknown): AxisNowTag {
  const row = objectValue(value)
  if (!row) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_TAG', '原 dnsmgr 返回了无法识别的 AxisNow 标签')
  const description = stringValue(row.description)
  const createdAt = stringValue(row.created_at)
  const updatedAt = stringValue(row.updated_at)
  return {
    uuid: requiredString(row.uuid, 'AxisNow 标签缺少 UUID'),
    accountId: numberValue(row.account_id),
    accountName: stringValue(row.account_name) ?? '-',
    name: requiredString(row.name, 'AxisNow 标签缺少名称'),
    ...(description ? { description } : {}),
    boundCount: numberValue(row.bound_count),
    referencedCount: numberValue(row.referenced_count),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function normalizeSimpleOption(value: unknown) {
  const row = objectValue(value) ?? {}
  const description = stringValue(row.description)
  return {
    uuid: stringValue(row.uuid) ?? '',
    name: stringValue(row.name) ?? stringValue(row.address) ?? '-',
    ...(description ? { description } : {}),
  }
}

function normalizeProvider(value: unknown) {
  const row = objectValue(value) ?? {}
  const zones = Array.isArray(row.zones) ? row.zones.map((value) => {
    const zone = objectValue(value) ?? {}
    const conf = objectValue(zone.conf) ?? {}
    const name = stringValue(zone.name)
    return {
      uuid: stringValue(zone.uuid) ?? '',
      zone: stringValue(zone.zone) ?? stringValue(conf.zone) ?? stringValue(zone.name) ?? '',
      ...(name ? { name } : {}),
    }
  }).filter((zone) => zone.uuid && zone.zone) : []
  return {
    uuid: stringValue(row.uuid) ?? '',
    name: stringValue(row.name) ?? stringValue(row.type) ?? '-',
    type: stringValue(row.type) ?? '',
    source: row.source === 'platform' ? 'platform' as const : 'self-hosted' as const,
    zones,
  }
}

export async function listAxisNowAccounts(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<AxisNowAccount[]> {
  const html = requireUpstreamHtml(await client.getHtml('/axisnow/domains', context), config)
  const raw = embeddedJsonAssignment(html, 'axisnowAccounts')
  if (!Array.isArray(raw)) throw new ApiError(502, 'UPSTREAM_INVALID_AXISNOW_ACCOUNTS', '原 dnsmgr 返回了无法识别的 AxisNow 平台账户')
  return raw.flatMap((value) => {
    const row = objectValue(value)
    const id = numberValue(row?.id)
    const name = stringValue(row?.name)
    return id > 0 && name ? [{ id, name }] : []
  })
}

export async function listAxisNowDomains(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
) {
  const query = ListQuerySchema.parse(rawQuery)
  const payload = await postPayload(client, config, context, '/axisnow/domains/data', listForm(query, new Set(['domain', 'account_name', 'updated_at'])))
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  return { data: rows.map(normalizeDomain), meta: pageMeta(query, payload, rows) }
}

export async function getAxisNowDomain(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawUuid: string,
): Promise<AxisNowDomain> {
  const uuid = UuidSchema.parse(rawUuid)
  for (let offset = 0; offset < 100_000; offset += 200) {
    const payload = await postPayload(client, config, context, '/axisnow/domains/data', {
      offset,
      limit: 200,
      account_id: AccountId.parse(accountId),
    })
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    const found = rows.find((row) => stringValue(objectValue(row)?.uuid)?.toLowerCase() === uuid)
    if (found) return normalizeDomain(found)
    if (rows.length < 200) break
  }
  throw new ApiError(404, 'AXISNOW_DOMAIN_NOT_FOUND', 'AxisNow 调度域名不存在')
}

function domainForm(body: z.infer<typeof AxisNowDomainUpdateMutationSchema>, domain: string) {
  return {
    account_id: body.accountId,
    domain,
    provider_source: body.providerSource,
    dns_provider_uuid: body.dnsProviderUuid,
    dns_zone_uuid: body.dnsZoneUuid ?? '',
    record_type: body.recordType,
    name: body.name ?? '',
    description: body.description ?? '',
    share_default: body.shareDefault ?? false,
    expose_eips: body.exposeEips ?? false,
  }
}

export async function createAxisNowDomain(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawBody: unknown) {
  const body = AxisNowDomainMutationSchema.parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/domains/create', domainForm(body, body.domain)))
}

export async function updateAxisNowDomain(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawUuid: string, rawBody: unknown) {
  const uuid = UuidSchema.parse(rawUuid)
  const body = AxisNowDomainUpdateMutationSchema.parse(rawBody)
  const current = await getAxisNowDomain(client, config, context, body.accountId, uuid)
  return operationResult(await postPayload(client, config, context, '/axisnow/domains/update', { uuid, ...domainForm(body, current.domain) }))
}

export async function deleteAxisNowDomain(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, rawUuid: string) {
  return operationResult(await postPayload(client, config, context, '/axisnow/domains/delete', { account_id: AccountId.parse(accountId), uuid: UuidSchema.parse(rawUuid) }))
}

export async function getAxisNowOptions(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawQuery: unknown,
): Promise<AxisNowDomainOptions | AxisNowEipOptions | AxisNowRuleOptions> {
  const query = z.object({
    scope: z.enum(['domain', 'eip', 'rule']),
    domainUuid: UuidSchema.optional(),
  }).strict().parse(rawQuery)
  if (query.scope === 'rule' && !query.domainUuid) throw new ApiError(422, 'VALIDATION_ERROR', '路由规则选项缺少域名 UUID')
  const search = new URLSearchParams({ scope: query.scope })
  if (query.domainUuid) search.set('domain_uuid', query.domainUuid)
  const payload = await getPayload(client, config, context, `/axisnow/options/${AccountId.parse(accountId)}?${search}`)
  const data = objectValue(payload.data) ?? {}
  if (query.scope === 'domain') {
    return {
      providers: (Array.isArray(data.providers) ? data.providers : []).map(normalizeProvider),
      systemProviders: (Array.isArray(data.system_providers) ? data.system_providers : []).map(normalizeProvider),
    }
  }
  if (query.scope === 'eip') {
    return {
      edges: (Array.isArray(data.edges) ? data.edges : []).map(normalizeSimpleOption),
      clusters: (Array.isArray(data.clusters) ? data.clusters : []).map(normalizeSimpleOption),
      tags: (Array.isArray(data.tags) ? data.tags : []).map(normalizeSimpleOption),
    }
  }
  return {
    eips: (Array.isArray(data.eips) ? data.eips : []).map(normalizeSimpleOption),
    tags: (Array.isArray(data.tags) ? data.tags : []).map(normalizeSimpleOption),
    probeTemplates: (Array.isArray(data.probe_templates) ? data.probe_templates : []).map(normalizeSimpleOption),
    geoIspOptions: (Array.isArray(data.geo_isp_options) ? data.geo_isp_options : []).map((value) => {
      const row = objectValue(value) ?? {}
      return {
        value: stringValue(row.value) ?? 'default',
        name: stringValue(row.name) ?? stringValue(row.value) ?? '默认线路',
        depth: numberValue(row.depth),
        disabled: booleanValue(row.disabled),
      }
    }),
  }
}

export async function listAxisNowRules(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, domainUuid: string, rawQuery: unknown) {
  const query = ListQuerySchema.omit({ accountId: true }).parse(rawQuery)
  const payload = await postPayload(client, config, context, `/axisnow/rules/data/${AccountId.parse(accountId)}/${UuidSchema.parse(domainUuid)}`, listForm(query, new Set(['updated_at'])))
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  return { data: rows.map(normalizeRule), meta: pageMeta(query, payload, rows) }
}

export async function getAxisNowRule(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, rawUuid: string) {
  const payload = await getPayload(client, config, context, `/axisnow/rules/get/${AccountId.parse(accountId)}/${UuidSchema.parse(rawUuid)}`)
  return normalizeRule(payload.data)
}

function ruleForm(rawBody: unknown) {
  const body = AxisNowRuleMutationSchema.parse(rawBody)
  const form: Record<string, unknown> = {
    account_id: body.accountId,
    domain_uuid: body.domainUuid,
    geo_isp: body.geoIsp,
    description: body.description ?? '',
    status: body.status,
    pool_type: body.poolType,
    pool_values: body.poolValues,
    advanced_pool: body.advancedPool ?? '',
    election_strategy: body.electionStrategy,
    quantity: body.quantity,
    trigger_interval: body.triggerInterval,
    ttl: body.ttl,
    edge_probe_template_uuid: body.edgeProbeTemplateUuid ?? '',
  }
  if (body.name !== undefined) form.name = body.name ?? ''
  return form
}

export async function createAxisNowRule(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawBody: unknown) {
  return operationResult(await postPayload(client, config, context, '/axisnow/rules/save', ruleForm(rawBody)))
}

export async function updateAxisNowRule(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawUuid: string, rawBody: unknown) {
  return operationResult(await postPayload(client, config, context, '/axisnow/rules/save', { uuid: UuidSchema.parse(rawUuid), ...ruleForm(rawBody) }))
}

export async function setAxisNowRuleStatus(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, rawUuid: string, rawBody: unknown) {
  const body = z.object({ status: z.enum(['active', 'paused']) }).strict().parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/rules/status', { account_id: AccountId.parse(accountId), uuid: UuidSchema.parse(rawUuid), status: body.status }))
}

export async function deleteAxisNowRule(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, rawUuid: string) {
  return operationResult(await postPayload(client, config, context, '/axisnow/rules/delete', { account_id: AccountId.parse(accountId), uuid: UuidSchema.parse(rawUuid) }))
}

export async function getAxisNowRuleAutomation(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawUuid: string,
): Promise<AxisNowRuleAutomation> {
  const payload = await getPayload(
    client,
    config,
    context,
    `/axisnow/rules/automation/${AccountId.parse(accountId)}/${UuidSchema.parse(rawUuid)}`,
  )
  return normalizeAutomation(payload.data)
}

export async function saveAxisNowRuleAutomation(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawUuid: string,
  rawBody: unknown,
) {
  const body = AxisNowRuleAutomationMutationSchema.parse({
    ...(rawBody && typeof rawBody === 'object' ? rawBody : {}),
    accountId,
    ruleUuid: rawUuid,
  })
  return operationResult(await postPayload(client, config, context, '/axisnow/rules/automation/save', {
    account_id: body.accountId,
    rule_uuid: body.ruleUuid,
    tide_enabled: body.tideEnabled,
    tide_start: body.tideStart,
    tide_end: body.tideEnd,
    tide_pool: body.tidePool ? JSON.stringify(body.tidePool) : '',
    failover_enabled: body.failoverEnabled,
    failover_pool: body.failoverPool ? JSON.stringify(body.failoverPool) : '',
    failure_threshold: body.failureThreshold,
    check_interval_minutes: body.checkIntervalMinutes,
  }))
}

export async function restoreAxisNowRuleAutomation(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawUuid: string,
) {
  return operationResult(await postPayload(client, config, context, '/axisnow/rules/automation/restore', {
    account_id: AccountId.parse(accountId),
    rule_uuid: UuidSchema.parse(rawUuid),
  }))
}

export async function listAxisNowEips(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawQuery: unknown) {
  const query = ListQuerySchema.parse(rawQuery)
  const payload = await postPayload(client, config, context, '/axisnow/eips/data', listForm(query, new Set(['address', 'account_name', 'routing_referenced_count', 'updated_at'])))
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  return { data: rows.map(normalizeEip), meta: pageMeta(query, payload, rows) }
}

export async function createAxisNowEips(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawBody: unknown) {
  const body = AxisNowEipCreateSchema.parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/eips/create', { account_id: body.accountId, target_type: body.targetType, target_uuid: body.targetUuid, tag_uuids: body.tagUuids, addresses: body.addresses }))
}

export async function updateAxisNowEip(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawUuid: string, rawBody: unknown) {
  const body = AxisNowEipUpdateSchema.parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/eips/update', { account_id: body.accountId, uuid: UuidSchema.parse(rawUuid), target_type: body.targetType, target_uuid: body.targetUuid, tag_uuids: body.tagUuids, address: body.address }))
}

export async function deleteAxisNowEips(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawBody: unknown) {
  const body = AxisNowEipDeleteSchema.parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/eips/delete', { account_id: body.accountId, uuids: body.uuids }))
}

export async function listAxisNowTags(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawQuery: unknown) {
  const query = ListQuerySchema.parse(rawQuery)
  const payload = await postPayload(client, config, context, '/axisnow/tags/data', listForm(query, new Set(['name', 'account_name', 'bound_count', 'referenced_count', 'updated_at'])))
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  return { data: rows.map(normalizeTag), meta: pageMeta(query, payload, rows) }
}

export async function getAxisNowTag(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, rawUuid: string) {
  const query = new URLSearchParams({ account_id: String(AccountId.parse(accountId)), uuid: UuidSchema.parse(rawUuid) })
  const payload = await getPayload(client, config, context, `/axisnow/tags/edit?${query}`)
  return normalizeTag({ ...objectValue(payload.data), account_id: accountId })
}

export async function createAxisNowTag(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawBody: unknown) {
  const body = AxisNowTagMutationSchema.parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/tags/save', { account_id: body.accountId, name: body.name, description: body.description ?? '' }))
}

export async function updateAxisNowTag(client: DnsmgrClient, config: AppConfig, context: RequestContext, rawUuid: string, rawBody: unknown) {
  const body = AxisNowTagMutationSchema.parse(rawBody)
  return operationResult(await postPayload(client, config, context, '/axisnow/tags/save', { account_id: body.accountId, uuid: UuidSchema.parse(rawUuid), name: body.name, description: body.description ?? '' }))
}

export async function deleteAxisNowTag(client: DnsmgrClient, config: AppConfig, context: RequestContext, accountId: number, rawUuid: string) {
  return operationResult(await postPayload(client, config, context, '/axisnow/tags/delete', { account_id: AccountId.parse(accountId), uuid: UuidSchema.parse(rawUuid) }))
}
