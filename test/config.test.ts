import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig, parseConfig } from '../src/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('SSO provider configuration', () => {
  it('supports OIDC-only login and checks forced provider settings', () => {
    const base = {
      server: { environment: 'production', publicUrl: 'https://dns.example.com/' },
      upstream: { url: 'http://127.0.0.1:19101/' },
      cas: { enabled: false },
      oidc: { enabled: true, issuer: 'https://id.example.com', clientId: 'dnsmgr', clientSecret: 'secret' },
      auth: { sessionSecret: '0123456789abcdef0123456789abcdef', requiredProvider: 'oidc' },
      database: { enabled: true },
    }
    const configured = parseConfig(base)
    expect(configured.auth).toMatchObject({ requiredProvider: 'oidc', sessionCookie: 'dnsmgr_helper_session' })
    expect(configured.oidc.issuer?.href).toBe('https://id.example.com/')
    expect(() => parseConfig({ ...base, auth: { ...base.auth, requiredProvider: 'cas' } })).toThrow()
    expect(() => parseConfig({ ...base, auth: { ...base.auth, cookieSameSite: 'strict' } })).toThrow()
    expect(() => parseConfig({ ...base, oidc: { ...base.oidc, issuer: 'http://id.example.com' } })).toThrow()
  })
})

describe('ThinkPHP database configuration compatibility', () => {
  it('does not require managed dnsmgr credentials when database access is enabled', () => {
    const config = parseConfig({
      server: { environment: 'test', publicUrl: 'https://dns.example.com/' },
      upstream: { url: 'http://127.0.0.1:19101/' },
      cas: {
        enabled: true,
        baseUrl: 'https://cas.example.com/cas/',
        sessionSecret: '0123456789abcdef0123456789abcdef',
      },
      database: { enabled: true },
    })

    expect(config.legacySso).toEqual({})
  })

  it('keeps managed dnsmgr credentials mandatory for the no-database fallback', () => {
    expect(() => parseConfig({
      server: { environment: 'test', publicUrl: 'https://dns.example.com/' },
      upstream: { url: 'http://127.0.0.1:19101/' },
      cas: {
        enabled: true,
        baseUrl: 'https://cas.example.com/cas/',
        sessionSecret: '0123456789abcdef0123456789abcdef',
      },
      database: { enabled: false },
    })).toThrow()
  })

  it('uses the stock dnsmgr table prefix unless it is explicitly overridden', () => {
    const base = {
      server: { environment: 'test', publicUrl: 'https://dns.example.com/' },
      upstream: { url: 'http://127.0.0.1:19101/' },
      cas: { enabled: false },
      legacySso: {},
    }
    expect(parseConfig({ ...base, database: { enabled: true } }).database.tablePrefix).toBe('dnsmgr_')
    expect(parseConfig({ ...base, database: { enabled: true, tablePrefix: '' } }).database.tablePrefix).toBe('')
  })

  it('loads database credentials from a relative read-only-compatible env path', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dnsmgr-helper-config-'))
    temporaryDirectories.push(directory)

    const thinkphpEnvPath = path.join(directory, 'thinkphp.env')
    const configPath = path.join(directory, 'dnsmgr-helper.json')

    await writeFile(thinkphpEnvPath, `
APP_DEBUG = false

[DATABASE]
TYPE = mysql
HOSTNAME = 192.0.2.10
DATABASE = dnsmgr_example
USERNAME = dnsmgr_example
PASSWORD = "example#password=42"
HOSTPORT = 43306
CHARSET = utf8mb4
PREFIX = dnsmgr_
DEBUG = false

[LANG]
default_lang = zh-cn
`, 'utf8')

    await writeFile(configPath, JSON.stringify({
      server: {
        environment: 'test',
        host: '127.0.0.1',
        port: 43101,
        publicUrl: 'https://dns.example.com/',
      },
      upstream: {
        url: 'http://127.0.0.1:19101/',
      },
      cas: { enabled: false },
      legacySso: {},
      database: {
        enabled: true,
        thinkphpEnvPath: 'thinkphp.env',
        host: 'must-be-overridden',
        port: 3306,
        user: 'must-be-overridden',
        password: 'must-be-overridden',
        name: 'must-be-overridden',
        charset: 'latin1',
      },
    }), 'utf8')

    const config = await loadConfig(configPath)

    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 43101 })
    expect(config.database).toMatchObject({
      enabled: true,
      thinkphpEnvPath,
      host: '192.0.2.10',
      port: 43306,
      user: 'dnsmgr_example',
      password: 'example#password=42',
      name: 'dnsmgr_example',
      charset: 'utf8mb4',
      tablePrefix: 'dnsmgr_',
    })
  })
})
