import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamJson } from '../../upstream/legacy.js'

type LegacyOperationDefinition = {
  group: string
  method: 'GET' | 'POST'
  path: string
  fixedForm?: Record<string, string>
}

export const LegacyOperations = {
  'dashboard.stats': { group: 'dashboard', method: 'POST', path: '/', fixedForm: { do: 'stat' } },
  'dashboard.clearCache': { group: 'dashboard', method: 'GET', path: '/cleancache' },
  'preferences.setTheme': { group: 'profile', method: 'POST', path: '/changeskin' },
  'profile.changePassword': { group: 'profile', method: 'POST', path: '/setpwd' },
  'profile.totp.generate': { group: 'profile', method: 'POST', path: '/totp/generate' },
  'profile.totp.bind': { group: 'profile', method: 'POST', path: '/totp/bind' },
  'profile.totp.disable': { group: 'profile', method: 'POST', path: '/totp/close' },

  'users.list': { group: 'users', method: 'POST', path: '/user/data' },
  'users.get': { group: 'users', method: 'POST', path: '/user/op/act/get' },
  'users.create': { group: 'users', method: 'POST', path: '/user/op/act/add' },
  'users.update': { group: 'users', method: 'POST', path: '/user/op/act/edit' },
  'users.setStatus': { group: 'users', method: 'POST', path: '/user/op/act/set' },
  'users.delete': { group: 'users', method: 'POST', path: '/user/op/act/del' },
  'logs.list': { group: 'logs', method: 'POST', path: '/log/data' },

  'domainAccounts.list': { group: 'domainAccounts', method: 'POST', path: '/account/data' },
  'domainAccounts.create': { group: 'domainAccounts', method: 'POST', path: '/account/add' },
  'domainAccounts.update': { group: 'domainAccounts', method: 'POST', path: '/account/edit' },
  'domainAccounts.delete': { group: 'domainAccounts', method: 'POST', path: '/account/del' },
  'domainAccounts.discoverDomains': { group: 'domainAccounts', method: 'POST', path: '/domain/list' },

  'domains.list': { group: 'domains', method: 'POST', path: '/domain/data' },
  'domains.get': { group: 'domains', method: 'POST', path: '/domain/op/act/get' },
  'domains.create': { group: 'domains', method: 'POST', path: '/domain/op/act/add' },
  'domains.update': { group: 'domains', method: 'POST', path: '/domain/op/act/edit' },
  'domains.delete': { group: 'domains', method: 'POST', path: '/domain/op/act/del' },
  'domains.batchCreate': { group: 'domains', method: 'POST', path: '/domain/op/act/batchadd' },
  'domains.batchUpdate': { group: 'domains', method: 'POST', path: '/domain/op/act/batchedit' },
  'domains.batchSetNotice': { group: 'domains', method: 'POST', path: '/domain/op/act/batchsetnotice' },
  'domains.batchDelete': { group: 'domains', method: 'POST', path: '/domain/op/act/batchdel' },
  'domains.batchRefreshExpiry': { group: 'domains', method: 'POST', path: '/domain/op/act/updateexpire' },
  'domains.refreshExpiry': { group: 'domains', method: 'POST', path: '/domain/updatedate' },
  'domains.updateExpirySettings': { group: 'domains', method: 'POST', path: '/domain/expirenotice' },

  'domainCategories.table': { group: 'domainCategories', method: 'POST', path: '/domain/category/data' },
  'domainCategories.list': { group: 'domainCategories', method: 'GET', path: '/domain/category/list' },
  'domainCategories.create': { group: 'domainCategories', method: 'POST', path: '/domain/category/add' },
  'domainCategories.update': { group: 'domainCategories', method: 'POST', path: '/domain/category/edit' },
  'domainCategories.delete': { group: 'domainCategories', method: 'POST', path: '/domain/category/del' },
  'domainCategories.assign': { group: 'domainCategories', method: 'POST', path: '/domain/setcategory' },

  'records.list': { group: 'records', method: 'POST', path: '/record/data/{domainId}' },
  'records.lookup': { group: 'records', method: 'POST', path: '/record/list' },
  'records.create': { group: 'records', method: 'POST', path: '/record/add/{domainId}' },
  'records.update': { group: 'records', method: 'POST', path: '/record/update/{domainId}' },
  'records.delete': { group: 'records', method: 'POST', path: '/record/delete/{domainId}' },
  'records.setStatus': { group: 'records', method: 'POST', path: '/record/status/{domainId}' },
  'records.setRemark': { group: 'records', method: 'POST', path: '/record/remark/{domainId}' },
  'records.check': { group: 'records', method: 'POST', path: '/record/check/{domainId}' },
  'records.batchOperate': { group: 'records', method: 'POST', path: '/record/batch/{domainId}' },
  'records.batchEdit': { group: 'records', method: 'POST', path: '/record/batchedit/{domainId}' },
  'records.batchAdd': { group: 'records', method: 'POST', path: '/record/batchadd/{domainId}' },
  'records.crossDomainBatchEdit': { group: 'records', method: 'POST', path: '/record/batchedit' },
  'records.quickInfo': { group: 'records', method: 'POST', path: '/record/quickinfo/{domainId}' },
  'records.groups': { group: 'records', method: 'POST', path: '/record/groups/{domainId}' },
  'records.logs': { group: 'records', method: 'POST', path: '/record/log/{domainId}' },
  'recordWeights.list': { group: 'records', method: 'POST', path: '/record/weight/data/{domainId}' },
  'recordWeights.update': { group: 'records', method: 'POST', path: '/record/weight/{domainId}/act/update' },
  'recordWeights.setStatus': { group: 'records', method: 'POST', path: '/record/weight/{domainId}/act/status' },
  'domainAliases.create': { group: 'records', method: 'POST', path: '/record/alias/{domainId}?act=add' },
  'domainAliases.delete': { group: 'records', method: 'POST', path: '/record/alias/{domainId}?act=delete' },

  'monitoring.tasks.list': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/data' },
  'monitoring.tasks.create': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/add' },
  'monitoring.tasks.update': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/edit' },
  'monitoring.tasks.setActive': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/setactive' },
  'monitoring.tasks.delete': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/del' },
  'monitoring.tasks.operate': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/operation' },
  'monitoring.tasks.logs': { group: 'monitoring', method: 'POST', path: '/dmonitor/task/log/data/{taskId}' },
  'monitoring.clean': { group: 'monitoring', method: 'POST', path: '/dmonitor/clean' },

  'schedules.list': { group: 'schedules', method: 'POST', path: '/schedule/stask/data' },
  'schedules.create': { group: 'schedules', method: 'POST', path: '/schedule/stask/add' },
  'schedules.update': { group: 'schedules', method: 'POST', path: '/schedule/stask/edit' },
  'schedules.setActive': { group: 'schedules', method: 'POST', path: '/schedule/stask/setactive' },
  'schedules.delete': { group: 'schedules', method: 'POST', path: '/schedule/stask/del' },
  'schedules.operate': { group: 'schedules', method: 'POST', path: '/schedule/stask/operation' },

  'optimizeIp.updateSettings': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opipset' },
  'optimizeIp.queryAccount': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/queryapi' },
  'optimizeIp.tasks.list': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opiplist/data' },
  'optimizeIp.tasks.create': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opipform/add' },
  'optimizeIp.tasks.update': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opipform/edit' },
  'optimizeIp.tasks.setActive': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opipform/setactive' },
  'optimizeIp.tasks.delete': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opipform/del' },
  'optimizeIp.tasks.run': { group: 'optimizeIp', method: 'POST', path: '/optimizeip/opipform/run' },

  'certificateAccounts.listCertificates': { group: 'certificates', method: 'POST', path: '/cert/account/data?deploy=0' },
  'certificateAccounts.listDeployments': { group: 'certificates', method: 'POST', path: '/cert/account/data?deploy=1' },
  'certificateAccounts.create': { group: 'certificates', method: 'POST', path: '/cert/account/add' },
  'certificateAccounts.update': { group: 'certificates', method: 'POST', path: '/cert/account/edit' },
  'certificateAccounts.delete': { group: 'certificates', method: 'POST', path: '/cert/account/del' },
  'certificateOrders.list': { group: 'certificates', method: 'POST', path: '/cert/order/data' },
  'certificateOrders.get': { group: 'certificates', method: 'POST', path: '/cert/order/get' },
  'certificateOrders.create': { group: 'certificates', method: 'POST', path: '/cert/order/add' },
  'certificateOrders.update': { group: 'certificates', method: 'POST', path: '/cert/order/edit' },
  'certificateOrders.delete': { group: 'certificates', method: 'POST', path: '/cert/order/del' },
  'certificateOrders.setAuto': { group: 'certificates', method: 'POST', path: '/cert/order/setauto' },
  'certificateOrders.reset': { group: 'certificates', method: 'POST', path: '/cert/order/reset' },
  'certificateOrders.revoke': { group: 'certificates', method: 'POST', path: '/cert/order/revoke' },
  'certificateOrders.logs': { group: 'certificates', method: 'POST', path: '/cert/order/show_log' },
  'certificateOrders.operate': { group: 'certificates', method: 'POST', path: '/cert/order/operation' },
  'certificateOrders.process': { group: 'certificates', method: 'POST', path: '/cert/order/process' },
  'certificateDeployments.list': { group: 'certificates', method: 'POST', path: '/cert/deploy/data' },
  'certificateDeployments.create': { group: 'certificates', method: 'POST', path: '/cert/deploy/add' },
  'certificateDeployments.update': { group: 'certificates', method: 'POST', path: '/cert/deploy/edit' },
  'certificateDeployments.delete': { group: 'certificates', method: 'POST', path: '/cert/deploy/del' },
  'certificateDeployments.setActive': { group: 'certificates', method: 'POST', path: '/cert/deploy/setactive' },
  'certificateDeployments.reset': { group: 'certificates', method: 'POST', path: '/cert/deploy/reset' },
  'certificateDeployments.logs': { group: 'certificates', method: 'POST', path: '/cert/deploy/show_log' },
  'certificateDeployments.operate': { group: 'certificates', method: 'POST', path: '/cert/deploy/operation' },
  'certificateDeployments.process': { group: 'certificates', method: 'POST', path: '/cert/deploy/process' },
  'certificateCnames.list': { group: 'certificates', method: 'POST', path: '/cert/cname/data' },
  'certificateCnames.create': { group: 'certificates', method: 'POST', path: '/cert/cname/add' },
  'certificateCnames.update': { group: 'certificates', method: 'POST', path: '/cert/cname/edit' },
  'certificateCnames.delete': { group: 'certificates', method: 'POST', path: '/cert/cname/del' },
  'certificateCnames.check': { group: 'certificates', method: 'POST', path: '/cert/cname/check' },

  'cloudflare.hostnames.list': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/data/{domainId}' },
  'cloudflare.hostnames.create': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/add/{domainId}' },
  'cloudflare.hostnames.update': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/update/{domainId}' },
  'cloudflare.hostnames.delete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/delete/{domainId}' },
  'cloudflare.hostnames.refresh': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/refresh/{domainId}' },
  'cloudflare.hostnames.txtTargets': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/txttargets/{domainId}' },
  'cloudflare.hostnames.batchCreate': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/batch_add/{domainId}' },
  'cloudflare.hostnames.batchUpdate': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/batch_update/{domainId}' },
  'cloudflare.hostnames.batchDelete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/hostnames/batch_delete/{domainId}' },
  'cloudflare.fallback.get': { group: 'cloudflare', method: 'POST', path: '/cloudflare/fallback/get/{domainId}' },
  'cloudflare.fallback.set': { group: 'cloudflare', method: 'POST', path: '/cloudflare/fallback/set/{domainId}' },
  'cloudflare.fallback.delete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/fallback/delete/{domainId}' },
  'cloudflare.dcvDelegationUuid': { group: 'cloudflare', method: 'POST', path: '/cloudflare/dcv_delegation_uuid/{domainId}' },
  'cloudflare.defaultLine': { group: 'cloudflare', method: 'POST', path: '/cloudflare/get_domain_default_line' },
  'cloudflare.tunnels.list': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/data/{accountId}' },
  'cloudflare.tunnels.create': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/add/{accountId}' },
  'cloudflare.tunnels.delete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/delete/{accountId}' },
  'cloudflare.tunnels.token': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/token/{accountId}' },
  'cloudflare.tunnels.publicHostnames.list': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/publichostnames/data/{accountId}' },
  'cloudflare.tunnels.publicHostnames.save': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/publichostnames/save/{accountId}' },
  'cloudflare.tunnels.publicHostnames.delete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/publichostnames/delete/{accountId}' },
  'cloudflare.tunnels.cidrs.list': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/cidr/data/{accountId}' },
  'cloudflare.tunnels.cidrs.create': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/cidr/add/{accountId}' },
  'cloudflare.tunnels.cidrs.delete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/cidr/delete/{accountId}' },
  'cloudflare.tunnels.hostnameRoutes.list': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/hostnameroutes/data/{accountId}' },
  'cloudflare.tunnels.hostnameRoutes.create': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/hostnameroutes/add/{accountId}' },
  'cloudflare.tunnels.hostnameRoutes.delete': { group: 'cloudflare', method: 'POST', path: '/cloudflare/tunnels/hostnameroutes/delete/{accountId}' },

  'system.settings.update': { group: 'system', method: 'POST', path: '/system/set' },
  'system.notifications.testMail': { group: 'system', method: 'GET', path: '/system/mailtest' },
  'system.notifications.testTelegram': { group: 'system', method: 'GET', path: '/system/tgbottest' },
  'system.notifications.testWebhook': { group: 'system', method: 'GET', path: '/system/webhooktest' },
  'system.notifications.testCustomWebhook': { group: 'system', method: 'GET', path: '/system/customwebhooktest' },
  'system.proxy.test': { group: 'system', method: 'POST', path: '/system/proxytest' },
} as const satisfies Record<string, LegacyOperationDefinition>

