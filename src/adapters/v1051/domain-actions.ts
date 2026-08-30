import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { DomainCategory, PageMeta } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { getDomain } from './domains.js'
import { executeLegacyOperation } from './operations.js'

const PositiveId = z.coerce.number().int().positive()
const IdList = z.array(PositiveId).min(1).max(1000)

export const CreateDomainSchema = z.object({
  accountId: PositiveId,
  mode: z.enum(['existing', 'new']).default('existing'),
  name: z.string().trim().min(1).max(253),
  providerDomainId: z.string().trim().min(1).max(1024).optional(),
  recordCount: z.coerce.number().int().min(0).default(0),
}).strict().superRefine((value, context) => {
  if (value.mode === 'existing' && !value.providerDomainId) {
    context.addIssue({
      code: 'custom',
      path: ['providerDomainId'],
      message: '添加已有域名时必须提供供应商域名 ID',
    })
  }
})

export const UpdateDomainSchema = z.object({
  hidden: z.boolean().optional(),
  ssoEnabled: z.boolean().optional(),
  noticeEnabled: z.boolean().optional(),
  categoryId: z.coerce.number().int().min(0).optional(),
  expiresAt: z.string().trim().max(64).nullable().optional(),
  remark: z.string().trim().max(1000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: '至少提供一个要修改的字段',
})

export const BatchImportDomainsSchema = z.object({
  accountId: PositiveId,
  domains: z.array(z.object({
    name: z.string().trim().min(1).max(253),
    providerDomainId: z.string().trim().min(1).max(1024),
    recordCount: z.coerce.number().int().min(0).default(0),
  }).strict()).min(1).max(1000),
}).strict()

export const BatchDomainRemarkSchema = z.object({
  ids: IdList,
  remark: z.string().trim().max(1000).nullable(),
}).strict()

export const BatchDomainNoticeSchema = z.object({
  ids: IdList,
  enabled: z.boolean(),
}).strict()

export const BatchDomainIdsSchema = z.object({ ids: IdList }).strict()

const CategorySortMap = {
  id: 'id',
  name: 'name',
  remark: 'remark',
  sort: 'sort',
  addedAt: 'addtime',
} as const

export const DomainCategoriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(Object.keys(CategorySortMap) as [keyof typeof CategorySortMap]).default('sort'),
  order: z.enum(['asc', 'desc']).default('asc'),
}).strict()

export const DomainCategoryMutationSchema = z.object({
  name: z.string().trim().min(1).max(255),
  remark: z.string().trim().max(1000).nullable().optional(),
  sort: z.coerce.number().int().min(-2_147_483_648).max(2_147_483_647).default(0),
}).strict()

export const AssignDomainCategorySchema = z.object({
  ids: IdList,
  categoryId: z.coerce.number().int().min(0),
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

function operationMessage(message: string | undefined) {
  return message ? { message } : {}
}

export async function createDomain(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CreateDomainSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domains.create', {
    form: {
      aid: body.accountId,
      method: body.mode === 'new' ? 1 : 0,
      name: body.name,
      thirdid: body.providerDomainId ?? '',
      recordcount: body.recordCount,
    },
  })
  return operationMessage(result.message)
}

export async function updateDomain(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
  rawBody: unknown,
) {
  const body = UpdateDomainSchema.parse(rawBody)
  const current = await getDomain(client, config, context, domainId)
  const result = await executeLegacyOperation(client, config, context, 'domains.update', {
    form: {
      id: domainId,
      is_hide: body.hidden ?? current.hidden,
      is_sso: body.ssoEnabled ?? current.ssoEnabled,
      is_notice: body.noticeEnabled ?? current.noticeEnabled,
      cid: body.categoryId ?? current.categoryId ?? 0,
      expiretime: body.expiresAt === undefined ? current.expiresAt ?? '' : body.expiresAt ?? '',
      remark: body.remark === undefined ? current.remark ?? '' : body.remark ?? '',
    },
  })
  return operationMessage(result.message)
}

export async function deleteDomain(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'domains.delete', {
    form: { id: domainId },
  })
  return operationMessage(result.message)
}

export async function batchImportDomains(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = BatchImportDomainsSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domains.batchCreate', {
    form: {
      aid: body.accountId,
      domains: body.domains.map((domain) => ({
        name: domain.name,
        id: domain.providerDomainId,
        recordcount: domain.recordCount,
      })),
    },
  })
  return operationMessage(result.message)
}

export async function batchUpdateDomainRemark(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = BatchDomainRemarkSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domains.batchUpdate', {
    form: { ids: body.ids, remark: body.remark ?? '' },
  })
  return operationMessage(result.message)
}

export async function batchSetDomainNotice(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = BatchDomainNoticeSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domains.batchSetNotice', {
    form: { ids: body.ids, is_notice: body.enabled },
  })
  return operationMessage(result.message)
}

export async function batchDeleteDomains(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = BatchDomainIdsSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domains.batchDelete', {
    form: { ids: body.ids },
  })
  return operationMessage(result.message)
}

export async function queueDomainExpiryRefresh(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = BatchDomainIdsSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domains.batchRefreshExpiry', {
    form: { ids: body.ids },
  })
  return operationMessage(result.message)
}

export async function refreshDomainExpiry(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  domainId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'domains.refreshExpiry', {
    form: { id: domainId },
  })
  return operationMessage(result.message)
}

function normalizeCategory(row: LegacyObject): DomainCategory {
  const id = numberValue(row.id)
  const name = stringValue(row.name)
  if (!id || !Number.isInteger(id) || id <= 0 || !name) {
    throw new ApiError(502, 'UPSTREAM_INVALID_CATEGORY', '原 dnsmgr 返回了无法识别的域名分类')
  }
  const sort = numberValue(row.sort)
  const domainCount = numberValue(row.domain_count)
  const remark = stringValue(row.remark)
  const addedAt = stringValue(row.addtime)
  return {
    id,
    name,
    sort: sort === undefined ? 0 : Math.trunc(sort),
    domainCount: domainCount === undefined ? 0 : Math.max(0, Math.trunc(domainCount)),
    ...(remark ? { remark } : {}),
    ...(addedAt ? { addedAt } : {}),
  }
}

export async function listDomainCategories(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: DomainCategory[]; meta: PageMeta }> {
  const query = DomainCategoriesQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'domainCategories.table', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: CategorySortMap[query.sort],
      sortOrder: query.order,
    },
  })
  const rows = Array.isArray(result.data)
    ? result.data.flatMap((row): LegacyObject[] => objectValue(row) ? [row as LegacyObject] : [])
    : []
  return {
    data: rows.map(normalizeCategory),
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total: result.meta?.total ?? rows.length,
    },
  }
}

function categoryForm(rawBody: unknown) {
  const body = DomainCategoryMutationSchema.parse(rawBody)
  return { name: body.name, remark: body.remark ?? '', sort: body.sort }
}

export async function createDomainCategory(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainCategories.create', {
    form: categoryForm(rawBody),
  })
  return operationMessage(result.message)
}

export async function updateDomainCategory(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  categoryId: number,
  rawBody: unknown,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainCategories.update', {
    form: { id: categoryId, ...categoryForm(rawBody) },
  })
  return operationMessage(result.message)
}

export async function deleteDomainCategory(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  categoryId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'domainCategories.delete', {
    form: { id: categoryId },
  })
  return operationMessage(result.message)
}

export async function assignDomainCategory(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = AssignDomainCategorySchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'domainCategories.assign', {
    form: { ids: body.ids, cid: body.categoryId },
  })
  return operationMessage(result.message)
}
