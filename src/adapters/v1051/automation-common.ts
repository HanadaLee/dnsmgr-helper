import type { AutomationDomainOption, DnsRecordSnapshot, PageMeta } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import { embeddedJsonAssignment, plainText } from './html-state.js'
import type { NormalizedOperationResult } from './operations.js'

export type LegacyObject = Record<string, unknown>

export function objectValue(value: unknown): LegacyObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as LegacyObject
    : undefined
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value.trim() : undefined
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return undefined
}

export function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function integerValue(value: unknown): number | undefined {
  const parsed = numberValue(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined
}

export function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true'
}

export function requiredPositiveInteger(
  value: unknown,
  code: string,
  message: string,
): number {
  const parsed = integerValue(value)
  if (parsed === undefined || parsed <= 0) throw new ApiError(502, code, message)
  return parsed
}

export function rowsFromOperation(
  result: NormalizedOperationResult,
  invalidMessage: string,
): LegacyObject[] {
  if (!Array.isArray(result.data)) {
    throw new ApiError(502, 'UPSTREAM_INVALID_PAYLOAD', invalidMessage)
  }
  return result.data.flatMap((row): LegacyObject[] => objectValue(row) ? [row] : [])
}

export function pagedOperation<T>(
  result: NormalizedOperationResult,
  page: number,
  pageSize: number,
  invalidMessage: string,
  normalize: (row: LegacyObject) => T,
): { data: T[]; meta: PageMeta } {
  const rows = rowsFromOperation(result, invalidMessage)
  return {
    data: rows.map(normalize),
    meta: {
      page,
      pageSize,
      total: result.meta?.total ?? rows.length,
    },
  }
}

export function operationMessage(message: string | undefined): { message?: string } {
  return message ? { message } : {}
}

export function optionalDisplayTime(value: unknown): string | undefined {
  const text = stringValue(value)
  if (!text || text === '未运行' || text === '无' || text === '0') return undefined
  return text
}

export function parseRecordSnapshot(value: unknown): DnsRecordSnapshot | undefined {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  const record = objectValue(parsed)
  if (!record) return undefined
  const ttl = integerValue(record.TTL)
  if (ttl === undefined || ttl < 0) return undefined
  const lineId = stringValue(record.Line) ?? ''
  const lineLabel = stringValue(record.LineName)
  const type = stringValue(record.Type)
  const rawValues = Array.isArray(record.Value)
    ? record.Value.map(stringValue).filter((item): item is string => Boolean(item))
    : undefined
  const rawValue = rawValues?.join(',') ?? stringValue(record.Value)
  return {
    lineId,
    ttl,
    ...(type ? { type } : {}),
    ...(lineLabel ? { lineLabel } : {}),
    ...(rawValue ? { value: rawValue } : {}),
    ...(rawValues?.length ? { values: rawValues } : {}),
  }
}

export function parseAutomationDomains(html: string): AutomationDomainOption[] {
  const raw = embeddedJsonAssignment(html, 'domainList')
  if (!Array.isArray(raw)) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的域名选项格式不兼容')
  }
  return raw.flatMap((item): AutomationDomainOption[] => {
    const row = objectValue(item)
    if (!row) return []
    const id = integerValue(row.id)
    const name = stringValue(row.name)
    if (id === undefined || id <= 0 || !name) return []
    return [{ id, name, providerType: stringValue(row.type) ?? 'unknown' }]
  })
}

export function requiredEmbeddedObject(
  html: string,
  variable: string,
  notFoundText: RegExp,
  notFoundCode: string,
  notFoundMessage: string,
): LegacyObject {
  if (notFoundText.test(plainText(html) ?? '')) {
    throw new ApiError(404, notFoundCode, notFoundMessage)
  }
  const raw = embeddedJsonAssignment(html, variable)
  const value = objectValue(raw)
  if (!value) throw new ApiError(404, notFoundCode, notFoundMessage)
  return value
}

export function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function countAfterText(html: string, label: string): number | undefined {
  const match = new RegExp(`${regexpEscape(label)}\\s*[：:]?\\s*<[^>]+>\\s*(\\d+)`, 'i').exec(html)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export function textAfterBoldLabel(html: string, label: string): string | undefined {
  const match = new RegExp(
    `<b[^>]*>\\s*${regexpEscape(label)}\\s*[：:]?\\s*</b>([\\s\\S]*?)</li>`,
    'i',
  ).exec(html)
  return match ? plainText(match[1]) : undefined
}
