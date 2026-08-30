import type { AppConfig } from '../../config.js'
import type { CasProfile, SessionCapabilities, WebSession } from '../../contracts.js'
import { authenticationError } from '../../upstream/legacy.js'
import type { UpstreamResult } from '../../upstream/client.js'

function decodeHtml(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .trim()
}

function firstMatch(html: string, expression: RegExp): string | undefined {
  const value = expression.exec(html)?.[1]
  return value ? decodeHtml(value) : undefined
}

function capabilitiesFromDashboard(html: string): SessionCapabilities {
  return {
    dashboard: html.includes('href="/"') && html.includes('后台首页'),
    domains: html.includes('href="/domain"'),
    domainAccounts: html.includes('href="/account"'),
    domainCategories: html.includes('href="/domain/category"'),
    monitoring: html.includes('href="/dmonitor/'),
    schedules: html.includes('href="/schedule/'),
    certificates: html.includes('href="/cert/'),
    optimizeIp: html.includes('href="/optimizeip/'),
    systemSettings: html.includes('href="/system/'),
    users: html.includes('href="/user"'),
    logs: html.includes('href="/log"'),
  }
}

export function sessionFromUpstream(
  result: UpstreamResult,
  casProfile: CasProfile | undefined,
  config: AppConfig,
): WebSession {
  if (result.status >= 300 && result.status < 400 && result.location) {
    const location = new URL(result.location, 'https://dnsmgr-helper.invalid')
    const domainMatch = /^\/record\/(\d+)/.exec(location.pathname)
    if (!domainMatch) throw authenticationError(config)

    const name = casProfile?.name ?? `domain-${domainMatch[1]}`
    return {
      authenticated: true,
      user: {
        name,
        displayName: casProfile?.displayName ?? name,
        ...(casProfile?.email ? { email: casProfile.email } : {}),
        ...(casProfile?.avatar ? { avatar: casProfile.avatar } : {}),
        type: 'domain',
      },
      capabilities: {
        dashboard: false,
        domains: true,
        domainAccounts: false,
        domainCategories: false,
        monitoring: false,
        schedules: false,
        certificates: false,
        optimizeIp: false,
        systemSettings: false,
        users: false,
        logs: true,
      },
      sso: {
        profileVerified: Boolean(casProfile),
        loginPath: config.casLoginPath,
        logoutPath: config.casLogoutPath,
      },
      upstream: {
        configuredVersion: config.upstreamVersion,
        adapter: `v${config.upstreamVersion}`,
      },
    }
  }

  if (result.status !== 200 || !result.contentType.toLowerCase().includes('text/html')) {
    throw authenticationError(config)
  }

  const html = result.text
  if (html.includes('name="username"') && html.includes('name="password"')) {
    throw authenticationError(config)
  }

  const htmlName = firstMatch(html, /<span\s+class="hidden-xs">\s*([^<]+)\s*<\/span>/i)
  const name = casProfile?.name ?? htmlName
  if (!name) throw authenticationError(config)

  const registeredAt = firstMatch(html, /<small>\s*([^<]+)\s*<\/small>/i)
  const detectedVersion = /dnsmgr\.php\?ver=(\d+)/i.exec(html)?.[1]
  const type = html.includes('href="/setpwd"') ? 'user' : 'unknown'

  return {
    authenticated: true,
    user: {
      name,
      displayName: casProfile?.displayName ?? htmlName ?? name,
      ...(casProfile?.email ? { email: casProfile.email } : {}),
      ...(casProfile?.avatar ? { avatar: casProfile.avatar } : {}),
      ...(registeredAt ? { registeredAt } : {}),
      type,
    },
    capabilities: capabilitiesFromDashboard(html),
    sso: {
      profileVerified: Boolean(casProfile),
      loginPath: config.casLoginPath,
      logoutPath: config.casLogoutPath,
    },
    upstream: {
      configuredVersion: config.upstreamVersion,
      ...(detectedVersion ? { detectedVersion } : {}),
      adapter: `v${config.upstreamVersion}`,
    },
  }
}
