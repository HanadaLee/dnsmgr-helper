import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import type { DatabaseClient } from '../database/client.js'
import {
  DNSMGR_LOGIN_PATH,
  DNSMGR_REGISTER_PATH,
  DNSMGR_SESSION_COOKIE,
} from '../dnsmgr-constants.js'
import { ApiError } from '../errors.js'
import type { DnsmgrClient, RequestContext, UpstreamResult } from '../upstream/client.js'
import { requireUpstreamJson } from '../upstream/legacy.js'
import { singleCookieHeader } from './cookies.js'
import { createDnsmgrUserToken } from './dnsmgr-token.js'

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
    private readonly database: Pick<DatabaseClient, 'enabled' | 'prepareManagedUserSession'>,
  ) {}

  private credentials() {
    const { adminUser, managedPassword } = this.config.legacySso
    if (!adminUser || !managedPassword) {
      throw new ApiError(503, 'LEGACY_SSO_NOT_CONFIGURED', 'dnsmgr 托管登录尚未配置')
    }
    return { adminUser, managedPassword }
  }

  private async login(username: string, context: RequestContext = {}): Promise<LoginResult> {
    const { managedPassword } = this.credentials()
    const form = new URLSearchParams({ username, password: managedPassword })
    const result = await this.client.postForm(DNSMGR_LOGIN_PATH, form, context)
    const payload = requireUpstreamJson(result, this.config)
    const code = numericCode(payload)
    if (code === undefined) {
      throw new ApiError(502, 'LEGACY_LOGIN_INVALID', '原 dnsmgr 返回了无法识别的登录响应')
    }

    const token = code === 0
      ? cookieValue(result, DNSMGR_SESSION_COOKIE)
      : undefined
    if (code === 0 && !token) {
      throw new ApiError(502, 'LEGACY_LOGIN_COOKIE_MISSING', '原 dnsmgr 登录响应缺少会话 Cookie')
    }
    return { code, ...(token ? { token } : {}) }
  }

  private async register(profile: CasProfile, requestContext: RequestContext): Promise<void> {
    const { adminUser, managedPassword } = this.credentials()
    const adminLogin = await this.login(adminUser, requestContext)
    if (adminLogin.code !== 0 || !adminLogin.token) {
      throw new ApiError(502, 'LEGACY_ADMIN_LOGIN_FAILED', '无法使用配置的管理员登录原 dnsmgr')
    }

    const context: RequestContext = {
      ...requestContext,
      cookie: singleCookieHeader(DNSMGR_SESSION_COOKIE, adminLogin.token),
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
    const result = await this.client.postForm(DNSMGR_REGISTER_PATH, form, context)
    const code = numericCode(requireUpstreamJson(result, this.config))
    if (code !== 0 && code !== -1) {
      throw new ApiError(502, 'LEGACY_REGISTER_FAILED', '无法在原 dnsmgr 中创建 CAS 用户')
    }
  }

  async loginOrRegister(profile: CasProfile, context: RequestContext = {}): Promise<string> {
    if (this.database.enabled) {
      try {
        const user = await this.database.prepareManagedUserSession(profile.name, context.forwardedFor)
        return createDnsmgrUserToken(user, user.systemKey)
      } catch (error) {
        throw new ApiError(503, 'DATABASE_SSO_FAILED', '无法通过 dnsmgr 数据库创建登录会话', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const firstLogin = await this.login(profile.name, context)
    if (firstLogin.code === 0 && firstLogin.token) return firstLogin.token
    if (firstLogin.code !== -1) {
      throw new ApiError(502, 'LEGACY_LOGIN_FAILED', 'CAS 用户无法登录原 dnsmgr')
    }

    await this.register(profile, context)
    const secondLogin = await this.login(profile.name, context)
    if (secondLogin.code !== 0 || !secondLogin.token) {
      throw new ApiError(502, 'LEGACY_LOGIN_FAILED', 'dnsmgr 用户创建后仍无法登录')
    }
    return secondLogin.token
  }
}
