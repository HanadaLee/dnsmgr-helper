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

export type DnsRecord = {
  id: string
  name: string
  type: string
  value: string
  line: {
    id: string
    label: string
  }
  ttl?: number
  mxPriority?: number
  weight?: number
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
