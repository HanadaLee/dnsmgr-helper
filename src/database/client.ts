import {
  createPool,
  type Pool,
  type PoolOptions,
  type QueryResult,
  type RowDataPacket,
} from 'mysql2/promise'

import type { AppConfig } from '../config.js'

export type DatabaseStatus = {
  enabled: boolean
  connected: boolean
  error?: string
}

export class DatabaseClient {
  private readonly pool?: Pool
  private readonly configTable: string

  constructor(config: AppConfig['database']) {
    this.configTable = `${config.tablePrefix}config`
    if (!config.enabled) return

    const options: PoolOptions = {
      ...(config.socketPath
        ? { socketPath: config.socketPath }
        : { host: config.host, port: config.port }),
      user: config.user,
      password: config.password,
      database: config.name,
      connectionLimit: config.connectionLimit,
      connectTimeout: config.connectTimeoutMs,
      waitForConnections: true,
      enableKeepAlive: true,
      charset: config.charset,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    }
    this.pool = createPool(options)
  }

  get enabled(): boolean {
    return Boolean(this.pool)
  }

  async query<T extends QueryResult>(sql: string, values: unknown[] = []): Promise<T> {
    if (!this.pool) throw new Error('数据库连接未启用')
    const [result] = await this.pool.query(sql, values)
    return result as T
  }

  async getConfigValues(keys: string[]): Promise<Record<string, string>> {
    if (!this.pool || keys.length === 0) return {}
    const placeholders = keys.map(() => '?').join(',')
    const rows = await this.query<Array<RowDataPacket & { key: string; value: string | null }>>(
      `SELECT \`key\`, \`value\` FROM \`${this.configTable}\` WHERE \`key\` IN (${placeholders})`,
      keys,
    )
    return Object.fromEntries(rows.map((row) => [row.key, row.value ?? '']))
  }

  async status(): Promise<DatabaseStatus> {
    if (!this.pool) return { enabled: false, connected: false }

    try {
      await this.pool.query('SELECT 1')
      return { enabled: true, connected: true }
    } catch (error) {
      return {
        enabled: true,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async close(): Promise<void> {
    await this.pool?.end()
  }
}
