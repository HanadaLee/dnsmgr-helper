export type CasProfile = {
  name: string
  email?: string
  displayName?: string
  avatar?: string
}

export type SessionCapabilities = {
  dashboard: boolean
  domains: boolean
  domainAccounts: boolean
  domainCategories: boolean
  monitoring: boolean
  schedules: boolean
  certificates: boolean
  optimizeIp: boolean
  axisNow: boolean
  systemSettings: boolean
  users: boolean
  logs: boolean
}

export type WebSession = {
  authenticated: true
  user: {
    name: string
    displayName: string
    email?: string
    avatar?: string
    registeredAt?: string
    type: 'user' | 'domain' | 'unknown'
    domainId?: number
  }
  capabilities: SessionCapabilities
  sso: {
    profileVerified: boolean
    loginPath: string
    logoutPath: string
  }
  upstream: {
    configuredVersion: string
    detectedVersion?: string
    adapter: string
  }
}

export type PageMeta = {
  page: number
  pageSize: number
  total: number
}

export type DashboardOverview = {
  totals: {
    domains: number
    monitoringTasks: number
    certificateOrders: number
    certificateDeployments: number
  }
  monitoring: {
    workerRunning: boolean
    active: number
    healthy: number
    failed: number
  }
  optimizeIp: {
    active: number
    succeeded: number
    failed: number
  }
  certificates: {
    issued: number
    failed: number
    expiringSoon: number
    expired: number
  }
  deployments: {
    pending: number
    succeeded: number
    failed: number
  }
  server: {
    frameworkVersion?: string
    phpVersion?: string
    databaseVersion?: string
    webServer?: string
    serverTime?: string
  }
}

export type DashboardReleaseInfo = {
  status: 'current' | 'update-available' | 'unavailable' | 'disabled'
  currentBuild: string
  latestBuild?: string
  latestVersion?: string
  checkedAt?: string
  releaseUrl?: string
}

export type UserSummary = {
  id: number
  username: string
  role: 'administrator' | 'user' | 'unknown'
  apiEnabled: boolean
  totpEnabled: boolean
  enabled: boolean
  registeredAt?: string
  lastLoginAt?: string
}

export type UserDetail = UserSummary & {
  apiKey?: string
  permissions: string[]
}

export type UserFormOptions = {
  domains: string[]
}

export type AuditLogEntry = {
  id: number
  actor: { kind: 'administrator' } | { kind: 'user'; userId: number }
  domain?: string
  action: string
  detail: string
  occurredAt?: string
}

export type ProfileSecurity = {
  localCredentialsAvailable: boolean
  totpEnabled: boolean
}

export type TotpEnrollment = {
  secret: string
  provisioningUri: string
}

export type LoginSettings = {
  graphicalVerificationEnabled: boolean
  appliesToCurrentLogin: boolean
}

export type NotificationSettings = {
  email: {
    provider: 'smtp' | 'sendcloud' | 'aliyun'
    smtpServer: string
    smtpPort: number | null
    sender: string
    password: string
    apiUser: string
    apiKey: string
    recipient: string
  }
  wechat: {
    appToken: string
    userId: string
  }
  telegram: {
    token: string
    chatId: string
    topicId: string
    proxyMode: 'off' | 'system' | 'custom'
    customBaseUrl: string
  }
  robotWebhook: {
    url: string
    mention: string
  }
  customWebhook: {
    url: string
    method: 'GET' | 'POST' | 'PUT'
    contentType: 'application/json' | 'application/x-www-form-urlencoded'
    headers: string
    body: string
    contentFormat: 'html' | 'markdown' | 'text'
  }
}

export type ProxySettings = {
  server: string
  port: number | null
  username: string
  password: string
  type: 'http' | 'https' | 'sock4' | 'sock5' | 'sock5h'
}

export type CronSettings = {
  executionMode: 'shell' | 'http'
  accessKey: string
  publicUrl?: string
  shellCommand?: string
  lastRuns: {
    certificateRenewal: string | undefined
    certificateDeployment: string | undefined
    domainExpiryNotice: string | undefined
    optimizeIp: string | undefined
    scheduledDns: string | undefined
  }
}

