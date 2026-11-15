import { describe, expect, it } from 'vitest'

import { normalizeDynamicField, normalizeDynamicFields } from '../src/adapters/v1051/dynamic-fields.js'
import { auditFieldDefinitions, upstreamRoutes } from '../scripts/audit-upstream.js'

describe('upstream dynamic form compatibility', () => {
  it.each(['input', 'textarea', 'select', 'radio', 'checkbox', 'checkboxes', 'tags'])('preserves the %s control and its metadata', (type) => {
    expect(normalizeDynamicField('domain', { name: '绑定的域名', type, required: true, disabled: true,
      placeholder: '多个值', note: '<b>说明</b>', value: 'example.com', show: "product=='cdn'||product=='obs'" }))
      .toMatchObject({ key: 'domain', label: '绑定的域名', control: type, required: true, disabled: true,
        placeholder: '多个值', note: '说明', defaultValue: 'example.com', visibleWhen: { any: [
          { all: [{ field: 'product', operator: 'equals', value: 'cdn' }] },
          { all: [{ field: 'product', operator: 'equals', value: 'obs' }] },
        ] } })
  })

  it('fails explicitly on unknown field types instead of silently hiding original features', () => {
    expect(() => normalizeDynamicFields({ target: { name: '目标', type: 'new-upstream-control', required: true } }))
      .toThrow('target 的控件类型不兼容')
  })

  it('preserves option values, numeric defaults and combined visibility conditions', () => {
    expect(normalizeDynamicField('choice', { name: '选项', type: 'select', value: 0, min: 0, max: 2,
      options: { 0: '否', 1: '是' }, show: "product!='upload'&&proxy==2" }))
      .toMatchObject({ defaultValue: 0, min: 0, max: 2, options: [{ value: '0', label: '否' }, { value: '1', label: '是' }],
        visibleWhen: { any: [{ all: [{ field: 'product', operator: 'not-equals', value: 'upload' }, { field: 'proxy', operator: 'equals', value: '2' }] }] } })
  })

  it('distinguishes private key paths from passwords and rejects unsafe keys', () => {
    expect(normalizeDynamicField('pem_key_file', { name: '私钥保存路径', type: 'input' })?.sensitive).toBe(false)
    expect(normalizeDynamicField('SecretAccessKey', { type: 'input' })?.sensitive).toBe(true)
    expect(normalizeDynamicField('__proto__', { type: 'input' })).toBeUndefined()
  })

  it('audits PHP declarations without executing source and notices uninspected fields', () => {
    const source = "        'huawei' => [\n                'domain' => [\n                    'name' => '绑定的域名',\n                    'type' => 'tags',\n                    'show' => 'product==\\'cdn\\'||product==\\'obs\\'',\n                ],\n        ],\n"
    expect(auditFieldDefinitions(source)).toEqual([{ provider: 'huawei', key: 'domain', control: 'tags' }])
    expect(() => auditFieldDefinitions(source + "'type' => 'input'")).toThrow('not inspected')
    expect(upstreamRoutes("Route::any('/mcp', 'mcp/handle')->middleware(AuthMcp::class);"))
      .toEqual(['ANY /mcp => mcp/handle'])
  })
})
