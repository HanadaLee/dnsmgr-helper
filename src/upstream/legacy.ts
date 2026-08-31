import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'
import type { UpstreamResult } from './client.js'

function looksLikeLoginPage(result: UpstreamResult): boolean {
  return result.contentType.toLowerCase().includes('text/html')
    && result.text.includes('name="username"')
    && result.text.includes('name="password"')
}

function requireSuccessfulUpstream(result: UpstreamResult, config: AppConfig) {
  if (isLoginRedirect(result)) {
    throw authenticationError(config)
  }

  if (result.status === 401 || result.status === 403) {
    if (result.status === 401) throw authenticationError(config)
    throw new ApiError(403, 'FORBIDDEN', '没有权限执行此操作')
  }

  if (result.status < 200 || result.status >= 300) {
    throw new ApiError(502, 'UPSTREAM_BAD_STATUS', `原 dnsmgr 返回 HTTP ${result.status}`)
  }

  if (looksLikeLoginPage(result)) throw authenticationError(config)
}

export function requireUpstreamJson(result: UpstreamResult, config: AppConfig): unknown {
  requireSuccessfulUpstream(result, config)

  try {
    return JSON.parse(result.text) as unknown
  } catch {
    throw new ApiError(502, 'UPSTREAM_INVALID_JSON', '原 dnsmgr 返回了无法识别的数据')
  }
}

export function requireUpstreamHtml(result: UpstreamResult, config: AppConfig): string {
  requireSuccessfulUpstream(result, config)
  if (!result.contentType.toLowerCase().includes('text/html')) {
    throw new ApiError(502, 'UPSTREAM_INVALID_HTML', '原 dnsmgr 返回了无法识别的页面')
  }
  if (/无权限|权限不足/.test(result.text)) {
    throw new ApiError(403, 'FORBIDDEN', '没有权限执行此操作')
  }
  return result.text
}

export function requireUpstreamText(result: UpstreamResult, config: AppConfig): string {
  requireSuccessfulUpstream(result, config)
  return result.text.trim()
}

export function isLoginRedirect(result: UpstreamResult): boolean {
  if (result.status < 300 || result.status >= 400 || !result.location) return false
  try {
    const location = new URL(result.location, 'https://dnsmgr-helper.invalid')
    return location.pathname === '/login'
  } catch {
    return result.location.startsWith('/login')
  }
}

export function authenticationError(
  _config: AppConfig,
  source: 'helper-session' | 'legacy-upstream' = 'legacy-upstream',
): ApiError {
  return new ApiError(401, 'AUTH_REQUIRED', '请通过统一身份认证登录', {
    loginPath: '/login',
    source,
  })
}
