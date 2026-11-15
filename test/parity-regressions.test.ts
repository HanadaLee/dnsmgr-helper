import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())) })
const headers = { cookie: 'user_token=parity-session' }
const html = (text: string) => new Response(text, { headers: { 'content-type': 'text/html' } })
async function appWith(handler: (url: URL, init: RequestInit) => Response) {
  const config = parseConfig({ server: { environment: 'test', publicUrl: 'https://dns.test/' },
    upstream: { url: 'http://legacy.test/internal/' }, cas: { enabled: false }, legacySso: {}, database: {} })
  const fetcher: FetchLike = async (input, init) => handler(new URL(String(input)), init ?? {})
  const app = await buildApp({ config, fetcher, logger: false })
  apps.push(app)
  return app
}
const domainField = { name: '绑定的域名', type: 'tags', required: true, show: "product=='cdn'||product=='obs'" }

describe('original feature parity regressions', () => {
  it('preserves multi-domain fields across form metadata, create, edit and update', async () => {
    const saved = { product: 'cdn', domain: 'www.example.com,cdn.example.com' }
    let writes = 0
    const app = await appWith((url, init) => {
      if (init.method === 'POST') {
        const form = new URLSearchParams(String(init.body))
        expect(JSON.parse(form.get('config') ?? '{}')).toEqual(saved)
        expect(form.get('aid')).toBe('4')
        expect(form.get('oid')).toBe('9')
        writes++
        return Response.json({ code: 0, msg: '保存成功' })
      }
      if (url.pathname.endsWith('/cert/deploy/edit')) return html(`<script>var info=${JSON.stringify({ id: 11, aid: 4, oid: 9, type: 'huawei', config: JSON.stringify(saved) })};</script>`)
      return html(`<select name="aid"><option value="4" data-type="huawei">华为云</option></select><select name="oid"><option value="9">9_example.com</option></select><script>var typeList=${JSON.stringify({
        huawei: { name: '华为云', taskinputs: { product: { name: '产品', type: 'select', value: 'cdn', options: [{ value: 'cdn', label: 'CDN' }] }, domain: domainField } },
        tencent: { name: '腾讯云', taskinputs: { domain: { ...domainField, show: true } } },
        aliyun: { name: '阿里云', taskinputs: { domain: { ...domainField, show: true } } },
      })};</script>`)
    })
    const form = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-deployments/form', headers })
    expect(form.statusCode).toBe(200)
    expect(form.json().data.accountTypes).toHaveLength(3)
    for (const type of form.json().data.accountTypes) expect(type.taskFields).toContainEqual(expect.objectContaining({ key: 'domain', control: 'tags', required: true }))
    const payload = { accountId: 4, orderId: 9, config: saved }
    expect((await app.inject({ method: 'POST', url: '/api/web/v1/certificate-deployments', headers, payload })).statusCode).toBe(200)
    const detail = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-deployments/11', headers })
    expect(detail.json().data.config).toEqual(saved)
    expect((await app.inject({ method: 'PUT', url: '/api/web/v1/certificate-deployments/11', headers, payload })).statusCode).toBe(200)
    expect(writes).toBe(2)
  })

  it('uses the shared control and conditional-visibility contract for DNS accounts too', async () => {
    const app = await appWith(() => html(`<script>var typeList=${JSON.stringify({ custom: { name: '自定义', config: { domain: domainField } } })};</script>`))
    const response = await app.inject({ method: 'GET', url: '/api/web/v1/domain-account-providers', headers })
    expect(response.statusCode).toBe(200)
    expect(response.json().data[0].fields[0]).toMatchObject({ control: 'tags', visibleWhen: { any: expect.any(Array) } })
  })

  it('reports unsupported upstream controls instead of returning a falsely complete form', async () => {
    const app = await appWith(() => html(`<script>var typeList={"huawei":{"name":"华为云","taskinputs":{"domain":{"name":"域名","type":"future-control"}}}};</script>`))
    const response = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-deployments/form', headers })
    expect(response.statusCode).toBe(502)
    expect(response.json().code).toBe('UPSTREAM_ADAPTER_MISMATCH')
  })

  it.each(['已绑定', '未绑定'])('reads QQ credentials, public callback URL and accurate status: %s', async (status) => {
    const app = await appWith(() => html(`<input name="qqbot_appid" value="app-id"><input name="qqbot_appsecret" value="secret"><label class="control-label">绑定状态</label><div><p><font>${status}</font></p></div>`))
    const response = await app.inject({ method: 'GET', url: '/api/web/v1/system/notifications', headers })
    expect(response.json().data.qqbot).toEqual({ appId: 'app-id', appSecret: 'secret', webhookUrl: 'https://dns.test/qqbot/webhook', bound: status === '已绑定' })
  })

  it('writes QQ credentials and each notification channel using only the original fixed settings keys', async () => {
    const forms: Record<string, string>[] = []
    const app = await appWith((_url, init) => { forms.push(Object.fromEntries(new URLSearchParams(String(init.body)))); return Response.json({ code: 0 }) })
    const toggles = { email: false, wechat: false, telegram: false, qqbot: true, robotWebhook: false, customWebhook: false }
    for (const [url, payload] of [
      ['/api/web/v1/system/notifications', { qqbot: { appId: 'app-id', appSecret: 'secret' } }],
      ['/api/web/v1/domains/expiry-settings', { reminderDays: [7], notifications: toggles }],
      ['/api/web/v1/monitoring/notifications', toggles],
      ['/api/web/v1/certificate-settings', { notifications: { qqbot: 'failures-only' } }],
    ] as const) expect((await app.inject({ method: 'PUT', url, headers, payload })).statusCode).toBe(200)
    expect(forms[0]).toEqual({ qqbot_appid: 'app-id', qqbot_appsecret: 'secret' })
    expect(forms[1]).toMatchObject({ expire_notice_qqbot: '1' })
    expect(forms[2]).toMatchObject({ notice_qqbot: '1' })
    expect(forms[3]).toEqual({ cert_notice_qqbot: '2' })
    const rejected = await app.inject({ method: 'PUT', url: '/api/web/v1/system/notifications', headers,
      payload: { qqbot: { appId: 'app-id', appSecret: 'secret', bound: true } } })
    expect(rejected.statusCode).toBe(422)
    expect(forms).toHaveLength(4)
  })

  it('reads all three QQ notification switches and preserves old clients that omit the new switch', async () => {
    const app = await appWith((url, init) => {
      if (init.method === 'POST') {
        expect(String(init.body)).not.toContain('qqbot')
        return Response.json({ code: 0 })
      }
      return html('<input name="expire_noticedays" value="7"><select name="expire_notice_qqbot" default="1"></select><select name="notice_qqbot" default="1"></select><select name="cert_notice_qqbot" default="2"></select>'
        + '<input name="cert_renewdays" value="14"><select name="deploy_hour_start" default="0"></select><select name="deploy_hour_end" default="23"></select>'
        + ['运行状态', '今日运行次数', '24H告警次数', '24H切换次数'].map((label) => `<span class="info-box-text">${label}</span><span class="info-box-number">0</span>`).join(''))
    })
    expect((await app.inject({ method: 'GET', url: '/api/web/v1/domains/expiry-settings', headers })).json().data.notifications.qqbot).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/api/web/v1/monitoring/overview', headers })).json().data.notifications.qqbot).toBe(true)
    expect((await app.inject({ method: 'GET', url: '/api/web/v1/certificate-settings', headers })).json().data.notifications.qqbot).toBe('failures-only')
    expect((await app.inject({ method: 'PUT', url: '/api/web/v1/monitoring/notifications', headers,
      payload: { email: false, wechat: false, telegram: false, robotWebhook: false, customWebhook: false } })).statusCode).toBe(200)
  })
})
