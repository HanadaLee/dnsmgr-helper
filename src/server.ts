import { buildApp } from './app.js'
import { loadConfig } from './config.js'

const config = await loadConfig()
const app = await buildApp({ config })

try {
  await app.listen({ host: config.server.host, port: config.server.port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