export type DomainSummary = {
  id: number
  name: string
  provider: {
    type: string
    label: string
    accountId?: number
    accountLabel?: string
  }
  recordCount: number
  addedAt?: string
  registeredAt?: string
  expiresAt?: string
  expiryLookup: 'pending' | 'ready' | 'failed' | 'unknown'
  noticeEnabled: boolean
  hidden: boolean
  ssoEnabled: boolean
  categoryId?: number
  category?: string
  remark?: string
}

export type DomainExpirySettings = {
  reminderDays: number[]
  notifications: {
    email: boolean
    wechat: boolean
    telegram: boolean
    robotWebhook: boolean
    customWebhook: boolean
  }
}

export type DnsRecord = {
  id: string
  name: string
  type: string
  value: string
  values?: string[]
  line: {
    id: string
    label: string
  }
  ttl?: number
  mxPriority?: number
  weight?: number
  mode?: number
  parentId?: string
  childCount?: number
  remark?: string
  updatedAt?: string
  status: 'enabled' | 'disabled' | 'unknown'
}

export type DomainAccountSummary = {
  id: number
  provider: {
    type: string
    label: string
    icon?: string
  }
  name: string
  remark?: string
  addedAt?: string
}

export type ProviderFieldOption = {
  value: string
  label: string
}

export type ProviderField = {
  key: string
  label: string
  control: 'input' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes'
  required: boolean
  disabled: boolean
  sensitive: boolean
  placeholder?: string
  note?: string
  validator?: string
  min?: number
  max?: number
  defaultValue?: unknown
  options?: ProviderFieldOption[]
  visibleWhen?: {
    any: Array<{
      all: Array<{
        field: string
        operator: 'equals' | 'not-equals'
        value: string
      }>
    }>
  }
}

export type DnsProviderDefinition = {
  type: string
  label: string
  icon?: string
  note?: string
  fields: ProviderField[]
  capabilities: {
    recordRemark: 'none' | 'separate' | 'inline'
    recordStatus: boolean
    redirectRecords: boolean
    recordLogs: boolean
    recordWeight: boolean
    clientPaging: boolean
    domainCreation: boolean
    recordSorting: boolean
  }
}

export type DomainAccountDetail = DomainAccountSummary & {
  config: Record<string, unknown>
}

export type DomainCategory = {
  id: number
  name: string
  sort: number
  domainCount: number
  remark?: string
  addedAt?: string
}

export type RecordLine = {
  id: string
  label: string
  parent?: string
}

export type RecordOptions = {
  providerType: string
  minTtl: number
  lines: RecordLine[]
  recordTypes: string[]
  capabilities: {
    recordRemark: 'none' | 'separate' | 'inline'
    recordStatus: boolean
    redirectRecords: boolean
    recordLogs: boolean
    recordWeight: boolean
    clientPaging: boolean
    recordSorting: boolean
    recordGroups: boolean
    weightedSets: boolean
    domainAliases: boolean
    customHostnames: boolean
    hierarchicalRecords: boolean
  }
}

export type DomainRecordLog = {
  time?: string
  action: string
}

export type RecordGroup = {
  id: string
  name: string
}

export type DomainAlias = {
  id: number
  name: string
  status: 'active' | 'blocked' | 'dns_error' | 'unknown'
}

export type AutomationDomainOption = {
  id: number
  name: string
  providerType: string
}

export type DnsRecordSnapshot = {
  lineId: string
  lineLabel?: string
  ttl: number
  value?: string
  values?: string[]
}

export type MonitoringOverview = {
  workerRunning: boolean
  runCountToday: number
  alertsLast24Hours: number
  switchesLast24Hours: number
  lastRunAt?: string
  lastError?: string
  swooleInstalled: boolean
  notifications: {
    email: boolean
    wechat: boolean
    telegram: boolean
    robotWebhook: boolean
    customWebhook: boolean
  }
}

