import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CronSettings,
  LoginSettings,
  NotificationSettings,
  ProxySettings,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { operationMessage, optionalDisplayTime } from './automation-common.js'
import {
  elementIdHasAttribute,
  namedElementAttribute,
  namedTextareaValue,
  plainText,
  tableCellAfterLabel,
} from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const ShortText = z.string().trim().max(1024)
const LongText = z.string().max(65_535)
const Port = z.union([z.coerce.number().int().min(1).max(65_535), z.null()])

const EmailSettingsSchema = z.object({
  provider: z.enum(['smtp', 'sendcloud', 'aliyun']),
  smtpServer: ShortText,
  smtpPort: Port,
  sender: ShortText,
  password: ShortText,
  apiUser: ShortText,
  apiKey: ShortText,
  recipient: ShortText,
}).strict()

const WechatSettingsSchema = z.object({
  appToken: ShortText,
  userId: ShortText,
}).strict()

const TelegramSettingsSchema = z.object({
  token: ShortText,
  chatId: ShortText,
  topicId: ShortText,
  proxyMode: z.enum(['off', 'system', 'custom']),
  customBaseUrl: z.string().trim().max(2048),
}).strict()

const RobotWebhookSettingsSchema = z.object({
  url: z.string().trim().max(2048),
  mention: ShortText,
}).strict()

const CustomWebhookSettingsSchema = z.object({
  url: z.string().trim().max(2048),
  method: z.enum(['GET', 'POST', 'PUT']),
  contentType: z.enum(['application/json', 'application/x-www-form-urlencoded']),
  headers: LongText,
  body: LongText,
  contentFormat: z.enum(['html', 'markdown', 'text']),
}).strict()

export const NotificationSettingsMutationSchema = z.object({
  email: EmailSettingsSchema.optional(),
  wechat: WechatSettingsSchema.optional(),
  telegram: TelegramSettingsSchema.optional(),
  robotWebhook: RobotWebhookSettingsSchema.optional(),
  customWebhook: CustomWebhookSettingsSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少需要提交一组通知设置')

export const LoginSettingsMutationSchema = z.object({
  graphicalVerificationEnabled: z.boolean(),
}).strict()

export const ProxySettingsMutationSchema = z.object({
  server: z.string().trim().max(255),
  port: Port,
  username: z.string().trim().max(255),
  password: z.string().trim().max(1024),
  type: z.enum(['http', 'https', 'sock4', 'sock5', 'sock5h']),
}).strict()

export const ProxyTestSchema = ProxySettingsMutationSchema.refine(
  (value) => Boolean(value.server) && value.port !== null,
  '代理服务器和端口不能为空',
)

export const CronSettingsMutationSchema = z.object({
  executionMode: z.enum(['shell', 'http']),
  accessKey: z.string().trim().max(255),
}).strict().superRefine((value, context) => {
  if (value.executionMode === 'http' && !value.accessKey) {
    context.addIssue({ code: 'custom', path: ['accessKey'], message: 'HTTP 执行方式必须填写访问密钥' })
  }
})

export const NotificationTestSchema = z.object({
  channel: z.enum(['email', 'telegram', 'robot-webhook', 'custom-webhook']),
}).strict()

function input(html: string, name: string): string {
  return namedElementAttribute(html, 'input', name, 'value') ?? ''
}

function selectDefault(html: string, name: string): string {
  return namedElementAttribute(html, 'select', name, 'default') ?? ''
}

function parsedPort(value: string): number | null {
  if (!value) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > 65_535) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的端口设置格式不兼容')
  }
  return number
}

function emailProvider(value: string): NotificationSettings['email']['provider'] {
  if (!value || value === '0') return 'smtp'
  if (value === '1') return 'sendcloud'
  if (value === '2') return 'aliyun'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的邮件设置格式不兼容')
}

function telegramProxyMode(value: string): NotificationSettings['telegram']['proxyMode'] {
  if (!value || value === '0') return 'off'
  if (value === '1') return 'system'
  if (value === '2') return 'custom'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的 Telegram 设置格式不兼容')
}

function customMethod(value: string): NotificationSettings['customWebhook']['method'] {
  if (value === 'GET' || value === 'PUT') return value
  if (!value || value === 'POST') return 'POST'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的 Webhook 请求方式不兼容')
}

