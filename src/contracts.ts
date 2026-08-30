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
