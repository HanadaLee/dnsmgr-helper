import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { ProfileSecurity, TotpEnrollment } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { objectValue, operationMessage, stringValue } from './automation-common.js'
import { namedElementAttribute } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const LegacyThemeSchema = z.enum([
  'skin-blue', 'skin-black', 'skin-red', 'skin-yellow', 'skin-purple', 'skin-green',
  'skin-blue-light', 'skin-black-light', 'skin-red-light', 'skin-yellow-light',
  'skin-purple-light', 'skin-green-light', 'skin-black-blue', 'skin-black-purple',
  'skin-black-red', 'skin-black-green', 'skin-black-yellow', 'skin-black-pink',
])

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
}).strict()

export const TotpBindSchema = z.object({
  secret: z.string().trim().min(8).max(128).regex(/^[A-Z2-7]+=*$/i, 'TOTP 密钥格式不合法'),
  code: z.string().trim().regex(/^\d{6}$/, '动态口令必须是 6 位数字'),
}).strict()

export const LegacyThemeMutationSchema = z.object({ theme: LegacyThemeSchema }).strict()

function requireLocalCredentials(config: AppConfig) {
  if (config.cas.enabled) {
    throw new ApiError(409, 'LOCAL_CREDENTIALS_UNAVAILABLE', '当前登录方式不支持修改本地登录凭据')
  }
}

export async function getProfileSecurity(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<ProfileSecurity> {
  if (config.cas.enabled) {
    return { localCredentialsAvailable: false, totpEnabled: false }
  }
  const html = requireUpstreamHtml(await client.getHtml('/setpwd', context), config)
  const status = namedElementAttribute(html, 'input', 'totp_status', 'value')
  if (status !== '已开启' && status !== '未开启') {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的安全设置格式不兼容')
  }
  return { localCredentialsAvailable: true, totpEnabled: status === '已开启' }
}

export async function changePassword(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  requireLocalCredentials(config)
  const body = ChangePasswordSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'profile.changePassword', {
    form: {
      oldpwd: body.currentPassword,
      newpwd: body.newPassword,
      newpwd2: body.newPassword,
    },
  })
  return operationMessage(result.message)
}

export async function generateTotpEnrollment(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<TotpEnrollment> {
  requireLocalCredentials(config)
  const result = await executeLegacyOperation(client, config, context, 'profile.totp.generate', {})
  const data = objectValue(result.data)
  const secret = stringValue(data?.secret)
  const provisioningUri = stringValue(data?.qrcode)
  if (!secret || !provisioningUri?.startsWith('otpauth://')) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的 TOTP 初始化格式不兼容')
  }
  return { secret, provisioningUri }
}

export async function bindTotp(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  requireLocalCredentials(config)
  const body = TotpBindSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'profile.totp.bind', {
    form: body,
  })
  return operationMessage(result.message)
}

export async function disableTotp(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
) {
  requireLocalCredentials(config)
  const result = await executeLegacyOperation(client, config, context, 'profile.totp.disable', {})
  return operationMessage(result.message)
}

export async function setLegacyTheme(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = LegacyThemeMutationSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'preferences.setTheme', {
    form: { skin: body.theme },
  })
  return operationMessage(result.message)
}
