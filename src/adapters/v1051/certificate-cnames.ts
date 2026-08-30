import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { CertificateCnameProxy, PageMeta } from '../../contracts.js'
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
  targetRecordName: RecordNameSchema,
  targetDomainId: PositiveId,
}).strict()

export const CertificateCnameUpdateSchema = z.object({
  targetRecordName: RecordNameSchema,
  targetDomainId: PositiveId,
}).strict()

function normalizeCertificateCname(row: LegacyObject): CertificateCnameProxy {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_CERTIFICATE_CNAME',
    '原 dnsmgr 返回了无法识别的 CNAME 代理',
  )
  const targetDomainId = requiredPositiveInteger(
    row.did,
    'UPSTREAM_INVALID_CERTIFICATE_CNAME',
    '原 dnsmgr 返回了无法识别的 CNAME 代理',
  )
  const domain = stringValue(row.domain)
  const challengeHost = stringValue(row.host)
  const targetDomain = stringValue(row.cnamedomain)
  const targetRecordName = stringValue(row.rr)
  const target = stringValue(row.record)
  if (!domain || !challengeHost || !targetDomain || !targetRecordName || !target) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_CNAME', '原 dnsmgr 返回了无法识别的 CNAME 代理')
  }
  const addedAt = stringValue(row.addtime)
  return {
    id,
    domain,
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
    '原 dnsmgr 的 CNAME 代理列表格式不兼容',
    normalizeCertificateCname,
  )
}

export async function createCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CertificateCnameCreateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.create', {
    form: { domain: body.domain, rr: body.targetRecordName, did: body.targetDomainId },
  })
  return operationMessage(result.message)
}

export async function updateCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  cnameId: number,
  rawBody: unknown,
) {
  const body = CertificateCnameUpdateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.update', {
    form: { id: cnameId, rr: body.targetRecordName, did: body.targetDomainId },
  })
  return operationMessage(result.message)
}

export async function deleteCertificateCname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  cnameId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateCnames.delete', {
    form: { id: cnameId },
  })
  return operationMessage(result.message)
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
