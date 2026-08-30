import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CertificateAccountDetail,
  CertificateAccountKind,
  CertificateAccountSummary,
  CertificateAccountTypeDefinition,
  PageMeta,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext, UpstreamResult } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import {
  objectValue,
  operationMessage,
  pagedOperation,
  requiredPositiveInteger,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { normalizeDynamicFields, parseConfigObject, safeConfigObject, safeIcon } from './dynamic-fields.js'
import { embeddedJsonAssignment, plainText } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const AccountSortMap = {
  id: 'id',
  type: 'typename',
  name: 'name',
  remark: 'remark',
  addedAt: 'addtime',
} as const

export const CertificateAccountKindSchema = z.enum(['issuance', 'deployment'])

export const CertificateAccountsQuerySchema = z.object({
  kind: CertificateAccountKindSchema.default('issuance'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
  sort: z.enum(Object.keys(AccountSortMap) as [keyof typeof AccountSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

export const CertificateAccountKindQuerySchema = z.object({
  kind: CertificateAccountKindSchema.default('issuance'),
}).strict()

export const CertificateAccountMutationSchema = z.object({
  kind: CertificateAccountKindSchema,
  type: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().max(255).nullable().optional(),
  config: z.record(z.string().min(1).max(255), z.unknown()),
  remark: z.string().trim().max(1000).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.type !== 'local' && !value.name) {
    context.addIssue({ code: 'custom', path: ['name'], message: '账户名称不能为空' })
  }
  if (value.type !== 'local' && Object.keys(value.config).length === 0) {
    context.addIssue({ code: 'custom', path: ['config'], message: '账户配置不能为空' })
  }
})

function deploymentFlag(kind: CertificateAccountKind): number {
  return kind === 'deployment' ? 1 : 0
}

function requireCertificateHtml(result: UpstreamResult, config: AppConfig): string {
  if (!result.contentType.toLowerCase().includes('text/html')) {
    try {
      const payload = objectValue(JSON.parse(result.text) as unknown)
      if (payload && Number(payload.total) === 0 && Array.isArray(payload.rows)) {
        throw new ApiError(403, 'FORBIDDEN', '没有权限管理证书账户')
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
    }
  }
  return requireUpstreamHtml(result, config)
}

function accountTypesFromHtml(
  html: string,
  kind: CertificateAccountKind,
): CertificateAccountTypeDefinition[] {
  const typeList = objectValue(embeddedJsonAssignment(html, 'typeList'))
  const classList = objectValue(embeddedJsonAssignment(html, 'classList'))
  if (!typeList || !classList) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的证书账户类型格式不兼容')
  }
  return Object.entries(typeList).flatMap(([type, raw]): CertificateAccountTypeDefinition[] => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(type)) return []
    const definition = objectValue(raw)
    const label = plainText(definition?.name)
    if (!definition || !label) return []
    const categoryId = stringValue(definition.class)
    const categoryLabel = categoryId ? plainText(classList[categoryId]) : undefined
    const icon = safeIcon(definition.icon)
    const description = plainText(definition.desc)
    const note = plainText(definition.note)
    const taskNote = plainText(definition.tasknote)
    const maxDomains = Number(definition.max_domains)
    return [{
      type,
      kind,
      label,
      ...(categoryId && categoryLabel ? { category: { id: categoryId, label: categoryLabel } } : {}),
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
      ...(note ? { note } : {}),
      fields: normalizeDynamicFields(definition.inputs),
      taskFields: normalizeDynamicFields(definition.taskinputs),
      ...(taskNote ? { taskNote } : {}),
      ...(kind === 'issuance'
        ? {
            capabilities: {
              wildcard: definition.wildcard === true || definition.wildcard === 1,
              maxDomains: Number.isSafeInteger(maxDomains) && maxDomains > 0 ? maxDomains : 1,
              cnameDelegation: definition.cname === true || definition.cname === 1,
            },
          }
        : {}),
    }]
  })
}

export async function getCertificateAccountTypes(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<CertificateAccountTypeDefinition[]> {
  const query = CertificateAccountKindQuerySchema.parse(rawQuery)
  const deploy = deploymentFlag(query.kind)
  const html = requireCertificateHtml(
    await client.getHtml(`/cert/account/add?deploy=${deploy}`, context),
    config,
  )
  return accountTypesFromHtml(html, query.kind)
}

function normalizeCertificateAccount(
  row: LegacyObject,
  kind: CertificateAccountKind,
): CertificateAccountSummary {
  const id = requiredPositiveInteger(
    row.id,
    'UPSTREAM_INVALID_CERTIFICATE_ACCOUNT',
    '原 dnsmgr 返回了无法识别的证书账户',
  )
  const type = stringValue(row.type)
  const name = stringValue(row.name)
  if (!type || !name) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_ACCOUNT', '原 dnsmgr 返回了无法识别的证书账户')
  }
  const icon = safeIcon(row.icon)
  const remark = stringValue(row.remark)
  const addedAt = stringValue(row.addtime)
  return {
    id,
    kind,
    type,
    typeLabel: plainText(row.typename) ?? type,
    ...(icon ? { icon } : {}),
    name,
    ...(remark ? { remark } : {}),
    ...(addedAt ? { addedAt } : {}),
  }
}

export async function listCertificateAccounts(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: CertificateAccountSummary[]; meta: PageMeta }> {
  const query = CertificateAccountsQuerySchema.parse(rawQuery)
  const operation = query.kind === 'deployment'
    ? 'certificateAccounts.listDeployments'
    : 'certificateAccounts.listCertificates'
  const result = await executeLegacyOperation(client, config, context, operation, {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: AccountSortMap[query.sort],
      sortOrder: query.order,
      ...(query.q ? { kw: query.q } : {}),
    },
  })
  return pagedOperation(
    result,
    query.page,
    query.pageSize,
    '原 dnsmgr 的证书账户列表格式不兼容',
    (row) => normalizeCertificateAccount(row, query.kind),
  )
}

export async function getCertificateAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawQuery: unknown,
): Promise<CertificateAccountDetail> {
  const query = CertificateAccountKindQuerySchema.parse(rawQuery)
  const deploy = deploymentFlag(query.kind)
  const html = requireCertificateHtml(
    await client.getHtml(`/cert/account/edit?deploy=${deploy}&id=${accountId}`, context),
    config,
  )
  if (/(SSL证书账户|自动部署账户)不存在/.test(plainText(html) ?? '')) {
    throw new ApiError(404, 'CERTIFICATE_ACCOUNT_NOT_FOUND', '证书账户不存在')
  }
  const info = objectValue(embeddedJsonAssignment(html, 'info'))
  if (!info) throw new ApiError(404, 'CERTIFICATE_ACCOUNT_NOT_FOUND', '证书账户不存在')
  const definitions = accountTypesFromHtml(html, query.kind)
  const type = stringValue(info.type)
  const id = Number(info.id)
  const name = stringValue(info.name)
  if (!type || !Number.isSafeInteger(id) || id <= 0 || !name) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CERTIFICATE_ACCOUNT', '原 dnsmgr 返回了无法识别的证书账户')
  }
  const definition = definitions.find((item) => item.type === type)
  const remark = stringValue(info.remark)
  const addedAt = stringValue(info.addtime)
  return {
    id,
    kind: query.kind,
    type,
    typeLabel: definition?.label ?? type,
    ...(definition?.icon ? { icon: definition.icon } : {}),
    name,
    ...(remark ? { remark } : {}),
    ...(addedAt ? { addedAt } : {}),
    config: parseConfigObject(info.config ?? {}, '证书账户配置不是有效 JSON'),
  }
}

function accountMutationForm(rawBody: unknown) {
  const body = CertificateAccountMutationSchema.parse(rawBody)
  const accountConfig = safeConfigObject(body.config)
  return {
    deploy: deploymentFlag(body.kind),
    type: body.type,
    name: body.type === 'local' ? '复制到本机' : body.name ?? '',
    config: JSON.stringify(accountConfig),
    remark: body.remark ?? '',
  }
}

export async function createCertificateAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateAccounts.create', {
    form: accountMutationForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateCertificateAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'certificateAccounts.update', {
    form: { id: accountId, ...accountMutationForm(rawBody) },
  })
  return operationMessage(result.message)
}

export async function deleteCertificateAccount(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawQuery: unknown,
) {
  const query = CertificateAccountKindQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'certificateAccounts.delete', {
    form: { id: accountId, deploy: deploymentFlag(query.kind) },
  })
  return operationMessage(result.message)
}
