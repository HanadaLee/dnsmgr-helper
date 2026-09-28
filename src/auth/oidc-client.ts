import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { createRemoteJWKSet, customFetch, EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from 'jose'

import type { AppConfig } from '../config.js'
import type { CasProfile } from '../contracts.js'
import { ApiError } from '../errors.js'
import type { FetchLike } from '../upstream/client.js'

type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  end_session_endpoint?: string
  token_endpoint_auth_methods_supported?: string[]
}

export const OIDC_STATE_COOKIE = 'dnsmgr_helper_oidc_state'
export const OIDC_LOGOUT_COOKIE = 'dnsmgr_helper_oidc_logout'
export const OIDC_TOKEN_COOKIE = 'dnsmgr_helper_oidc_token'
export const SIGNED_OUT_COOKIE = 'dnsmgr_helper_signed_out'
const STATE_ISSUER = 'dnsmgr-helper'
const STATE_AUDIENCE = 'dnsmgr-oidc-state'

function randomValue(): string {
  return randomBytes(32).toString('base64url')
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function endpoint(value: unknown, config: AppConfig): URL {
  if (typeof value !== 'string') throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 发现文档缺少端点')
  let url: URL
  try { url = new URL(value) } catch { throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 端点地址无效') }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)
    || (config.server.environment === 'production' && url.protocol !== 'https:')) {
    throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 端点必须使用安全的绝对地址')
  }
  return url
}

function profileValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export class OidcClient {
  private metadata: Promise<Discovery> | undefined
  private keys?: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly config: AppConfig, private readonly fetcher: FetchLike = fetch) {}

  private async discover(): Promise<Discovery> {
    if (!this.config.oidc.enabled || !this.config.oidc.issuer) {
      throw new ApiError(503, 'OIDC_DISABLED', 'OIDC 登录未启用')
    }
    if (!this.metadata) {
      this.metadata = (async () => {
        const issuer = this.config.oidc.issuer!
        const discoveryUrl = new URL(`${issuer.href.replace(/\/$/, '')}/.well-known/openid-configuration`)
        let response: Response
        try {
          response = await this.fetcher(discoveryUrl, {
            headers: { accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(this.config.oidc.requestTimeoutMs),
          })
        } catch {
          throw new ApiError(502, 'OIDC_UNAVAILABLE', '无法连接 OIDC 身份服务')
        }
        if (!response.ok) throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 发现请求失败')
        const raw = await response.text()
        if (raw.length > 262_144) throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 发现文档过大')
        let value: unknown
        try { value = JSON.parse(raw) } catch { throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 发现文档无效') }
        if (!value || typeof value !== 'object') throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC 发现文档无效')
        const metadata = value as Discovery
        if (metadata.issuer !== issuer.href.replace(/\/$/, '')) {
          throw new ApiError(502, 'OIDC_DISCOVERY_INVALID', 'OIDC issuer 与配置不一致')
        }
        endpoint(metadata.authorization_endpoint, this.config)
        endpoint(metadata.token_endpoint, this.config)
        endpoint(metadata.jwks_uri, this.config)
        if (metadata.userinfo_endpoint) endpoint(metadata.userinfo_endpoint, this.config)
        if (metadata.end_session_endpoint) endpoint(metadata.end_session_endpoint, this.config)
        return metadata
      })().catch((error: unknown) => { this.metadata = undefined; throw error })
    }
    return this.metadata
  }

  private stateKey(): Uint8Array {
    return new TextEncoder().encode(this.config.auth.sessionSecret)
  }

  async start(returnTo: string): Promise<{ url: URL; stateCookie: string }> {
    const metadata = await this.discover()
    const state = randomValue()
    const nonce = randomValue()
    const verifier = randomValue()
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const stateCookie = await new SignJWT({ state, nonce, verifier, returnTo })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(STATE_ISSUER)
      .setAudience(STATE_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.stateKey())
    const url = endpoint(metadata.authorization_endpoint, this.config)
    url.searchParams.set('client_id', this.config.oidc.clientId!)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', new URL('/oidc/callback', this.config.server.publicUrl).href)
    url.searchParams.set('scope', 'openid profile email')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return { url, stateCookie }
  }

  async callback(code: string, state: string, stateCookie: string | undefined): Promise<{ profile: CasProfile; returnTo: string; idToken: string }> {
    if (!stateCookie) throw new ApiError(401, 'OIDC_STATE_INVALID', 'OIDC 登录状态已过期')
    let saved: Record<string, unknown>
    try {
      saved = (await jwtVerify(stateCookie, this.stateKey(), {
        algorithms: ['HS256'], issuer: STATE_ISSUER, audience: STATE_AUDIENCE,
      })).payload
    } catch { throw new ApiError(401, 'OIDC_STATE_INVALID', 'OIDC 登录状态无效') }
    if (typeof saved.state !== 'string' || !sameValue(saved.state, state)
      || typeof saved.nonce !== 'string' || typeof saved.verifier !== 'string'
      || typeof saved.returnTo !== 'string') {
      throw new ApiError(401, 'OIDC_STATE_INVALID', 'OIDC 登录状态无效')
    }
    const metadata = await this.discover()
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: new URL('/oidc/callback', this.config.server.publicUrl).href,
      code_verifier: saved.verifier,
    })
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' })
    if (metadata.token_endpoint_auth_methods_supported?.includes('client_secret_post')
      && !metadata.token_endpoint_auth_methods_supported.includes('client_secret_basic')) {
      form.set('client_id', this.config.oidc.clientId!)
      form.set('client_secret', this.config.oidc.clientSecret!)
    } else {
      headers.set('authorization', `Basic ${Buffer.from(`${this.config.oidc.clientId}:${this.config.oidc.clientSecret}`).toString('base64')}`)
    }
    let response: Response
    try {
      response = await this.fetcher(endpoint(metadata.token_endpoint, this.config), {
        method: 'POST', headers, body: form, redirect: 'error',
        signal: AbortSignal.timeout(this.config.oidc.requestTimeoutMs),
      })
    } catch { throw new ApiError(502, 'OIDC_UNAVAILABLE', '无法连接 OIDC 令牌服务') }
    if (!response.ok) throw new ApiError(401, 'OIDC_TOKEN_INVALID', 'OIDC 授权码兑换失败')
    const raw = await response.text()
    if (raw.length > 262_144) throw new ApiError(502, 'OIDC_TOKEN_INVALID', 'OIDC 令牌响应过大')
    let token: unknown
    try { token = JSON.parse(raw) } catch { throw new ApiError(502, 'OIDC_TOKEN_INVALID', 'OIDC 令牌响应无效') }
    const values = token && typeof token === 'object' ? token as Record<string, unknown> : {}
    if (typeof values.id_token !== 'string') throw new ApiError(401, 'OIDC_TOKEN_INVALID', 'OIDC 响应缺少 ID Token')
    this.keys ??= createRemoteJWKSet(endpoint(metadata.jwks_uri, this.config), {
      timeoutDuration: this.config.oidc.requestTimeoutMs,
      [customFetch]: (url, options) => this.fetcher(url, options),
    })
    let claims: Record<string, unknown>
    try {
      claims = (await jwtVerify(values.id_token, this.keys, {
        issuer: metadata.issuer, audience: this.config.oidc.clientId!,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
      })).payload
    } catch { throw new ApiError(401, 'OIDC_TOKEN_INVALID', 'OIDC 身份令牌验证失败') }
    if (!profileValue(claims.sub) || claims.nonce !== saved.nonce
      || typeof claims.iat !== 'number' || typeof claims.exp !== 'number'
      || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.config.oidc.clientId)
      || (claims.azp !== undefined && claims.azp !== this.config.oidc.clientId)) {
      throw new ApiError(401, 'OIDC_TOKEN_INVALID', 'OIDC 身份令牌声明无效')
    }
    if (!profileValue(claims[this.config.oidc.usernameClaim]) && metadata.userinfo_endpoint
      && typeof values.access_token === 'string') {
      let userInfoResponse: Response
      try {
        userInfoResponse = await this.fetcher(endpoint(metadata.userinfo_endpoint, this.config), {
          headers: { authorization: `Bearer ${values.access_token}`, accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(this.config.oidc.requestTimeoutMs),
        })
      } catch { throw new ApiError(502, 'OIDC_UNAVAILABLE', '无法连接 OIDC UserInfo 服务') }
      if (userInfoResponse.ok) {
        const userInfoRaw = await userInfoResponse.text()
        if (userInfoRaw.length <= 262_144) {
          let userInfo: unknown
          try { userInfo = JSON.parse(userInfoRaw) } catch { userInfo = undefined }
          if (userInfo && typeof userInfo === 'object') {
            const attributes = userInfo as Record<string, unknown>
            if (attributes.sub !== claims.sub) throw new ApiError(401, 'OIDC_PROFILE_INVALID', 'OIDC UserInfo 用户身份不一致')
            claims = {
              ...attributes, ...claims,
              [this.config.oidc.usernameClaim]: profileValue(claims[this.config.oidc.usernameClaim])
                ?? attributes[this.config.oidc.usernameClaim],
            }
          }
        }
      }
    }
    const name = profileValue(claims[this.config.oidc.usernameClaim])
    if (!name || name.length > 128) throw new ApiError(401, 'OIDC_PROFILE_INVALID', 'OIDC 响应缺少可关联的用户名')
    const email = profileValue(claims.email)
    const displayName = profileValue(claims.name)
    const avatar = profileValue(claims.picture)
    return {
      profile: { name, ...(email ? { email } : {}), ...(displayName ? { displayName } : {}), ...(avatar ? { avatar } : {}) },
      returnTo: saved.returnTo,
      idToken: values.id_token,
    }
  }

  private encryptionKey(): Uint8Array {
    return createHash('sha256').update(this.config.auth.sessionSecret!).digest()
  }

  async sealIdToken(idToken: string): Promise<string> {
    return new EncryptJWT({ idToken })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuer(STATE_ISSUER).setAudience('dnsmgr-oidc-logout')
      .setIssuedAt().setExpirationTime(`${this.config.auth.sessionTtlSeconds}s`)
      .encrypt(this.encryptionKey())
  }

  async openIdToken(token: string | undefined): Promise<string | undefined> {
    if (!token) return undefined
    try {
      const result = await jwtDecrypt(token, this.encryptionKey(), {
        issuer: STATE_ISSUER, audience: 'dnsmgr-oidc-logout',
      })
      return profileValue(result.payload.idToken)
    } catch { return undefined }
  }

  async logoutUrl(): Promise<URL | undefined> {
    if (this.config.oidc.logoutUrl) return endpoint(this.config.oidc.logoutUrl.href, this.config)
    const metadata = await this.discover()
    return metadata.end_session_endpoint ? endpoint(metadata.end_session_endpoint, this.config) : undefined
  }

  async logoutState(): Promise<string> {
    return new SignJWT({ state: randomValue() })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(STATE_ISSUER)
      .setAudience(STATE_AUDIENCE).setIssuedAt().setExpirationTime('5m')
      .sign(this.stateKey())
  }

  async verifyLogoutState(token: string | undefined, state: string): Promise<boolean> {
    if (!token) return false
    try {
      const result = await jwtVerify(token, this.stateKey(), {
        algorithms: ['HS256'], issuer: STATE_ISSUER, audience: STATE_AUDIENCE,
      })
      return typeof result.payload.state === 'string' && sameValue(result.payload.state, state)
    } catch { return false }
  }
}
