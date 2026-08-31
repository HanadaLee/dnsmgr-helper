import { z } from 'zod'

import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext, UpstreamResult } from '../../upstream/client.js'

export const PublicApiIdSchema = z.coerce.number().int().positive()
export const CronQuerySchema = z.object({ key: z.string().max(255).default('') }).strict()
export const QuickLoginQuerySchema = z.object({
  domain: z.string().trim().min(1).max(253),
  timestamp: z.string().regex(/^\d{1,20}$/),
  token: z.string().trim().min(1).max(2048),
  sign: z.string().regex(/^[a-f\d]{32}$/i),
}).strict()

const UnsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const PublicFormKey = /^[A-Za-z][A-Za-z0-9_]*(?:\[[A-Za-z0-9_]*\])*$/

function appendScalar(form: URLSearchParams, key: string, value: unknown) {
  if (value === null || value === undefined) {
    form.append(key, '')
    return
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    form.append(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    return
  }
  throw new ApiError(422, 'VALIDATION_ERROR', `公开 API 字段 ${key} 的值格式不合法`)
}

export function publicApiForm(rawBody: unknown): URLSearchParams {
  if (rawBody === undefined || rawBody === null) return new URLSearchParams()
  if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new ApiError(422, 'VALIDATION_ERROR', '公开 API 请求体必须是表单对象')
  }
  const form = new URLSearchParams()
  let count = 0
  for (const [key, value] of Object.entries(rawBody as Record<string, unknown>)) {
    if (!PublicFormKey.test(key) || UnsafeKeys.has(key) || key.length > 255) {
      throw new ApiError(422, 'VALIDATION_ERROR', '公开 API 表单字段名称不合法')
    }
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      count += 1
      if (count > 10_000) throw new ApiError(413, 'FORM_TOO_LARGE', '公开 API 表单字段数量过多')
      appendScalar(form, key, item)
    }
  }
  return form
}

export async function forwardPublicApi(
  client: DnsmgrClient,
  context: RequestContext,
  path: string,
  rawBody: unknown,
): Promise<UpstreamResult> {
  return client.postForm(path, publicApiForm(rawBody), context)
}

export async function forwardCron(
  client: DnsmgrClient,
  context: RequestContext,
  rawQuery: unknown,
): Promise<UpstreamResult> {
  const query = CronQuerySchema.parse(rawQuery)
  return client.get(`/cron?key=${encodeURIComponent(query.key)}`, context)
}

export async function forwardQuickLogin(
  client: DnsmgrClient,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ domain: string; result: UpstreamResult }> {
  const query = QuickLoginQuerySchema.parse(rawQuery)
  const search = new URLSearchParams(query)
  return {
    domain: query.domain,
    result: await client.getHtml(`/quicklogin?${search.toString()}`, context),
  }
}

export async function forwardWorkerStatus(
  client: DnsmgrClient,
  context: RequestContext,
  path: '/dmtask/status' | '/optimizeip/status',
): Promise<UpstreamResult> {
  return client.get(path, context)
}
