import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { parseConfig } from '../src/config.js'
import type { FetchLike } from '../src/upstream/client.js'

const apps: Awaited<ReturnType<typeof buildApp>>[] = []
const accountId = 25
const domainUuid = '1311af83-8647-4541-9521-e2387a411a2f'
const ruleUuid = 'ad6b9339-58c2-40c5-a8e5-65af8708175c'
const eipUuid = '36bc8942-cb3d-41c0-8fba-4dcf18f284d7'
const tagUuid = '2751529a-efd3-40ce-b8e3-9ff31f2dfccc'
const providerUuid = 'f4042cab-2255-4387-921a-8dce9aa76c11'
const zoneUuid = 'b92016ed-2ee0-4114-9a2e-383c6fd3e99f'

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

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): FetchLike {
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

function form(init: RequestInit) {
  return new URLSearchParams(String(init.body))
}

const headers = { cookie: 'user_token=legacy-axisnow-session' }

describe('typed AxisNow API', () => {
  it('normalizes platform accounts, domains, linked options and route rules', async () => {
    const mutations: string[] = []
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/axisnow/domains' && (init.method ?? 'GET') === 'GET') {
        return new Response(`<script>var axisnowAccounts = [{"id":${accountId},"name":"生产平台"}];</script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      if (url.pathname === '/internal/axisnow/domains/data') {
        const body = form(init)
        expect(body.get('account_id')).toBe(String(accountId))
        return json({ code: 0, total: 1, rows: [{
          uuid: domainUuid,
          account_id: accountId,
          account_name: '生产平台',
          domain: 'route.example.com',
          provider_source: 'platform',
          record_type: 'A',
          dns_provider_uuid: providerUuid,
          dns_zone_uuid: zoneUuid,
          provider_type: 'axisnow',
          eips_count: 3,
          dns_rules_count: 1,
          updated_at: '2026-09-09T01:02:03Z',
        }] })
      }
      if (url.pathname === `/internal/axisnow/options/${accountId}`) {
        expect(url.searchParams.get('scope')).toBe('rule')
        expect(url.searchParams.get('domain_uuid')).toBe(domainUuid)
        return json({ code: 0, data: {
          eips: [{ uuid: eipUuid, address: '192.0.2.10' }],
          tags: [{ uuid: tagUuid, name: '中国电信' }],
          probe_templates: [{ uuid: providerUuid, name: 'HTTP 可用性' }],
          geo_isp_options: [{ value: 'isp/china-telecom', name: '中国电信', depth: 1, disabled: false }],
        } })
      }
      if (url.pathname === `/internal/axisnow/rules/data/${accountId}/${domainUuid}`) {
        return json({ code: 0, total: 1, rows: [{
          uuid: ruleUuid,
          account_id: accountId,
          account_name: '生产平台',
          dns_domain_uuid: domainUuid,
          type: 'A',
          geo_isp: 'isp/china-telecom',
          geo_isp_name: '中国电信',
          status: 'active',
          strategy: 'quality_optimized',
          pool_summary: '1 个 EIP',
          pool_groups: [{ type: 'eip', type_name: 'EIP', count: 1, items: ['192.0.2.10'] }],
          pool_addresses: [
            { address: '192.0.2.10', score: 98.25, status: 'available', quality_filtered: false, country_code: 'HK', isp_name: '测试线路', provider_name: '测试提供商', tag_names: ['edge.test'] },
            { address: '192.0.2.11', score: 72.5, status: 'available', quality_filtered: false, country_code: 'SG', tag_names: [] },
          ],
          pool_address_count: 2,
          pool_truncated: false,
          strategy_quantity: 1,
          strategy_interval: 5,
          resolved_addresses: [{ address: '192.0.2.10', score: 98.25, status: 'available', quality_filtered: false, country_code: 'HK', isp_name: '测试线路', provider_name: '测试提供商', tag_names: ['edge.test'] }],
          updated_at: '2026-09-09T01:02:03Z',
          resolved_updated_at: '2026-09-09T01:08:09Z',
          action: { conf: { address_pool: { groups: [{ type: 'eip', eip_uuids: [eipUuid] }] } } },
        }] })
      }
      if (url.pathname === `/internal/axisnow/rules/get/${accountId}/${ruleUuid}`) {
        return json({ code: 0, data: {
          uuid: ruleUuid,
          dns_domain_uuid: domainUuid,
          type: 'A',
          geo_isp: 'isp/china-telecom',
          status: 'paused',
          action: { conf: { response_strategy: { election_strategy: 'random', ip_quantity: 1 } } },
        } })
      }
      if (url.pathname === '/internal/axisnow/domains/create') {
        mutations.push(url.pathname)
        const body = form(init)
        expect(Object.fromEntries(body)).toMatchObject({
          account_id: String(accountId),
          domain: 'route.example.com',
          provider_source: 'platform',
          dns_provider_uuid: providerUuid,
          dns_zone_uuid: zoneUuid,
          record_type: 'A',
        })
        return json({ code: 0, msg: '调度域名创建成功' })
      }
      if (url.pathname === '/internal/axisnow/domains/update') {
        mutations.push(url.pathname)
        const body = form(init)
        expect(Object.fromEntries(body)).toMatchObject({
          uuid: domainUuid,
          account_id: String(accountId),
          domain: 'route.example.com',
          provider_source: 'platform',
          dns_provider_uuid: providerUuid,
          dns_zone_uuid: zoneUuid,
          record_type: 'A',
        })
        return json({ code: 0, msg: '调度域名修改成功' })
      }
      throw new Error(`unexpected upstream route: ${url.pathname}`)
    })

    const accounts = await app.inject({ method: 'GET', url: '/api/web/v1/axisnow/accounts', headers })
    expect(accounts.json()).toEqual({ code: 'OK', data: [{ id: accountId, name: '生产平台' }] })

    const domains = await app.inject({ method: 'GET', url: `/api/web/v1/axisnow/domains?accountId=${accountId}`, headers })
    expect(domains.json()).toMatchObject({ code: 'OK', meta: { total: 1 }, data: [{ uuid: domainUuid, accountName: '生产平台', providerSource: 'platform', ruleCount: 1 }] })

    const detail = await app.inject({ method: 'GET', url: `/api/web/v1/axisnow/accounts/${accountId}/domains/${domainUuid}`, headers })
    expect(detail.json()).toMatchObject({ code: 'OK', data: { domain: 'route.example.com', dnsZoneUuid: zoneUuid } })

    const options = await app.inject({ method: 'GET', url: `/api/web/v1/axisnow/accounts/${accountId}/options?scope=rule&domainUuid=${domainUuid}`, headers })
    expect(options.json()).toMatchObject({ code: 'OK', data: { eips: [{ uuid: eipUuid, name: '192.0.2.10' }], geoIspOptions: [{ name: '中国电信' }] } })

    const rules = await app.inject({ method: 'GET', url: `/api/web/v1/axisnow/accounts/${accountId}/domains/${domainUuid}/rules`, headers })
    expect(rules.json()).toMatchObject({
      code: 'OK',
      meta: { total: 1 },
      data: [{
        uuid: ruleUuid,
        geoIspName: '中国电信',
        poolSummary: '1 个 EIP',
        poolAddressCount: 2,
        poolGroups: [{ type: 'eip', typeName: 'EIP', count: 1, items: ['192.0.2.10'] }],
        poolAddresses: [
          { address: '192.0.2.10', score: 98.25, status: 'available', qualityFiltered: false, countryCode: 'HK', ispName: '测试线路', providerName: '测试提供商', tagNames: ['edge.test'] },
          { address: '192.0.2.11', score: 72.5, status: 'available', qualityFiltered: false, countryCode: 'SG', tagNames: [] },
        ],
        strategyQuantity: 1,
        strategyInterval: 5,
        resolvedAddresses: [{ address: '192.0.2.10', score: 98.25, status: 'available', qualityFiltered: false, countryCode: 'HK', ispName: '测试线路', providerName: '测试提供商', tagNames: ['edge.test'] }],
        updatedAt: '2026-09-09T01:02:03Z',
        resolvedUpdatedAt: '2026-09-09T01:08:09Z',
      }],
    })

    const rule = await app.inject({ method: 'GET', url: `/api/web/v1/axisnow/accounts/${accountId}/domains/${domainUuid}/rules/${ruleUuid}`, headers })
    expect(rule.json()).toMatchObject({ code: 'OK', data: { uuid: ruleUuid, status: 'paused' } })

    const created = await app.inject({ method: 'POST', url: '/api/web/v1/axisnow/domains', headers, payload: {
      accountId,
      domain: 'route.example.com',
      providerSource: 'platform',
      dnsProviderUuid: providerUuid,
      dnsZoneUuid: zoneUuid,
      recordType: 'A',
    } })
    expect(created.json()).toEqual({ code: 'OK', message: '调度域名创建成功' })

    const updated = await app.inject({ method: 'PUT', url: `/api/web/v1/axisnow/domains/${domainUuid}`, headers, payload: {
      accountId,
      providerSource: 'platform',
      dnsProviderUuid: providerUuid,
      dnsZoneUuid: zoneUuid,
      recordType: 'A',
      name: '生产路由',
    } })
    expect(updated.json()).toEqual({ code: 'OK', message: '调度域名修改成功' })

    const renamed = await app.inject({ method: 'PUT', url: `/api/web/v1/axisnow/domains/${domainUuid}`, headers, payload: {
      accountId,
      domain: 'renamed.example.com',
      providerSource: 'platform',
      dnsProviderUuid: providerUuid,
      dnsZoneUuid: zoneUuid,
      recordType: 'A',
    } })
    expect(renamed.statusCode).toBe(422)
    expect(mutations).toEqual(['/internal/axisnow/domains/create', '/internal/axisnow/domains/update'])
  })

  it('covers shared EIP visibility, tag editing and array mutation forms', async () => {
    const app = await appWith((url, init) => {
      if (url.pathname === '/internal/axisnow/eips/data') {
        return json({ code: 0, total: 1, rows: [{
          uuid: eipUuid,
          account_id: accountId,
          account_name: '生产平台',
          address: '192.0.2.10',
          can_manage: false,
          data_origin: 'subscribed',
          sharer_tenant_uuid: providerUuid,
          tag_uuids: [tagUuid],
          tag_names: ['中国电信'],
          routing_referenced_count: 2,
          provider_name: '共享租户',
          geo: { country_code: 'CN', isp_name: '中国电信' },
          subscription_status: 'active',
        }] })
      }
      if (url.pathname === '/internal/axisnow/tags/data') {
        return json({ code: 0, total: 1, rows: [{ uuid: tagUuid, account_id: accountId, account_name: '生产平台', name: '中国电信', bound_count: 4, referenced_count: 2 }] })
      }
      if (url.pathname === '/internal/axisnow/tags/edit') {
        expect(url.searchParams.get('account_id')).toBe(String(accountId))
        expect(url.searchParams.get('uuid')).toBe(tagUuid)
        return json({ code: 0, data: { uuid: tagUuid, name: '中国电信', description: '电信地址池' } })
      }
      if (url.pathname === '/internal/axisnow/eips/delete') {
        const body = form(init)
        expect(body.get('account_id')).toBe(String(accountId))
        expect(body.getAll('uuids[]')).toEqual([eipUuid])
        return json({ code: 0, msg: 'EIP 删除成功' })
      }
      if (url.pathname === '/internal/axisnow/tags/save') {
        expect(Object.fromEntries(form(init))).toEqual({ account_id: String(accountId), uuid: tagUuid, name: '中国电信优化', description: '' })
        return json({ code: 0, msg: '标签修改成功' })
      }
      throw new Error(`unexpected upstream route: ${url.pathname}`)
    })

    const eips = await app.inject({ method: 'GET', url: '/api/web/v1/axisnow/eips', headers })
    expect(eips.json()).toMatchObject({ code: 'OK', data: [{ dataOrigin: 'subscribed', canManage: false, providerName: '共享租户', referencedCount: 2 }] })

    const tags = await app.inject({ method: 'GET', url: '/api/web/v1/axisnow/tags', headers })
    expect(tags.json()).toMatchObject({ code: 'OK', data: [{ uuid: tagUuid, boundCount: 4, referencedCount: 2 }] })

    const tag = await app.inject({ method: 'GET', url: `/api/web/v1/axisnow/accounts/${accountId}/tags/${tagUuid}`, headers })
    expect(tag.json()).toEqual({ code: 'OK', data: { uuid: tagUuid, accountId, accountName: '-', name: '中国电信', description: '电信地址池', boundCount: 0, referencedCount: 0 } })

    const removed = await app.inject({ method: 'POST', url: '/api/web/v1/axisnow/eips/batch-delete', headers, payload: { accountId, uuids: [eipUuid] } })
    expect(removed.json()).toEqual({ code: 'OK', message: 'EIP 删除成功' })

    const updated = await app.inject({ method: 'PUT', url: `/api/web/v1/axisnow/tags/${tagUuid}`, headers, payload: { accountId, name: '中国电信优化', description: null } })
    expect(updated.json()).toEqual({ code: 'OK', message: '标签修改成功' })
  })

  it('translates AxisNow automation configuration, status and restore actions', async () => {
    const tidePool = { mode: 'customize', groups: [{ type: 'ip', ips: ['192.0.2.20'] }] }
    const failoverPool = { mode: 'customize', groups: [{ type: 'ip', ips: ['192.0.2.30'] }] }
    const app = await appWith((url, init) => {
      if (url.pathname === `/internal/axisnow/rules/automation/${accountId}/${ruleUuid}`) {
        expect(init.method).toBe('GET')
        return json({ code: 0, data: {
          configured: true,
          rule_uuid: ruleUuid,
          domain_uuid: domainUuid,
          rule_type: 'A',
          geo_isp: 'default',
          primary_pool: { mode: 'all_valid_eips' },
          tide_enabled: true,
          tide_start: '22:00',
          tide_end: '06:00',
          tide_pool: tidePool,
          failover_enabled: true,
          failover_pool: failoverPool,
          failure_threshold: 3,
          check_interval_minutes: 5,
          active_pool: 'tide',
          failover_state: 'armed',
          fail_count: 1,
          last_check_at: 1_757_000_000,
          last_health_state: 'partial',
          last_switch_at: 1_756_999_000,
          last_error: '',
          has_probe_template: true,
          logs: [{ id: 9, action: 'tide', status: 'success', message: '进入潮汐时间段', created_at: '2026-09-10 06:00:00' }],
        } })
      }
      if (url.pathname === '/internal/axisnow/rules/automation/save') {
        expect(init.method).toBe('POST')
        const body = form(init)
        expect(Object.fromEntries(body)).toMatchObject({
          account_id: String(accountId),
          rule_uuid: ruleUuid,
          tide_enabled: '1',
          tide_start: '23:00',
          tide_end: '07:00',
          failover_enabled: '1',
          failure_threshold: '4',
          check_interval_minutes: '10',
        })
        expect(JSON.parse(body.get('tide_pool') ?? '')).toEqual(tidePool)
        expect(JSON.parse(body.get('failover_pool') ?? '')).toEqual(failoverPool)
        return json({ code: 0, msg: '自动调度配置已保存' })
      }
      if (url.pathname === '/internal/axisnow/rules/automation/restore') {
        expect(init.method).toBe('POST')
        expect(Object.fromEntries(form(init))).toEqual({ account_id: String(accountId), rule_uuid: ruleUuid })
        return json({ code: 0, msg: '已恢复主地址池并重新布防' })
      }
      throw new Error(`unexpected upstream route: ${url.pathname}`)
    })

    const path = `/api/web/v1/axisnow/accounts/${accountId}/domains/${domainUuid}/rules/${ruleUuid}/automation`
    const loaded = await app.inject({ method: 'GET', url: path, headers })
    expect(loaded.json()).toMatchObject({
      code: 'OK',
      data: {
        configured: true,
        tideEnabled: true,
        tideStart: '22:00',
        tidePool,
        failoverEnabled: true,
        failoverPool,
        activePool: 'tide',
        failCount: 1,
        lastHealthState: 'partial',
        logs: [{ id: 9, action: 'tide', status: 'success', createdAt: '2026-09-10 06:00:00' }],
      },
    })

    const saved = await app.inject({ method: 'PUT', url: path, headers, payload: {
      tideEnabled: true,
      tideStart: '23:00',
      tideEnd: '07:00',
      tidePool,
      failoverEnabled: true,
      failoverPool,
      failureThreshold: 4,
      checkIntervalMinutes: 10,
    } })
    expect(saved.json()).toEqual({ code: 'OK', message: '自动调度配置已保存' })

    const restored = await app.inject({ method: 'POST', url: `${path}/restore`, headers })
    expect(restored.json()).toEqual({ code: 'OK', message: '已恢复主地址池并重新布防' })
  })
})
