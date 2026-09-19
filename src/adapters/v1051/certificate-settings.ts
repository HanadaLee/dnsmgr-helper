import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CertificateDcvDelegationTemplate,
  CertificateLocalDeploymentTemplate,
  CertificateNotificationMode,
  CertificateSettings,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import { requireUpstreamHtml } from '../../upstream/legacy.js'
import { operationMessage } from './automation-common.js'
import { namedElementAttribute } from './html-state.js'
import { executeLegacyOperation } from './operations.js'

const NotificationModeSchema = z.enum(['off', 'all', 'failures-only'])
const TemplateIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
const TemplateNameSchema = z.string().trim().min(1).max(64)
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

const LocalDeploymentTemplateSchema = z.object({
  id: TemplateIdSchema,
  name: TemplateNameSchema,
  pemCertificatePathTemplate: PathTemplateSchema,
  pemPrivateKeyPathTemplate: PathTemplateSchema,
  pfxPathTemplate: PathTemplateSchema,
  commandTemplate: CommandTemplateSchema,
}).strict()

const DcvDelegationTemplateSchema = z.object({
  id: TemplateIdSchema,
  name: TemplateNameSchema,
  targetDomainId: z.number().int().positive().nullable(),
  allowedDomains: z.array(AllowedDomainSchema).max(1000).refine(
    (domains) => new Set(domains).size === domains.length,
    '允许托管的域名不能重复',
  ),
  targetRecordNameTemplate: TargetRecordNameTemplateSchema,
}).strict()

const StoredDcvDelegationTemplateSchema = z.object({
  id: TemplateIdSchema,
  name: TemplateNameSchema,
  targetDomainId: z.number().int().positive().nullable().optional(),
  allowedDomains: z.array(AllowedDomainSchema).max(1000).default([]),
  targetRecordNameTemplate: TargetRecordNameTemplateSchema,
  domainMatchMode: z.enum(['exact', 'suffix']).optional(),
  forceTargetRecordNameTemplate: z.boolean().optional(),
}).passthrough()

function validateTemplateCollection(
  value: { defaultTemplateId: string; templates: Array<{ id: string; name: string }> },
  context: z.RefinementCtx,
) {
  const ids = value.templates.map((template) => template.id)
  const names = value.templates.map((template) => template.name)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['templates'], message: '模板 ID 不能重复' })
  }
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', path: ['templates'], message: '模板名称不能重复' })
  }
  if (!ids.includes(value.defaultTemplateId)) {
    context.addIssue({ code: 'custom', path: ['defaultTemplateId'], message: '默认模板必须存在' })
  }
  if (Buffer.byteLength(JSON.stringify(value.templates), 'utf8') > 60_000) {
    context.addIssue({ code: 'custom', path: ['templates'], message: '模板配置总大小不能超过 60000 字节' })
  }
}

const LocalDeploymentSettingsSchema = z.object({
  defaultTemplateId: TemplateIdSchema,
  templates: z.array(LocalDeploymentTemplateSchema).min(1).max(20),
}).strict().superRefine(validateTemplateCollection)
const DcvDelegationSettingsSchema = z.object({
  defaultTemplateId: TemplateIdSchema,
  templates: z.array(DcvDelegationTemplateSchema).min(1).max(20),
}).strict().superRefine(validateTemplateCollection)

const DEFAULT_LOCAL_TEMPLATE: CertificateLocalDeploymentTemplate = {
  id: 'default',
  name: '默认模板',
  pemCertificatePathTemplate: '/etc/ssl/{domain}/fullchain.pem',
  pemPrivateKeyPathTemplate: '/etc/ssl/{domain}/privkey.pem',
  pfxPathTemplate: '/etc/ssl/{domain}/certificate.pfx',
  commandTemplate: '',
}

const DEFAULT_DCV_TEMPLATE: CertificateDcvDelegationTemplate = {
  id: 'default',
  name: '默认模板',
  targetDomainId: null,
  allowedDomains: [],
  targetRecordNameTemplate: '{domainWithDashes}.cname',
}

const DCV_DELEGATION_DEFAULTS: CertificateSettings['dcvDelegation'] = {
  defaultTemplateId: DEFAULT_DCV_TEMPLATE.id,
  templates: [DEFAULT_DCV_TEMPLATE],
}

export const CertificateAutomationConfigKeys = {
  localDefaultTemplate: 'helper_cert_local_default',
  localTemplates: 'helper_cert_local_templates',
  dcvDefaultTemplate: 'helper_cert_dcv_default',
  dcvTemplates: 'helper_cert_dcv_templates',
} as const

