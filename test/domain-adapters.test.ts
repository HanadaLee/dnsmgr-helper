import { describe, expect, it } from 'vitest'

import {
  domainAccountDetailFromHtml,
  providerDefinitionsFromHtml,
} from '../src/adapters/v1051/accounts.js'
import { embeddedJsonAssignment, namedTextareaValue } from '../src/adapters/v1051/html-state.js'
import {
  domainAliasesFromHtml,
  recordOptionsFromHtml,
} from '../src/adapters/v1051/record-actions.js'
import { domainFromRecordPage, normalizeRecord } from '../src/adapters/v1051/domains.js'

const providerState = {
  cloudflare: {
    name: 'Cloudflare',
    icon: 'cloudflare.ico',
    note: '<b>提示</b>：使用 API Token',
    config: {
      email: {
        name: '邮箱',
        type: 'input',
        required: true,
        validator: 'email',
      },
      api_token: {
        name: 'API Token',
        type: 'input',
        placeholder: 'token',
        required: true,
      },
      auth: {
        name: '认证方式',
        type: 'radio',
        options: ['API密钥', 'API令牌'],
        value: '0',
      },
      proxy: {
        name: '使用代理服务器',
        type: 'radio',
        options: ['否', '是'],
        value: '0',
      },
    },
    remark: 1,
    status: true,
    redirect: true,
    log: true,
    weight: false,
    page: true,
    add: false,
    sort: false,
  },
}

function accountHtml() {
  return `<!doctype html><html><body><script>
    var info = ${JSON.stringify({
      id: 7,
      type: 'cloudflare',
      name: 'admin@example.test',
      config: JSON.stringify({ email: 'admin@example.test', api_token: 'secret', proxy: '0' }),
      remark: '生产',
      addtime: '2026-08-31 12:00:00',
    })};
    var typeList = ${JSON.stringify(providerState)};
    new Vue({ data: { text: 'a;{b}' } });
  </script></body></html>`
}

