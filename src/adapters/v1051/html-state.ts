import { ApiError } from '../../errors.js'

const MAX_EMBEDDED_JSON_BYTES = 2 * 1024 * 1024

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function jsonLiteralEnd(source: string, start: number): number {
  const first = source[start]
  if (first === undefined) return -1

  if (first === '{' || first === '[') {
    const stack = [first]
    let quoted = false
    let escaped = false

    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }

      if (character === '"') {
        quoted = true
        continue
      }
      if (character === '{' || character === '[') stack.push(character)
      else if (character === '}' || character === ']') {
        const expected = character === '}' ? '{' : '['
        if (stack.pop() !== expected) return -1
        if (stack.length === 0) return index + 1
      }
    }
    return -1
  }

  if (first === '"') {
    let escaped = false
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index]
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') return index + 1
    }
    return -1
  }

  const end = source.slice(start).search(/[;\r\n<]/)
  return end < 0 ? source.length : start + end
}

export function embeddedJsonAssignment(html: string, variable: string): unknown {
  const assignment = new RegExp(`\\b(?:var|let|const)\\s+${regexpEscape(variable)}\\s*=`).exec(html)
  if (!assignment) {
    throw new ApiError(
      502,
      'UPSTREAM_ADAPTER_MISMATCH',
      `原 dnsmgr 页面缺少 ${variable} 状态`,
    )
  }

  let start = assignment.index + assignment[0].length
  while (/\s/.test(html[start] ?? '')) start += 1
  const end = jsonLiteralEnd(html, start)
  if (end <= start || end - start > MAX_EMBEDDED_JSON_BYTES) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', `原 dnsmgr 的 ${variable} 状态格式不兼容`)
  }

  try {
    return JSON.parse(html.slice(start, end)) as unknown
  } catch {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', `原 dnsmgr 的 ${variable} 状态格式不兼容`)
  }
}

const HtmlEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
}

export function plainText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
      if (entity[0] === '#') {
        const hexadecimal = entity[1]?.toLowerCase() === 'x'
        const parsed = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
        return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff
          ? String.fromCodePoint(parsed)
          : ''
      }
      return HtmlEntities[entity.toLowerCase()] ?? ''
    })
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || undefined
}

export function integerInputAttribute(
  html: string,
  inputName: string,
  attribute: string,
): number | undefined {
  const escapedName = regexpEscape(inputName)
  const input = new RegExp(`<input\\b[^>]*\\bname=["']${escapedName}["'][^>]*>`, 'i').exec(html)?.[0]
  if (!input) return undefined
  const escapedAttribute = regexpEscape(attribute)
  const value = new RegExp(`\\b${escapedAttribute}=["'](-?\\d+)["']`, 'i').exec(input)?.[1]
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}
