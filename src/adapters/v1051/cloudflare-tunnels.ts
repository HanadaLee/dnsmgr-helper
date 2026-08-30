import { isIP } from 'node:net'

import { z } from 'zod'

import type { AppConfig } from '../../config.js'
import type {
  CloudflareTunnel,
  CloudflareTunnelCidrRoute,
  CloudflareTunnelHostnameRoute,
  CloudflareTunnelPublicHostname,
  PageMeta,
} from '../../contracts.js'
import { ApiError } from '../../errors.js'
import type { DnsmgrClient, RequestContext } from '../../upstream/client.js'
import {
  integerValue,
  objectValue,
  operationMessage,
  rowsFromOperation,
  stringValue,
  type LegacyObject,
} from './automation-common.js'
import { executeLegacyOperation, type NormalizedOperationResult } from './operations.js'

const ExternalId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const Hostname = z.string().trim().min(3).max(253).superRefine((value, context) => {
  const plain = value.startsWith('*.') ? value.slice(2) : value
  if (!plain.includes('.') || /[\s/:]/.test(plain) || plain.includes('*') || value === '*.' || isIP(plain) !== 0) {
    context.addIssue({ code: 'custom', message: '主机名格式不正确' })
  }
})

const CidrNetwork = z.string().trim().min(3).max(128).superRefine((value, context) => {
  const [address, prefixText, ...rest] = value.split('/')
  const family = address ? isIP(address) : 0
  const prefix = prefixText === undefined || !/^\d+$/.test(prefixText) ? Number.NaN : Number(prefixText)
  const valid = rest.length === 0
    && family !== 0
    && Number.isSafeInteger(prefix)
    && prefix >= 0
    && prefix <= (family === 4 ? 32 : 128)
  if (!valid) context.addIssue({ code: 'custom', message: 'CIDR 格式不正确' })
})

export const CloudflareTunnelCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
}).strict()

export const CloudflareTunnelPublicHostnameSchema = z.object({
  hostname: Hostname,
  service: z.string().trim().min(1).max(2048).refine((value) => !value.includes('\0'), '服务地址格式不正确'),
  path: z.string().trim().max(2048).nullable().optional(),
}).strict()

export const CloudflareTunnelPublicHostnameDeleteSchema = z.object({
  hostname: Hostname,
  path: z.string().trim().max(2048).nullable().optional(),
}).strict()

export const CloudflareTunnelCidrCreateSchema = z.object({
  network: CidrNetwork,
  comment: z.string().trim().max(1000).nullable().optional(),
}).strict()

export const CloudflareTunnelRouteDeleteSchema = z.object({ routeId: ExternalId }).strict()

export const CloudflareTunnelHostnameRouteCreateSchema = z.object({
  hostname: Hostname,
  comment: z.string().trim().max(1000).nullable().optional(),
}).strict()

function requiredString(row: LegacyObject | undefined, key: string, message: string): string {
  const value = stringValue(row?.[key])
  if (!value) throw new ApiError(502, 'UPSTREAM_INVALID_CLOUDFLARE_TUNNEL', message)
  return value
}

function normalizeTunnel(value: unknown): CloudflareTunnel {
  const row = objectValue(value)
  const id = requiredString(row, 'id', '原 dnsmgr 返回了无法识别的 Cloudflare Tunnel')
  const name = requiredString(row, 'name', '原 dnsmgr 返回了无法识别的 Cloudflare Tunnel')
  const createdAt = stringValue(row?.created_at)
  const deletedAt = stringValue(row?.deleted_at)
  const activeAt = stringValue(row?.conns_active_at)
  return {
    id,
    name,
    status: stringValue(row?.status) ?? 'unknown',
    connectionCount: Math.max(0, integerValue(row?.connection_count) ?? 0),
    ...(createdAt ? { createdAt } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(activeAt ? { activeAt } : {}),
  }
}

function normalizePublicHostname(value: unknown): CloudflareTunnelPublicHostname {
  const row = objectValue(value)
  const hostname = requiredString(row, 'hostname', '原 dnsmgr 返回了无法识别的 Tunnel 公网主机名')
  const service = requiredString(row, 'service', '原 dnsmgr 返回了无法识别的 Tunnel 公网主机名')
  const path = stringValue(row?.path)
  const zoneName = stringValue(row?.zone_name)
  const zoneId = stringValue(row?.zone_id)
  return {
    hostname,
    ...(path ? { path } : {}),
    service,
    ...(zoneName ? { zoneName } : {}),
    ...(zoneId ? { zoneId } : {}),
  }
}

function normalizeCidrRoute(value: unknown): CloudflareTunnelCidrRoute {
  const row = objectValue(value)
  const id = requiredString(row, 'id', '原 dnsmgr 返回了无法识别的 Tunnel CIDR 路由')
  const network = requiredString(row, 'network', '原 dnsmgr 返回了无法识别的 Tunnel CIDR 路由')
  const comment = stringValue(row?.comment)
  const virtualNetworkId = stringValue(row?.virtual_network_id)
  const tunnelId = stringValue(row?.tunnel_id)
  const createdAt = stringValue(row?.created_at)
  return {
    id,
    network,
    ...(comment ? { comment } : {}),
    ...(virtualNetworkId ? { virtualNetworkId } : {}),
    ...(tunnelId ? { tunnelId } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
}

function normalizeHostnameRoute(value: unknown): CloudflareTunnelHostnameRoute {
  const row = objectValue(value)
  const id = requiredString(row, 'id', '原 dnsmgr 返回了无法识别的 Tunnel 主机名路由')
  const hostname = requiredString(row, 'hostname', '原 dnsmgr 返回了无法识别的 Tunnel 主机名路由')
  const comment = stringValue(row?.comment)
  const tunnelId = stringValue(row?.tunnel_id)
  const createdAt = stringValue(row?.created_at)
  return {
    id,
    hostname,
    ...(comment ? { comment } : {}),
    ...(tunnelId ? { tunnelId } : {}),
    ...(createdAt ? { createdAt } : {}),
  }
}

function rowsResult<T>(
  result: NormalizedOperationResult,
  invalidMessage: string,
  normalize: (value: unknown) => T,
): { data: T[]; meta: PageMeta } {
  const rows = rowsFromOperation(result, invalidMessage)
  return {
    data: rows.map(normalize),
    meta: { page: 1, pageSize: rows.length, total: result.meta?.total ?? rows.length },
  }
}

function dataObject(result: NormalizedOperationResult, invalidMessage: string): LegacyObject {
  const data = objectValue(result.data)
  if (!data) throw new ApiError(502, 'UPSTREAM_INVALID_PAYLOAD', invalidMessage)
  return data
}

export async function listCloudflareTunnels(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
) {
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.list', {
    path: { accountId },
  })
  return rowsResult(result, '原 dnsmgr 的 Cloudflare Tunnel 列表格式不兼容', normalizeTunnel)
}

export async function createCloudflareTunnel(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  rawBody: unknown,
) {
  const body = CloudflareTunnelCreateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.create', {
    path: { accountId },
    form: { name: body.name },
  })
  return { ...operationMessage(result.message), data: normalizeTunnel(result.data) }
}

