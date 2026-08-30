import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

const configPath = path.resolve(
  process.env.DNSMGR_HELPER_CONFIG || '/app/config/dnsmgr-helper.json',
)

try {
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  const configuredHost = config?.server?.host
  const port = config?.server?.port

  if (typeof configuredHost !== 'string' || !Number.isInteger(port)) {
    throw new Error('server.host or server.port is invalid')
  }

  const host = configuredHost === '0.0.0.0' || configuredHost === '::'
    ? '127.0.0.1'
    : configuredHost
  const urlHost = isIP(host) === 6 ? `[${host}]` : host
  const response = await fetch(`http://${urlHost}:${port}/healthz`, {
    signal: AbortSignal.timeout(3_000),
  })

  if (!response.ok) {
    throw new Error(`/healthz returned HTTP ${response.status}`)
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  console.error(`dnsmgr-helper health check failed: ${reason}`)
  process.exit(1)
}
