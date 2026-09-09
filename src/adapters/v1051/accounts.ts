import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  DnsProviderDefinition,
  DomainAccountDetail,
  DomainAccountSummary,
  PageMeta,
  ProviderField,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { normalizeFieldOptions } from './dynamic-fields.js'
import { embeddedJsonAssignment, plainText } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const AccountSortMap = {
  id: 'id',
  provider: 'typename',
  name: 'name',
  remark: 'remark',
  addedAt: 'addtime',
} as const

export const DomainAccountsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
  sort: z.enum(Object.keys(AccountSortMap) as [keyof typeof AccountSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

const JsonObjectSchema = z.record(z.string().min(1).max(255), z.unknown())

export const DomainAccountMutationSchema = z.object({
  providerType: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  config: JsonObjectSchema,
  remark: z.string().trim().max(1000).nullable().optional(),
}).strict()

export const AvailableDomainsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
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

function safeIcon(value: unknown): string | undefined {
  const icon = stringValue(value)
  if (!icon || icon.includes('/') || icon.includes('\\') || icon.includes('..') || icon.length > 255) return undefined
  return icon
}

function providerLabel(type: string, label: string): string {
  return type.toLowerCase() === 'cloudflare' ? 'CloudFlare' : label
}

const UnsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

type JsonState = { count: number }

function safeJsonValue(value: unknown, state: JsonState, depth = 0): unknown {
  if (depth > 8) throw new ApiError(422, 'VALIDATION_ERROR', '账户配置嵌套层级过深')
  if (state.count >= 10_000) throw new ApiError(413, 'CONFIG_TOO_LARGE', '账户配置字段数量过多')
  state.count += 1

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiError(422, 'VALIDATION_ERROR', '账户配置包含无效数字')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => safeJsonValue(item, state, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value as LegacyObject)) {
      if (!key || key.length > 255 || key.includes('\0') || UnsafeKeys.has(key)) {
        throw new ApiError(422, 'VALIDATION_ERROR', '账户配置字段名称不合法')
      }
      result[key] = safeJsonValue(item, state, depth + 1)
    }
    return result
  }
  throw new ApiError(422, 'VALIDATION_ERROR', '账户配置包含不支持的值')
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  const object = objectValue(value)
  if (!object) throw new ApiError(422, 'VALIDATION_ERROR', '账户配置必须是对象')
  return safeJsonValue(object, { count: 0 }) as Record<string, unknown>
}

function providerRemarkMode(value: unknown): 'none' | 'separate' | 'inline' {
  return Number(value) === 1 ? 'separate' : Number(value) === 2 ? 'inline' : 'none'
}

function sensitiveField(key: string, label: string): boolean {
  const name = `${key} ${label}`.toLowerCase()
  return /(secret|password|passwd|token|private|credential|密码|密钥)/.test(name)
    || /(^|[_\s-])(api[_\s-]?key|sk)([_\s-]|$)/.test(name)
}