function customContentType(value: string): NotificationSettings['customWebhook']['contentType'] {
  if (value === 'application/x-www-form-urlencoded') return value
  if (!value || value === 'application/json') return 'application/json'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的 Webhook Content-Type 不兼容')
}

function customContentFormat(value: string): NotificationSettings['customWebhook']['contentFormat'] {
  if (value === 'markdown' || value === 'text') return value
  if (!value || value === 'html') return 'html'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的 Webhook 内容格式不兼容')
}

export async function getLoginSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<LoginSettings> {
  const html = requireUpstreamHtml(await client.getHtml('/system/loginset', context), config)
  return {
    graphicalVerificationEnabled: elementIdHasAttribute(html, 'input', 'vocde_switch', 'checked'),
    appliesToCurrentLogin: !config.cas.enabled,
  }
}

export async function updateLoginSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = LoginSettingsMutationSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'system.settings.update', {
    form: { vcode: body.graphicalVerificationEnabled ? '1' : '2' },
  })
  return operationMessage(result.message)
}

export async function getNotificationSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<NotificationSettings> {
  const html = requireUpstreamHtml(await client.getHtml('/system/noticeset', context), config)
  return {
    email: {
      provider: emailProvider(selectDefault(html, 'mail_type')),
      smtpServer: input(html, 'mail_smtp'),
      smtpPort: parsedPort(input(html, 'mail_port')),
      sender: input(html, 'mail_name'),
      password: input(html, 'mail_pwd'),
      apiUser: input(html, 'mail_apiuser'),
      apiKey: input(html, 'mail_apikey'),
      recipient: input(html, 'mail_recv'),
    },
    wechat: {
      appToken: input(html, 'wechat_apptoken'),
      userId: input(html, 'wechat_appuid'),
    },
    telegram: {
      token: input(html, 'tgbot_token'),
      chatId: input(html, 'tgbot_chatid'),
      topicId: input(html, 'tgbot_topicid'),
      proxyMode: telegramProxyMode(selectDefault(html, 'tgbot_proxy')),
      customBaseUrl: input(html, 'tgbot_url'),
    },
    robotWebhook: {
      url: input(html, 'webhook_url'),
      mention: input(html, 'webhook_user'),
    },
    customWebhook: {
      url: input(html, 'custom_webhook_url'),
      method: customMethod(selectDefault(html, 'custom_webhook_method')),
      contentType: customContentType(selectDefault(html, 'custom_webhook_content_type')),
      headers: namedTextareaValue(html, 'custom_webhook_headers') ?? '',
      body: namedTextareaValue(html, 'custom_webhook_body') ?? '{"title":"{title}","content":"{content}"}',
      contentFormat: customContentFormat(selectDefault(html, 'custom_webhook_content_format')),
    },
  }
}

export async function updateNotificationSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = NotificationSettingsMutationSchema.parse(rawBody)
  const form: Record<string, unknown> = {}
  if (body.email) {
    const provider = body.email.provider === 'smtp' ? 0 : body.email.provider === 'sendcloud' ? 1 : 2
    Object.assign(form, {
      mail_type: provider,
      mail_smtp: body.email.smtpServer,
      mail_port: body.email.smtpPort ?? '',
      mail_name: body.email.sender,
      mail_pwd: body.email.password,
      mail_apiuser: body.email.apiUser,
      mail_apikey: body.email.apiKey,
      mail_name2: body.email.sender,
      mail_recv: body.email.recipient,
    })
  }
  if (body.wechat) {
    Object.assign(form, {
      wechat_apptoken: body.wechat.appToken,
      wechat_appuid: body.wechat.userId,
    })
  }
  if (body.telegram) {
    Object.assign(form, {
      tgbot_token: body.telegram.token,
      tgbot_chatid: body.telegram.chatId,
      tgbot_topicid: body.telegram.topicId,
      tgbot_proxy: body.telegram.proxyMode === 'off' ? 0 : body.telegram.proxyMode === 'system' ? 1 : 2,
      tgbot_url: body.telegram.customBaseUrl,
    })
  }
  if (body.robotWebhook) {
    Object.assign(form, {
      webhook_url: body.robotWebhook.url,
      webhook_user: body.robotWebhook.mention,
    })
  }
  if (body.customWebhook) {
    Object.assign(form, {
      custom_webhook_url: body.customWebhook.url,
      custom_webhook_method: body.customWebhook.method,
      custom_webhook_content_type: body.customWebhook.contentType,
      custom_webhook_headers: body.customWebhook.headers,
      custom_webhook_body: body.customWebhook.body,
      custom_webhook_content_format: body.customWebhook.contentFormat,
    })
  }
  const result = await executeLegacyOperation(client, config, context, 'system.settings.update', { form })
  return operationMessage(result.message)
}

