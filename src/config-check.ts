import { loadConfig } from './config.js'

const config = await loadConfig(process.argv[2])

process.stdout.write(`${JSON.stringify({
  valid: true,
  sourcePath: config.sourcePath,
  publicUrl: config.server.publicUrl.href,
  upstreamVersion: config.upstream.version,
  casEnabled: config.cas.enabled,
  databaseEnabled: config.database.enabled,
}, null, 2)}\n`)
