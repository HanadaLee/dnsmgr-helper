import type { AppConfig } from '../config.js'
import { ApiError } from '../errors.js'
import type { UpstreamResult } from './client.js'

function looksLikeLoginPage(result: UpstreamResult): boolean {
  return result.contentType.toLowerCase().includes('text/html')
    && result.text.includes('name="username"')
    && result.text.includes('name="password"')
}

export function requireUpstreamJson(result: UpstreamResult, config: AppConfig): unknown {
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

  try {
    return JSON.parse(result.text) as unknown
  } catch {
    throw new ApiError(502, 'UPSTREAM_INVALID_JSON', '原 dnsmgr 返回了无法识别的数据')
  }
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
  config: AppConfig,
  source: 'helper-session' | 'legacy-upstream' = 'legacy-upstream',
): ApiError {
  return new ApiError(401, 'AUTH_REQUIRED', '请通过统一身份认证登录', {
    loginPath: config.cas.loginPath,
    source,
  })
}