export type MonitoringTask = {
  id: number
  domainId: number
  domain: string
  recordName: string
  recordId: string
  action: 'none' | 'disable' | 'failover' | 'conditional-enable' | 'unknown'
  primaryValue: string
  backupValue?: string
  checkType: 'ping' | 'tcp' | 'http' | 'unknown'
  checkUrl?: string
  tcpPort?: number
  intervalSeconds: number
  cycleCount: number
  timeoutSeconds: number
  useProxy: boolean
  enableCloudflareProxy: boolean
  active: boolean
  health: 'healthy' | 'failed' | 'unknown'
  checkedAt?: string
  addedAt?: string
  remark?: string
  record?: DnsRecordSnapshot
  alertsLast24Hours?: number
  switchesLast24Hours?: number
}

export type MonitoringTaskLog = {
  id: number
  event: 'failure' | 'recovery' | 'unknown'
  time?: string
  error?: string
}

export type ScheduledDnsTask = {
  id: number
  domainId: number
  domain: string
  recordName: string
  recordId: string
  execution: 'once' | 'recurring' | 'unknown'
  cycle: 'daily' | 'weekly' | 'monthly' | 'unknown'
  action: 'update' | 'enable' | 'disable' | 'delete' | 'unknown'
  switchDate?: string
  switchTime: string
  value?: string
  lineMode: 'unchanged' | 'dns-only' | 'proxied' | 'unknown'
  active: boolean
  lastRunAt?: string
  nextRunAt?: string
  addedAt?: string
  remark?: string
  record?: DnsRecordSnapshot
}

export type OptimizeIpSettings = {
  dataSource: 'wetest' | 'hostmonit' | 'xingpingcn'
  apiKey: string
  proxyUrl: string
  intervalMinutes: number
}

export type OptimizeIpTask = {
  id: number
  domainId: number
  domain: string
  recordName: string
  lineStrategy: 'carrier-lines' | 'default-unicom-mobile' | 'unknown'
  ipVersions: Array<'v4' | 'v6'>
  cdnProvider: 'cloudflare' | 'cloudfront' | 'gcore' | 'edgeone' | 'unknown'
  recordCount: number
  ttl: number
  active: boolean
  status: 'never-run' | 'success' | 'failed' | 'unknown'
  lastRunAt?: string
  lastError?: string
  addedAt?: string
  remark?: string
}

export type CertificateAccountKind = 'issuance' | 'deployment'

export type CertificateAccountTypeDefinition = {
  type: string
  kind: CertificateAccountKind
  label: string
  category?: { id: string; label: string }
  icon?: string
  description?: string
  note?: string
  fields: ProviderField[]
  taskFields: ProviderField[]
  taskNote?: string
  capabilities?: {
    wildcard: boolean
    maxDomains: number
    cnameDelegation: boolean
  }
}

export type CertificateAccountSummary = {
  id: number
  kind: CertificateAccountKind
  type: string
  typeLabel: string
  icon?: string
  name: string
  remark?: string
  addedAt?: string
}

export type CertificateAccountDetail = CertificateAccountSummary & {
  config: Record<string, unknown>
}

export type CertificateOrderSummary = {
  id: number
  mode: 'managed' | 'manual'
  account?: {
    id: number
    type: string
    label: string
    remark?: string
  }
  domains: string[]
  keyType: string
  keySize: number
  issuer?: string
  autoRenew: boolean
  status: 'pending' | 'awaiting-validation' | 'validating' | 'issued' | 'revoked' | 'failed' | 'unknown'
  failureStage?: 'purchase' | 'create' | 'add-dns' | 'check-dns' | 'validate' | 'rejected' | 'issue' | 'unknown'
  processing: boolean
  retryAt?: string
  processId?: string
  issuedAt?: string
  expiresAt?: string
  remainingDays?: number
  addedAt?: string
  updatedAt?: string
  error?: string
}

export type CertificateOrderDetail = CertificateOrderSummary & {
  certificate?: string
  privateKey?: string
}

export type CertificateArtifacts = {
  id: number
  domains: string[]
  certificate: string
  privateKey: string
  pfxBase64: string
  pfxPassword: string
  issuedAt?: string
  expiresAt?: string
}

