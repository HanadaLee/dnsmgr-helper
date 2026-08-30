import { describe, expect, it } from 'vitest'

import {
  domainAccountDetailFromHtml,
  providerDefinitionsFromHtml,
} from '../src/adapters/v1051/accounts.js'
import { embeddedJsonAssignment } from '../src/adapters/v1051/html-state.js'
import {
  domainAliasesFromHtml,
  recordOptionsFromHtml,
} from '../src/adapters/v1051/record-actions.js'

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
      proxy: {
        name: '使用代理服务器',
        type: 'radio',
        options: { 0: '否', 1: '是' },
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

  it('normalizes provider form definitions and marks credential fields as sensitive', () => {
    const providers = providerDefinitionsFromHtml(accountHtml())
    expect(providers).toEqual([{
      type: 'cloudflare',
      label: 'Cloudflare',
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

  it('returns account secrets only from the privileged detail form, not the list normalizer', () => {
    expect(domainAccountDetailFromHtml(accountHtml())).toEqual({
      id: 7,
      provider: { type: 'cloudflare', label: 'Cloudflare', icon: 'cloudflare.ico' },
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
        domainAliases: false, customHostnames: false,
      },
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
