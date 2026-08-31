import { loadConfig } from './config.js'

const config = await loadConfig(process.argv[2])

process.stdout.write(`${JSON.stringify({
  valid: true,
  sourcePath: config.sourcePath,
  listen: `${config.server.host}:${config.server.port}`,
  publicUrl: config.server.publicUrl.href,
  upstreamVersion: config.upstream.version,
  releaseCheckEnabled: config.releaseCheck.enabled,
  casEnabled: config.cas.enabled,
  legacyBridgeCookie: config.legacySso.bridgeCookie,
  databaseEnabled: config.database.enabled,
  databaseConfigSource: !config.database.enabled
    ? 'disabled'
    : config.database.thinkphpEnvPath ? 'thinkphp-env' : 'static-json',
}, null, 2)}\n`)
