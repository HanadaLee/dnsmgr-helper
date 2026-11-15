import { describe, expect, it, vi } from 'vitest'
import { bindTotp, changePassword, disableTotp, generateTotpEnrollment, getProfileSecurity } from '../src/adapters/v1051/profile.js'
import { getLoginSettings } from '../src/adapters/v1051/system-settings.js'
import { parseConfig } from '../src/config.js'
import { DnsmgrClient } from '../src/upstream/client.js'

function config(provider: 'cas' | 'oidc' | 'local') {
  return parseConfig({ server: { environment: 'test', publicUrl: 'https://dns.test/' }, upstream: { url: 'http://legacy.test/' },
    cas: { enabled: provider === 'cas', baseUrl: 'https://cas.test/', sessionSecret: 'test-session-secret-with-32-characters' },
    oidc: { enabled: provider === 'oidc', issuer: 'https://id.test', clientId: 'test-client', clientSecret: 'test-secret' },
    legacySso: { adminUser: 'admin', managedPassword: 'managed-password' }, database: {} })
}

describe('local account controls under unified login', () => {
  it.each(['cas', 'oidc'] as const)('does not offer or mutate irrelevant local passwords/TOTP under %s', async (provider) => {
    const settings = config(provider)
    const fetcher = vi.fn(async () => new Response('unexpected upstream call'))
    const client = new DnsmgrClient(settings, fetcher)
    expect(await getProfileSecurity(client, settings, {})).toEqual({ localCredentialsAvailable: false, totpEnabled: false })
    for (const operation of [
      () => changePassword(client, settings, {}, { currentPassword: 'old', newPassword: 'new' }),
      () => generateTotpEnrollment(client, settings, {}),
      () => bindTotp(client, settings, {}, { secret: 'AAAABBBBCCCCDDDD', code: '123456' }),
      () => disableTotp(client, settings, {}),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: 409, code: 'LOCAL_CREDENTIALS_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['cas', 'oidc', 'local'] as const)('reports CAPTCHA applicability accurately for %s', async (provider) => {
    const settings = config(provider)
    const client = new DnsmgrClient(settings, async () => new Response('<input id="vocde_switch" type="checkbox" checked>', { headers: { 'content-type': 'text/html' } }))
    expect(await getLoginSettings(client, settings, {})).toEqual({ graphicalVerificationEnabled: true, appliesToCurrentLogin: provider === 'local' })
  })
})