function providerField(key: string, raw: unknown): ProviderField | undefined {
  const field = objectValue(raw)
  if (!field || UnsafeKeys.has(key) || !key || key.length > 255) return undefined
  const control = stringValue(field.type)
  if (!control || !['input', 'textarea', 'select', 'radio', 'checkbox', 'checkboxes'].includes(control)) {
    return undefined
  }
  const label = plainText(field.name) ?? key
  const placeholder = plainText(field.placeholder)
  const note = plainText(field.note)
  const validator = stringValue(field.validator)
  const min = numberValue(field.min)
  const max = numberValue(field.max)
  const options = normalizeFieldOptions(field.options)
  let defaultValue: unknown
  if (Object.hasOwn(field, 'value')) {
    try {
      defaultValue = safeJsonValue(field.value, { count: 0 })
    } catch {
      defaultValue = undefined
    }
  }

  return {
    key,
    label,
    control: control as ProviderField['control'],
    required: boolValue(field.required),
    disabled: boolValue(field.disabled),
    sensitive: sensitiveField(key, label),
    ...(placeholder ? { placeholder } : {}),
    ...(note ? { note } : {}),
    ...(validator ? { validator } : {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(options ? { options } : {}),
  }
}

function providerDefinition(type: string, raw: unknown): DnsProviderDefinition | undefined {
  const provider = objectValue(raw)
  if (!provider || !/^[A-Za-z0-9_-]{1,64}$/.test(type)) return undefined
  const label = plainText(provider.name)
  if (!label) return undefined
  const config = objectValue(provider.config) ?? {}
  const fields = Object.entries(config).flatMap(([key, field]) => {
    const normalized = providerField(key, field)
    return normalized ? [normalized] : []
  })
  const icon = safeIcon(provider.icon)
  const note = plainText(provider.note)

  return {
    type,
    label: providerLabel(type, label),
    ...(icon ? { icon } : {}),
    ...(note ? { note } : {}),
    fields,
    capabilities: {
      recordRemark: providerRemarkMode(provider.remark),
      recordStatus: boolValue(provider.status),
      redirectRecords: boolValue(provider.redirect),
      recordLogs: boolValue(provider.log),
      recordWeight: boolValue(provider.weight),
      clientPaging: boolValue(provider.page),
      domainCreation: boolValue(provider.add),
      recordSorting: boolValue(provider.sort),
    },
  }
}

export function providerDefinitionsFromHtml(html: string): DnsProviderDefinition[] {
  const definitions = objectValue(embeddedJsonAssignment(html, 'typeList'))
  if (!definitions) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的域名账户类型格式不兼容')
  }
  return Object.entries(definitions).flatMap(([type, provider]) => {
    const normalized = providerDefinition(type, provider)
    return normalized ? [normalized] : []
  })
}

function normalizeAccount(row: LegacyObject): DomainAccountSummary {
  const id = numberValue(row.id)
  const name = stringValue(row.name)
  const type = stringValue(row.type)
  if (!id || !Number.isInteger(id) || id <= 0 || !name || !type) {
    throw new ApiError(502, 'UPSTREAM_INVALID_ACCOUNT', '原 dnsmgr 返回了无法识别的域名账户')
  }
  const label = providerLabel(type, plainText(row.typename) ?? type)
  const icon = safeIcon(row.icon)
  const remark = stringValue(row.remark)
  const addedAt = stringValue(row.addtime)
  return {
    id,
    provider: { type, label, ...(icon ? { icon } : {}) },
    name,
    ...(remark ? { remark } : {}),
    ...(addedAt ? { addedAt } : {}),
  }
}

export async function listDomainAccounts(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: DomainAccountSummary[]; meta: PageMeta }> {
  const query = DomainAccountsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'domainAccounts.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: AccountSortMap[query.sort],
      sortOrder: query.order,
      ...(query.q ? { kw: query.q } : {}),
    },
  })
  const rows = Array.isArray(result.data)
    ? result.data.filter((row): row is LegacyObject => Boolean(objectValue(row)))
    : []
  return {
    data: rows.map(normalizeAccount),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total: result.meta?.total ?? rows.length,
    },
  }
}