describe('v1051 embedded page state', () => {
  it('extracts balanced JSON assignments without being confused by semicolons in strings', () => {
    const html = '<script>var state = {"message":"a; } ] b","nested":[{"ok":true}]}; next()</script>'
    expect(embeddedJsonAssignment(html, 'state')).toEqual({
      message: 'a; } ] b',
      nested: [{ ok: true }],
    })
  })

  it('preserves exact multiline textarea templates while decoding HTML entities', () => {
    const html = `<textarea name="template">{
  &quot;content&quot;: &quot;&lt;b&gt;hello  world&lt;/b&gt;&quot;
}</textarea>`
    expect(namedTextareaValue(html, 'template')).toBe(`{
  "content": "<b>hello  world</b>"
}`)
  })

  it('normalizes provider form definitions and marks credential fields as sensitive', () => {
    const providers = providerDefinitionsFromHtml(accountHtml())
    expect(providers).toEqual([{
      type: 'cloudflare',
      label: 'CloudFlare',
      icon: 'cloudflare.ico',
      note: '提示：使用 API Token',
      fields: [
        {
          key: 'email', label: '邮箱', control: 'input', required: true,
          disabled: false, sensitive: false, validator: 'email',
        },
        {
          key: 'api_token', label: 'API Token', control: 'input', required: true,
          disabled: false, sensitive: true, placeholder: 'token',
        },
        {
          key: 'auth', label: '认证方式', control: 'radio', required: false,
          disabled: false, sensitive: false, defaultValue: '0',
          options: [{ value: '0', label: 'API密钥' }, { value: '1', label: 'API令牌' }],
        },
        {
          key: 'proxy', label: '使用代理服务器', control: 'radio', required: false,
          disabled: false, sensitive: false, defaultValue: '0',
          options: [{ value: '0', label: '否' }, { value: '1', label: '是' }],
        },
      ],
      capabilities: {
        recordRemark: 'separate', recordStatus: true, redirectRecords: true,
        recordLogs: true, recordWeight: false, clientPaging: true,
        domainCreation: false, recordSorting: false,
      },
    }])
  })

  it('keeps newly added DNS account providers discoverable without a helper allowlist', () => {
    const html = `<script>var typeList = ${JSON.stringify({
      technitium: {
        name: 'Technitium',
        config: { proxy: { name: '使用代理服务器', type: 'radio', options: ['否', '是'], value: '0' } },
      },
      henet: {
        name: 'HE DNS',
        config: { proxy: { name: '使用代理服务器', type: 'radio', options: ['否', '是'], value: '0' } },
      },
      goedge: {
        name: 'GoEdge智能DNS',
        config: { proxy: { name: '使用代理服务器', type: 'radio', options: ['否', '是'], value: '0' } },
      },
    })};</script>`

    const providers = providerDefinitionsFromHtml(html)
    expect(providers.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: 'technitium', label: 'Technitium' },
      { type: 'henet', label: 'HE DNS' },
      { type: 'goedge', label: 'GoEdge智能DNS' },
    ])
    expect(providers.every((provider) => provider.fields[0]?.options?.length === 2)).toBe(true)
  })

  it('returns account secrets only from the privileged detail form, not the list normalizer', () => {
    expect(domainAccountDetailFromHtml(accountHtml())).toEqual({
      id: 7,
      provider: { type: 'cloudflare', label: 'CloudFlare', icon: 'cloudflare.ico' },
      name: 'admin@example.test',
      remark: '生产',
      addedAt: '2026-08-31 12:00:00',
      config: { email: 'admin@example.test', api_token: 'secret', proxy: '0' },
    })
  })

  it('translates record-page capabilities, lines, TTL and provider-specific record types', () => {
    const html = `<input name="ttl" value="600" min="60">
      <script>
      var recordLine = [{"id":"0","name":"默认","parent":""},{"id":"oversea","name":"境外","parent":"0"}];
      var dnsconfig = {"type":"powerdns","remark":2,"status":true,"redirect":true,"log":false,"weight":true,"page":false,"sort":true};
      </script>`
    expect(recordOptionsFromHtml(html)).toEqual({
      providerType: 'powerdns',
      minTtl: 60,
      lines: [
        { id: '0', label: '默认' },
        { id: 'oversea', label: '境外', parent: '0' },
      ],
      recordTypes: [
        'A', 'CNAME', 'AAAA', 'NS', 'MX', 'SRV', 'TXT', 'CAA',
        'REDIRECT_URL', 'FORWARD_URL', 'LOC', 'PTR', 'LUA',
      ],
      capabilities: {
        recordRemark: 'inline', recordStatus: true, redirectRecords: true,
        recordLogs: false, recordWeight: true, clientPaging: false,
        recordSorting: true, recordGroups: false, weightedSets: false,
        domainAliases: false, customHostnames: false, hierarchicalRecords: false,
      },
    })
  })

  it('recovers the minimal domain context from an authorized record page', () => {
    const html = `<html><head><title>解析管理 - example.com</title></head><body><script>
      var recordLine = [{"id":"0","name":"默认"}];
      var dnsconfig = {"type":"cloudflare","name":"Cloudflare"};
      </script></body></html>`

    expect(domainFromRecordPage(html, 42)).toEqual({
      id: 42,
      name: 'example.com',
      provider: { type: 'cloudflare', label: 'Cloudflare' },
      recordCount: 0,
      expiryLookup: 'unknown',
      noticeEnabled: false,
      hidden: false,
      ssoEnabled: true,
    })
  })

  it('preserves QingCloud parent sets and child record modes', () => {
    expect(normalizeRecord({
      RecordId: 'parent-1', Name: 'www', Count: '3', Remark: '入口记录',
    })).toEqual({
      id: 'parent-1', name: 'www', type: 'UNKNOWN', value: '',
      line: { id: '', label: '默认' }, childCount: 3, remark: '入口记录', status: 'unknown',
    })

    expect(normalizeRecord({
      RecordId: 'child-1', Name: 'www', Type: 'A', Value: '192.0.2.10',
      Line: '0', LineName: '默认', TTL: '600', Weight: '30', Mode: '3',
      ParentId: 'parent-1', Status: '1',
    })).toEqual({
      id: 'child-1', name: 'www', type: 'A', value: '192.0.2.10',
      line: { id: '0', label: '默认' }, ttl: 600, weight: 30, mode: 3,
      parentId: 'parent-1', status: 'enabled',
    })

    const qingcloudHtml = `<input name="ttl" min="60"><script>
      var recordLine = [{"id":"0","name":"默认"}];
      var dnsconfig = {"type":"qingcloud"};
      </script>`
    const qingcloudOptions = recordOptionsFromHtml(qingcloudHtml)
    expect(qingcloudOptions.capabilities.hierarchicalRecords).toBe(true)
    expect(qingcloudOptions.recordTypes).toEqual(['A', 'CNAME', 'AAAA', 'NS', 'MX', 'TXT'])
  })

  it('preserves each value when a provider returns an array-valued record', () => {
    expect(normalizeRecord({
      RecordId: 'multi-1', Name: 'mail', Type: 'MX', Value: ['mx1.example.net', 'mx2.example.net'],
      Line: '0', LineName: '默认', Status: '1',
    })).toMatchObject({
      id: 'multi-1',
      value: 'mx1.example.net,mx2.example.net',
      values: ['mx1.example.net', 'mx2.example.net'],
    })
  })

  it('translates the legacy alias table without carrying its HTML into the API', () => {
    const html = `<table><tbody>
      <tr data-id="11"><td>alias.example.com</td><td><font>正常</font></td><td>删除</td></tr>
      <tr data-id="12"><td>blocked.example.com</td><td><font>封禁</font></td><td>删除</td></tr>
      <tr data-id="13"><td>bad.example.com</td><td><font>DNS不正确</font></td><td>删除</td></tr>
    </tbody></table>`
    expect(domainAliasesFromHtml(html)).toEqual([
      { id: 11, name: 'alias.example.com', status: 'active' },
      { id: 12, name: 'blocked.example.com', status: 'blocked' },
      { id: 13, name: 'bad.example.com', status: 'dns_error' },
    ])
  })
})
