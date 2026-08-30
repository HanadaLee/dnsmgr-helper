import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'

export type RequestContext = {
  cookie?: string
  forwardedFor?: string
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

    const url = new URL(path.slice(1), this.config.upstreamUrl)
    if (url.origin !== this.config.upstreamUrl.origin) {
      throw new ApiError(500, 'INVALID_UPSTREAM_ORIGIN', '拒绝访问未配置的上游地址')
    }

    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json, text/html;q=0.9')
    headers.set('x-requested-with', 'XMLHttpRequest')
    if (context.cookie) headers.set('cookie', context.cookie)
    if (context.forwardedFor) headers.set('x-forwarded-for', context.forwardedFor)
    if (this.config.upstreamHost) headers.set('host', this.config.upstreamHost)

    let response: Response
    try {
      response = await this.fetcher(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      })
    } catch (error) {
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', '无法连接原 dnsmgr 服务', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    const location = response.headers.get('location') ?? undefined
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
      ...(location ? { location } : {}),
      setCookies: setCookieValues(response.headers),
    }
  }
}
