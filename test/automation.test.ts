import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { MonitoringTaskMutationSchema } from '../src/adapters/v1051/monitoring.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
})

function testConfig() {
  return parseConfig({
    server: { environment: 'test', publicUrl: 'https://dns.test/' },
    upstream: { url: 'http://legacy.test/internal/' },
    cas: { enabled: false },
    legacySso: {},
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

async function appWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const app = await buildApp({ config: testConfig(), fetcher: fakeFetch(handler), logger: false })
  apps.push(app)
  return app
}

function json(value: unknown) {
  return Response.json(value)
}

describe('monitoring validation compatibility', () => {
  const baseTask = {
    domainId: 42,
    recordName: 'www',
    recordId: 'r1',
    primaryValue: '192.0.2.1',
    backupValue: null,
    checkType: 'tcp' as const,
    checkUrl: null,
    tcpPort: 80,
    intervalSeconds: 5,
    timeoutSeconds: 2,
    useProxy: false,
    enableCloudflareProxy: false,
    remark: null,
    record: { lineId: '0', lineLabel: '默认', ttl: 600 },
  }

  it('rejects a zero threshold for every monitoring action because dnsmgr treats it as empty', () => {
    expect(MonitoringTaskMutationSchema.safeParse({ ...baseTask, action: 'conditional-enable', cycleCount: 0 }).success).toBe(false)
    expect(MonitoringTaskMutationSchema.safeParse({ ...baseTask, action: 'disable', cycleCount: 0 }).success).toBe(false)
  })
})

function html(value: string) {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const headers = { cookie: 'user_token=legacy-automation-session' }

describe('typed monitoring API', () => {
  it('parses overview, worker state and form metadata and only writes fixed settings', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/dmonitor/overview') {
        expect(new Headers(init.headers).get('x-requested-with')).toBeNull()
        return html(`<html><body>
          <span class="info-box-text">运行状态</span><span class="info-box-number"><font>正在运行</font></span>
          <span class="info-box-text">今日运行次数</span><span class="info-box-number">18</span>
          <span class="info-box-text">24H告警次数</span><span class="info-box-number">2</span>
          <span class="info-box-text">24H切换次数</span><span class="info-box-number">5</span>
          <li><b>上次运行时间：</b> 2026-08-31 13:00:00</li>
          <li><b>Swoole组件：</b> <font>已安装</font></li>
          <li><b>上次运行错误信息：</b> 网络超时 &amp; 已恢复</li>
          <select name="notice_mail" default="1"></select>
          <select name="notice_wxtpl" default="0"></select>
          <select name="notice_tgbot" default="1"></select>
          <select name="notice_webhook" default="0"></select>
          <select name="notice_custom_webhook" default="1"></select>
        </body></html>`)
      }
      if (url.pathname === '/internal/dmonitor/task/add') {
        return html(`<script>
          var info = null;
          var domainList = [{"id":42,"name":"example.com","type":"cloudflare"}];
          var support_ping = '1';
        </script>`)
      }
      if (url.pathname === '/internal/dmtask/status') return new Response('ok')
      if (url.pathname === '/internal/system/set') {
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          notice_mail: '1',
          notice_wxtpl: '0',
          notice_tgbot: '1',
          notice_webhook: '0',
          notice_custom_webhook: '1',
        })
        return json({ code: 0, msg: '设置保存成功' })
      }
      if (url.pathname === '/internal/dmonitor/clean') {
        expect(new URLSearchParams(String(init.body)).get('days')).toBe('30')
        return json({ code: 0, msg: '清理成功' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    const overview = await app.inject({ method: 'GET', url: '/api/web/v1/monitoring/overview', headers })
    const form = await app.inject({ method: 'GET', url: '/api/web/v1/monitoring/form', headers })
    const worker = await app.inject({ method: 'GET', url: '/api/web/v1/monitoring/worker-status', headers })
    const settings = await app.inject({
      method: 'PUT',
      url: '/api/web/v1/monitoring/notifications',
      headers,
      payload: { email: true, wechat: false, telegram: true, robotWebhook: false, customWebhook: true },
    })
    const clean = await app.inject({
      method: 'POST', url: '/api/web/v1/monitoring/logs/clean', headers, payload: { days: 30 },
    })

    expect(overview.json()).toEqual({
      code: 'OK',
      data: {
        workerRunning: true,
        runCountToday: 18,
        alertsLast24Hours: 2,
        switchesLast24Hours: 5,
        lastRunAt: '2026-08-31 13:00:00',
        lastError: '网络超时 & 已恢复',
        swooleInstalled: true,
        notifications: {
          email: true, wechat: false, telegram: true, robotWebhook: false, customWebhook: true,
        },
      },
    })
    expect(form.json()).toMatchObject({
      code: 'OK',
      data: {
        supportPing: true,
        domains: [{ id: 42, name: 'example.com', providerType: 'cloudflare' }],
        defaults: { action: 'disable', checkType: 'tcp', intervalSeconds: 5 },
      },
    })
    expect(worker.json()).toEqual({ code: 'OK', data: { running: true } })
    expect(settings.json()).toEqual({ code: 'OK', message: '设置保存成功' })
    expect(clean.json()).toEqual({ code: 'OK', message: '清理成功' })
  })

  it('normalizes tasks and logs and translates every monitoring task mutation', async () => {
    const mutationPaths: string[] = []
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/dmonitor/task/data') {
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          offset: '0', limit: '10', sortName: 'frequency', sortOrder: 'asc', type: '5', kw: 'edge', status: '1',
        })
        return json({ total: 1, rows: [{
          id: 7, did: 42, domain: 'example.com', rr: 'www', recordid: 'r1', type: 2,
          main_value: '192.0.2.1', backup_value: '192.0.2.2', checktype: 1, checkurl: '', tcpport: 443,
          frequency: 10, cycle: 3, timeout: 5, proxy: 0, cdn: 1, active: 1, status: 1,
          checktimestr: '2026-08-31 13:00:00', addtimestr: '2026-08-01 10:00:00', remark: 'edge',
          recordinfo: '{"Line":"0","LineName":"默认","TTL":600}',
        }] })
      }
      if (url.pathname === '/internal/dmonitor/task/edit' && init.method === 'GET') {
        return html(`<script>
          var info = {"id":7,"did":42,"rr":"www","recordid":"r1","type":2,"main_value":"192.0.2.1","backup_value":"192.0.2.2","checktype":1,"tcpport":443,"frequency":10,"cycle":3,"timeout":5,"proxy":0,"cdn":1,"active":1,"status":1,"recordinfo":"{\\"Line\\":\\"0\\",\\"LineName\\":\\"默认\\",\\"TTL\\":600}"};
          var domainList = [{"id":42,"name":"example.com","type":"cloudflare"}];
        </script>`)
      }
      if (url.pathname === '/internal/dmonitor/task/info/7') {
        return html('24H告警次数：<strong>3</strong> 切换次数：<strong>4</strong>')
      }
      if (url.pathname === '/internal/dmonitor/task/log/data/7') {
        return json({ total: 1, rows: [{ id: 9, action: 1, date: '2026-08-31 13:01:00', errmsg: 'TCP timeout' }] })
      }
      if (url.pathname.startsWith('/internal/dmonitor/task/')) {
        mutationPaths.push(url.pathname)
        const form = new URLSearchParams(String(init.body))
        if (url.pathname === '/internal/dmonitor/task/add') {
          expect(Object.fromEntries(form)).toEqual({
            did: '42', rr: 'www', recordid: 'r1', type: '2', main_value: '192.0.2.1',
            backup_value: '192.0.2.2', checktype: '1', checkurl: '', tcpport: '443', frequency: '10',
            cycle: '3', timeout: '5', proxy: '0', cdn: '1', remark: 'edge',
            recordinfo: '{"Type":"A","Line":"0","LineName":"默认","TTL":600}',
          })
        }
        if (url.pathname === '/internal/dmonitor/task/edit') expect(form.get('id')).toBe('7')
        if (url.pathname === '/internal/dmonitor/task/setactive') expect(Object.fromEntries(form)).toEqual({ id: '7', active: '0' })
        if (url.pathname === '/internal/dmonitor/task/del') expect(form.get('id')).toBe('7')
        if (url.pathname === '/internal/dmonitor/task/operation') {
          expect(form.getAll('ids[]')).toEqual(['7', '8'])
          expect(form.get('act')).toBe('retry')
        }
        return json({ code: 0, msg: '成功' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    const taskPayload = {
      domainId: 42,
      recordName: 'www',
      recordId: 'r1',
      action: 'failover',
      primaryValue: '192.0.2.1',
      backupValue: '192.0.2.2',
      checkType: 'tcp',
      checkUrl: null,
      tcpPort: 443,
      intervalSeconds: 10,
      cycleCount: 3,
      timeoutSeconds: 5,
      useProxy: false,
      enableCloudflareProxy: true,
      remark: 'edge',
      record: { type: 'A', lineId: '0', lineLabel: '默认', ttl: 600 },
    }
    const list = await app.inject({
      method: 'GET',
      url: '/api/web/v1/monitoring/tasks?pageSize=10&q=edge&searchBy=remark&health=failed&sort=intervalSeconds&order=asc',
      headers,
    })
    const detail = await app.inject({ method: 'GET', url: '/api/web/v1/monitoring/tasks/7', headers })
    const logs = await app.inject({
      method: 'GET', url: '/api/web/v1/monitoring/tasks/7/logs?pageSize=10&event=failure', headers,
    })
    const create = await app.inject({ method: 'POST', url: '/api/web/v1/monitoring/tasks', headers, payload: taskPayload })
    const update = await app.inject({ method: 'PUT', url: '/api/web/v1/monitoring/tasks/7', headers, payload: taskPayload })
    const status = await app.inject({
      method: 'PATCH', url: '/api/web/v1/monitoring/tasks/7/status', headers, payload: { enabled: false },
    })
    const batch = await app.inject({
      method: 'POST', url: '/api/web/v1/monitoring/tasks/batch', headers, payload: { ids: [7, 8], action: 'retry' },
    })
    const remove = await app.inject({ method: 'DELETE', url: '/api/web/v1/monitoring/tasks/7', headers })

    expect(list.json()).toMatchObject({
      code: 'OK',
      data: [{
        id: 7, domainId: 42, domain: 'example.com', action: 'failover', checkType: 'tcp',
        health: 'failed', enableCloudflareProxy: true,
        record: { lineId: '0', lineLabel: '默认', ttl: 600 },
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(detail.json()).toMatchObject({
      code: 'OK', data: { id: 7, domain: 'example.com', alertsLast24Hours: 3, switchesLast24Hours: 4 },
    })
    expect(logs.json()).toEqual({
      code: 'OK',
      data: [{ id: 9, event: 'failure', time: '2026-08-31 13:01:00', error: 'TCP timeout' }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    for (const response of [create, update, status, batch, remove]) {
      expect(response.json()).toEqual({ code: 'OK', message: '成功' })
    }
    expect(mutationPaths).toEqual([
      '/internal/dmonitor/task/add',
      '/internal/dmonitor/task/edit',
      '/internal/dmonitor/task/setactive',
      '/internal/dmonitor/task/operation',
      '/internal/dmonitor/task/del',
    ])
  })
})

describe('typed schedule API', () => {
  it('covers list, form, detail and all schedule mutations', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/schedule/stask/data') {
        return json({ total: 1, rows: [{
          id: 5, did: 42, domain: 'example.com', rr: 'www', recordid: 'r1', type: 1, cycle: 1,
          switchtype: 0, switchdate: '1', switchtime: '08:30', value: '192.0.2.9', line: '1', active: 1,
          nexttimestr: '2026-09-07 08:30:00', updatetimestr: '未运行', addtimestr: '2026-08-31 10:00:00',
          remark: 'weekly', recordinfo: '{"Value":["192.0.2.1","192.0.2.2"],"Line":"0","LineName":"默认","TTL":600}',
        }] })
      }
      if ((url.pathname === '/internal/schedule/stask/add' || url.pathname === '/internal/schedule/stask/edit') && init.method === 'GET') {
        const info = url.pathname.endsWith('/edit')
          ? '{"id":5,"did":42,"rr":"www","recordid":"r1","type":1,"cycle":1,"switchtype":0,"switchdate":"1","switchtime":"08:30","value":"192.0.2.9","line":"1","active":1,"recordinfo":"{\\"Value\\":[\\"192.0.2.1\\",\\"192.0.2.2\\"],\\"Line\\":\\"0\\",\\"LineName\\":\\"默认\\",\\"TTL\\":600}"}'
          : 'null'
        return html(`<script>var info = ${info}; var domainList = [{"id":42,"name":"example.com","type":"cloudflare"}];</script>`)
      }
      if (url.pathname.startsWith('/internal/schedule/stask/')) {
        const form = new URLSearchParams(String(init.body))
        if (url.pathname.endsWith('/add')) {
          expect(Object.fromEntries(form)).toEqual({
            did: '42', rr: 'www', recordid: 'r1', type: '1', cycle: '1', switchtype: '0',
            switchdate: '1', switchtime: '08:30', value: '192.0.2.9', line: '1', remark: 'weekly',
            recordinfo: '{"Type":"A","Value":["192.0.2.1","192.0.2.2"],"Line":"0","LineName":"默认","TTL":600}',
          })
        }
        if (url.pathname.endsWith('/edit')) expect(form.get('id')).toBe('5')
        if (url.pathname.endsWith('/setactive')) expect(form.get('active')).toBe('0')
        if (url.pathname.endsWith('/operation')) {
          expect(form.getAll('ids[]')).toEqual(['5', '6'])
          expect(form.get('act')).toBe('open')
        }
        if (url.pathname.endsWith('/del')) expect(form.get('id')).toBe('5')
        return json({ code: 0, msg: '成功' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    const payload = {
      domainId: 42,
      recordName: 'www',
      recordId: 'r1',
      execution: 'recurring',
      cycle: 'weekly',
      action: 'update',
      switchDate: '1',
      switchTime: '08:30',
      value: '192.0.2.9',
      lineMode: 'proxied',
      remark: 'weekly',
      record: {
        type: 'A',
        value: '192.0.2.1,192.0.2.2', values: ['192.0.2.1', '192.0.2.2'],
        lineId: '0', lineLabel: '默认', ttl: 600,
      },
    }
    const form = await app.inject({ method: 'GET', url: '/api/web/v1/schedules/form', headers })
    const list = await app.inject({ method: 'GET', url: '/api/web/v1/schedules?pageSize=10&execution=recurring', headers })
    const detail = await app.inject({ method: 'GET', url: '/api/web/v1/schedules/5', headers })
    const create = await app.inject({ method: 'POST', url: '/api/web/v1/schedules', headers, payload })
    const update = await app.inject({ method: 'PUT', url: '/api/web/v1/schedules/5', headers, payload })
    const status = await app.inject({ method: 'PATCH', url: '/api/web/v1/schedules/5/status', headers, payload: { enabled: false } })
    const batch = await app.inject({ method: 'POST', url: '/api/web/v1/schedules/batch', headers, payload: { ids: [5, 6], action: 'enable' } })
    const remove = await app.inject({ method: 'DELETE', url: '/api/web/v1/schedules/5', headers })

    expect(form.json()).toMatchObject({ code: 'OK', data: { domains: [{ id: 42, name: 'example.com' }] } })
    expect(list.json()).toMatchObject({
      code: 'OK', data: [{
        id: 5, execution: 'recurring', cycle: 'weekly', action: 'update', lineMode: 'proxied',
        record: { value: '192.0.2.1,192.0.2.2', values: ['192.0.2.1', '192.0.2.2'] },
      }],
    })
    expect(detail.json()).toMatchObject({ code: 'OK', data: { id: 5, domain: 'example.com' } })
    for (const response of [create, update, status, batch, remove]) {
      expect(response.json()).toEqual({ code: 'OK', message: '成功' })
    }
  })
})

describe('typed optimize IP API', () => {
  it('covers settings, account query, worker state, task reads and all mutations', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/optimizeip/opipset' && init.method === 'GET') {
        return html(`<select name="optimize_ip_api" default="2"></select>
          <input name="optimize_ip_key" value="key&amp;value">
          <input name="optimize_ip_proxy" value="https://proxy.example/">
          <input name="optimize_ip_min" value="30">`)
      }
      if (url.pathname === '/internal/optimizeip/opipform/add' && init.method === 'GET') {
        return html(`<select name="did"><option value="">--主域名--</option><option value="42">example.com</option></select>
          <script>var info = null; new Vue({data:{optimize_ip_api: '2'}})</script>`)
      }
      if (url.pathname === '/internal/optimizeip/opipform/edit' && init.method === 'GET') {
        return html(`<select name="did"><option value="42">example.com</option></select><script>
          var info = {"id":8,"did":42,"rr":"edge","type":0,"ip_type":"v4,v6","cdn_type":4,"recordnum":2,"ttl":600,"active":1,"status":2,"errmsg":"API timeout","updatetime":"2026-08-31 14:00:00","remark":"edge"};
        </script>`)
      }
      if (url.pathname === '/internal/optimizeip/status') return new Response('error')
      if (url.pathname === '/internal/optimizeip/opiplist/data') {
        return json({ total: 1, rows: [{
          id: 8, did: 42, domain: 'example.com', rr: 'edge', type: 0, ip_type: 'v4,v6', cdn_type: 4,
          recordnum: 2, ttl: 600, active: 1, status: 2, errmsg: 'API timeout',
          updatetime: '2026-08-31 14:00:00', addtime: '2026-08-01 10:00:00', remark: 'edge',
        }] })
      }
      if (url.pathname === '/internal/optimizeip/opipset') {
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          optimize_ip_api: '0', optimize_ip_key: 'new-key', optimize_ip_proxy: '', optimize_ip_min: '60',
        })
        return json({ code: 0, msg: 'succ' })
      }
      if (url.pathname === '/internal/optimizeip/queryapi') {
        expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
          optimize_ip_api: '1', optimize_ip_key: 'balance-key',
        })
        return json({ code: 0, msg: '当前积分余额：100' })
      }
      if (url.pathname.startsWith('/internal/optimizeip/opipform/')) {
        const form = new URLSearchParams(String(init.body))
        if (url.pathname.endsWith('/add')) {
          expect(Object.fromEntries(form)).toEqual({
            did: '42', rr: 'edge', type: '0', ip_type: 'v4,v6', cdn_type: '4', recordnum: '2', ttl: '600', remark: 'edge',
          })
        }
        if (url.pathname.endsWith('/edit')) expect(form.get('id')).toBe('8')
        if (url.pathname.endsWith('/setactive')) expect(form.get('active')).toBe('0')
        if (url.pathname.endsWith('/del') || url.pathname.endsWith('/run')) expect(form.get('id')).toBe('8')
        return json({ code: 0, msg: '成功' })
      }
      throw new Error(`unexpected request: ${url.pathname}`)
    })

    const taskPayload = {
      domainId: 42,
      recordName: 'edge',
      lineStrategy: 'carrier-lines',
      ipVersions: ['v4', 'v6'],
      cdnProvider: 'edgeone',
      recordCount: 2,
      ttl: 600,
      remark: 'edge',
    }
    const settings = await app.inject({ method: 'GET', url: '/api/web/v1/optimize-ip/settings', headers })
    const form = await app.inject({ method: 'GET', url: '/api/web/v1/optimize-ip/form', headers })
    const worker = await app.inject({ method: 'GET', url: '/api/web/v1/optimize-ip/worker-status', headers })
    const list = await app.inject({ method: 'GET', url: '/api/web/v1/optimize-ip/tasks?pageSize=10&status=failed', headers })
    const detail = await app.inject({ method: 'GET', url: '/api/web/v1/optimize-ip/tasks/8', headers })
    const updateSettings = await app.inject({
      method: 'PUT',
      url: '/api/web/v1/optimize-ip/settings',
      headers,
      payload: { dataSource: 'wetest', apiKey: 'new-key', proxyUrl: '', intervalMinutes: 60 },
    })
    const balance = await app.inject({
      method: 'POST',
      url: '/api/web/v1/optimize-ip/account-balance',
      headers,
      payload: { dataSource: 'hostmonit', apiKey: 'balance-key' },
    })
    const create = await app.inject({ method: 'POST', url: '/api/web/v1/optimize-ip/tasks', headers, payload: taskPayload })
    const update = await app.inject({ method: 'PUT', url: '/api/web/v1/optimize-ip/tasks/8', headers, payload: taskPayload })
    const status = await app.inject({ method: 'PATCH', url: '/api/web/v1/optimize-ip/tasks/8/status', headers, payload: { enabled: false } })
    const run = await app.inject({ method: 'POST', url: '/api/web/v1/optimize-ip/tasks/8/run', headers })
    const remove = await app.inject({ method: 'DELETE', url: '/api/web/v1/optimize-ip/tasks/8', headers })

    expect(settings.json()).toEqual({
      code: 'OK',
      data: { dataSource: 'xingpingcn', apiKey: 'key&value', proxyUrl: 'https://proxy.example/', intervalMinutes: 30 },
    })
    expect(form.json()).toMatchObject({
      code: 'OK', data: { dataSource: 'xingpingcn', domains: [{ id: 42, name: 'example.com' }], excludedProviderTypes: ['cloudflare'] },
    })
    expect(worker.json()).toEqual({ code: 'OK', data: { running: false } })
    expect(list.json()).toMatchObject({
      code: 'OK', data: [{ id: 8, cdnProvider: 'edgeone', ipVersions: ['v4', 'v6'], status: 'failed' }],
    })
    expect(detail.json()).toMatchObject({ code: 'OK', data: { id: 8, domain: 'example.com', lastError: 'API timeout' } })
    expect(updateSettings.json()).toEqual({ code: 'OK', message: 'succ' })
    expect(balance.json()).toEqual({ code: 'OK', message: '当前积分余额：100' })
    for (const response of [create, update, status, run, remove]) {
      expect(response.json()).toEqual({ code: 'OK', message: '成功' })
    }
  })
})

describe('automation validation boundaries', () => {
  it('rejects invalid cross-field combinations before contacting dnsmgr', async () => {
    const fetcher = vi.fn() as unknown as FetchLike
    const app = await buildApp({ config: testConfig(), fetcher, logger: false })
    apps.push(app)

    const monitoring = await app.inject({
      method: 'POST',
      url: '/api/web/v1/monitoring/tasks',
      headers,
      payload: {
        domainId: 42,
        recordName: 'www',
        recordId: 'r1',
        action: 'failover',
        primaryValue: '192.0.2.1',
        backupValue: '192.0.2.1',
        checkType: 'tcp',
        tcpPort: 443,
        intervalSeconds: 5,
        cycleCount: 3,
        timeoutSeconds: 10,
        record: { lineId: '0', ttl: 600 },
      },
    })
    const schedule = await app.inject({
      method: 'POST',
      url: '/api/web/v1/schedules',
      headers,
      payload: {
        domainId: 42,
        recordName: 'www',
        recordId: 'r1',
        execution: 'recurring',
        cycle: 'daily',
        action: 'delete',
        switchTime: '08:30',
        record: { lineId: '0', ttl: 600 },
      },
    })
    const optimize = await app.inject({
      method: 'POST',
      url: '/api/web/v1/optimize-ip/tasks',
      headers,
      payload: {
        domainId: 42,
        recordName: 'edge',
        lineStrategy: 'carrier-lines',
        ipVersions: ['v4', 'v4'],
        cdnProvider: 'cloudflare',
        recordCount: 2,
        ttl: 600,
      },
    })

    for (const response of [monitoring, schedule, optimize]) {
      expect(response.statusCode).toBe(422)
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})
