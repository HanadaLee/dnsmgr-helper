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
  const value = namedElementAttribute(html, 'input', inputName, attribute)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export function namedElementAttribute(
  html: string,
  tag: 'input' | 'select' | 'textarea',
  elementName: string,
  attribute: string,
): string | undefined {
  const escapedName = regexpEscape(elementName)
  const element = new RegExp(
    `<${tag}\\b(?=[^>]*\\bname\\s*=\\s*(?:["']${escapedName}["']|${escapedName}(?=\\s|>)))[^>]*>`,
    'i',
  ).exec(html)?.[0]
  if (!element) return undefined

  const escapedAttribute = regexpEscape(attribute)
  const match = new RegExp(
    `\\b${escapedAttribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(element)
  if (!match) return undefined
  return plainText(match[1] ?? match[2] ?? match[3] ?? '') ?? ''
}

export function namedElementHasAttribute(
  html: string,
  tag: 'input' | 'select' | 'textarea',
  elementName: string,
  attribute: string,
): boolean {
  const escapedName = regexpEscape(elementName)
  const element = new RegExp(
    `<${tag}\\b(?=[^>]*\\bname\\s*=\\s*(?:["']${escapedName}["']|${escapedName}(?=\\s|>)))[^>]*>`,
    'i',
  ).exec(html)?.[0]
  if (!element) return false
  return new RegExp(`\\b${regexpEscape(attribute)}(?:\\s*=|(?=\\s|/?>))`, 'i').test(element)
}

export function elementIdHasAttribute(
  html: string,
  tag: 'input' | 'select' | 'textarea',
  elementId: string,
  attribute: string,
): boolean {
  const escapedId = regexpEscape(elementId)
  const element = new RegExp(
    `<${tag}\\b(?=[^>]*\\bid\\s*=\\s*(?:["']${escapedId}["']|${escapedId}(?=\\s|>)))[^>]*>`,
    'i',
  ).exec(html)?.[0]
  if (!element) return false
  return new RegExp(`\\b${regexpEscape(attribute)}(?:\\s*=|(?=\\s|/?>))`, 'i').test(element)
}

export function namedTextareaValue(html: string, elementName: string): string | undefined {
  const escapedName = regexpEscape(elementName)
  const value = new RegExp(
    `<textarea\\b(?=[^>]*\\bname\\s*=\\s*(?:["']${escapedName}["']|${escapedName}(?=\\s|>)))[^>]*>([\\s\\S]*?)</textarea>`,
    'i',
  ).exec(html)?.[1]
  if (value === undefined) return undefined
  return plainText(value) ?? ''
}

export function tableCellAfterLabel(html: string, label: string): string | undefined {
  const match = new RegExp(
    `<t[dh]\\b[^>]*>\\s*${regexpEscape(label)}\\s*</t[dh]>\\s*<t[dh]\\b[^>]*>([\\s\\S]*?)</t[dh]>`,
    'i',
  ).exec(html)
  return match ? plainText(match[1]) : undefined
}

export function namedSelectOptions(
  html: string,
  elementName: string,
): Array<{ value: string; label: string }> {
  const escapedName = regexpEscape(elementName)
  const select = new RegExp(
    `<select\\b(?=[^>]*\\bname\\s*=\\s*(?:["']${escapedName}["']|${escapedName}(?=\\s|>)))[^>]*>([\\s\\S]*?)</select>`,
    'i',
  ).exec(html)?.[1]
  if (select === undefined) return []

  return Array.from(select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)).flatMap((match) => {
    const valueMatch = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1] ?? '')
    const value = plainText(valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3] ?? '') ?? ''
    const label = plainText(match[2]) ?? ''
    return value || label ? [{ value, label }] : []
  })
}