export type CertificateDeploymentSummary = {
  id: number
  account: {
    id: number
    type: string
    label: string
    name?: string
    remark?: string
  }
  order: {
    id: number
    sourceType?: string
    sourceLabel: string
    domains: string[]
  }
  active: boolean
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'unknown'
  processId?: string
  lastRunAt?: string
  addedAt?: string
  error?: string
  remark?: string
}

export type CertificateDeploymentDetail = {
  id: number
  accountId: number
  accountType: string
  orderId: number
  config: Record<string, unknown>
  remark?: string
}

export type CertificateCnameProxy = {
  id: number
  domain: string
  challengeHost: string
  targetDomainId: number
  targetDomain: string
  targetRecordName: string
  target: string
  status: 'verified' | 'unverified'
  addedAt?: string
}

export type CertificateNotificationMode = 'off' | 'all' | 'failures-only'

export type CertificateSettings = {
  renewBeforeDays: number
  deploymentWindow: { startHour: number; endHour: number }
  notifications: {
    email: CertificateNotificationMode
    wechat: CertificateNotificationMode
    telegram: CertificateNotificationMode
    robotWebhook: CertificateNotificationMode
    customWebhook: CertificateNotificationMode
  }
}

export type ProcessLog = {
  content: string
  modifiedAt: number
}

export type CloudflareValidationRecord = {
  status?: string
  txtName?: string
  txtValue?: string
  cnameName?: string
  cnameTarget?: string
  httpUrl?: string
  httpBody?: string
  emails: string[]
}

export type CloudflareCustomHostname = {
  id: string
  hostname: string
  customOrigin?: string
  status: string
  createdAt?: string
  validationErrors: string[]
  ownershipVerification: {
    type?: string
    name?: string
    value?: string
    status: string
    httpUrl?: string
    httpBody?: string
  }
  ssl: {
    status: string
    method: 'txt' | 'http' | 'unknown'
    minTlsVersion?: string
    type?: string
    validationStatus: string
    validationRecords: CloudflareValidationRecord[]
  }
}

export type CloudflareTxtTargetCandidate = {
  domainId: number
  domainName: string
  recordName: string
  accountId: number
  accountType: string
  accountTypeName: string
  accountDisplayName: string
  currentDomain: boolean
}

export type CloudflareDnsLine = {
  value: string
  label: string
  parent?: string
  default: boolean
}

export type CloudflareTunnel = {
  id: string
  name: string
  status: string
  connectionCount: number
  createdAt?: string
  deletedAt?: string
  activeAt?: string
}

export type CloudflareTunnelPublicHostname = {
  hostname: string
  path?: string
  service: string
  zoneName?: string
  zoneId?: string
}

export type CloudflareTunnelCidrRoute = {
  id: string
  network: string
  comment?: string
  virtualNetworkId?: string
  tunnelId?: string
  createdAt?: string
}

export type CloudflareTunnelHostnameRoute = {
  id: string
  hostname: string
  comment?: string
  tunnelId?: string
  createdAt?: string
}

export type AxisNowAccount = {
  id: number
  name: string
}

export type AxisNowDomain = {
  uuid: string
  accountId: number
  accountName: string
  domain: string
  providerSource: 'platform' | 'self-hosted'
  recordType: 'A' | 'CNAME'
  dnsProviderUuid: string
  dnsZoneUuid?: string
  providerType?: string
  name?: string
  description?: string
  eipCount: number
  ruleCount: number
  shareDefault: boolean
  exposeEips: boolean
  status?: string
  createdAt?: string
  updatedAt?: string
}

export type AxisNowSimpleOption = {
  uuid: string
  name: string
  description?: string
}

export type AxisNowDnsZoneOption = {
  uuid: string
  zone: string
  name?: string
}

export type AxisNowDnsProviderOption = {
  uuid: string
  name: string
  type: string
  source: 'platform' | 'self-hosted'
  zones: AxisNowDnsZoneOption[]
}