export async function deleteCloudflareTunnel(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
) {
  const id = ExternalId.parse(tunnelId)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.delete', {
    path: { accountId },
    form: { tunnel_id: id },
  })
  return operationMessage(result.message)
}

export async function getCloudflareTunnelToken(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
) {
  const id = ExternalId.parse(tunnelId)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.token', {
    path: { accountId },
    form: { tunnel_id: id },
  })
  const token = stringValue(dataObject(result, '原 dnsmgr 的 Tunnel Token 格式不兼容').token)
  if (!token) throw new ApiError(502, 'UPSTREAM_INVALID_CLOUDFLARE_TOKEN', '原 dnsmgr 的 Tunnel Token 格式不兼容')
  return { token, command: `cloudflared tunnel run --token ${token}` }
}

export async function listCloudflareTunnelPublicHostnames(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
) {
  const id = ExternalId.parse(tunnelId)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.publicHostnames.list', {
    path: { accountId },
    form: { tunnel_id: id },
  })
  return rowsResult(result, '原 dnsmgr 的 Tunnel 公网主机名列表格式不兼容', normalizePublicHostname)
}

export async function saveCloudflareTunnelPublicHostname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(tunnelId)
  const body = CloudflareTunnelPublicHostnameSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.publicHostnames.save', {
    path: { accountId },
    form: { tunnel_id: id, hostname: body.hostname, service: body.service, path: body.path ?? '' },
  })
  return operationMessage(result.message)
}

export async function deleteCloudflareTunnelPublicHostname(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(tunnelId)
  const body = CloudflareTunnelPublicHostnameDeleteSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.publicHostnames.delete', {
    path: { accountId },
    form: { tunnel_id: id, hostname: body.hostname, path: body.path ?? '' },
  })
  return operationMessage(result.message)
}

export async function listCloudflareTunnelCidrRoutes(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
) {
  const id = ExternalId.parse(tunnelId)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.cidrs.list', {
    path: { accountId },
    form: { tunnel_id: id },
  })
  return rowsResult(result, '原 dnsmgr 的 Tunnel CIDR 路由列表格式不兼容', normalizeCidrRoute)
}

export async function createCloudflareTunnelCidrRoute(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(tunnelId)
  const body = CloudflareTunnelCidrCreateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.cidrs.create', {
    path: { accountId },
    form: { tunnel_id: id, network: body.network, comment: body.comment ?? '' },
  })
  return { ...operationMessage(result.message), data: normalizeCidrRoute(result.data) }
}

export async function deleteCloudflareTunnelCidrRoute(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(tunnelId)
  const body = CloudflareTunnelRouteDeleteSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.cidrs.delete', {
    path: { accountId },
    form: { tunnel_id: id, route_id: body.routeId },
  })
  return operationMessage(result.message)
}

export async function listCloudflareTunnelHostnameRoutes(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
) {
  const id = ExternalId.parse(tunnelId)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.hostnameRoutes.list', {
    path: { accountId },
    form: { tunnel_id: id },
  })
  return rowsResult(result, '原 dnsmgr 的 Tunnel 主机名路由列表格式不兼容', normalizeHostnameRoute)
}

export async function createCloudflareTunnelHostnameRoute(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(tunnelId)
  const body = CloudflareTunnelHostnameRouteCreateSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.hostnameRoutes.create', {
    path: { accountId },
    form: { tunnel_id: id, hostname: body.hostname, comment: body.comment ?? '' },
  })
  return { ...operationMessage(result.message), data: normalizeHostnameRoute(result.data) }
}

export async function deleteCloudflareTunnelHostnameRoute(
  client: DnsmgrClient,
  config: AppConfig,
  context: RequestContext,
  accountId: number,
  tunnelId: string,
  rawBody: unknown,
) {
  const id = ExternalId.parse(tunnelId)
  const body = CloudflareTunnelRouteDeleteSchema.parse(rawBody)
  const result = await executeLegacyOperation(client, config, context, 'cloudflare.tunnels.hostnameRoutes.delete', {
    path: { accountId },
    form: { tunnel_id: id, route_id: body.routeId },
  })
  return operationMessage(result.message)
}
