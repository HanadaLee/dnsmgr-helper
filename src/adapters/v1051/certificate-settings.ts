import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type { CertificateNotificationMode, CertificateSettings } from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { operationMessage } from './automation-common.js'
import { namedElementAttribute } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const NotificationModeSchema = z.enum(['off', 'all', 'failures-only'])

const NotificationsSchema = z.object({
  email: NotificationModeSchema.optional(),
  wechat: NotificationModeSchema.optional(),
  telegram: NotificationModeSchema.optional(),
  robotWebhook: NotificationModeSchema.optional(),
  customWebhook: NotificationModeSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少需要提交一项通知设置')

export const CertificateSettingsMutationSchema = z.object({
  renewBeforeDays: z.coerce.number().int().min(0).max(3650).optional(),
  deploymentWindow: z.object({
    startHour: z.coerce.number().int().min(0).max(23),
    endHour: z.coerce.number().int().min(0).max(23),
  }).strict().optional(),
  notifications: NotificationsSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少需要提交一项证书设置')

const ModeToCode = {
  off: '0',
  all: '1',
  'failures-only': '2',
} as const

function requiredInteger(value: string | undefined, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的证书设置格式不兼容')
  }
  return parsed
}

function notificationMode(value: string | undefined): CertificateNotificationMode {
  if (value === '0' || value === undefined || value === '') return 'off'
  if (value === '1') return 'all'
  if (value === '2') return 'failures-only'
  throw new ApiError(502, 'UPSTREAM_ADAPTER_MISMATCH', '原 dnsmgr 的证书通知设置格式不兼容')
}

export async function getCertificateSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
): Promise<CertificateSettings> {
  const html = requireUpstreamHtml(await client.getHtml('/cert/certset', context), config)
  return {
    renewBeforeDays: requiredInteger(
      namedElementAttribute(html, 'input', 'cert_renewdays', 'value'),
      0,
      3650,
    ),
    deploymentWindow: {
      startHour: requiredInteger(
        namedElementAttribute(html, 'select', 'deploy_hour_start', 'default'),
        0,
        23,
      ),
      endHour: requiredInteger(
        namedElementAttribute(html, 'select', 'deploy_hour_end', 'default'),
        0,
        23,
      ),
    },
    notifications: {
      email: notificationMode(namedElementAttribute(html, 'select', 'cert_notice_mail', 'default')),
      wechat: notificationMode(namedElementAttribute(html, 'select', 'cert_notice_wxtpl', 'default')),
      telegram: notificationMode(namedElementAttribute(html, 'select', 'cert_notice_tgbot', 'default')),
      robotWebhook: notificationMode(namedElementAttribute(html, 'select', 'cert_notice_webhook', 'default')),
      customWebhook: notificationMode(namedElementAttribute(html, 'select', 'cert_notice_custom_webhook', 'default')),
    },
  }
}

export async function updateCertificateSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  rawBody: unknown,
) {
  const body = CertificateSettingsMutationSchema.parse(rawBody)
  const notifications = body.notifications
  const result = await executeLegacyOperation(client, config, context, 'system.settings.update', {
    form: {
      ...(body.renewBeforeDays === undefined ? {} : { cert_renewdays: body.renewBeforeDays }),
      ...(body.deploymentWindow
        ? {
            deploy_hour_start: body.deploymentWindow.startHour,
            deploy_hour_end: body.deploymentWindow.endHour,
          }
        : {}),
      ...(notifications?.email === undefined ? {} : { cert_notice_mail: ModeToCode[notifications.email] }),
      ...(notifications?.wechat === undefined ? {} : { cert_notice_wxtpl: ModeToCode[notifications.wechat] }),
      ...(notifications?.telegram === undefined ? {} : { cert_notice_tgbot: ModeToCode[notifications.telegram] }),
      ...(notifications?.robotWebhook === undefined ? {} : { cert_notice_webhook: ModeToCode[notifications.robotWebhook] }),
      ...(notifications?.customWebhook === undefined
        ? {}
        : { cert_notice_custom_webhook: ModeToCode[notifications.customWebhook] }),
    },
  })
  return operationMessage(result.message)
}