export type AxisNowDomainOptions = {
  providers: AxisNowDnsProviderOption[]
  systemProviders: AxisNowDnsProviderOption[]
}

export type AxisNowEipOptions = {
  edges: AxisNowSimpleOption[]
  clusters: AxisNowSimpleOption[]
  tags: AxisNowSimpleOption[]
}

export type AxisNowGeoIspOption = {
  value: string
  name: string
  depth: number
  disabled: boolean
}

export type AxisNowRuleOptions = {
  eips: AxisNowSimpleOption[]
  tags: AxisNowSimpleOption[]
  probeTemplates: AxisNowSimpleOption[]
  geoIspOptions: AxisNowGeoIspOption[]
}

export type AxisNowRulePoolGroup = {
  type: string
  typeName: string
  count: number
  items: string[]
}

export type AxisNowRuleResolvedAddress = {
  address: string
  score?: number
  status?: string
  qualityFiltered: boolean
  countryCode?: string
  provinceCode?: string
  ispName?: string
  providerName?: string
  tagNames: string[]
}

export type AxisNowRuleProbeStatus = {
  address: string
  status: string
}

export type AxisNowRuleAutomationLog = {
  id: number
  action: string
  status: 'success' | 'failed' | 'unknown'
  message: string
  createdAt?: string
}

export type AxisNowRuleAutomation = {
  configured: boolean
  ruleUuid: string
  domainUuid: string
  ruleType: 'A' | 'CNAME' | string
  geoIsp: string
  primaryPool: Record<string, unknown>
  tideEnabled: boolean
  tideStart: string
  tideEnd: string
  tidePool?: Record<string, unknown>
  failoverEnabled: boolean
  failoverPool?: Record<string, unknown>
  failureThreshold: number
  checkIntervalMinutes: number
  activePool: 'primary' | 'tide' | 'failover' | string
  failoverState: 'armed' | 'switching' | 'switched' | 'restoring' | string
  failCount: number
  lastCheckAt: number
  lastHealthState: string
  lastSwitchAt: number
  lastError: string
  hasProbeTemplate: boolean
  probeTemplateUuid?: string
  probeState?: string
  probeStatuses: AxisNowRuleProbeStatus[]
  logs: AxisNowRuleAutomationLog[]
}

export type AxisNowRule = {
  uuid: string
  accountId: number
  accountName: string
  domainUuid: string
  type: string
  geoIsp: string
  geoIspName: string
  name?: string
  description?: string
  status: 'active' | 'paused'
  strategy?: string
  poolSummary?: string
  poolGroups: AxisNowRulePoolGroup[]
  poolAddresses: AxisNowRuleResolvedAddress[]
  poolAddressCount: number
  poolTruncated: boolean
  strategyQuantity?: number
  strategyInterval?: number
  resolvedAddresses: AxisNowRuleResolvedAddress[]
  probeTemplateUuid?: string
  probeState?: string
  probeStatuses: AxisNowRuleProbeStatus[]
  action: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
  resolvedUpdatedAt?: string
  automation?: {
    configured: boolean
    tideEnabled?: boolean
    failoverEnabled?: boolean
    activePool?: string
    failoverState?: string
    failCount?: number
    failureThreshold?: number
    lastHealthState?: string
    lastSwitchAt?: number
    lastError?: string
  }
}

export type AxisNowEip = {
  uuid: string
  accountId: number
  accountName: string
  address: string
  canManage: boolean
  dataOrigin: 'own' | 'subscribed'
  ownerType: 'edge' | 'cluster'
  edgeUuid?: string
  clusterUuid?: string
  tagUuids: string[]
  tagNames: string[]
  referencedCount: number
  providerName: string
  geo: {
    countryCode?: string
    provinceCode?: string
    cityName?: string
    ispName?: string
  }
  subscriptionStatus?: string
  createdAt?: string
  updatedAt?: string
}

export type AxisNowTag = {
  uuid: string
  accountId: number
  accountName: string
  name: string
  description?: string
  boundCount: number
  referencedCount: number
  createdAt?: string
  updatedAt?: string
}
