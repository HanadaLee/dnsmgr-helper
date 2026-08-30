import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { AuditLogEntry, PageMeta } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { integerValue, pagedOperation, stringValue } from './automation-common.js'
import { plainText } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

export const LogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  userId: z.coerce.number().int().positive().optional(),
  domain: z.string().trim().max(255).optional(),
  q: z.string().trim().max(255).optional(),
}).strict()

function normalizeLog(row: Record<string, unknown>): AuditLogEntry {
  const id = integerValue(row.id)
  if (id === undefined || id <= 0) {
    throw new ApiError(502, 'UPSTREAM_INVALID_LOG', '原 dnsmgr 返回了无法识别的操作日志')
  }
  const userId = integerValue(row.uid)
  const domain = stringValue(row.domain)
  const occurredAt = stringValue(row.addtime)
  return {
    id,
    actor: userId !== undefined && userId > 0
      ? { kind: 'user', userId }
      : { kind: 'administrator' },
    action: plainText(row.action) ?? '',
    detail: plainText(row.data) ?? '',
    ...(domain ? { domain } : {}),
    ...(occurredAt ? { occurredAt } : {}),
  }
}

export async function listAuditLogs(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawQuery: unknown,
): Promise<{ data: AuditLogEntry[]; meta: PageMeta }> {
  const query = LogsQuerySchema.parse(rawQuery)
  const result = await executeLegacyOperation(client, config, context, 'logs.list', {
    form: {
      offset: (query.page - 1) * query.pageSize,
      limit: query.pageSize,
      ...(query.userId === undefined ? {} : { uid: query.userId }),
      ...(query.domain ? { domain: query.domain } : {}),
      ...(query.q ? { kw: query.q } : {}),
    },
  })
  return pagedOperation(result, query.page, query.pageSize, '原 dnsmgr 操作日志格式不兼容', normalizeLog)
}
