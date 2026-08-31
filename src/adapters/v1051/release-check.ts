import type { AppConfig } from '../../config.js'
import type { DashboardReleaseInfo } from '../../contracts.js'
import type { FetchLike, UpstreamLogger } from '../../upstream/client.js'
import { plainText } from './html-state.js'

const MAX_RESPONSE_BYTES = 256 * 1024
const RELEASE_URL = 'https://github.com/netcccyun/dnsmgr/releases'

function releasePayload(source: string): { code?: unknown; msg?: unknown } | undefined {
  const match = /^\s*[A-Za-z_$][\w$]*\((\{[\s\S]*\})\)\s*;?\s*$/.exec(source)
  if (!match?.[1]) return undefined
  try {
    const value = JSON.parse(match[1]) as unknown
    return value && typeof value === 'object' ? value as { code?: unknown; msg?: unknown } : undefined
  } catch {
    return undefined
  }
}

export async function getDashboardReleaseInfo(
  config: AppConfig,
  fetcher: FetchLike,
  logger?: UpstreamLogger,
): Promise<DashboardReleaseInfo> {
  const currentBuild = config.upstream.version
  if (!config.releaseCheck.enabled) return { status: 'disabled', currentBuild }

  const url = new URL(config.releaseCheck.url)
  url.searchParams.set('ver', currentBuild)
  url.searchParams.set('callback', 'dnsmgrRelease')
  const startedAt = performance.now()
  logger?.info({ host: url.host, path: url.pathname, currentBuild }, 'dnsmgr release check request')
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/javascript, text/javascript, text/plain;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(config.releaseCheck.requestTimeoutMs),
    })
    const source = await response.text()
    if (!response.ok || Buffer.byteLength(source) > MAX_RESPONSE_BYTES) throw new Error(`HTTP ${response.status}`)
    const payload = releasePayload(source)
    const message = plainText(payload?.msg)
    const version = message ? /(?:当前|最新)版本[：:]\s*V?([^\s(]+)\s*\(Build\s*(\d+)\)/i.exec(message) : undefined
    if (Number(payload?.code) !== 0 || !version?.[1] || !version[2]) throw new Error('invalid release response')
    const latestVersion = version[1]
    const latestBuild = version[2]
    const updateAvailable = Number(latestBuild) > Number(currentBuild)
    logger?.info({
      host: url.host,
      statusCode: response.status,
      responseTime: performance.now() - startedAt,
      currentBuild,
      latestBuild,
      updateAvailable,
    }, 'dnsmgr release check response')
    return {
      status: updateAvailable ? 'update-available' : 'current',
      currentBuild,
      latestBuild,
      latestVersion,
      checkedAt: new Date().toISOString(),
      releaseUrl: RELEASE_URL,
    }
  } catch (error) {
    logger?.warn({
      host: url.host,
      responseTime: performance.now() - startedAt,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }, 'dnsmgr release check failed')
    return { status: 'unavailable', currentBuild }
  }
}
