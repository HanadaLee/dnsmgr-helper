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
const LocalDeploymentModeSchema = z.enum(['quick', 'custom'])
const DomainMatchModeSchema = z.enum(['exact', 'suffix'])
const PathTemplateSchema = z.string().trim().min(1).max(4096)
const CommandTemplateSchema = z.string().trim().max(4096)
const AllowedDomainSchema = z.string().trim().toLowerCase().min(3).max(253).transform(
  (value) => value.replace(/^\*\./, '').replace(/\.$/, ''),
).refine((value) => value.includes('.') && !/[\s/:]/.test(value), '允许托管的域名格式不正确')
const TargetRecordNameTemplateSchema = z.string().trim().min(1).max(253).superRefine((value, context) => {
  const remaining = value.replaceAll('{domain}', '').replaceAll('{domainWithDashes}', '')
  if (/[{}]/.test(remaining)) {
    context.addIssue({ code: 'custom', message: '目标记录模板包含不支持的占位符' })
  }
})

const LOCAL_DEPLOYMENT_DEFAULTS: CertificateSettings['localDeployment'] = {
  defaultMode: 'quick',
  pemCertificatePathTemplate: '/etc/ssl/{domain}/fullchain.pem',
  pemPrivateKeyPathTemplate: '/etc/ssl/{domain}/privkey.pem',
  pfxPathTemplate: '/etc/ssl/{domain}/certificate.pfx',
  commandTemplate: '',
}

const DCV_DELEGATION_DEFAULTS: CertificateSettings['dcvDelegation'] = {
  allowedDomains: [],
  domainMatchMode: 'suffix',
  targetRecordNameTemplate: '{domainWithDashes}.cname',
  forceTargetRecordNameTemplate: false,
}

export const CertificateAutomationConfigKeys = {
  localDefaultMode: 'helper_cert_local_mode',
  localPemCertificatePathTemplate: 'helper_cert_local_pem_cert',
  localPemPrivateKeyPathTemplate: 'helper_cert_local_pem_key',
  localPfxPathTemplate: 'helper_cert_local_pfx_path',
  localCommandTemplate: 'helper_cert_local_command',
  dcvAllowedDomains: 'helper_cert_dcv_domains',
  dcvDomainMatchMode: 'helper_cert_dcv_match_mode',
  dcvTargetRecordNameTemplate: 'helper_cert_dcv_target_name',
  dcvForceTargetRecordNameTemplate: 'helper_cert_dcv_force_target',
} as const

const ConfigKeys = CertificateAutomationConfigKeys

export type ConfigValueReader = {
  getConfigValues(keys: string[]): Promise<Record<string, string>>
}

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
  localDeployment: z.object({
    defaultMode: LocalDeploymentModeSchema,
    pemCertificatePathTemplate: PathTemplateSchema,
    pemPrivateKeyPathTemplate: PathTemplateSchema,
    pfxPathTemplate: PathTemplateSchema,
    commandTemplate: CommandTemplateSchema,
  }).strict().optional(),
  dcvDelegation: z.object({
    allowedDomains: z.array(AllowedDomainSchema).max(1000).refine(
      (domains) => new Set(domains).size === domains.length,
      '允许托管的域名不能重复',
    ),
    domainMatchMode: DomainMatchModeSchema,
    targetRecordNameTemplate: TargetRecordNameTemplateSchema,
    forceTargetRecordNameTemplate: z.boolean(),
  }).strict().optional(),
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

function allowedDomains(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      return Array.from(new Set(parsed.flatMap((item) => {
        const result = AllowedDomainSchema.safeParse(item)
        return result.success ? [result.data] : []
      })))
    }
  } catch {
    // Accept the line/comma format used by early helper builds.
  }
  return Array.from(new Set(value.split(/[\r\n,]+/).flatMap((item) => {
    const result = AllowedDomainSchema.safeParse(item)
    return result.success ? [result.data] : []
  })))
}

export async function getCertificateAutomationSettings(
  reader: ConfigValueReader,
): Promise<Pick<CertificateSettings, 'localDeployment' | 'dcvDelegation'>> {
  const values = await reader.getConfigValues(Object.values(ConfigKeys))
  const localMode = LocalDeploymentModeSchema.safeParse(values[ConfigKeys.localDefaultMode])
  const domainMatchMode = DomainMatchModeSchema.safeParse(values[ConfigKeys.dcvDomainMatchMode])
  return {
    localDeployment: {
      defaultMode: localMode.success ? localMode.data : LOCAL_DEPLOYMENT_DEFAULTS.defaultMode,
      pemCertificatePathTemplate: values[ConfigKeys.localPemCertificatePathTemplate]
        || LOCAL_DEPLOYMENT_DEFAULTS.pemCertificatePathTemplate,
      pemPrivateKeyPathTemplate: values[ConfigKeys.localPemPrivateKeyPathTemplate]
        || LOCAL_DEPLOYMENT_DEFAULTS.pemPrivateKeyPathTemplate,
      pfxPathTemplate: values[ConfigKeys.localPfxPathTemplate]
        || LOCAL_DEPLOYMENT_DEFAULTS.pfxPathTemplate,
      commandTemplate: values[ConfigKeys.localCommandTemplate]
        ?? LOCAL_DEPLOYMENT_DEFAULTS.commandTemplate,
    },
    dcvDelegation: {
      allowedDomains: allowedDomains(values[ConfigKeys.dcvAllowedDomains]),
      domainMatchMode: domainMatchMode.success ? domainMatchMode.data : DCV_DELEGATION_DEFAULTS.domainMatchMode,
      targetRecordNameTemplate: values[ConfigKeys.dcvTargetRecordNameTemplate]
        || DCV_DELEGATION_DEFAULTS.targetRecordNameTemplate,
      forceTargetRecordNameTemplate: values[ConfigKeys.dcvForceTargetRecordNameTemplate] === '1',
    },
  }
}

export async function getCertificateSettings(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  reader: ConfigValueReader,
): Promise<CertificateSettings> {
  const [htmlResult, automation] = await Promise.all([
    client.getHtml('/cert/certset', context),
    getCertificateAutomationSettings(reader),
  ])
  const html = requireUpstreamHtml(htmlResult, config)
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
    ...automation,
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
  const local = body.localDeployment
  const dcv = body.dcvDelegation
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
      ...(local
        ? {
            [ConfigKeys.localDefaultMode]: local.defaultMode,
            [ConfigKeys.localPemCertificatePathTemplate]: local.pemCertificatePathTemplate,
            [ConfigKeys.localPemPrivateKeyPathTemplate]: local.pemPrivateKeyPathTemplate,
            [ConfigKeys.localPfxPathTemplate]: local.pfxPathTemplate,
            [ConfigKeys.localCommandTemplate]: local.commandTemplate,
          }
        : {}),
      ...(dcv
        ? {
            [ConfigKeys.dcvAllowedDomains]: JSON.stringify(dcv.allowedDomains),
            [ConfigKeys.dcvDomainMatchMode]: dcv.domainMatchMode,
            [ConfigKeys.dcvTargetRecordNameTemplate]: dcv.targetRecordNameTemplate,
            [ConfigKeys.dcvForceTargetRecordNameTemplate]: dcv.forceTargetRecordNameTemplate ? 1 : 0,
          }
        : {}),
    },
  })
  return operationMessage(result.message)
}
