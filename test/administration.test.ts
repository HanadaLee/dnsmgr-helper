import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { createCasSession } from '../src/auth/cas.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

function config(casEnabled = false) {
  return parseConfig({
    server: { environment: 'test', publicUrl: 'https://dns.test/' },
    upstream: { url: 'http://legacy.test/internal/' },
    cas: casEnabled ? {
      enabled: true,
      baseUrl: 'https://login.test/cas/',
      sessionSecret: '0123456789abcdef0123456789abcdef',
    } : { enabled: false },
    legacySso: casEnabled
      ? { adminUser: 'admin', managedPassword: 'managed-password' }
      : {},
    database: {},
  })
}

function fakeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    return handler(url, init ?? {})
  }) as FetchLike
}

async function appWith(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
  casEnabled = false,
) {
  const app = await buildApp({ config: config(casEnabled), fetcher: fakeFetch(handler), logger: false })
  apps.push(app)
  return app
}

function json(value: unknown, init?: ResponseInit) {
  return Response.json(value, init)
}

function html(value: string) {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function form(init: RequestInit) {
  return new URLSearchParams(String(init.body))
}

function browserCookies(response: { headers: Record<string, string | string[] | number | undefined> }) {
  const header = response.headers['set-cookie']
  const values = Array.isArray(header) ? header : typeof header === 'string' ? [header] : []
  return values.map((value) => value.split(';', 1)[0]).join('; ')
}

const headers = { cookie: 'user_token=legacy-administrator-session' }

describe('dashboard, users and logs', () => {
  it('normalizes the complete dashboard and clears cache through fixed routes', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/' && init.method === 'POST') {
        expect(Object.fromEntries(form(init))).toEqual({ do: 'stat' })
        return json({
          domains: 8, tasks: 3, certs: 5, deploys: 4,
          dmonitor_state: 1, dmonitor_active: 2, dmonitor_status_0: 1, dmonitor_status_1: 1,
          optimizeip_active: 6, optimizeip_status_1: 4, optimizeip_status_2: 2,
          certorder_status_3: 3, certorder_status_5: 1, certorder_status_6: 2, certorder_status_7: 1,
          certdeploy_status_0: 1, certdeploy_status_1: 2, certdeploy_status_2: 1,
        })
      }
      if (url.pathname === '/internal/' && init.method === 'GET') {
        return html(`<table>
          <tr><td>框架版本</td><td>8.1.3</td></tr>
          <tr><td>PHP版本</td><td>8.4.12</td></tr>
          <tr><td>数据库版本</td><td>8.0.43</td></tr>
          <tr><td>Web服务器</td><td>nginx/1.31</td></tr>
          <tr><td>服务器时间</td><td>2026-08-31 12:00:00</td></tr>
        </table>`)
      }
      if (url.pathname === '/internal/cleancache') return json({ code: 0, msg: 'succ' })
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const overview = await app.inject({ method: 'GET', url: '/api/web/v1/dashboard', headers })
    const clear = await app.inject({ method: 'POST', url: '/api/web/v1/dashboard/cache/clear', headers })

    expect(overview.json()).toEqual({
      code: 'OK',
      data: {
        totals: { domains: 8, monitoringTasks: 3, certificateOrders: 5, certificateDeployments: 4 },
        monitoring: { workerRunning: true, active: 2, healthy: 1, failed: 1 },
        optimizeIp: { active: 6, succeeded: 4, failed: 2 },
        certificates: { issued: 3, failed: 1, expiringSoon: 2, expired: 1 },
        deployments: { pending: 1, succeeded: 2, failed: 1 },
        server: {
          frameworkVersion: '8.1.3', phpVersion: '8.4.12', databaseVersion: '8.0.43',
          webServer: 'nginx/1.31', serverTime: '2026-08-31 12:00:00',
        },
      },
    })
    expect(clear.json()).toEqual({ code: 'OK', message: 'succ' })
  })

  it('converts the original JSONP release check into structured data', async () => {
    const app = await appWith((url) => {
      expect(url.origin + url.pathname).toBe('https://auth.cccyun.cc/app/dnsmgr.php')
      expect(url.searchParams.get('ver')).toBe('1051')
      expect(url.searchParams.get('callback')).toBe('dnsmgrRelease')
      return new Response('dnsmgrRelease({"code":0,"msg":"<li>当前版本：V2.19 (Build 1051)</li>"})')
    })

    const response = await app.inject({ method: 'GET', url: '/api/web/v1/dashboard/release' })
    expect(response.statusCode).toBe(200)
    expect(response.json().data).toMatchObject({
      status: 'current',
      currentBuild: '1051',
      latestBuild: '1051',
      latestVersion: '2.19',
      releaseUrl: 'https://github.com/netcccyun/dnsmgr/releases',
    })
  })

  it('covers user CRUD, permission options and logs without leaking credential internals', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/domain/data') {
        expect(new Headers(init.headers).get('x-requested-with')).toBe('XMLHttpRequest')
        expect(Object.fromEntries(form(init))).toEqual({
          offset: '0', limit: '10000', sortName: 'name', sortOrder: 'asc',
        })
        return json({ total: 2, rows: [
          { id: 1, name: 'example.com' },
          { id: 2, name: 'example.net' },
        ] })
      }
      if (url.pathname === '/internal/user/data') {
        expect(Object.fromEntries(form(init))).toEqual({
          offset: '0', limit: '10', sortName: 'username', sortOrder: 'asc', kw: 'hana',
        })
        return json({ total: 1, rows: [{
          id: 1001, username: 'hanada', password: '$2y$secret', apikey: 'list-secret',
          level: 1, is_api: 1, totp_open: 1, totp_secret: 'TOTPSECRET', status: 1,
          regtime: '2026-01-01 00:00:00', lasttime: '2026-08-31 00:00:00',
        }] })
      }
      if (url.pathname === '/internal/user/op/act/get') {
        expect(form(init).get('id')).toBe('1001')
        return json({ code: 0, data: {
          id: 1001, username: 'hanada', password: '$2y$secret', apikey: 'detail-api-key',
          level: 1, is_api: 1, totp_open: 1, totp_secret: 'TOTPSECRET', status: 1,
          permission: ['example.com'],
        } })
      }
      if (url.pathname === '/internal/user/op/act/add') {
        const values = form(init)
        expect(values.getAll('permission[]')).toEqual(['example.com'])
        expect(Object.fromEntries(values)).toMatchObject({
          username: 'new-user', password: 'new-password', is_api: '1', apikey: 'api-key', level: '1',
        })
        return json({ code: 0, msg: '添加用户成功！' })
      }
      if (url.pathname === '/internal/user/op/act/edit') {
        const values = form(init)
        expect(values.getAll('permission[]')).toEqual([])
        expect(Object.fromEntries(values)).toEqual({
          id: '1001', username: 'hanada', is_api: '0', apikey: '', level: '2', repwd: 'reset-password',
        })
        return json({ code: 0, msg: '修改用户成功！' })
      }
      if (url.pathname === '/internal/user/op/act/set') {
        expect(Object.fromEntries(form(init))).toEqual({ id: '1001', status: '0' })
        return json({ code: 0 })
      }
      if (url.pathname === '/internal/user/op/act/del') {
        expect(Object.fromEntries(form(init))).toEqual({ id: '1001' })
        return json({ code: 0 })
      }
      if (url.pathname === '/internal/log/data') {
        expect(Object.fromEntries(form(init))).toEqual({
          offset: '0', limit: '10', uid: '1001', domain: 'example.com', kw: '更新',
        })
        return json({ total: 1, rows: [{
          id: 7, uid: 1001, domain: 'example.com', action: '<b>更新记录</b>',
          data: '值 &lt;changed&gt;', addtime: '2026-08-31 01:02:03',
        }] })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const options = await app.inject({ method: 'GET', url: '/api/web/v1/users/form', headers })
    const list = await app.inject({
      method: 'GET', url: '/api/web/v1/users?pageSize=10&q=hana&sort=username&order=asc', headers,
    })
    const detail = await app.inject({ method: 'GET', url: '/api/web/v1/users/1001', headers })
    const mutations = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/web/v1/users', headers,
        payload: {
          username: 'new-user', password: 'new-password', apiEnabled: true, apiKey: 'api-key',
          role: 'user', permissions: ['example.com'],
        },
      }),
      app.inject({
        method: 'PUT', url: '/api/web/v1/users/1001', headers,
        payload: {
          username: 'hanada', apiEnabled: false, apiKey: null, role: 'administrator',
          permissions: [], resetPassword: 'reset-password',
        },
      }),
      app.inject({ method: 'PATCH', url: '/api/web/v1/users/1001/status', headers, payload: { enabled: false } }),
      app.inject({ method: 'DELETE', url: '/api/web/v1/users/1001', headers }),
    ])
    const logs = await app.inject({
      method: 'GET', url: '/api/web/v1/logs?pageSize=10&userId=1001&domain=example.com&q=%E6%9B%B4%E6%96%B0', headers,
    })

    expect(options.json()).toEqual({ code: 'OK', data: { domains: ['example.com', 'example.net'] } })
    expect(list.json()).toEqual({
      code: 'OK',
      data: [{
        id: 1001, username: 'hanada', role: 'user', apiEnabled: true, totpEnabled: true,
        enabled: true, registeredAt: '2026-01-01 00:00:00', lastLoginAt: '2026-08-31 00:00:00',
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(list.body).not.toContain('$2y$secret')
    expect(list.body).not.toContain('list-secret')
    expect(list.body).not.toContain('TOTPSECRET')
    expect(detail.json()).toEqual({
      code: 'OK',
      data: {
        id: 1001, username: 'hanada', role: 'user', apiEnabled: true, totpEnabled: true,
        enabled: true, apiKey: 'detail-api-key', permissions: ['example.com'],
      },
    })
    expect(detail.body).not.toContain('$2y$secret')
    expect(detail.body).not.toContain('TOTPSECRET')
    expect(mutations.map((response) => response.json())).toEqual([
      { code: 'OK', message: '添加用户成功！' },
      { code: 'OK', message: '修改用户成功！' },
      { code: 'OK' },
      { code: 'OK' },
    ])
    expect(logs.json()).toEqual({
      code: 'OK',
      data: [{
        id: 7, actor: { kind: 'user', userId: 1001 }, domain: 'example.com',
        action: '更新记录', detail: '值 <changed>', occurredAt: '2026-08-31 01:02:03',
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
  })
})

describe('profile and fixed system settings', () => {
  it('covers local password, TOTP and legacy theme only when local credentials are active', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/setpwd' && init.method === 'GET') {
        return html('<input name="totp_status" value="已开启" readonly>')
      }
      if (url.pathname === '/internal/setpwd') {
        expect(Object.fromEntries(form(init))).toEqual({
          oldpwd: 'old-password', newpwd: 'new-password', newpwd2: 'new-password',
        })
        return json({ code: 0, msg: 'succ' })
      }
      if (url.pathname === '/internal/totp/generate') {
        return json({ code: 0, data: { secret: 'JBSWY3DPEHPK3PXP', qrcode: 'otpauth://totp/DNS' } })
      }
      if (url.pathname === '/internal/totp/bind') {
        expect(Object.fromEntries(form(init))).toEqual({ secret: 'JBSWY3DPEHPK3PXP', code: '123456' })
        return json({ code: 0, msg: 'succ' })
      }
      if (url.pathname === '/internal/totp/close') return json({ code: 0, msg: 'succ' })
      if (url.pathname === '/internal/changeskin') {
        expect(Object.fromEntries(form(init))).toEqual({ skin: 'skin-blue-light' })
        return json({ code: 0, msg: 'succ' })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const security = await app.inject({ method: 'GET', url: '/api/web/v1/profile/security', headers })
    const password = await app.inject({
      method: 'PUT', url: '/api/web/v1/profile/password', headers,
      payload: { currentPassword: 'old-password', newPassword: 'new-password' },
    })
    const enrollment = await app.inject({ method: 'POST', url: '/api/web/v1/profile/totp/enrollment', headers })
    const bind = await app.inject({
      method: 'PUT', url: '/api/web/v1/profile/totp', headers,
      payload: { secret: 'JBSWY3DPEHPK3PXP', code: '123456' },
    })
    const disable = await app.inject({ method: 'DELETE', url: '/api/web/v1/profile/totp', headers })
    const theme = await app.inject({
      method: 'PUT', url: '/api/web/v1/profile/legacy-theme', headers,
      payload: { theme: 'skin-blue-light' },
    })

    expect(security.json()).toEqual({ code: 'OK', data: { localCredentialsAvailable: true, totpEnabled: true } })
    expect(password.json()).toEqual({ code: 'OK', message: 'succ' })
    expect(enrollment.json()).toEqual({
      code: 'OK', data: { secret: 'JBSWY3DPEHPK3PXP', provisioningUri: 'otpauth://totp/DNS' },
    })
    expect(bind.json()).toEqual({ code: 'OK', message: 'succ' })
    expect(disable.json()).toEqual({ code: 'OK', message: 'succ' })
    expect(theme.json()).toEqual({ code: 'OK', message: 'succ' })
  })

  it('does not call the legacy password/TOTP surface for externally managed login', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const appConfig = config(true)
    const app = await buildApp({ config: appConfig, fetcher, logger: false })
    apps.push(app)
    const session = await createCasSession({ name: 'hanada' }, appConfig)
    const authenticatedHeaders = {
      cookie: `${appConfig.cas.sessionCookie}=${session}; user_token=legacy-session`,
    }
    const security = await app.inject({
      method: 'GET', url: '/api/web/v1/profile/security', headers: authenticatedHeaders,
    })
    const password = await app.inject({
      method: 'PUT', url: '/api/web/v1/profile/password', headers: authenticatedHeaders,
      payload: { currentPassword: 'old', newPassword: 'new' },
    })

    expect(security.json()).toEqual({
      code: 'OK', data: { localCredentialsAvailable: false, totpEnabled: false },
    })
    expect(password.statusCode).toBe(409)
    expect(password.json()).toMatchObject({ code: 'LOCAL_CREDENTIALS_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reads and writes notification, login, proxy and cron settings through fixed key sets', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/system/loginset' && init.method === 'GET') {
        return html('<input id="vocde_switch" type="checkbox" checked>')
      }
      if (url.pathname === '/internal/system/noticeset' && init.method === 'GET') {
        return html(`
          <select name="mail_type" default="1"></select>
          <input name="mail_smtp" value="smtp.example"><input name="mail_port" value="465">
          <input name="mail_name" value="sender@example.com"><input name="mail_pwd" value="mail-password">
          <input name="mail_apiuser" value="api-user"><input name="mail_apikey" value="api-secret">
          <input name="mail_recv" value="receiver@example.com">
          <input name="wechat_apptoken" value="wx-token"><input name="wechat_appuid" value="UID_example">
          <input name="tgbot_token" value="tg-token"><input name="tgbot_chatid" value="123">
          <input name="tgbot_topicid" value="456"><select name="tgbot_proxy" default="2"></select>
          <input name="tgbot_url" value="https://telegram.example">
          <input name="webhook_url" value="https://robot.example"><input name="webhook_user" value="all">
          <input name="custom_webhook_url" value="https://custom.example">
          <select name="custom_webhook_method" default="PUT"></select>
          <select name="custom_webhook_content_type" default="application/json"></select>
          <textarea name="custom_webhook_headers">Authorization: Bearer token</textarea>
          <textarea name="custom_webhook_body">{&quot;title&quot;:&quot;{title}&quot;}</textarea>
          <select name="custom_webhook_content_format" default="markdown"></select>
        `)
      }
      if (url.pathname === '/internal/system/proxyset' && init.method === 'GET') {
        return html(`
          <input name="proxy_server" value="127.0.0.1"><input name="proxy_port" value="7890">
          <input name="proxy_user" value="proxy-user"><input name="proxy_pwd" value="proxy-password">
          <select name="proxy_type" default="sock5h"></select>
        `)
      }
      if (url.pathname === '/internal/system/cronset' && init.method === 'GET') {
        return html(`
          <select name="cron_type" default="1"></select><input name="cron_key" value="cron-secret">
          <table>
            <tr><td>SSL证书续签</td><td><font>2026-08-31 01:00:00</font></td></tr>
            <tr><td>SSL证书部署</td><td><font>未运行</font></td></tr>
            <tr><td>域名到期提醒</td><td><font>2026-08-31 01:01:00</font></td></tr>
            <tr><td>CF优选IP更新</td><td><font>2026-08-31 01:02:00</font></td></tr>
            <tr><td>定时切换解析</td><td><font>2026-08-31 01:03:00</font></td></tr>
          </table>
        `)
      }
      if (url.pathname === '/internal/system/set') {
        const values = Object.fromEntries(form(init))
        if ('vcode' in values) expect(values).toEqual({ vcode: '2' })
        else if ('tgbot_token' in values) expect(values).toEqual({
          tgbot_token: 'new-token', tgbot_chatid: '789', tgbot_topicid: '',
          tgbot_proxy: '1', tgbot_url: '',
        })
        else if ('proxy_server' in values) expect(values).toEqual({
          proxy_server: 'proxy.example', proxy_port: '1080', proxy_user: 'user',
          proxy_pwd: 'password', proxy_type: 'sock5',
        })
        else if ('cron_type' in values) expect(values).toEqual({ cron_type: '1', cron_key: 'new-cron-key' })
        else throw new Error(`unexpected settings form ${JSON.stringify(values)}`)
        return json({ code: 0, msg: 'succ' })
      }
      if (url.pathname === '/internal/system/proxytest') {
        expect(Object.fromEntries(form(init))).toEqual({
          proxy_server: 'proxy.example', proxy_port: '1080', proxy_user: 'user',
          proxy_pwd: 'password', proxy_type: 'sock5',
        })
        return json({ code: 0 })
      }
      if (url.pathname === '/internal/system/tgbottest') return json({ code: 0, msg: '消息发送成功！' })
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const [login, notifications, proxy, cron] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/web/v1/system/login-settings', headers }),
      app.inject({ method: 'GET', url: '/api/web/v1/system/notifications', headers }),
      app.inject({ method: 'GET', url: '/api/web/v1/system/proxy', headers }),
      app.inject({ method: 'GET', url: '/api/web/v1/system/cron', headers }),
    ])
    expect(login.json()).toEqual({
      code: 'OK', data: { graphicalVerificationEnabled: true, appliesToCurrentLogin: true },
    })
    expect(notifications.json()).toMatchObject({
      code: 'OK',
      data: {
        email: { provider: 'sendcloud', smtpPort: 465, apiKey: 'api-secret' },
        telegram: { proxyMode: 'custom', customBaseUrl: 'https://telegram.example' },
        customWebhook: {
          method: 'PUT', headers: 'Authorization: Bearer token',
          body: '{"title":"{title}"}', contentFormat: 'markdown',
        },
      },
    })
    expect(proxy.json()).toEqual({
      code: 'OK',
      data: {
        server: '127.0.0.1', port: 7890, username: 'proxy-user',
        password: 'proxy-password', type: 'sock5h',
      },
    })
    expect(cron.json()).toEqual({
      code: 'OK',
      data: {
        executionMode: 'http', accessKey: 'cron-secret',
        publicUrl: 'https://dns.test/cron?key=cron-secret',
        lastRuns: {
          certificateRenewal: '2026-08-31 01:00:00',
          domainExpiryNotice: '2026-08-31 01:01:00', optimizeIp: '2026-08-31 01:02:00',
          scheduledDns: '2026-08-31 01:03:00',
        },
      },
    })

    const proxyPayload = {
      server: 'proxy.example', port: 1080, username: 'user', password: 'password', type: 'sock5',
    }
    const writes = await Promise.all([
      app.inject({
        method: 'PUT', url: '/api/web/v1/system/login-settings', headers,
        payload: { graphicalVerificationEnabled: false },
      }),
      app.inject({
        method: 'PUT', url: '/api/web/v1/system/notifications', headers,
        payload: {
          telegram: {
            token: 'new-token', chatId: '789', topicId: '', proxyMode: 'system', customBaseUrl: '',
          },
        },
      }),
      app.inject({ method: 'POST', url: '/api/web/v1/system/notifications/test', headers, payload: { channel: 'telegram' } }),
      app.inject({ method: 'PUT', url: '/api/web/v1/system/proxy', headers, payload: proxyPayload }),
      app.inject({ method: 'POST', url: '/api/web/v1/system/proxy/test', headers, payload: proxyPayload }),
      app.inject({
        method: 'PUT', url: '/api/web/v1/system/cron', headers,
        payload: { executionMode: 'http', accessKey: 'new-cron-key' },
      }),
    ])
    expect(writes.map((response) => response.json())).toEqual([
      { code: 'OK', message: 'succ' },
      { code: 'OK', message: 'succ' },
      { code: 'OK', message: '消息发送成功！' },
      { code: 'OK', message: 'succ' },
      { code: 'OK' },
      { code: 'OK', message: 'succ' },
    ])
  })
})

describe('public compatibility surface', () => {
  it('preserves original API authentication responses and public execution/status text', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/api/record/add/42') {
        expect(Object.fromEntries(form(init))).toEqual({
          uid: '1000', timestamp: '1788120000', sign: 'bad-sign', name: 'www', value: '192.0.2.1',
        })
        return json({ code: -1, msg: '签名错误' }, { status: 403 })
      }
      if (url.pathname === '/internal/api/domain') {
        expect([...form(init)]).toEqual([])
        return json({ code: -1, msg: '认证参数不能为空' }, { status: 403 })
      }
      if (url.pathname === '/internal/cron') {
        expect(url.searchParams.get('key')).toBe('cron-secret')
        expect(new Headers(init.headers).get('user-agent')).toBe('cron-agent')
        return new Response('success!', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
      if (url.pathname === '/internal/dmtask/status') return new Response('ok')
      if (url.pathname === '/internal/optimizeip/status') return new Response('error')
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const api = await app.inject({
      method: 'POST',
      url: '/api/record/add/42',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'uid=1000&timestamp=1788120000&sign=bad-sign&name=www&value=192.0.2.1',
    })
    const emptyApi = await app.inject({ method: 'POST', url: '/api/domain' })
    const cron = await app.inject({
      method: 'GET', url: '/cron?key=cron-secret', headers: { 'user-agent': 'cron-agent' },
    })
    const monitoring = await app.inject({ method: 'GET', url: '/dmtask/status' })
    const optimize = await app.inject({ method: 'PUT', url: '/optimizeip/status' })

    expect(api.statusCode).toBe(403)
    expect(api.json()).toEqual({ code: -1, msg: '签名错误' })
    expect(emptyApi.statusCode).toBe(403)
    expect(emptyApi.json()).toEqual({ code: -1, msg: '认证参数不能为空' })
    expect(cron.body).toBe('success!')
    expect(monitoring.body).toBe('ok')
    expect(optimize.body).toBe('error')
  })

  it('preserves domain quick login while CAS protects the management session', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/quicklogin') {
        expect(url.searchParams.get('domain')).toBe('example.com')
        expect(url.searchParams.get('timestamp')).toBe('1788120000')
        expect(url.searchParams.get('token')).toBe('one-time-token')
        expect(url.searchParams.get('sign')).toBe('0123456789abcdef0123456789abcdef')
        expect(new Headers(init.headers).get('x-requested-with')).toBeNull()
        return new Response(null, {
          status: 302,
          headers: {
            location: '/record/42',
            'set-cookie': 'user_token=domain-session; Path=/; HttpOnly',
          },
        })
      }
      if (url.pathname === '/internal/' && init.method === 'GET') {
        expect(new Headers(init.headers).get('cookie')).toBe('user_token=domain-session')
        return new Response(null, { status: 302, headers: { location: '/record/42' } })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    }, true)

    const login = await app.inject({
      method: 'GET',
      url: '/quicklogin?domain=example.com&timestamp=1788120000&token=one-time-token&sign=0123456789abcdef0123456789abcdef',
    })
    expect(login.statusCode).toBe(302)
    expect(login.headers.location).toBe('/record/42')
    const cookies = browserCookies(login)
    expect(cookies).toContain('dnsmgr_helper_session=')
    expect(cookies).toContain('dnsmgr_helper_legacy_session=domain-session')
    expect(cookies).toContain('user_token=domain-session')

    const session = await app.inject({
      method: 'GET',
      url: '/api/web/v1/session',
      headers: { cookie: cookies },
    })
    expect(session.statusCode).toBe(200)
    expect(session.json().data).toMatchObject({
      authenticated: true,
      user: { name: 'example.com', type: 'domain', domainId: 42 },
      capabilities: { domains: true, systemSettings: false },
    })
  })

  it('rejects unregistered public paths and malformed identifiers without an upstream request', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await buildApp({ config: config(), fetcher, logger: false })
    apps.push(app)
    const unknown = await app.inject({ method: 'POST', url: '/api/system/set', payload: {} })
    const invalid = await app.inject({ method: 'POST', url: '/api/domain/not-an-id', payload: {} })

    expect(unknown.statusCode).toBe(404)
    expect(invalid.statusCode).toBe(422)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
