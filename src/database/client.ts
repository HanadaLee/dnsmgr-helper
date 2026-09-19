import { randomBytes } from 'node:crypto'

import {
  createPool,
  type Pool,
  type PoolOptions,
  type QueryResult,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise'

import type { AppConfig } from '../config.js'

export type DatabaseStatus = {
  enabled: boolean
  connected: boolean
  error?: string
}

export type DnsmgrUserSessionMaterial = {
  id: number
  password: string
  systemKey: string
}

export class DatabaseClient {
  private readonly pool?: Pool
  private readonly configTable: string
  private readonly logTable: string
  private readonly userTable: string

  constructor(config: AppConfig['database']) {
    this.configTable = `${config.tablePrefix}config`
    this.logTable = `${config.tablePrefix}log`
    this.userTable = `${config.tablePrefix}user`
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

  async prepareManagedUserSession(
    username: string,
    clientIp = '',
  ): Promise<DnsmgrUserSessionMaterial> {
    if (!this.pool) throw new Error('数据库连接未启用')
    if (Array.from(username).length > 64) throw new Error('CAS 用户名不能超过 64 个字符')

    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const configRows = await connection.query<Array<RowDataPacket & { value: string | null }>>(
        `SELECT \`value\` FROM \`${this.configTable}\` WHERE \`key\` = 'sys_key' LIMIT 1`,
      )
      const systemKey = configRows[0][0]?.value
      if (!systemKey) throw new Error('dnsmgr 缺少 config.sys_key')

      const userRows = await connection.query<Array<RowDataPacket & {
        id: number
        password: string
        status: number
      }>>(
        `SELECT \`id\`, \`password\`, \`status\` FROM \`${this.userTable}\` WHERE \`username\` = ? ORDER BY \`id\` ASC LIMIT 1 FOR UPDATE`,
        [username],
      )
      let user = userRows[0][0]
      if (!user) {
        const password = `$dnsmgr-helper$${randomBytes(32).toString('base64url')}`
        const result = await connection.query<ResultSetHeader>(
          `INSERT INTO \`${this.userTable}\` (\`username\`, \`password\`, \`is_api\`, \`apikey\`, \`level\`, \`regtime\`, \`lasttime\`, \`totp_open\`, \`totp_secret\`, \`status\`) VALUES (?, ?, 0, NULL, 1, NOW(), NOW(), 0, NULL, 1)`,
          [username, password],
        )
        user = { id: result[0].insertId, password, status: 1 } as typeof userRows[0][number]
      }

      if (Number(user.status) !== 1) throw new Error('dnsmgr 用户已被禁用')
      if (userRows[0][0]) {
        await connection.query(
          `UPDATE \`${this.userTable}\` SET \`lasttime\` = NOW() WHERE \`id\` = ?`,
          [user.id],
        )
      }

      await connection.query(
        `INSERT INTO \`${this.logTable}\` (\`uid\`, \`action\`, \`data\`, \`addtime\`) VALUES (?, ?, ?, NOW())`,
        [user.id, 'CAS 登录后台', `IP:${clientIp}`],
      )
      await connection.commit()
      return { id: Number(user.id), password: String(user.password), systemKey }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
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
