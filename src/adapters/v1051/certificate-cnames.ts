import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CertificateCnameProxy,
  CertificateDcvDelegationTemplate,
  CertificateSettings,
  PageMeta,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import {
  booleanValue,
  objectValue,
  operationMessage,
  pagedOperation,
  requiredPositiveInteger,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { namedSelectOptions } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()
const TemplateIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)

export const CertificateCnameTemplateBindingsConfigKey = 'helper_cert_dcv_bindings'

type ConfigValueReader = {
  getConfigValues(keys: string[]): Promise<Record<string, string>>
}

const CnameSortMap = {
  id: 'id',
  domain: 'domain',
  status: 'status',
  addedAt: 'addtime',
} as const

const DomainNameSchema = z.string().trim().min(3).max(253).superRefine((value, context) => {
  if (value.includes('/') || value.includes('://') || /\s/.test(value) || !value.includes('.')) {
    context.addIssue({ code: 'custom', message: '域名格式不正确' })
  }
})

const RecordNameSchema = z.string().trim().min(1).max(253).superRefine((value, context) => {
  if (value.includes('/') || /\s/.test(value)) {
    context.addIssue({ code: 'custom', message: 'CNAME 记录名称格式不正确' })
  }
})

export const CertificateCnamesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(253).optional(),
  sort: z.enum(Object.keys(CnameSortMap) as [keyof typeof CnameSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

export const CertificateCnameCreateSchema = z.object({
  domain: DomainNameSchema,
  targetRecordName: RecordNameSchema.optional(),
  targetDomainId: PositiveId.optional(),
  dcvTemplateId: TemplateIdSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.dcvTemplateId !== null) return
  if (!value.targetRecordName) {
    context.addIssue({ code: 'custom', path: ['targetRecordName'], message: '自定义模式必须填写目标主机记录' })
  }
  if (!value.targetDomainId) {
    context.addIssue({ code: 'custom', path: ['targetDomainId'], message: '自定义模式必须选择目标域名' })
  }
})

export const CertificateCnameUpdateSchema = z.object({
  domain: DomainNameSchema.optional(),
  targetRecordName: RecordNameSchema.optional(),
  targetDomainId: PositiveId.optional(),
  dcvTemplateId: TemplateIdSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (typeof value.dcvTemplateId === 'string') {
    if (!value.domain) {
      context.addIssue({ code: 'custom', path: ['domain'], message: '使用模板时必须提供证书域名' })
    }
    return
  }
  if (!value.targetRecordName) {
    context.addIssue({ code: 'custom', path: ['targetRecordName'], message: '自定义模式必须填写目标主机记录' })
  }
  if (!value.targetDomainId) {
    context.addIssue({ code: 'custom', path: ['targetDomainId'], message: '自定义模式必须选择目标域名' })
  }
  if (value.dcvTemplateId === null && !value.domain) {
    context.addIssue({ code: 'custom', path: ['domain'], message: '保存自定义配置时必须提供证书域名' })
  }
})

export const CertificateCnameDeleteSchema = z.object({
  domain: DomainNameSchema.optional(),
}).strict()

function normalizedDelegationDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
}

export function certificateCnameBindingKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

export async function getCertificateCnameTemplateBindings(
  reader: ConfigValueReader,
): Promise<Record<string, string>> {
  const stored = (await reader.getConfigValues([CertificateCnameTemplateBindingsConfigKey]))[
    CertificateCnameTemplateBindingsConfigKey
  ]
  if (!stored) return {}
  try {
    const parsed = JSON.parse(stored) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([domain, templateId]) => {
      const result = TemplateIdSchema.safeParse(templateId)
      const key = certificateCnameBindingKey(domain)
      return result.success && key ? [[key, result.data]] : []
    }))
  } catch {
    return {}
  }
}

export function renderDcvTargetRecordName(template: string, domain: string): string {
  const normalized = normalizedDelegationDomain(domain)
  return template
    .replaceAll('{domainWithDashes}', normalized.replaceAll('.', '-'))
    .replaceAll('{domain}', normalized)
}

function domainAllowed(
  domain: string,
  template: CertificateDcvDelegationTemplate,
): boolean {
  if (template.allowedDomains.length === 0) return true
  const normalized = normalizedDelegationDomain(domain)
  return template.allowedDomains.some((allowed) => {
    const candidate = normalizedDelegationDomain(allowed)
    return normalized === candidate || normalized.endsWith(`.${candidate}`)
  })
}

function selectedDcvTemplate(
  settings: CertificateSettings['dcvDelegation'],
  requestedTemplateId?: string | null,
): CertificateDcvDelegationTemplate | undefined {
  if (requestedTemplateId === null) return undefined
  const templateId = requestedTemplateId ?? settings.defaultTemplateId
  const template = settings.templates.find((candidate) => candidate.id === templateId)
  if (!template) {
    throw new ApiError(422, 'DCV_TEMPLATE_NOT_FOUND', '所选 DCV 模板不存在')
  }
  return template
}