export async function testNotification(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = NotificationTestSchema.parse(rawBody)
  const operation = {
    email: 'system.notifications.testMail',
    telegram: 'system.notifications.testTelegram',
    'robot-webhook': 'system.notifications.testWebhook',
    'custom-webhook': 'system.notifications.testCustomWebhook',
  } as const
  const result = await executeLegacyOperation(client, config, context, operation[body.channel], {})
  return operationMessage(result.message)
}

function proxyType(value: string): ProxySettings['type'] {
  if (value === 'https' || value === 'sock4' || value === 'sock5' || value === 'sock5h') return value
  if (!value || value === 'http') return 'http'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的代理协议设置不兼容')
}

export async function getProxySettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<ProxySettings> {
  const html = requireUpstreamHtml(await client.getHtml('/system/proxyset', context), config)
  return {
    server: input(html, 'proxy_server'),
    port: parsedPort(input(html, 'proxy_port')),
    username: input(html, 'proxy_user'),
    password: input(html, 'proxy_pwd'),
    type: proxyType(selectDefault(html, 'proxy_type')),
  }
}

function proxyForm(body: z.infer<typeof ProxySettingsMutationSchema>) {
  return {
    proxy_server: body.server,
    proxy_port: body.port ?? '',
    proxy_user: body.username,
    proxy_pwd: body.password,
    proxy_type: body.type,
  }
}

export async function updateProxySettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = ProxySettingsMutationSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'system.settings.update', {
    form: proxyForm(body),
  })
  return operationMessage(result.message)
}

export async function testProxy(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = ProxyTestSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'system.proxy.test', {
    form: proxyForm(body),
  })
  return operationMessage(result.message)
}

function executionMode(value: string): CronSettings['executionMode'] {
  if (!value || value === '0') return 'shell'
  if (value === '1') return 'http'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的计划任务设置格式不兼容')
}

function codeBlocks(html: string): string[] {
  return Array.from(html.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi))
    .map((match) => plainText(match[1]))
    .filter((value): value is string => Boolean(value))
}

export async function getCronSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<CronSettings> {
  const html = requireUpstreamHtml(await client.getHtml('/system/cronset', context), config)
  const mode = executionMode(selectDefault(html, 'cron_type'))
  const accessKey = input(html, 'cron_key')
  const codes = codeBlocks(html)
  const shellCommand = codes.find((value) => value.startsWith('cd '))
  const publicUrl = mode === 'http' && accessKey
    ? new URL(`/cron?key=${encodeURIComponent(accessKey)}`, config.server.publicUrl).href
    : undefined
  return {
    executionMode: mode,
    accessKey,
    ...(publicUrl ? { publicUrl } : {}),
    ...(shellCommand ? { shellCommand } : {}),
    lastRuns: {
      certificateRenewal: optionalDisplayTime(tableCellAfterLabel(html, 'SSL证书续签')),
      certificateDeployment: optionalDisplayTime(tableCellAfterLabel(html, 'SSL证书部署')),
      domainExpiryNotice: optionalDisplayTime(tableCellAfterLabel(html, '域名到期提醒')),
      optimizeIp: optionalDisplayTime(tableCellAfterLabel(html, 'CF优选IP更新')),
      scheduledDns: optionalDisplayTime(tableCellAfterLabel(html, '定时切换解析')),
    },
  }
}

export async function updateCronSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CronSettingsMutationSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'system.settings.update', {
    form: {
      cron_type: body.executionMode === 'shell' ? 0 : 1,
      cron_key: body.accessKey,
    },
  })
  return operationMessage(result.message)
}
