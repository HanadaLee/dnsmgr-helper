import type { ProviderField, ProviderFieldOption } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import { booleanValue, numberValue, objectValue, stringValue, type LegacyObject } from './automation-common.js'
import { plainText } from './html-state.js'

const UnsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])

type JsonState = { count: number }

function safeJsonValue(value: unknown, state: JsonState, depth = 0): unknown {
  if (depth > 8) throw new ApiError(422, 'VALIDATION_ERROR', '动态配置嵌套层级过深')
  if (state.count >= 10_000) throw new ApiError(413, 'CONFIG_TOO_LARGE', '动态配置字段数量过多')
  state.count += 1

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiError(422, 'VALIDATION_ERROR', '动态配置包含无效数字')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => safeJsonValue(item, state, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value as LegacyObject)) {
      if (!key || key.length > 255 || key.includes('\0') || UnsafeKeys.has(key)) {
        throw new ApiError(422, 'VALIDATION_ERROR', '动态配置字段名称不合法')
      }
      result[key] = safeJsonValue(item, state, depth + 1)
    }
    return result
  }
  throw new ApiError(422, 'VALIDATION_ERROR', '动态配置包含不支持的值')
}

export function safeConfigObject(value: unknown): Record<string, unknown> {
  const object = objectValue(value)
  if (!object) throw new ApiError(422, 'VALIDATION_ERROR', '动态配置必须是对象')
  return safeJsonValue(object, { count: 0 }) as Record<string, unknown>
}

export function parseConfigObject(value: unknown, invalidMessage: string): Record<string, unknown> {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new ApiError(502, 'UPSTREAM_INVALID_CONFIG', invalidMessage)
    }
  }
  try {
    return safeConfigObject(parsed)
  } catch (error) {
    if (error instanceof ApiError && error.statusCode >= 500) throw error
    throw new ApiError(502, 'UPSTREAM_INVALID_CONFIG', invalidMessage)
  }
}

export function safeIcon(value: unknown): string | undefined {
  const icon = stringValue(value)
  if (!icon || icon.includes('/') || icon.includes('\\') || icon.includes('..') || icon.length > 255) {
    return undefined
  }
  return icon
}

function sensitiveField(key: string, label: string): boolean {
  const name = `${key} ${label}`.toLowerCase()
  return /(secret|password|passwd|token|private|credential|密码|密钥|私钥)/.test(name)
    || /(^|[_\s-])(api[_\s-]?key|sk)([_\s-]|$)/.test(name)
}

export function normalizeFieldOptions(value: unknown): ProviderFieldOption[] | undefined {
  if (Array.isArray(value)) {
    const options = value.flatMap((option, index): ProviderFieldOption[] => {
      const object = objectValue(option)
      if (object) {
        const optionValue = stringValue(object.value)
        const label = plainText(object.label)
        return optionValue === undefined || !label ? [] : [{ value: optionValue, label }]
      }
      const label = plainText(option)
      return label ? [{ value: String(index), label }] : []
    })
    return options.length ? options : undefined
  }
  const object = objectValue(value)
  if (!object) return undefined
  const options = Object.entries(object).flatMap(([optionValue, optionLabel]): ProviderFieldOption[] => {
    const label = plainText(optionLabel)
    return label ? [{ value: optionValue, label }] : []
  })
  return options.length ? options : undefined
}

function visibility(value: unknown): ProviderField['visibleWhen'] | undefined {
  if (value === undefined || value === null || value === '' || value === true) return undefined
  if (value === false) return { any: [] }
  const expression = stringValue(value)
  if (!expression) return undefined

  const any = expression.split(/\s*\|\|\s*/).map((group) => {
    const all = group.split(/\s*&&\s*/).map((condition) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.-]+))$/.exec(condition.trim())
      if (!match?.[1] || !match[2]) {
        throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', `原 dnsmgr 包含不兼容的字段显示条件：${expression}`)
      }
      return {
        field: match[1],
        operator: match[2] === '==' ? 'equals' as const : 'not-equals' as const,
        value: match[3] ?? match[4] ?? match[5] ?? '',
      }
    })
    return { all }
  })
  return { any }
}

export function normalizeDynamicField(key: string, raw: unknown): ProviderField | undefined {
  const field = objectValue(raw)
  if (!field || UnsafeKeys.has(key) || !key || key.length > 255) return undefined
  const control = stringValue(field.type)
  if (!control || !['input', 'textarea', 'select', 'radio', 'checkbox', 'checkboxes'].includes(control)) {
    return undefined
  }
  const label = plainText(field.name) ?? key
  const placeholder = plainText(field.placeholder)
  const note = plainText(field.note)
  const validator = stringValue(field.validator)
  const min = numberValue(field.min)
  const max = numberValue(field.max)
  const options = normalizeFieldOptions(field.options)
  const visibleWhen = visibility(field.show)
  let defaultValue: unknown
  if (Object.hasOwn(field, 'value')) {
    try {
      defaultValue = safeJsonValue(field.value, { count: 0 })
    } catch {
      defaultValue = undefined
    }
  }

  return {
    key,
    label,
    control: control as ProviderField['control'],
    required: booleanValue(field.required),
    disabled: booleanValue(field.disabled),
    sensitive: sensitiveField(key, label),
    ...(placeholder ? { placeholder } : {}),
    ...(note ? { note } : {}),
    ...(validator ? { validator } : {}),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(options ? { options } : {}),
    ...(visibleWhen ? { visibleWhen } : {}),
  }
}

export function normalizeDynamicFields(value: unknown): ProviderField[] {
  const fields = objectValue(value)
  if (!fields) return []
  return Object.entries(fields).flatMap(([key, raw]): ProviderField[] => {
    const field = normalizeDynamicField(key, raw)
    return field ? [field] : []
  })
}
