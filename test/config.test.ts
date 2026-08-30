import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('ThinkPHP database configuration compatibility', () => {
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
        url: 'http://127.0.0.1:8081/__dnsmgr_legacy/',
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
