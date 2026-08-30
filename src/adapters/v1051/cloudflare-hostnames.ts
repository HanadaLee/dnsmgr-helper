import { isIP } from 'node:net'

import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CloudflareCustomHostname,
  CloudflareDnsLine,
  CloudflareTxtTargetCandidate,
  CloudflareValidationRecord,
  PageMeta,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import {
  booleanValue,
  integerValue,
  objectValue,
  operationMessage,
  requiredPositiveInteger,
  rowsFromOperation,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { plainText } from './html-state.js'
import { executeLegacyOperation, type NormalizedOperationResult } from './operations.js'

const ExternalId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const ExternalIds = z.array(ExternalId).min(1).max(1000)
const ValidationMethod = z.enum(['txt', 'http'])
const TlsVersion = z.enum(['1.0', '1.1', '1.2', '1.3'])

const Hostname = z.string().trim().min(3).max(253).superRefine((value, context) => {
  const plain = value.startsWith('*.') ? value.slice(2) : value
  if (!plain.includes('.') || /[\s/:]/.test(plain) || plain.includes('*') || value === '*.' || isIP(plain) !== 0) {
    context.addIssue({ code: 'custom', message: '主机名格式不正确' })
  }
})

const Origin = z.string().trim().min(3).max(253).superRefine((value, context) => {
  if (!value.includes('.') || /[\s/:*]/.test(value) || isIP(value) !== 0) {
    context.addIssue({ code: 'custom', message: '自定义源站必须是不带协议、端口和路径的域名' })
  }
})

export const CloudflareCustomHostnameCreateSchema = z.object({
  hostname: Hostname,
  customOrigin: Origin.nullable().default(null),
  validationMethod: ValidationMethod.default('txt'),
  minTlsVersion: TlsVersion.default('1.0'),
}).strict()

export const CloudflareCustomHostnameUpdateSchema = z.object({
  customOrigin: Origin.nullable(),
  validationMethod: ValidationMethod,
  minTlsVersion: TlsVersion,
}).strict()

export const CloudflareCustomHostnameDeleteSchema = z.object({
  hostname: Hostname.optional(),
}).strict()

export const CloudflareCustomHostnameBatchAddSchema = z.object({
  hostnames: z.array(Hostname).min(1).max(1000),
  customOrigin: Origin.nullable().default(null),
  validationMethod: ValidationMethod.default('txt'),
  minTlsVersion: TlsVersion.default('1.0'),
}).strict().superRefine((value, context) => {
  if (new Set(value.hostnames.map((hostname) => hostname.toLowerCase())).size !== value.hostnames.length) {
    context.addIssue({ code: 'custom', path: ['hostnames'], message: '主机名不能重复' })
  }
})

export const CloudflareCustomHostnameBatchUpdateSchema = z.object({
  ids: ExternalIds,
  customOrigin: Origin.nullable(),
  validationMethod: ValidationMethod.optional(),
  minTlsVersion: TlsVersion.optional(),
}).strict()

export const CloudflareCustomHostnameBatchDeleteSchema = z.object({ ids: ExternalIds }).strict()
export const CloudflareTxtTargetsQuerySchema = z.object({ hostname: z.string().trim().min(1).max(253) }).strict()
export const CloudflareFallbackOriginSchema = z.object({ origin: Origin }).strict()

function sslMethod(value: unknown): CloudflareCustomHostname['ssl']['method'] {
  if (value === 'txt') return 'txt'
  if (value === 'http') return 'http'
  return 'unknown'
}

function optionalText(value: unknown): string | undefined {
  return plainText(value)
}

function normalizeValidationRecord(value: unknown): CloudflareValidationRecord | undefined {
  const row = objectValue(value)
  if (!row) return undefined
  const status = stringValue(row.status)
  const txtName = stringValue(row.txt_name)
  const txtValue = stringValue(row.txt_value)
  const cnameName = stringValue(row.cname_name)
  const cnameTarget = stringValue(row.cname_target)
  const httpUrl = stringValue(row.http_url)
  const httpBody = stringValue(row.http_body)
  const emails = Array.isArray(row.emails)
    ? row.emails.map(stringValue).filter((item): item is string => Boolean(item))
    : []
  return {
    ...(status ? { status } : {}),
    ...(txtName ? { txtName } : {}),
    ...(txtValue ? { txtValue } : {}),
    ...(cnameName ? { cnameName } : {}),
    ...(cnameTarget ? { cnameTarget } : {}),
    ...(httpUrl ? { httpUrl } : {}),
    ...(httpBody ? { httpBody } : {}),
    emails,
  }
}

function normalizeCustomHostname(value: unknown): CloudflareCustomHostname {
  const row = objectValue(value)
  const id = stringValue(row?.id)
  const hostname = stringValue(row?.hostname)
  if (!row || !id || !hostname) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CLOUDFLARE_HOSTNAME', '原 dnsmgr 返回了无法识别的自定义主机名')
  }
  const ownership = objectValue(row.ownership_verification) ?? {}
  const ownershipHttp = objectValue(row.ownership_verification_http) ?? {}
  const customOrigin = stringValue(row.custom_origin_server)
  const createdAt = stringValue(row.created_on)
  const ownershipType = stringValue(ownership.type)
  const ownershipName = stringValue(ownership.name)
  const ownershipValue = stringValue(ownership.value)
  const ownershipStatus = stringValue(ownership.status) ?? stringValue(row.verification_status) ?? 'unknown'
  const ownershipHttpUrl = stringValue(ownershipHttp.http_url)
  const ownershipHttpBody = stringValue(ownershipHttp.http_body)
  const sslStatus = stringValue(row.ssl_status) ?? 'unknown'
  const minTlsVersion = stringValue(row.ssl_min_tls_version)
  const sslType = stringValue(row.ssl_type)
  const validationStatus = stringValue(row.ssl_validation_status) ?? 'unknown'
  const validationRecords = Array.isArray(row.ssl_validation_records)
    ? row.ssl_validation_records
      .map(normalizeValidationRecord)
      .filter((item): item is CloudflareValidationRecord => Boolean(item))
    : []
  const errors = optionalText(row.validation_errors)
  return {
    id,
    hostname,
    ...(customOrigin ? { customOrigin } : {}),
    status: stringValue(row.status) ?? 'unknown',
    ...(createdAt ? { createdAt } : {}),
    validationErrors: errors ? errors.split(/\s*\|\s*/).filter(Boolean) : [],
    ownershipVerification: {
      ...(ownershipType ? { type: ownershipType } : {}),
      ...(ownershipName ? { name: ownershipName } : {}),
      ...(ownershipValue ? { value: ownershipValue } : {}),
      status: ownershipStatus,
      ...(ownershipHttpUrl ? { httpUrl: ownershipHttpUrl } : {}),
      ...(ownershipHttpBody ? { httpBody: ownershipHttpBody } : {}),
    },
    ssl: {
      status: sslStatus,
      method: sslMethod(row.ssl_method),
      ...(minTlsVersion ? { minTlsVersion } : {}),
      ...(sslType ? { type: sslType } : {}),
      validationStatus,
      validationRecords,
    },
  }
}