export type LegacyOperationId = keyof typeof LegacyOperations

const OperationRequestSchema = z.object({
  path: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  form: z.record(z.string(), z.unknown()).default({}),
}).strict()

type FormState = {
  count: number
}

const UnsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

function validateKey(key: string) {
  if (key.length === 0 || key.length > 255 || key.includes('\0') || UnsafeKeys.has(key)) {
    throw new ApiError(422, 'VALIDATION_ERROR', '表单字段名称不合法')
  }
}

function validateSegment(key: string) {
  validateKey(key)
  if (key.includes('[') || key.includes(']')) {
    throw new ApiError(422, 'VALIDATION_ERROR', '表单字段名称不合法')
  }
}

function appendFormValue(
  form: URLSearchParams,
  key: string,
  value: unknown,
  state: FormState,
  depth = 0,
) {
  validateKey(key)
  if (depth > 8) throw new ApiError(422, 'VALIDATION_ERROR', '表单嵌套层级过深')
  if (state.count >= 10_000) throw new ApiError(413, 'FORM_TOO_LARGE', '表单字段数量过多')

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    state.count += 1
    form.append(key, value === null ? '' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childKey = item !== null && typeof item === 'object'
        ? `${key}[${index}]`
        : `${key}[]`
      appendFormValue(form, childKey, item, state, depth + 1)
    })
    return
  }

  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([child, item]) => {
      validateSegment(child)
      appendFormValue(form, `${key}[${child}]`, item, state, depth + 1)
    })
    return
  }

  throw new ApiError(422, 'VALIDATION_ERROR', `表单字段 ${key} 的值不合法`)
}