export async function getDnsProviderDefinitions(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<DnsProviderDefinition[]> {
  const result = await client.getHtml('/account/add', context)
  if (!result.contentType.toLowerCase().includes('text/html')) {
    try {
      const payload = objectValue(JSON.parse(result.text) as unknown)
      if (payload && Number(payload.total) === 0 && Array.isArray(payload.rows)) {
        throw new ApiError(403, 'FORBIDDEN', '没有权限管理域名账户')
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
    }
  }
  const html = requireUpstreamHtml(result, config)
  return providerDefinitionsFromHtml(html)
}

export function domainAccountDetailFromHtml(html: string): DomainAccountDetail {
  const info = objectValue(embeddedJsonAssignment(html, 'info'))
  if (!info) throw new ApiError(404, 'DOMAIN_ACCOUNT_NOT_FOUND', '域名账户不存在')
  const definitions = providerDefinitionsFromHtml(html)
  const type = stringValue(info.type)
  const id = numberValue(info.id)
  const name = stringValue(info.name)
  if (!type || !id || !Number.isInteger(id) || id <= 0 || !name) {
    throw new ApiError(502, 'UPSTREAM_INVALID_ACCOUNT', '原 dnsmgr 返回了无法识别的域名账户')
  }
  const definition = definitions.find((provider) => provider.type === type)
  let parsedConfig: unknown
  try {
    parsedConfig = JSON.parse(typeof info.config === 'string' ? info.config : '{}') as unknown
  } catch {
    throw new ApiError(502, 'UPSTREAM_INVALID_ACCOUNT', '域名账户配置不是有效 JSON')
  }
  const accountConfig = safeJsonObject(parsedConfig)
  const remark = stringValue(info.remark)
  const addedAt = stringValue(info.addtime)
  return {
    id,
    provider: {
      type,
      label: definition?.label ?? type,
      ...(definition?.icon ? { icon: definition.icon } : {}),
    },
    name,
    ...(remark ? { remark } : {}),
    ...(addedAt ? { addedAt } : {}),
    config: accountConfig,
  }
}

export async function getDomainAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
): Promise<DomainAccountDetail> {
  const result = await client.getHtml(`/account/edit?id=${encodeURIComponent(String(accountId))}`, context)
  if (!result.contentType.toLowerCase().includes('text/html')) {
    try {
      const payload = objectValue(JSON.parse(result.text) as unknown)
      if (payload && Number(payload.total) === 0 && Array.isArray(payload.rows)) {
        throw new ApiError(403, 'FORBIDDEN', '没有权限管理域名账户')
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
    }
  }
  const html = requireUpstreamHtml(result, config)
  if (html.includes('域名账户不存在')) {
    throw new ApiError(404, 'DOMAIN_ACCOUNT_NOT_FOUND', '域名账户不存在')
  }
  return domainAccountDetailFromHtml(html)
}

function accountMutationForm(rawBody: unknown): Record<string, unknown> {
  const body = DomainAccountMutationSchema.parse(rawBody)
  const accountConfig = safeJsonObject(body.config)
  for (const [key, value] of Object.entries(accountConfig)) {
    if (typeof value === 'string' && value) accountConfig[key] = value.trim()
  }
  const firstConfigValue = Object.values(accountConfig)[0]
  if (firstConfigValue === undefined) {
    throw new ApiError(422, 'VALIDATION_ERROR', '账户配置不能为空')
  }
  const name = stringValue(firstConfigValue)
  if (!name) {
    throw new ApiError(422, 'VALIDATION_ERROR', '账户首个配置项不能为空')
  }
  return {
    type: body.providerType,
    name,
    config: JSON.stringify(accountConfig),
    remark: body.remark ?? '',
  }
}

export async function createDomainAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainAccounts.create', {
    form: accountMutationForm(rawBody),
  })
  return { message: result.message }
}

export async function updateDomainAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainAccounts.update', {
    form: { id: accountId, ...accountMutationForm(rawBody) },
  })
  return { message: result.message }
}

export async function deleteDomainAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainAccounts.delete', {
    form: { id: accountId },
  })
  return { message: result.message }
}

export type AvailableDomain = {
  providerId: string
  name: string
  recordCount: number
  alreadyAdded: boolean
}

export async function listAvailableDomains(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawQuery: unknown,
): Promise<{ data: AvailableDomain[]; meta: PageMeta }> {
  const query = AvailableDomainsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'domainAccounts.discoverDomains', {
    form: {
      aid: accountId,
      page: query.page,
      pagesize: query.pageSize,
      ...(query.q ? { kw: query.q } : {}),
    },
  })
  const object = objectValue(result.data)
  const rows = Array.isArray(object?.list) ? object.list : []
  const data = rows.flatMap((raw): AvailableDomain[] => {
    const row = objectValue(raw)
    const providerId = stringValue(row?.DomainId)
    const name = stringValue(row?.Domain)
    if (!row || !providerId || !name) return []
    const recordCount = numberValue(row.RecordCount)
    return [{
      providerId,
      name,
      recordCount: recordCount === undefined ? 0 : Math.max(0, Math.trunc(recordCount)),
      alreadyAdded: boolValue(row.disabled),
    }]
  })
  const total = numberValue(object?.total)
  return {
    data,
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total: total === undefined ? data.length : Math.max(0, Math.trunc(total)),
    },
  }
}
