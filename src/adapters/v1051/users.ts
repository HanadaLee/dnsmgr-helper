import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { PageMeta, UserDetail, UserFormOptions, UserSummary } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import {
  booleanValue,
  integerValue,
  objectValue,
  operationMessage,
  pagedOperation,
  stringValue,
} from './automation-common.js'
import { namedSelectOptions } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const UserSortMap = {
  id: 'id',
  username: 'username',
  role: 'level',
  apiEnabled: 'is_api',
  registeredAt: 'regtime',
  lastLoginAt: 'lasttime',
  status: 'status',
} as const

const DomainPermissionSchema = z.string().trim().min(1).max(255).refine(
  (value) => !/[\0\r\n]/.test(value),
  '域名权限格式不合法',
)

export const UsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(255).optional(),
  sort: z.enum(Object.keys(UserSortMap) as [keyof typeof UserSortMap]).default('id'),
  order: z.enum(['asc', 'desc']).default('desc'),
}).strict()

const UserFieldsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  apiEnabled: z.boolean(),
  apiKey: z.string().trim().max(32).nullable().optional(),
  role: z.enum(['user', 'administrator']),
  permissions: z.array(DomainPermissionSchema).max(10_000).default([]),
}).strict()

export const CreateUserSchema = UserFieldsSchema.extend({
  password: z.string().min(1).max(1024),
}).strict().superRefine((value, context) => {
  if (value.apiEnabled && !value.apiKey) {
    context.addIssue({ code: 'custom', path: ['apiKey'], message: '开启 API 时必须填写 API 密钥' })
  }
})

export const UpdateUserSchema = UserFieldsSchema.extend({
  resetPassword: z.string().min(1).max(1024).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.apiEnabled && !value.apiKey) {
    context.addIssue({ code: 'custom', path: ['apiKey'], message: '开启 API 时必须填写 API 密钥' })
  }
})

export const UserStatusSchema = z.object({ enabled: z.boolean() }).strict()

type LegacyObject = Record<string, unknown>

function role(value: unknown): UserSummary['role'] {
  return Number(value) === 2 ? 'administrator' : Number(value) === 1 ? 'user' : 'unknown'
}

function normalizeUser(row: LegacyObject): UserSummary {
  const id = integerValue(row.id)
  const username = stringValue(row.username)
  if (id === undefined || id <= 0 || !username) {
    throw new ApiError(502, 'UPSTREAM_INVALID_USER', '原 dnsmgr 返回了无法识别的用户数据')
  }
  const registeredAt = stringValue(row.regtime)
  const lastLoginAt = stringValue(row.lasttime)
  return {
    id,
    username,
    role: role(row.level),
    apiEnabled: booleanValue(row.is_api),
    totpEnabled: booleanValue(row.totp_open),
    enabled: booleanValue(row.status),
    ...(registeredAt ? { registeredAt } : {}),
    ...(lastLoginAt ? { lastLoginAt } : {}),
  }
}

function permissions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map(stringValue).filter((item): item is string => Boolean(item))))
}

export async function listUsers(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: UserSummary[]; meta: PageMeta }> {
  const query = UsersQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'users.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      sortName: UserSortMap[query.sort],
      sortOrder: query.order,
      ...(query.q ? { kw: query.q } : {}),
    },
  })
  return pagedOperation(result, query.page, query.pageSize, '原 dnsmgr 用户列表格式不兼容', normalizeUser)
}

export async function getUser(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  id: number,
): Promise<UserDetail> {
  const result = await executeLegacyOperation(client, config, context, 'users.get', { form: { id } })
  const row = objectValue(result.data)
  if (!row) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在')
  const apiKey = stringValue(row.apikey)
  return {
    ...normalizeUser(row),
    ...(apiKey ? { apiKey } : {}),
    permissions: permissions(row.permission),
  }
}

export async function getUserFormOptions(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<UserFormOptions> {
  const html = requireUpstreamHtml(await client.getHtml('/user', context), config)
  const domains = namedSelectOptions(html, 'permission[]')
    .map((option) => option.value || option.label)
    .filter(Boolean)
  return { domains: Array.from(new Set(domains)) }
}

export async function createUser(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CreateUserSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'users.create', {
    form: {
      username: body.username,
      password: body.password,
      is_api: body.apiEnabled ? 1 : 0,
      apikey: body.apiKey ?? '',
      level: body.role === 'administrator' ? 2 : 1,
      permission: body.role === 'user' ? body.permissions : [],
    },
  })
  return operationMessage(result.message)
}

export async function updateUser(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  id: number,
  rawBody: unknown,
) {
  const body = UpdateUserSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'users.update', {
    form: {
      id,
      username: body.username,
      is_api: body.apiEnabled ? 1 : 0,
      apikey: body.apiKey ?? '',
      level: body.role === 'administrator' ? 2 : 1,
      permission: body.role === 'user' ? body.permissions : [],
      ...(body.resetPassword ? { repwd: body.resetPassword } : {}),
    },
  })
  return operationMessage(result.message)
}

export async function setUserStatus(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  id: number,
  rawBody: unknown,
) {
  const body = UserStatusSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'users.setStatus', {
    form: { id, status: body.enabled ? 1 : 0 },
  })
  return operationMessage(result.message)
}

export async function deleteUser(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  id: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'users.delete', { form: { id } })
  return operationMessage(result.message)
}
