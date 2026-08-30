import { describe, expect, it } from 'vitest'

import {
  listLegacyOperations,
  toLegacyForm,
} from '../src/adapters/v1051/operations.js'

describe('v1051 operation registry', () => {
  it('covers every server-side feature group with an explicit allowlisted operation', () => {
    const operations = listLegacyOperations()
    const groups = new Set(operations.map((operation) => operation.group))

    expect(operations).toHaveLength(143)
    expect(groups).toEqual(new Set([
      'certificates',
      'cloudflare',
      'dashboard',
      'domainAccounts',
      'domainCategories',
      'domains',
      'logs',
      'monitoring',
      'optimizeIp',
      'profile',
      'records',
      'schedules',
      'system',
      'users',
    ]))
    expect(operations).toContainEqual({
      id: 'records.create',
      group: 'records',
      method: 'POST',
      pathParameters: ['domainId'],
    })
    expect(operations).toContainEqual({
      id: 'cloudflare.tunnels.publicHostnames.save',
      group: 'cloudflare',
      method: 'POST',
      pathParameters: ['accountId'],
    })
  })

  it('encodes JSON values using PHP-compatible form field names', () => {
    const form = toLegacyForm({
      enabled: true,
      permission: ['example.com', 'example.net'],
      records: [
        { name: 'www', value: '192.0.2.1' },
        { name: 'api', value: '192.0.2.2' },
      ],
      weight: { 'record-1': 50, 'record-2': 50 },
      nullable: null,
      do: 'caller-value',
    }, { do: 'stat' })

    expect(Array.from(form.entries())).toEqual([
      ['enabled', '1'],
      ['permission[]', 'example.com'],
      ['permission[]', 'example.net'],
      ['records[0][name]', 'www'],
      ['records[0][value]', '192.0.2.1'],
      ['records[1][name]', 'api'],
      ['records[1][value]', '192.0.2.2'],
      ['weight[record-1]', '50'],
      ['weight[record-2]', '50'],
      ['nullable', ''],
      ['do', 'stat'],
    ])
  })

  it('rejects caller-controlled PHP bracket syntax in form key segments', () => {
    expect(() => toLegacyForm({ 'ids[admin]': '1' })).toThrow('表单字段名称不合法')
    expect(() => toLegacyForm({ weight: { 'record][admin': 100 } })).toThrow('表单字段名称不合法')
  })
})