const ConfigKeys = CertificateAutomationConfigKeys
const LegacyConfigKeys = {
  localPemCertificatePathTemplate: 'helper_cert_local_pem_cert',
  localPemPrivateKeyPathTemplate: 'helper_cert_local_pem_key',
  localPfxPathTemplate: 'helper_cert_local_pfx_path',
  localCommandTemplate: 'helper_cert_local_command',
  dcvAllowedDomains: 'helper_cert_dcv_domains',
  dcvTargetRecordNameTemplate: 'helper_cert_dcv_target_name',
} as const

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
  localDeployment: LocalDeploymentSettingsSchema.optional(),
  dcvDelegation: DcvDelegationSettingsSchema.optional(),
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

function storedLocalTemplates(value: string | undefined): CertificateLocalDeploymentTemplate[] | undefined {
  if (!value) return undefined
  try {
    const result = z.array(LocalDeploymentTemplateSchema).min(1).max(20).safeParse(JSON.parse(value))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

function storedDcvTemplates(value: string | undefined): CertificateDcvDelegationTemplate[] | undefined {
  if (!value) return undefined
  try {
    const result = z.array(StoredDcvDelegationTemplateSchema).min(1).max(20).safeParse(JSON.parse(value))
    return result.success
      ? result.data.map((template) => ({
          id: template.id,
          name: template.name,
          targetDomainId: template.targetDomainId ?? null,
          allowedDomains: template.allowedDomains,
          targetRecordNameTemplate: template.targetRecordNameTemplate,
        }))
      : undefined
  } catch {
    return undefined
  }
}

function selectedDefaultTemplateId<T extends { id: string }>(
  requestedId: string | undefined,
  templates: T[],
): string {
  return templates.some((template) => template.id === requestedId)
    ? requestedId!
    : templates[0]!.id
}

export async function getCertificateAutomationSettings(
  reader: ConfigValueReader,
): Promise<Pick<CertificateSettings, 'localDeployment' | 'dcvDelegation'>> {
  const values = await reader.getConfigValues([
    ...Object.values(ConfigKeys),
    ...Object.values(LegacyConfigKeys),
  ])
  const localTemplates = storedLocalTemplates(values[ConfigKeys.localTemplates]) ?? [{
    ...DEFAULT_LOCAL_TEMPLATE,
    pemCertificatePathTemplate: values[LegacyConfigKeys.localPemCertificatePathTemplate]
      || DEFAULT_LOCAL_TEMPLATE.pemCertificatePathTemplate,
    pemPrivateKeyPathTemplate: values[LegacyConfigKeys.localPemPrivateKeyPathTemplate]
      || DEFAULT_LOCAL_TEMPLATE.pemPrivateKeyPathTemplate,
    pfxPathTemplate: values[LegacyConfigKeys.localPfxPathTemplate]
      || DEFAULT_LOCAL_TEMPLATE.pfxPathTemplate,
    commandTemplate: values[LegacyConfigKeys.localCommandTemplate]
      ?? DEFAULT_LOCAL_TEMPLATE.commandTemplate,
  }]
  const dcvTemplates = storedDcvTemplates(values[ConfigKeys.dcvTemplates]) ?? [{
    ...DEFAULT_DCV_TEMPLATE,
    allowedDomains: allowedDomains(values[LegacyConfigKeys.dcvAllowedDomains]),
    targetRecordNameTemplate: values[LegacyConfigKeys.dcvTargetRecordNameTemplate]
      || DEFAULT_DCV_TEMPLATE.targetRecordNameTemplate,
  }]
  return {
    localDeployment: {
      defaultTemplateId: selectedDefaultTemplateId(values[ConfigKeys.localDefaultTemplate], localTemplates),
      templates: localTemplates,
    },
    dcvDelegation: {
      defaultTemplateId: selectedDefaultTemplateId(values[ConfigKeys.dcvDefaultTemplate], dcvTemplates),
      templates: dcvTemplates,
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
            [ConfigKeys.localDefaultTemplate]: local.defaultTemplateId,
            [ConfigKeys.localTemplates]: JSON.stringify(local.templates),
          }
        : {}),
      ...(dcv
        ? {
            [ConfigKeys.dcvDefaultTemplate]: dcv.defaultTemplateId,
            [ConfigKeys.dcvTemplates]: JSON.stringify(dcv.templates),
          }
        : {}),
    },
  })
  return operationMessage(result.message)
}
