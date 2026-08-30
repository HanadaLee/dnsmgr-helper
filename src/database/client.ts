import {
  createPool,
  type Pool,
  type PoolOptions,
  type QueryResult,
} from 'mysql2/promise'

import type { AppConfig } from '../config.js'

export type DatabaseStatus = {
  enabled: boolean
  connected: boolean
  error?: string
}

export class DatabaseClient {
  private readonly pool?: Pool

  constructor(config: AppConfig['database']) {
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
      charset: 'utf8mb4',
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
