import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'

export type RequestContext = {
  cookie?: string
  forwardedFor?: string
  requestId?: string
  logger?: UpstreamLogger
}

export type UpstreamLogger = {
  info(bindings: Record<string, unknown>, message: string): void
  warn(bindings: Record<string, unknown>, message: string): void
}

export type UpstreamResult = {
  status: number
  headers: Headers
  text: string
  contentType: string
  location?: string
  setCookies: string[]
}

export type FetchLike = typeof fetch

function setCookieValues(headers: Headers): string[] {
  const enhancedHeaders = headers as Headers & { getSetCookie?: () => string[] }
  if (enhancedHeaders.getSetCookie) return enhancedHeaders.getSetCookie()
  const value = headers.get('set-cookie')
  return value ? [value] : []
}

function redirectPath(location: string | undefined, baseUrl: URL): string | undefined {
  if (!location) return undefined
  try {
    return new URL(location, baseUrl).pathname
  } catch {
    return undefined
  }
}

export class DnsmgrClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async get(path: string, context: RequestContext): Promise<UpstreamResult> {
    return this.request(path, { method: 'GET' }, context)
  }

  async postForm(
    path: string,
    form: URLSearchParams,
    context: RequestContext,
  ): Promise<UpstreamResult> {
    return this.request(
      path,
      {
        method: 'POST',
        body: form,
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
      },
      context,
    )
  }

  private async request(
    path: string,
    init: RequestInit,
    context: RequestContext,
  ): Promise<UpstreamResult> {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new ApiError(500, 'INVALID_UPSTREAM_PATH', '拒绝访问非站内上游路径')
    }

    const url = new URL(path.slice(1), this.config.upstream.url)
    if (url.origin !== this.config.upstream.url.origin) {
      throw new ApiError(500, 'INVALID_UPSTREAM_ORIGIN', '拒绝访问未配置的上游地址')
    }

    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json, text/html;q=0.9')
    headers.set('x-requested-with', 'XMLHttpRequest')
    if (context.cookie) headers.set('cookie', context.cookie)
    if (context.forwardedFor) headers.set('x-forwarded-for', context.forwardedFor)
    if (this.config.upstream.host) headers.set('host', this.config.upstream.host)

    const method = init.method ?? 'GET'
    const startedAt = performance.now()
    const logContext = {
      parentRequestId: context.requestId,
      method,
      path: url.pathname,
      upstreamHost: url.host,
      hasSessionCookie: Boolean(context.cookie),
    }
    context.logger?.info(logContext, 'dnsmgr upstream request')

    let response: Response
    try {
      response = await this.fetcher(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.upstream.requestTimeoutMs),
      })
    } catch (error) {
      context.logger?.warn({
        ...logContext,
        responseTime: performance.now() - startedAt,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'dnsmgr upstream request failed')
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', '无法连接原 dnsmgr 服务', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    const location = response.headers.get('location') ?? undefined
    const text = await response.text()
    const setCookies = setCookieValues(response.headers)
    context.logger?.info({
      ...logContext,
      statusCode: response.status,
      responseTime: performance.now() - startedAt,
      contentType: response.headers.get('content-type') ?? '',
      responseBytes: Buffer.byteLength(text),
      setCookieCount: setCookies.length,
      ...(location ? { redirectPath: redirectPath(location, url) } : {}),
    }, 'dnsmgr upstream response')
    return {
      status: response.status,
      headers: response.headers,
      text,
      contentType: response.headers.get('content-type') ?? '',
      ...(location ? { location } : {}),
      setCookies,
    }
  }
}
