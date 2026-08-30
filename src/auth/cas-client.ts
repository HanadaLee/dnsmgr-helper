import { XMLParser, XMLValidator } from 'fast-xml-parser'

import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import { ApiError } from '../errors.js'
import type { FetchLike } from '../upstream/client.js'

type XmlObject = Record<string, unknown>

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
})

function objectValue(value: unknown): XmlObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as XmlObject
    : undefined
}

function scalarValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return scalarValue(value[0])
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim()
    return text === '' ? undefined : text
  }
  const object = objectValue(value)
  return object ? scalarValue(object['#text']) : undefined
}

function listedAttribute(value: unknown, name: string): string | undefined {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  for (const entry of entries) {
    const object = objectValue(entry)
    if (!object || scalarValue(object['@_name']) !== name) continue
    return scalarValue(object['@_value']) ?? scalarValue(object['#text'])
  }
  return undefined
}

function profileAttribute(success: XmlObject, name: string): string | undefined {
  const direct = scalarValue(success[name])
  if (direct) return direct

  const attributes = objectValue(success.attributes)
  if (!attributes) return undefined
  const directAttribute = scalarValue(attributes[name])
  if (directAttribute) return directAttribute

  const directListValue = listedAttribute(attributes.attribute, name)
  if (directListValue) return directListValue

  const userAttributes = objectValue(attributes.userAttributes)
  return listedAttribute(userAttributes?.attribute, name)
}

export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const base = new URL('https://dnsmgr-helper.invalid/')
    const candidate = new URL(value, base)
    if (candidate.origin !== base.origin) return '/'
    return `${candidate.pathname}${candidate.search}${candidate.hash}`
  } catch {
    return '/'
  }
}

export function casServiceUrl(config: AppConfig, returnTo: string): URL {
  const service = new URL(config.cas.callbackPath, config.server.publicUrl)
  service.searchParams.set('returnTo', safeReturnTo(returnTo))
  return service
}

function casUrl(config: AppConfig, path: string): URL {
  if (!config.cas.enabled || !config.cas.baseUrl) {
    throw new ApiError(503, 'CAS_DISABLED', 'CAS 登录未启用')
  }
  return new URL(path, config.cas.baseUrl)
}

export function casLoginUrl(config: AppConfig, returnTo: string): URL {
  const url = casUrl(config, 'login')
  url.searchParams.set('service', casServiceUrl(config, returnTo).href)
  return url
}

export function casLogoutUrl(config: AppConfig): URL {
  const url = casUrl(config, 'logout')
  url.searchParams.set(
    'service',
    new URL(config.cas.logoutRedirectPath, config.server.publicUrl).href,
  )
  return url
}

export class CasClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async validate(ticket: string, returnTo: string): Promise<CasProfile> {
    const validationBase = this.config.cas.validationUrl ?? this.config.cas.baseUrl
    if (!this.config.cas.enabled || !validationBase) {
      throw new ApiError(503, 'CAS_DISABLED', 'CAS 登录未启用')
    }

    const url = new URL('serviceValidate', validationBase)
    url.searchParams.set('ticket', ticket)
    url.searchParams.set('service', casServiceUrl(this.config, returnTo).href)
    const headers = new Headers({ accept: 'application/xml, text/xml' })
    if (this.config.cas.validationHost) headers.set('host', this.config.cas.validationHost)

    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.cas.requestTimeoutMs),
      })
    } catch (error) {
      throw new ApiError(502, 'CAS_UNAVAILABLE', '无法连接 CAS 服务', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    if (response.status !== 200) {
      throw new ApiError(502, 'CAS_BAD_STATUS', `CAS 验证服务返回 HTTP ${response.status}`)
    }

    const xml = await response.text()
    if (xml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new ApiError(502, 'CAS_INVALID_RESPONSE', 'CAS 返回了不安全的验证响应')
    }
    if (XMLValidator.validate(xml) !== true) {
      throw new ApiError(502, 'CAS_INVALID_RESPONSE', 'CAS 返回了无法解析的验证响应')
    }

    let parsed: XmlObject
    try {
      parsed = objectValue(parser.parse(xml)) ?? {}
    } catch {
      throw new ApiError(502, 'CAS_INVALID_RESPONSE', 'CAS 返回了无法解析的验证响应')
    }

    const serviceResponse = objectValue(parsed.serviceResponse)
    const success = objectValue(serviceResponse?.authenticationSuccess)
    if (!success) throw new ApiError(401, 'CAS_TICKET_INVALID', 'CAS Ticket 无效或已经使用')

    const fields = this.config.cas.attributes
    const name = profileAttribute(success, fields.user)
    if (!name || name.length > 128) {
      throw new ApiError(502, 'CAS_PROFILE_INVALID', 'CAS 响应缺少有效用户名')
    }

    const email = profileAttribute(success, fields.email)
    const displayName = profileAttribute(success, fields.displayName)
    const avatar = profileAttribute(success, fields.avatar)
    return {
      name,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
      ...(avatar ? { avatar } : {}),
    }
  }
}