export function resolveDcvTarget(
  domain: string,
  requestedRecordName: string | undefined,
  requestedDomainId: number | undefined,
  settings: CertificateSettings['dcvDelegation'],
  requestedTemplateId?: string | null,
): { targetRecordName: string; targetDomainId: number } {
  const template = selectedDcvTemplate(settings, requestedTemplateId)
  if (!template) {
    return {
      targetRecordName: RecordNameSchema.parse(requestedRecordName),
      targetDomainId: PositiveId.parse(requestedDomainId),
    }
  }
  if (!domainAllowed(domain, template)) {
    throw new ApiError(422, 'DCV_DOMAIN_NOT_ALLOWED', '该证书域名不在允许托管的域名范围内')
  }
  if (!template.targetDomainId) {
    throw new ApiError(422, 'DCV_TEMPLATE_TARGET_NOT_CONFIGURED', '所选 DCV 模板尚未配置目标域名')
  }
  return {
    targetRecordName: RecordNameSchema.parse(
      renderDcvTargetRecordName(template.targetRecordNameTemplate, domain),
    ),
    targetDomainId: template.targetDomainId,
  }
}

function normalizeCertificateCname(
  row: LegacyObject,
  templateBindings: Record<string, string>,
): CertificateCnameProxy {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_CERTIFICATE_CNAME',
    '原 dnsmgr 返回了无法识别的 DCV 托管校验记录',
  )
  const targetDomainId = requiredPositiveInteger(
    row.did,
    'UPSTREAM_INVALID_CERTIFICATE_CNAME',
    '原 dnsmgr 返回了无法识别的 DCV 托管校验记录',
  )
  const domain = stringValue(row.domain)
  const challengeHost = stringValue(row.host)
  const targetDomain = stringValue(row.cnamedomain)
  const targetRecordName = stringValue(row.rr)
  const target = stringValue(row.record)
  if (!domain || !challengeHost || !targetDomain || !targetRecordName || !target) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_CNAME', '原 dnsmgr 返回了无法识别的 DCV 托管校验记录')
  }
  const addedAt = stringValue(row.addtime)
  return {
    id,
    domain,
    ...(templateBindings[certificateCnameBindingKey(domain)]
      ? { templateId: templateBindings[certificateCnameBindingKey(domain)] }
      : {}),
    challengeHost,
    targetDomainId,
    targetDomain,
    targetRecordName,
    target,
    status: booleanValue(row.status) ? 'verified' : 'unverified',
    ...(addedAt ? { addedAt } : {}),
  }
}

export async function getCertificateCnameForm(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  const html = requireUpstreamHtml(await client.getHtml('/cert/cname', context), config)
  return {
    domains: namedSelectOptions(html, 'did').flatMap(({ value, label }) => {
      const id = Number(value)
      return Number.isSafeInteger(id) && id > 0 && label ? [{ id, name: label }] : []
    }),
  }
}

export async function listCertificateCnames(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
  templateBindings: Record<string, string> = {},
): Promise<{ data: CertificateCnameProxy[]; meta: PageMeta }> {
  const query = CertificateCnamesQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: CnameSortMap[query.sort],
      sortOrder: query.order,
      ...(query.q ? { kw: query.q } : {}),
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的 DCV 托管校验列表格式不兼容',
    (row) => normalizeCertificateCname(row, templateBindings),
  )
}

export async function createCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
  settings: CertificateSettings['dcvDelegation'],
) {
  const body = CertificateCnameCreateSchema.parse(rawBody)
  const target = resolveDcvTarget(
    body.domain,
    body.targetRecordName,
    body.targetDomainId,
    settings,
    body.dcvTemplateId,
  )
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.create', {
    form: { domain: body.domain, rr: target.targetRecordName, did: target.targetDomainId },
  })
  return {
    ...operationMessage(result.message),
    domain: certificateCnameBindingKey(body.domain),
    templateId: body.dcvTemplateId === null
      ? null
      : body.dcvTemplateId ?? settings.defaultTemplateId,
  }
}

export async function updateCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  cnameId: number,
  rawBody: unknown,
  settings: CertificateSettings['dcvDelegation'],
) {
  const body = CertificateCnameUpdateSchema.parse(rawBody)
  const target = typeof body.dcvTemplateId === 'string'
    ? resolveDcvTarget(body.domain!, undefined, undefined, settings, body.dcvTemplateId)
    : {
        targetRecordName: RecordNameSchema.parse(body.targetRecordName),
        targetDomainId: PositiveId.parse(body.targetDomainId),
      }
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.update', {
    form: { id: cnameId, rr: target.targetRecordName, did: target.targetDomainId },
  })
  return {
    ...operationMessage(result.message),
    ...(body.domain && body.dcvTemplateId !== undefined
      ? {
          domain: certificateCnameBindingKey(body.domain),
          templateId: body.dcvTemplateId,
        }
      : {}),
  }
}

export async function deleteCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  cnameId: number,
  rawBody: unknown,
) {
  const body = CertificateCnameDeleteSchema.parse(rawBody ?? {})
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.delete', {
    form: { id: cnameId },
  })
  return {
    ...operationMessage(result.message),
    ...(body.domain ? { domain: certificateCnameBindingKey(body.domain) } : {}),
  }
}

export async function checkCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  cnameId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.check', {
    form: { id: cnameId },
  })
  const data = objectValue(result.data)
  if (!data || !Object.hasOwn(data, 'status')) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_CNAME', '原 dnsmgr 返回了无法识别的 CNAME 验证结果')
  }
  return { status: booleanValue(data.status) ? 'verified' as const : 'unverified' as const }
}