function dataObject(result: NormalizedOperationResult, invalidMessage: string): LegacyObject {
  const data = objectValue(result.data)
  if (!data) throw new ApiError(502, 'UPSTREAM_INVALID_PAYLOAD', invalidMessage)
  return data
}

function operationWithHostname(result: NormalizedOperationResult) {
  return {
    ...operationMessage(result.message),
    data: normalizeCustomHostname(result.data),
  }
}

export async function listCloudflareCustomHostnames(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
): Promise<{ data: CloudflareCustomHostname[]; meta: PageMeta }> {
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.list', {
    path: { domainId },
  })
  const rows = rowsFromOperation(result, '原 dnsmgr 的自定义主机名列表格式不兼容')
  return {
    data: rows.map(normalizeCustomHostname),
    meta: { page: 1, pageSize: rows.length, total: result.meta?.total ?? rows.length },
  }
}

export async function createCloudflareCustomHostname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = CloudflareCustomHostnameCreateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.create', {
    path: { domainId },
    form: {
      hostname: body.hostname,
      custom_origin_server: body.customOrigin ?? '',
      ssl_method: body.validationMethod,
      min_tls_version: body.minTlsVersion,
    },
  })
  return operationWithHostname(result)
}

export async function updateCloudflareCustomHostname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  hostnameId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(hostnameId)
  const body = CloudflareCustomHostnameUpdateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.update', {
    path: { domainId },
    form: {
      hostname_id: id,
      custom_origin_server: body.customOrigin ?? '',
      ssl_method: body.validationMethod,
      min_tls_version: body.minTlsVersion,
    },
  })
  return operationWithHostname(result)
}

export async function deleteCloudflareCustomHostname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  hostnameId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(hostnameId)
  const body = CloudflareCustomHostnameDeleteSchema.parse(rawBody ?? {})
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.delete', {
    path: { domainId },
    form: { hostname_id: id, hostname: body.hostname ?? '' },
  })
  return operationMessage(result.message)
}

export async function refreshCloudflareCustomHostname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  hostnameId: string,
) {
  const id = ExternalId.parse(hostnameId)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.refresh', {
    path: { domainId },
    form: { hostname_id: id },
  })
  return operationWithHostname(result)
}

