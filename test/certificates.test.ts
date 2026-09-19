import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { resolveDcvTargetRecordName } from '../src/adapters/v1051/certificate-cnames.js'
import {
  CertificateAutomationConfigKeys,
  CertificateSettingsMutationSchema,
  getCertificateAutomationSettings,
} from '../src/adapters/v1051/certificate-settings.js'
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

function html(value: string) {
  return new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function form(init: RequestInit) {
  return new URLSearchParams(String(init.body))
}

const headers = { cookie: 'user_token=legacy-certificate-session' }

describe('typed certificate API', () => {
  it('keeps helper setting keys within the dnsmgr config table limit', () => {
    expect(Object.values(CertificateAutomationConfigKeys).every((key) => key.length <= 32)).toBe(true)
  })

  it('rejects duplicate template names and missing defaults', () => {
    const template = {
      id: 'one',
      name: '重复名称',
      pemCertificatePathTemplate: '/srv/{domain}/cert.pem',
      pemPrivateKeyPathTemplate: '/srv/{domain}/key.pem',
      pfxPathTemplate: '/srv/{domain}/cert.pfx',
      commandTemplate: '',
    }
    const result = CertificateSettingsMutationSchema.safeParse({
      localDeployment: {
        defaultMode: 'quick',
        defaultTemplateId: 'missing',
        templates: [template, { ...template, id: 'two' }],
      },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        '模板名称不能重复',
        '默认模板必须存在',
      ]))
    }
  })

  it('loads helper certificate policies and enforces DCV domain and record templates', async () => {
    const settings = await getCertificateAutomationSettings({
      getConfigValues: async () => ({
        helper_cert_local_mode: 'custom',
        helper_cert_local_pem_cert: '/srv/{domain}/cert.pem',
        helper_cert_dcv_domains: '["example.com"]',
        helper_cert_dcv_match_mode: 'suffix',
        helper_cert_dcv_target_name: '_acme-{domainWithDashes}',
        helper_cert_dcv_force_target: '1',
      }),
    })
    expect(settings.localDeployment).toMatchObject({
      defaultMode: 'custom',
      defaultTemplateId: 'default',
      templates: [{
        id: 'default',
        name: '默认模板',
        pemCertificatePathTemplate: '/srv/{domain}/cert.pem',
      }],
    })
    expect(resolveDcvTargetRecordName(
      'www.example.com',
      'ignored',
      settings.dcvDelegation,
    )).toBe('_acme-www-example-com')
    expect(() => resolveDcvTargetRecordName(
      'outside.example.net',
      'requested',
      settings.dcvDelegation,
    )).toThrow('不在允许托管的域名范围内')
  })

  it('loads multiple certificate templates and applies the selected DCV policy', async () => {
    const localTemplates = [{
      id: 'edge',
      name: '边缘节点',
      pemCertificatePathTemplate: '/edge/{domain}/cert.pem',
      pemPrivateKeyPathTemplate: '/edge/{domain}/key.pem',
      pfxPathTemplate: '/edge/{domain}/cert.pfx',
      commandTemplate: 'reload edge',
    }, {
      id: 'origin',
      name: '源站',
      pemCertificatePathTemplate: '/origin/{domain}/cert.pem',
      pemPrivateKeyPathTemplate: '/origin/{domain}/key.pem',
      pfxPathTemplate: '/origin/{domain}/cert.pfx',
      commandTemplate: 'reload origin',
    }]
    const dcvTemplates = [{
      id: 'public',
      name: '公网托管',
      allowedDomains: ['example.com'],
      domainMatchMode: 'suffix' as const,
      targetRecordNameTemplate: '{domainWithDashes}.public',
      forceTargetRecordNameTemplate: true,
    }, {
      id: 'internal',
      name: '内网托管',
      allowedDomains: ['internal.example'],
      domainMatchMode: 'exact' as const,
      targetRecordNameTemplate: '{domain}.internal',
      forceTargetRecordNameTemplate: true,
    }]
    const settings = await getCertificateAutomationSettings({
      getConfigValues: async () => ({
        helper_cert_local_mode: 'quick',
        helper_cert_local_default: 'origin',
        helper_cert_local_templates: JSON.stringify(localTemplates),
        helper_cert_dcv_default: 'public',
        helper_cert_dcv_templates: JSON.stringify(dcvTemplates),
      }),
    })

    expect(settings.localDeployment).toEqual({
      defaultMode: 'quick',
      defaultTemplateId: 'origin',
      templates: localTemplates,
    })
    expect(resolveDcvTargetRecordName(
      'internal.example',
      'ignored',
      settings.dcvDelegation,
      'internal',
    )).toBe('internal.example.internal')
    expect(() => resolveDcvTargetRecordName(
      'www.internal.example',
      'ignored',
      settings.dcvDelegation,
      'internal',
    )).toThrow('不在允许托管的域名范围内')
    expect(() => resolveDcvTargetRecordName(
      'example.com',
      'ignored',
      settings.dcvDelegation,
      'missing',
    )).toThrow('所选 DCV 托管策略不存在')
  })

  it('discovers the AxisNow deployment account definition and its numeric options', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/cert/account/add' && init.method === 'GET') {
        expect(url.searchParams.get('deploy')).toBe('1')
        return html(`<script>
          var info = null;
          var typeList = {
            "axisnow": {
              "name":"AxisNow", "class":2, "icon":"axisnow.png",
              "desc":"支持上传证书到AxisNow平台", "note":"支持上传证书到AxisNow平台",
              "inputs": {
                "name":{"name":"租户名","type":"input","required":true},
                "token":{"name":"API 令牌","type":"input","required":true},
                "proxy":{"name":"使用代理服务器","type":"radio","options":["否","是"],"value":"0"}
              },
              "taskinputs": []
            }
          };
          var classList = {"1":"自建系统","2":"云服务商","3":"服务器"};
        </script>`)
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const response = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-account-types?kind=deployment', headers,
    })

    expect(response.json()).toEqual({
      code: 'OK',
      data: [{
        type: 'axisnow', kind: 'deployment', label: 'AxisNow',
        category: { id: '2', label: '云服务商' }, icon: 'axisnow.png',
        description: '支持上传证书到AxisNow平台', note: '支持上传证书到AxisNow平台',
        fields: [
          { key: 'name', label: '租户名', control: 'input', required: true, disabled: false, sensitive: false },
          { key: 'token', label: 'API 令牌', control: 'input', required: true, disabled: false, sensitive: true },
          {
            key: 'proxy', label: '使用代理服务器', control: 'radio', required: false,
            disabled: false, sensitive: false, defaultValue: '0',
            options: [{ value: '0', label: '否' }, { value: '1', label: '是' }],
          },
        ],
        taskFields: [],
      }],
    })
  })

  it('normalizes account definitions without exposing list credentials and translates all account mutations', async () => {
    const typeState = `<script>
      var info = null;
      var typeList = {
        "acme": {
          "name":"ACME &amp; DNS", "class":"free", "icon":"acme.svg", "wildcard":true,
          "max_domains":100, "cname":1,
          "inputs": {
            "environment":{"name":"环境","type":"select","required":true,"options":{"prod":"生产","test":"测试"},"value":"prod"},
            "api_token":{"name":"API 密钥","type":"input","required":true,"show":"environment=='prod' && mode!='dns'"}
          }
        }
      };
      var classList = {"free":"免费证书"};
    </script>`
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/cert/account/add' && init.method === 'GET') return html(typeState)
      if (url.pathname === '/internal/cert/account/edit' && init.method === 'GET') {
        expect(url.searchParams.get('deploy')).toBe('0')
        expect(url.searchParams.get('id')).toBe('7')
        return html(typeState.replace(
          'var info = null;',
          'var info = {"id":7,"type":"acme","name":"主账户","remark":"production","addtime":"2026-08-01 10:00:00","config":"{\\"api_token\\":\\"secret\\",\\"environment\\":\\"prod\\"}"};',
        ))
      }
      if (url.pathname === '/internal/cert/account/data') {
        expect(url.searchParams.get('deploy')).toBe('0')
        expect(Object.fromEntries(form(init))).toEqual({
          offset: '0', limit: '10', sortName: 'name', sortOrder: 'asc', kw: '主',
        })
        return json({ total: 1, rows: [{
          id: 7, type: 'acme', typename: 'ACME &amp; DNS', icon: 'acme.svg', name: '主账户',
          remark: 'production', addtime: '2026-08-01 10:00:00', config: '{"api_token":"must-not-leak"}',
          ext: '{"credential":"must-not-leak"}',
        }] })
      }
      if (url.pathname === '/internal/cert/account/add') {
        expect(Object.fromEntries(form(init))).toEqual({
          deploy: '0', type: 'acme', name: '主账户',
          config: '{"api_token":"secret","environment":"prod"}', remark: 'production',
        })
        return json({ code: 0, msg: '添加成功' })
      }
      if (url.pathname === '/internal/cert/account/edit') {
        expect(form(init).get('id')).toBe('7')
        expect(form(init).get('deploy')).toBe('0')
        return json({ code: 0, msg: '修改成功' })
      }
      if (url.pathname === '/internal/cert/account/del') {
        expect(Object.fromEntries(form(init))).toEqual({ id: '7', deploy: '0' })
        return json({ code: 0 })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const types = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-account-types?kind=issuance', headers,
    })
    const list = await app.inject({
      method: 'GET',
      url: '/api/web/v1/certificate-accounts?kind=issuance&pageSize=10&q=%E4%B8%BB&sort=name&order=asc',
      headers,
    })
    const detail = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-accounts/7?kind=issuance', headers,
    })
    const payload = {
      kind: 'issuance', type: 'acme', name: '主账户',
      config: { api_token: 'secret', environment: 'prod' }, remark: 'production',
    }
    const create = await app.inject({ method: 'POST', url: '/api/web/v1/certificate-accounts', headers, payload })
    const update = await app.inject({ method: 'PUT', url: '/api/web/v1/certificate-accounts/7', headers, payload })
    const remove = await app.inject({
      method: 'DELETE', url: '/api/web/v1/certificate-accounts/7?kind=issuance', headers,
    })

    expect(types.json()).toMatchObject({
      code: 'OK',
      data: [{
        type: 'acme', kind: 'issuance', label: 'ACME & DNS',
        category: { id: 'free', label: '免费证书' },
        capabilities: { wildcard: true, maxDomains: 100, cnameDelegation: true },
        fields: [
          { key: 'environment', control: 'select', defaultValue: 'prod', sensitive: false },
          {
            key: 'api_token', sensitive: true,
            visibleWhen: { any: [{ all: [
              { field: 'environment', operator: 'equals', value: 'prod' },
              { field: 'mode', operator: 'not-equals', value: 'dns' },
            ] }] },
          },
        ],
      }],
    })
    expect(list.json()).toEqual({
      code: 'OK',
      data: [{
        id: 7, kind: 'issuance', type: 'acme', typeLabel: 'ACME & DNS', icon: 'acme.svg',
        name: '主账户', remark: 'production', addedAt: '2026-08-01 10:00:00',
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(detail.json()).toMatchObject({
      code: 'OK', data: { id: 7, config: { api_token: 'secret', environment: 'prod' } },
    })
    expect(create.json()).toEqual({ code: 'OK', message: '添加成功' })
    expect(update.json()).toEqual({ code: 'OK', message: '修改成功' })
    expect(remove.json()).toEqual({ code: 'OK' })
  })

  it('covers certificate order forms, secrets, lifecycle actions, batches and safe process logs', async () => {
    const actionPaths: string[] = []
    const orderRow = {
      id: 9, aid: 0, keytype: 'RSA', keysize: 2048, issuer: 'Example CA', isauto: 1,
      status: -3, islock: 1, processid: '0123456789abcdef0123456789abcdef',
      domains: ['example.com', '*.example.com'], issuetime: '2026-08-01 00:00:00',
      expiretime: '2026-11-01 00:00:00', end_day: 62, error: 'DNS &lt;timeout&gt;',
    }
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/cert/order/add' && init.method === 'GET') {
        return html(`<select name="aid"><option value="">请选择</option><option value="3" data-type="acme">3_ACME</option></select>`)
      }
      if (url.pathname === '/internal/cert/order/edit' && init.method === 'GET') {
        return html(`<script>var info = {"id":9,"aid":0,"fullchain":"-----BEGIN CERTIFICATE-----\\nCRT","privatekey":"-----BEGIN PRIVATE KEY-----\\nKEY"};</script>`)
      }
      if (url.pathname === '/internal/cert/order/data') {
        const values = form(init)
        if (!values.has('id')) {
          expect(Object.fromEntries(values)).toEqual({
            offset: '0', limit: '10', sortName: 'status', sortOrder: 'asc', domain: 'example.com', status: '5',
          })
        }
        return json({ total: 1, rows: [orderRow] })
      }
      if (url.pathname === '/internal/cert/order/get') {
        expect(form(init).get('id')).toBe('9')
        return json({ code: 0, data: {
          fullchain: 'CERTIFICATE', privatekey: 'PRIVATE KEY', pfx: 'UEZY',
        } })
      }
      if (url.pathname === '/internal/cert/order/show_log') {
        expect(form(init).get('processid')).toBe('0123456789abcdef0123456789abcdef')
        return json({ code: 0, data: 'processing\ndone', time: 1788118000 })
      }
      if (url.pathname.startsWith('/internal/cert/order/')) {
        actionPaths.push(url.pathname)
        const values = form(init)
        if (url.pathname.endsWith('/add')) {
          expect(values.get('aid')).toBe('3')
          expect(values.getAll('domains[]')).toEqual(['example.com', '*.example.com'])
        }
        if (url.pathname.endsWith('/edit')) {
          expect(Object.fromEntries(values)).toEqual({
            id: '9', aid: '-1', fullchain: 'CERTIFICATE', privatekey: 'PRIVATE KEY',
          })
        }
        if (url.pathname.endsWith('/setauto')) expect(values.get('isauto')).toBe('0')
        if (url.pathname.endsWith('/operation')) {
          expect(values.getAll('ids[]')).toEqual(['9', '10'])
          expect(values.get('act')).toBe('open')
        }
        if (url.pathname.endsWith('/process')) expect(values.get('reset')).toBe('1')
        return json({ code: 0, msg: '操作成功' })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const list = await app.inject({
      method: 'GET',
      url: '/api/web/v1/certificate-orders?pageSize=10&domain=example.com&status=failed&sort=status&order=asc',
      headers,
    })
    const formResponse = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-orders/form', headers })
    const detail = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-orders/9', headers })
    const artifacts = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-orders/9/artifacts', headers,
    })
    const log = await app.inject({
      method: 'GET',
      url: '/api/web/v1/certificate-orders/9/log?processId=0123456789abcdef0123456789abcdef',
      headers,
    })
    const invalidLog = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-orders/9/log?processId=..%2F..%2Fsecret', headers,
    })
    const managed = {
      mode: 'managed', accountId: 3, keyType: 'RSA', keySize: 2048,
      domains: ['example.com', '*.example.com'],
    }
    const manual = { mode: 'manual', certificate: 'CERTIFICATE', privateKey: 'PRIVATE KEY' }
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-orders', headers, payload: managed }),
      app.inject({ method: 'PUT', url: '/api/web/v1/certificate-orders/9', headers, payload: manual }),
      app.inject({ method: 'DELETE', url: '/api/web/v1/certificate-orders/9', headers }),
      app.inject({ method: 'PATCH', url: '/api/web/v1/certificate-orders/9/auto-renew', headers, payload: { enabled: false } }),
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-orders/9/reset', headers }),
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-orders/9/revoke', headers }),
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-orders/9/process', headers, payload: { reset: true } }),
      app.inject({
        method: 'POST', url: '/api/web/v1/certificate-orders/batch', headers,
        payload: { ids: [9, 10], action: 'enable' },
      }),
    ])

    expect(list.json()).toMatchObject({
      code: 'OK',
      data: [{
        id: 9, mode: 'manual', domains: ['example.com', '*.example.com'], status: 'failed',
        failureStage: 'add-dns', processing: true, error: 'DNS <timeout>',
      }],
      meta: { page: 1, pageSize: 10, total: 1 },
    })
    expect(formResponse.json()).toEqual({
      code: 'OK',
      data: {
        accounts: [{ id: 3, type: 'acme', label: '3_ACME' }],
        keyOptions: { RSA: [2048, 3072], ECC: [256, 384] },
        defaults: { mode: 'managed', keyType: 'RSA', keySize: 2048 },
      },
    })
    expect(detail.json()).toMatchObject({
      code: 'OK', data: { id: 9, certificate: '-----BEGIN CERTIFICATE-----\nCRT', privateKey: '-----BEGIN PRIVATE KEY-----\nKEY' },
    })
    expect(artifacts.json()).toEqual({
      code: 'OK',
      data: {
        id: 9, domains: ['example.com', '*.example.com'], certificate: 'CERTIFICATE', privateKey: 'PRIVATE KEY',
        pfxBase64: 'UEZY', pfxPassword: '123456',
        issuedAt: '2026-08-01 00:00:00', expiresAt: '2026-11-01 00:00:00',
      },
    })
    expect(log.json()).toEqual({ code: 'OK', data: { content: 'processing\ndone', modifiedAt: 1788118000 } })
    expect(invalidLog.statusCode).toBe(422)
    responses.forEach((response) => expect(response.json()).toEqual({ code: 'OK', message: '操作成功' }))
    expect(actionPaths).toEqual(expect.arrayContaining([
      '/internal/cert/order/add', '/internal/cert/order/edit', '/internal/cert/order/del',
      '/internal/cert/order/setauto', '/internal/cert/order/reset', '/internal/cert/order/revoke',
      '/internal/cert/order/process', '/internal/cert/order/operation',
    ]))
  })

  it('covers deployments, CNAME delegation and the fixed certificate settings whitelist', async () => {
    const deploymentActions: string[] = []
    const cnameActions: string[] = []
    const localTemplates = [{
      id: 'local-default',
      name: '本机默认',
      pemCertificatePathTemplate: '/srv/certs/{domain}/fullchain.pem',
      pemPrivateKeyPathTemplate: '/srv/certs/{domain}/privkey.pem',
      pfxPathTemplate: '/srv/certs/{domain}/certificate.pfx',
      commandTemplate: 'nginx -s reload',
    }, {
      id: 'local-backup',
      name: '本机备用',
      pemCertificatePathTemplate: '/backup/{domain}/fullchain.pem',
      pemPrivateKeyPathTemplate: '/backup/{domain}/privkey.pem',
      pfxPathTemplate: '/backup/{domain}/certificate.pfx',
      commandTemplate: '',
    }]
    const dcvTemplates = [{
      id: 'dcv-default',
      name: '默认托管',
      allowedDomains: ['example.com'],
      domainMatchMode: 'suffix' as const,
      targetRecordNameTemplate: '{domainWithDashes}.cname',
      forceTargetRecordNameTemplate: true,
    }]
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/cert/deploy/add' && init.method === 'GET') {
        return html(`<select name="aid"><option value="">请选择</option><option value="4" data-type="nginx">4_Nginx</option></select>
          <select name="oid"><option value="9">9_example.com（ACME）</option></select>
          <script>var info=null; var typeList={"nginx":{"name":"Nginx","taskinputs":{"path":{"name":"证书路径","type":"input","required":true},"pem_key_file":{"name":"私钥保存路径","type":"input","required":true}},"tasknote":"重新加载服务"}};</script>`)
      }
      if (url.pathname === '/internal/cert/deploy/edit' && init.method === 'GET') {
        return html(`<script>var info={"id":11,"aid":4,"oid":9,"type":"nginx","config":"{\\"path\\":\\"/etc/nginx/cert.pem\\"}","remark":"edge"};</script>`)
      }
      if (url.pathname === '/internal/cert/deploy/data') {
        expect(Object.fromEntries(form(init))).toEqual({
          offset: '0', limit: '10', sortName: 'lasttime', sortOrder: 'asc',
          domain: 'example.com', aid: '4', status: '-1', remark: 'edge',
        })
        return json({ total: 1, rows: [{
          id: 11, aid: 4, oid: 9, type: 'nginx', typename: 'Nginx', aname: '边缘节点', aremark: 'hk',
          certtype: 'acme', certtypename: 'ACME', domains: ['example.com'], active: 1,
          status: -1, islock: 0, processid: 'fedcba9876543210fedcba9876543210',
          lasttime: '2026-08-31 12:00:00', addtime: '2026-08-01 00:00:00', error: 'reload failed', remark: 'edge',
        }] })
      }
      if (url.pathname === '/internal/cert/deploy/show_log') {
        expect(form(init).get('processid')).toBe('fedcba9876543210fedcba9876543210')
        return json({ code: 0, data: 'deploy complete', time: 1788119000 })
      }
      if (url.pathname.startsWith('/internal/cert/deploy/')) {
        deploymentActions.push(url.pathname)
        const values = form(init)
        if (url.pathname.endsWith('/add')) {
          expect(Object.fromEntries(values)).toEqual({
            aid: '4', oid: '9', config: '{"path":"/etc/nginx/cert.pem"}', remark: 'edge',
          })
        }
        if (url.pathname.endsWith('/operation')) {
          expect(values.getAll('ids[]')).toEqual(['11', '12'])
          expect(values.get('act')).toBe('cert')
          expect(values.get('certid')).toBe('10')
        }
        if (url.pathname.endsWith('/setactive')) expect(values.get('active')).toBe('0')
        if (url.pathname.endsWith('/process')) expect(['0', '1']).toContain(values.get('reset'))
        return json({ code: 0, msg: '部署操作成功' })
      }
      if (url.pathname === '/internal/cert/cname' && init.method === 'GET') {
        return html('<select name="did"><option value="42">target.example</option></select>')
      }
      if (url.pathname === '/internal/cert/cname/data') {
        expect(Object.fromEntries(form(init))).toEqual({
          offset: '0', limit: '10', sortName: 'domain', sortOrder: 'asc', kw: 'external',
        })
        return json({ total: 1, rows: [{
          id: 13, domain: 'external.example', host: '_acme-challenge', did: 42,
          cnamedomain: 'target.example', rr: '_acme-proxy', record: '_acme-proxy.target.example',
          status: 1, addtime: '2026-08-31 00:00:00',
        }] })
      }
      if (url.pathname.startsWith('/internal/cert/cname/')) {
        cnameActions.push(url.pathname)
        if (url.pathname.endsWith('/check')) return json({ code: 0, status: 1 })
        return json({ code: 0, msg: 'CNAME 操作成功' })
      }
      if (url.pathname === '/internal/cert/certset' && init.method === 'GET') {
        return html(`<input name="cert_renewdays" value="14">
          <select name="deploy_hour_start" default="1"></select><select name="deploy_hour_end" default="22"></select>
          <select name="cert_notice_mail" default="1"></select><select name="cert_notice_wxtpl" default="0"></select>
          <select name="cert_notice_tgbot" default="2"></select><select name="cert_notice_webhook" default="1"></select>
          <select name="cert_notice_custom_webhook" default="0"></select>`)
      }
      if (url.pathname === '/internal/system/set') {
        const values = Object.fromEntries(form(init))
        expect(values).toMatchObject({
          cert_renewdays: '30', cert_notice_mail: '2', cert_notice_custom_webhook: '1',
          helper_cert_local_mode: 'quick',
          helper_cert_local_default: 'local-default',
          helper_cert_dcv_default: 'dcv-default',
        })
        expect(JSON.parse(values.helper_cert_local_templates!)).toEqual(localTemplates)
        expect(JSON.parse(values.helper_cert_dcv_templates!)).toEqual(dcvTemplates)
        return json({ code: 0, msg: '设置保存成功' })
      }
      throw new Error(`unexpected request: ${init.method} ${url.pathname}`)
    })

    const deploymentList = await app.inject({
      method: 'GET',
      url: '/api/web/v1/certificate-deployments?pageSize=10&domain=example.com&accountId=4&status=failed&remark=edge&sort=lastRunAt&order=asc',
      headers,
    })
    const deploymentForm = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-deployments/form', headers,
    })
    const deploymentDetail = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-deployments/11', headers,
    })
    const deploymentLog = await app.inject({
      method: 'GET',
      url: '/api/web/v1/certificate-deployments/11/log?processId=fedcba9876543210fedcba9876543210',
      headers,
    })
    const deploymentPayload = {
      accountId: 4, orderId: 9, config: { path: '/etc/nginx/cert.pem' }, remark: 'edge',
    }
    const deploymentResponses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-deployments', headers, payload: deploymentPayload }),
      app.inject({ method: 'PUT', url: '/api/web/v1/certificate-deployments/11', headers, payload: deploymentPayload }),
      app.inject({ method: 'DELETE', url: '/api/web/v1/certificate-deployments/11', headers }),
      app.inject({ method: 'PATCH', url: '/api/web/v1/certificate-deployments/11/status', headers, payload: { enabled: false } }),
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-deployments/11/reset', headers }),
      app.inject({ method: 'POST', url: '/api/web/v1/certificate-deployments/11/process', headers, payload: { reset: true } }),
      app.inject({
        method: 'POST', url: '/api/web/v1/certificate-deployments/batch', headers,
        payload: { ids: [11, 12], action: 'assign-certificate', orderId: 10 },
      }),
    ])
    const batchProcess = await app.inject({
      method: 'POST', url: '/api/web/v1/certificate-deployments/batch', headers,
      payload: { ids: [11, 12], action: 'process' },
    })

    expect(deploymentList.json()).toMatchObject({
      code: 'OK',
      data: [{
        id: 11, account: { id: 4, type: 'nginx', label: 'Nginx', name: '边缘节点' },
        order: { id: 9, sourceType: 'acme', sourceLabel: 'ACME', domains: ['example.com'] },
        active: true, status: 'failed', error: 'reload failed', remark: 'edge',
      }],
    })
    expect(deploymentForm.json()).toMatchObject({
      code: 'OK',
      data: {
        accounts: [{ id: 4, type: 'nginx', label: '4_Nginx' }],
        orders: [{ id: 9, label: '9_example.com（ACME）', domain: 'example.com' }],
        accountTypes: [{
          type: 'nginx',
          taskFields: [
            { key: 'path', required: true },
            { key: 'pem_key_file', required: true, sensitive: false },
          ],
          taskNote: '重新加载服务',
        }],
      },
    })
    expect(deploymentDetail.json()).toEqual({
      code: 'OK', data: {
        id: 11, accountId: 4, accountType: 'nginx', orderId: 9,
        config: { path: '/etc/nginx/cert.pem' }, remark: 'edge',
      },
    })
    expect(deploymentLog.json()).toEqual({ code: 'OK', data: { content: 'deploy complete', modifiedAt: 1788119000 } })
    deploymentResponses.forEach((response) => {
      expect(response.json()).toEqual({ code: 'OK', message: '部署操作成功' })
    })
    expect(batchProcess.json()).toEqual({ code: 'OK', message: '已执行 2 个证书部署任务' })

    const cnameForm = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-cnames/form', headers })
    const cnameList = await app.inject({
      method: 'GET', url: '/api/web/v1/certificate-cnames?pageSize=10&q=external&sort=domain&order=asc', headers,
    })
    const cnameResponses = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/web/v1/certificate-cnames', headers,
        payload: { domain: 'external.example', targetRecordName: '_acme-proxy', targetDomainId: 42 },
      }),
      app.inject({
        method: 'PUT', url: '/api/web/v1/certificate-cnames/13', headers,
        payload: { targetRecordName: '_acme-proxy', targetDomainId: 42 },
      }),
      app.inject({ method: 'DELETE', url: '/api/web/v1/certificate-cnames/13', headers }),
    ])
    const cnameCheck = await app.inject({ method: 'POST', url: '/api/web/v1/certificate-cnames/13/check', headers })
    expect(cnameForm.json()).toEqual({ code: 'OK', data: { domains: [{ id: 42, name: 'target.example' }] } })
    expect(cnameList.json()).toMatchObject({
      code: 'OK', data: [{ id: 13, status: 'verified', target: '_acme-proxy.target.example' }],
    })
    cnameResponses.forEach((response) => expect(response.json()).toEqual({ code: 'OK', message: 'CNAME 操作成功' }))
    expect(cnameCheck.json()).toEqual({ code: 'OK', data: { status: 'verified' } })

    const settings = await app.inject({ method: 'GET', url: '/api/web/v1/certificate-settings', headers })
    const settingsUpdate = await app.inject({
      method: 'PUT', url: '/api/web/v1/certificate-settings', headers,
      payload: {
        renewBeforeDays: 30,
        notifications: { email: 'failures-only', customWebhook: 'all' },
        localDeployment: {
          defaultMode: 'quick',
          defaultTemplateId: 'local-default',
          templates: localTemplates,
        },
        dcvDelegation: {
          defaultTemplateId: 'dcv-default',
          templates: dcvTemplates,
        },
      },
    })
    expect(settings.json()).toEqual({
      code: 'OK', data: {
        renewBeforeDays: 14,
        deploymentWindow: { startHour: 1, endHour: 22 },
        notifications: {
          email: 'all', wechat: 'off', telegram: 'failures-only', robotWebhook: 'all', customWebhook: 'off',
        },
        localDeployment: {
          defaultMode: 'quick',
          defaultTemplateId: 'default',
          templates: [{
            id: 'default',
            name: '默认模板',
            pemCertificatePathTemplate: '/etc/ssl/{domain}/fullchain.pem',
            pemPrivateKeyPathTemplate: '/etc/ssl/{domain}/privkey.pem',
            pfxPathTemplate: '/etc/ssl/{domain}/certificate.pfx',
            commandTemplate: '',
          }],
        },
        dcvDelegation: {
          defaultTemplateId: 'default',
          templates: [{
            id: 'default',
            name: '默认策略',
            allowedDomains: [],
            domainMatchMode: 'suffix',
            targetRecordNameTemplate: '{domainWithDashes}.cname',
            forceTargetRecordNameTemplate: false,
          }],
        },
      },
    })
    expect(settingsUpdate.json()).toEqual({ code: 'OK', message: '设置保存成功' })
    expect(deploymentActions).toHaveLength(9)
    expect(cnameActions).toHaveLength(4)
  })
})
