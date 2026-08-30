import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import { ApiError } from '../errors.js'
import type { DnsmgrClient, RequestContext, UpstreamResult } from '../upstream/client.js'
import { requireUpstreamJson } from '../upstream/legacy.js'
import { singleCookieHeader } from './cookies.js'

type LoginResult = {
  code: number
  token?: string
}

function numericCode(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const code = Number((payload as Record<string, unknown>).code)
  return Number.isFinite(code) ? code : undefined
}

function cookieValue(result: UpstreamResult, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`(?:^|,\\s*)${escapedName}=([^;,]*)`, 'i')
  for (const setCookie of result.setCookies) {
    const value = expression.exec(setCookie)?.[1]
    if (!value) continue
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

export class LegacySsoService {
  constructor(
    private readonly config: AppConfig,
    private readonly client: DnsmgrClient,
  ) {}

  private credentials() {
    const { adminUser, managedPassword } = this.config.legacySso
    if (!adminUser || !managedPassword) {
      throw new ApiError(503, 'LEGACY_SSO_NOT_CONFIGURED', 'dnsmgr 托管登录尚未配置')
    }
    return { adminUser, managedPassword }
  }

  private async login(username: string): Promise<LoginResult> {
    const { managedPassword } = this.credentials()
    const form = new URLSearchParams({ username, password: managedPassword })
    const result = await this.client.postForm(this.config.legacySso.loginPath, form, {})
    const payload = requireUpstreamJson(result, this.config)
    const code = numericCode(payload)
    if (code === undefined) {
      throw new ApiError(502, 'LEGACY_LOGIN_INVALID', '原 dnsmgr 返回了无法识别的登录响应')
    }

    const token = code === 0
      ? cookieValue(result, this.config.legacySso.sessionCookie)
      : undefined
    if (code === 0 && !token) {
      throw new ApiError(502, 'LEGACY_LOGIN_COOKIE_MISSING', '原 dnsmgr 登录响应缺少会话 Cookie')
    }
    return { code, ...(token ? { token } : {}) }
  }

  private async register(profile: CasProfile): Promise<void> {
    const { adminUser, managedPassword } = this.credentials()
    const adminLogin = await this.login(adminUser)
    if (adminLogin.code !== 0 || !adminLogin.token) {
      throw new ApiError(502, 'LEGACY_ADMIN_LOGIN_FAILED', '无法使用配置的管理员登录原 dnsmgr')
    }

    const context: RequestContext = {
      cookie: singleCookieHeader(this.config.legacySso.sessionCookie, adminLogin.token),
    }
    const form = new URLSearchParams({
      action: 'add',
      id: '',
      username: profile.name,
      password: managedPassword,
      is_api: '0',
      apikey: '',
      level: '1',
      repwd: '',
    })
    const result = await this.client.postForm(this.config.legacySso.registerPath, form, context)
    const code = numericCode(requireUpstreamJson(result, this.config))
    if (code !== 0 && code !== -1) {
      throw new ApiError(502, 'LEGACY_REGISTER_FAILED', '无法在原 dnsmgr 中创建 CAS 用户')
    }
  }

  async loginOrRegister(profile: CasProfile): Promise<string> {
    const firstLogin = await this.login(profile.name)
    if (firstLogin.code === 0 && firstLogin.token) return firstLogin.token
    if (firstLogin.code !== -1) {
      throw new ApiError(502, 'LEGACY_LOGIN_FAILED', 'CAS 用户无法登录原 dnsmgr')
    }

    await this.register(profile)
    const secondLogin = await this.login(profile.name)
    if (secondLogin.code !== 0 || !secondLogin.token) {
      throw new ApiError(502, 'LEGACY_LOGIN_FAILED', 'dnsmgr 用户创建后仍无法登录')
    }
    return secondLogin.token
  }
}