export function toLegacyForm(
  values: Record<string, unknown>,
  fixed: Record<string, string> = {},
): URLSearchParams {
  const form = new URLSearchParams()
  const state = { count: 0 }
  Object.entries(values).forEach(([key, value]) => {
    validateSegment(key)
    appendFormValue(form, key, value, state)
  })
  Object.entries(fixed).forEach(([key, value]) => form.set(key, value))
  return form
}

function resolveOperationPath(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = values[name]
    const text = value === undefined ? '' : String(value)
    if (!/^[1-9]\d*$/.test(text)) {
      throw new ApiError(422, 'VALIDATION_ERROR', `路径参数 ${name} 必须是正整数`)
    }
    return encodeURIComponent(text)
  })
}

function operationDefinition(id: string): LegacyOperationDefinition {
  if (!Object.hasOwn(LegacyOperations, id)) {
    throw new ApiError(404, 'ACTION_NOT_FOUND', '请求的操作不存在')
  }
  const definition = (LegacyOperations as Record<string, LegacyOperationDefinition>)[id]
  if (!definition) throw new ApiError(404, 'ACTION_NOT_FOUND', '请求的操作不存在')
  return definition
}

export type NormalizedOperationResult = {
  data: unknown
  message?: string
  meta?: { total: number }
}

function optionalMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function normalizePayload(payload: unknown): NormalizedOperationResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { data: payload }
  const object = payload as Record<string, unknown>
  const message = optionalMessage(object.msg) ?? optionalMessage(object.message)

  if ('code' in object) {
    const upstreamCode = Number(object.code)
    if (!Number.isFinite(upstreamCode) || upstreamCode !== 0) {
      throw new ApiError(422, 'OPERATION_FAILED', message ?? '操作失败', {
        upstreamCode: Number.isFinite(upstreamCode) ? upstreamCode : object.code,
      })
    }

    const rest = Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== 'code' && key !== 'msg' && key !== 'message'),
    )
    if (Array.isArray(rest.rows)) {
      const total = Number(rest.total)
      return {
        data: rest.rows,
        meta: { total: Number.isFinite(total) && total >= 0 ? total : rest.rows.length },
        ...(message ? { message } : {}),
      }
    }
    const restKeys = Object.keys(rest)
    const data = restKeys.length === 1 && restKeys[0] === 'data' ? rest.data : restKeys.length === 0 ? null : rest
    return { data, ...(message ? { message } : {}) }
  }

  if (Array.isArray(object.rows)) {
    const total = Number(object.total)
    return {
      data: object.rows,
      meta: { total: Number.isFinite(total) && total >= 0 ? total : object.rows.length },
    }
  }

  return { data: object, ...(message ? { message } : {}) }
}

export function listLegacyOperations() {
  return Object.entries(LegacyOperations).map(([id, definition]) => ({
    id,
    group: definition.group,
    method: definition.method,
    pathParameters: Array.from(definition.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g), (match) => match[1]),
  }))
}

export async function executeLegacyOperation(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  operationId: string,
  rawRequest: unknown,
): Promise<NormalizedOperationResult> {
  const definition = operationDefinition(operationId)
  const request = OperationRequestSchema.parse(rawRequest ?? {})
  const path = resolveOperationPath(definition.path, request.path)
  const result = definition.method === 'GET'
    ? await client.get(path, context)
    : await client.postForm(path, toLegacyForm(request.form, definition.fixedForm), context)
  return normalizePayload(requireUpstreamJson(result, config))
}