export async function batchAddCloudflareCustomHostnames(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = CloudflareCustomHostnameBatchAddSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.batchCreate', {
    path: { domainId },
    form: {
      hostnames: body.hostnames.join('\n'),
      custom_origin_server: body.customOrigin ?? '',
      ssl_method: body.validationMethod,
      min_tls_version: body.minTlsVersion,
    },
  })
  return operationMessage(result.message)
}

export async function batchUpdateCloudflareCustomHostnames(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = CloudflareCustomHostnameBatchUpdateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.batchUpdate', {
    path: { domainId },
    form: {
      hostname_ids: body.ids.join(','),
      custom_origin_server: body.customOrigin ?? '',
      ssl_method: body.validationMethod ?? '',
      min_tls_version: body.minTlsVersion ?? '',
    },
  })
  return operationMessage(result.message)
}

export async function batchDeleteCloudflareCustomHostnames(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = CloudflareCustomHostnameBatchDeleteSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.batchDelete', {
    path: { domainId },
    form: { hostname_ids: body.ids },
  })
  return operationMessage(result.message)
}

function normalizeTxtTarget(value: unknown): CloudflareTxtTargetCandidate | undefined {
  const row = objectValue(value)
  if (!row) return undefined
  const domainId = integerValue(row.domain_id)
  const domainName = stringValue(row.domain_name)
  const recordName = stringValue(row.record_name)
  const accountId = integerValue(row.account_id)
  if (!domainId || !domainName || !recordName || !accountId) return undefined
  return {
    domainId,
    domainName,
    recordName,
    accountId,
    accountType: stringValue(row.account_type) ?? 'unknown',
    accountTypeName: plainText(row.account_type_name) ?? stringValue(row.account_type) ?? 'unknown',
    accountDisplayName: plainText(row.account_display_name) ?? '',
    currentDomain: booleanValue(row.is_current_domain),
  }
}

export async function getCloudflareTxtTargets(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawQuery: unknown,
) {
  const query = CloudflareTxtTargetsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.hostnames.txtTargets', {
    path: { domainId },
    form: { hostname: query.hostname },
  })
  const data = dataObject(result, '原 dnsmgr 的 TXT 目标格式不兼容')
  const hostname = stringValue(data.hostname)
  if (!hostname || !Array.isArray(data.candidates)) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CLOUDFLARE_TARGETS', '原 dnsmgr 的 TXT 目标格式不兼容')
  }
  return {
    hostname,
    candidates: data.candidates
      .map(normalizeTxtTarget)
      .filter((item): item is CloudflareTxtTargetCandidate => Boolean(item)),
  }
}

export async function getCloudflareFallbackOrigin(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.fallback.get', {
    path: { domainId },
  })
  const data = dataObject(result, '原 dnsmgr 的 Fallback Origin 格式不兼容')
  return { origin: stringValue(data.origin) ?? null }
}

export async function setCloudflareFallbackOrigin(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = CloudflareFallbackOriginSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.fallback.set', {
    path: { domainId },
    form: { origin: body.origin },
  })
  const data = dataObject(result, '原 dnsmgr 的 Fallback Origin 格式不兼容')
  return { ...operationMessage(result.message), data: { origin: stringValue(data.origin) ?? body.origin } }
}

export async function deleteCloudflareFallbackOrigin(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.fallback.delete', {
    path: { domainId },
  })
  return operationMessage(result.message)
}

export async function getCloudflareDcvDelegationUuid(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.dcvDelegationUuid', {
    path: { domainId },
  })
  const uuid = stringValue(dataObject(result, '原 dnsmgr 的 DCV 委派信息格式不兼容').uuid)
  if (!uuid) throw new ApiError(502, 'UPSTREAM_INVALID_CLOUDFLARE_DCV', '原 dnsmgr 的 DCV 委派信息格式不兼容')
  return { uuid }
}

function normalizeDnsLine(value: unknown): CloudflareDnsLine | undefined {
  const row = objectValue(value)
  if (!row) return undefined
  const lineValue = stringValue(row.value)
  const label = plainText(row.label)
  if (lineValue === undefined || !label) return undefined
  const parent = stringValue(row.parent)
  return {
    value: lineValue,
    label,
    ...(parent ? { parent } : {}),
    default: booleanValue(row.is_default),
  }
}

export async function getCloudflareDomainDefaultLine(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.defaultLine', {
    form: { domain_id: domainId },
  })
  const data = dataObject(result, '原 dnsmgr 的默认解析线路格式不兼容')
  const defaultLine = stringValue(data.default_line)
  if (defaultLine === undefined || !Array.isArray(data.lines)) {
    throw new ApiError(502, 'UPSTREAM_INVALID_RECORD_LINES', '原 dnsmgr 的默认解析线路格式不兼容')
  }
  return {
    defaultLine,
    lines: data.lines.map(normalizeDnsLine).filter((item): item is CloudflareDnsLine => Boolean(item)),
  }
}
