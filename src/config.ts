import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { DNSMGR_BRIDGE_COOKIE, DNSMGR_SESSION_COOKIE } from './dnsmgr-constants.js'

const OptionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
)

const OptionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.url().optional(),
)

const OptionalHeaderValue = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).refine((value) => !/[\r\n]/.test(value), '不能包含换行符').optional(),
)

const OptionalCookieDomain = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().regex(/^\.?[A-Za-z0-9.-]+$/).optional(),
)

const RelativePath = z.string().startsWith('/').refine(
  (value) => !value.startsWith('//'),
  '必须是站内绝对路径',
)

const CookieName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)

const CasAttributesSchema = z.object({
  user: z.string().min(1).default('user'),
  email: z.string().min(1).default('email'),
  displayName: z.string().min(1).default('displayName'),
  avatar: z.string().min(1).default('avatar'),
}).default({
  user: 'user',
  email: 'email',
  displayName: 'displayName',
  avatar: 'avatar',
})

const ConfigSchema = z.object({
  server: z.object({
    environment: z.enum(['development', 'test', 'production']).default('production'),
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).default(3001),
    publicUrl: z.url(),
  }),
  upstream: z.object({
    url: z.url(),
    host: OptionalNonEmptyString,
    version: z.string().regex(/^\d+$/).default('1051'),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(15_000),
  }),
  releaseCheck: z.object({
    enabled: z.boolean().default(true),
    url: z.url().default('https://auth.cccyun.cc/app/dnsmgr.php'),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
  }).default({
    enabled: true,
    url: 'https://auth.cccyun.cc/app/dnsmgr.php',
    requestTimeoutMs: 10_000,
  }),
  cas: z.object({
    enabled: z.boolean().default(true),
    baseUrl: OptionalUrl,
    validationUrl: OptionalUrl,
    validationHost: OptionalHeaderValue,
    loginPath: RelativePath.default('/cas/login'),
    callbackPath: RelativePath.default('/cas/callback'),
    logoutPath: RelativePath.default('/cas/logout'),
    logoutRedirectPath: RelativePath.default('/'),
    sessionCookie: CookieName.default('dnsmgr_helper_session'),
    sessionSecret: OptionalNonEmptyString,
    sessionTtlSeconds: z.number().int().min(60).max(31_536_000).default(604_800),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(15_000),
    cookieSecure: z.boolean().default(true),
    cookieSameSite: z.enum(['strict', 'lax', 'none']).default('lax'),
    cookieDomain: OptionalCookieDomain,
    attributes: CasAttributesSchema,
  }),
  oidc: z.object({
    enabled: z.boolean().default(false),
    issuer: OptionalUrl,
    clientId: OptionalNonEmptyString,
    clientSecret: OptionalNonEmptyString,
    logoutUrl: OptionalUrl,
    usernameClaim: z.string().min(1).default('preferred_username'),
    requestTimeoutMs: z.number().int().min(100).max(300_000).default(15_000),
  }).default({ enabled: false, usernameClaim: 'preferred_username', requestTimeoutMs: 15_000 }),
  auth: z.object({
    requiredProvider: z.enum(['any', 'cas', 'oidc']).default('any'),
    sessionCookie: CookieName.optional(),
    sessionSecret: OptionalNonEmptyString,
    sessionTtlSeconds: z.number().int().min(60).max(31_536_000).optional(),
    cookieSecure: z.boolean().optional(),
    cookieSameSite: z.enum(['strict', 'lax', 'none']).optional(),
    cookieDomain: OptionalCookieDomain,
  }).default({ requiredProvider: 'any' }),
  legacySso: z.object({
    adminUser: OptionalNonEmptyString,
    managedPassword: OptionalNonEmptyString,
  }).default({}),
  database: z.object({
    enabled: z.boolean().default(false),
    thinkphpEnvPath: OptionalNonEmptyString,
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).default(3306),
    socketPath: OptionalNonEmptyString,
    user: z.string().min(1).default('dnsmgr_helper'),
    password: z.string().default(''),
    name: z.string().min(1).default('dnsmgr'),
    charset: z.string().regex(/^[A-Za-z0-9_-]+$/).default('utf8mb4'),
    tablePrefix: z.string().regex(/^[A-Za-z0-9_]*$/).default('dnsmgr_'),
    connectionLimit: z.number().int().min(1).max(100).default(5),
    connectTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    ssl: z.boolean().default(false),
  }),
}).superRefine((value, context) => {
  const authPaths = [value.cas.loginPath, value.cas.callbackPath, value.cas.logoutPath,
    '/oidc/login', '/oidc/callback', '/oidc/logout', '/oidc/logged-out']
  if (new Set(authPaths).size !== authPaths.length
    || value.cas.callbackPath === '/login' || value.cas.callbackPath === '/logout'
    || (value.cas.loginPath === '/logout' || value.cas.logoutPath === '/login')
    || (value.oidc.enabled
      && (value.cas.loginPath === '/login' || value.cas.logoutPath === '/logout'))) {
    context.addIssue({ code: 'custom', path: ['cas'], message: '登录、回调和退出路径不能重复' })
  }
  const cookieNames = [
    value.auth.sessionCookie ?? value.cas.sessionCookie,
    DNSMGR_SESSION_COOKIE,
    DNSMGR_BRIDGE_COOKIE,
    'dnsmgr_helper_oidc_state',
    'dnsmgr_helper_oidc_logout',
    'dnsmgr_helper_oidc_token',
    'dnsmgr_helper_signed_out',
  ]
  if (new Set(cookieNames).size !== cookieNames.length) {
    context.addIssue({
      code: 'custom',
      path: ['cas', 'sessionCookie'],
      message: 'CAS Session Cookie 不能与固定的 dnsmgr Cookie 名称重复',
    })
  }
  if ((value.auth.cookieSameSite ?? value.cas.cookieSameSite) === 'none'
    && !(value.auth.cookieSecure ?? value.cas.cookieSecure)) {
    context.addIssue({ code: 'custom', path: ['cas', 'cookieSecure'], message: 'SameSite=None 时必须启用 Secure' })
  }
  if (value.oidc.enabled && (value.auth.cookieSameSite ?? value.cas.cookieSameSite) === 'strict') {
    context.addIssue({ code: 'custom', path: ['auth', 'cookieSameSite'], message: 'OIDC 回调需要 SameSite=Lax 或 None' })
  }
  if (value.auth.requiredProvider === 'cas' && !value.cas.enabled) {
    context.addIssue({ code: 'custom', path: ['auth', 'requiredProvider'], message: '强制 CAS 登录时必须启用 CAS' })
  }
  if (value.auth.requiredProvider === 'oidc' && !value.oidc.enabled) {
    context.addIssue({ code: 'custom', path: ['auth', 'requiredProvider'], message: '强制 OIDC 登录时必须启用 OIDC' })
  }
  if (value.oidc.enabled) {
    if (!value.oidc.issuer || !value.oidc.clientId || !value.oidc.clientSecret) {
      context.addIssue({ code: 'custom', path: ['oidc'], message: '启用 OIDC 时必须配置 issuer、clientId 和 clientSecret' })
    }
    if (value.server.environment === 'production' && value.oidc.issuer && !value.oidc.issuer.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['oidc', 'issuer'], message: '生产环境 OIDC issuer 必须使用 HTTPS' })
    }
    if (value.oidc.issuer) {
      const issuer = new URL(value.oidc.issuer)
      if (issuer.username || issuer.password || issuer.search || issuer.hash) {
        context.addIssue({ code: 'custom', path: ['oidc', 'issuer'], message: 'OIDC issuer 不能包含凭据、查询或片段' })
      }
    }
    if (value.oidc.logoutUrl && value.server.environment === 'production'
      && !value.oidc.logoutUrl.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['oidc', 'logoutUrl'], message: '生产环境 OIDC 退出地址必须使用 HTTPS' })
    }
  }
  if (!value.cas.enabled && !value.oidc.enabled) return

  if (value.cas.enabled && !value.cas.baseUrl) {
    context.addIssue({ code: 'custom', path: ['cas', 'baseUrl'], message: '启用 CAS 时必须配置 baseUrl' })
  }
  const sessionSecret = value.auth.sessionSecret ?? value.cas.sessionSecret
  if (!sessionSecret || sessionSecret.length < 32) {
    context.addIssue({
      code: 'custom',
      path: ['auth', 'sessionSecret'],
      message: '启用统一登录时 sessionSecret 至少需要 32 个字符',
    })
  }
  if (!value.database.enabled && !value.legacySso.adminUser) {
    context.addIssue({ code: 'custom', path: ['legacySso', 'adminUser'], message: '启用统一登录时必须配置管理员用户' })
  }
  if (!value.database.enabled && !value.legacySso.managedPassword) {
    context.addIssue({ code: 'custom', path: ['legacySso', 'managedPassword'], message: '启用统一登录时必须配置托管密码' })
  }
})

type ParsedConfig = z.output<typeof ConfigSchema>

export type AppConfig = Omit<ParsedConfig, 'server' | 'upstream' | 'cas' | 'oidc' | 'auth' | 'releaseCheck'> & {
  sourcePath?: string
  server: Omit<ParsedConfig['server'], 'publicUrl'> & { publicUrl: URL }
  upstream: Omit<ParsedConfig['upstream'], 'url'> & { url: URL }
  releaseCheck: Omit<ParsedConfig['releaseCheck'], 'url'> & { url: URL }
  cas: Omit<ParsedConfig['cas'], 'baseUrl' | 'validationUrl'> & {
    baseUrl?: URL
    validationUrl?: URL
  }
  oidc: Omit<ParsedConfig['oidc'], 'issuer' | 'logoutUrl'> & { issuer?: URL; logoutUrl?: URL }
  auth: ParsedConfig['auth'] & {
    sessionCookie: string
    sessionTtlSeconds: number
    cookieSecure: boolean
    cookieSameSite: 'strict' | 'lax' | 'none'
  }
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value)
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unquoteIniValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed

  const first = trimmed[0]
  const last = trimmed.at(-1)
  return (first === '"' || first === "'") && last === first
    ? trimmed.slice(1, -1)
    : trimmed
}

function parseThinkphpDatabaseEnv(source: string, sourcePath: string): Record<string, unknown> {
  const values = new Map<string, string>()
  let section = ''

  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    const sectionMatch = /^\[([^\]]+)]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1]?.trim().toUpperCase() ?? ''
      continue
    }
    if (section !== 'DATABASE') continue

    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim().toUpperCase()
    const value = unquoteIniValue(line.slice(separator + 1))
    values.set(key, value)
  }

  if (values.size === 0) {
    throw new Error(`ThinkPHP 环境文件 ${sourcePath} 缺少 [DATABASE] 配置段`)
  }

  const databaseType = values.get('TYPE')
  if (databaseType && databaseType.toLowerCase() !== 'mysql') {
    throw new Error(`ThinkPHP 环境文件 ${sourcePath} 的 DATABASE.TYPE 只支持 mysql`)
  }

  const requiredValue = (key: string, allowEmpty = false): string => {
    const value = values.get(key)
    if (value === undefined || (!allowEmpty && value === '')) {
      throw new Error(`ThinkPHP 环境文件 ${sourcePath} 缺少 DATABASE.${key}`)
    }
    return value
  }

  const host = requiredValue('HOSTNAME')
  const name = requiredValue('DATABASE')
  const user = requiredValue('USERNAME')
  const password = requiredValue('PASSWORD', true)
  const rawPort = values.get('HOSTPORT')
  const charset = values.get('CHARSET')
  const tablePrefix = values.get('PREFIX')

  if (rawPort !== undefined && !/^\d+$/.test(rawPort)) {
    throw new Error(`ThinkPHP 环境文件 ${sourcePath} 的 DATABASE.HOSTPORT 必须是端口号`)
  }
  if (charset !== undefined && charset === '') {
    throw new Error(`ThinkPHP 环境文件 ${sourcePath} 的 DATABASE.CHARSET 不能为空`)
  }

  return {
    host,
    name,
    user,
    password,
    ...(rawPort !== undefined ? { port: Number(rawPort) } : {}),
    ...(charset !== undefined ? { charset } : {}),
    ...(tablePrefix !== undefined ? { tablePrefix } : {}),
  }
}

async function mergeThinkphpDatabaseConfig(
  input: unknown,
  configPath: string,
): Promise<unknown> {
  if (!isRecord(input) || !isRecord(input.database)) return input

  const database = input.database
  const configuredPath = database.thinkphpEnvPath
  if (database.enabled !== true
    || typeof configuredPath !== 'string'
    || configuredPath.trim() === '') {
    return input
  }

  const sourcePath = path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(path.dirname(configPath), configuredPath)

  let source: string
  try {
    source = await readFile(sourcePath, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取 ThinkPHP 环境文件 ${sourcePath}: ${reason}`)
  }

  const credentials = parseThinkphpDatabaseEnv(source, sourcePath)
  return {
    ...input,
    database: {
      ...database,
      ...credentials,
      thinkphpEnvPath: sourcePath,
    },
  }
}

export function parseConfig(input: unknown, sourcePath?: string): AppConfig {
  const parsed = ConfigSchema.parse(input)
  const { baseUrl, validationUrl, ...cas } = parsed.cas
  const { issuer, logoutUrl, ...oidc } = parsed.oidc
  return {
    ...(sourcePath ? { sourcePath } : {}),
    server: {
      ...parsed.server,
      publicUrl: normalizedBaseUrl(parsed.server.publicUrl),
    },
    upstream: {
      ...parsed.upstream,
      url: normalizedBaseUrl(parsed.upstream.url),
    },
    releaseCheck: {
      ...parsed.releaseCheck,
      url: new URL(parsed.releaseCheck.url),
    },
    cas: {
      ...cas,
      ...(baseUrl ? { baseUrl: normalizedBaseUrl(baseUrl) } : {}),
      ...(validationUrl
        ? { validationUrl: normalizedBaseUrl(validationUrl) }
        : {}),
    },
    oidc: {
      ...oidc,
      ...(issuer ? { issuer: new URL(issuer) } : {}),
      ...(logoutUrl ? { logoutUrl: new URL(logoutUrl) } : {}),
    },
    auth: {
      ...parsed.auth,
      sessionCookie: parsed.auth.sessionCookie ?? parsed.cas.sessionCookie,
      sessionSecret: parsed.auth.sessionSecret ?? parsed.cas.sessionSecret,
      sessionTtlSeconds: parsed.auth.sessionTtlSeconds ?? parsed.cas.sessionTtlSeconds,
      cookieSecure: parsed.auth.cookieSecure ?? parsed.cas.cookieSecure,
      cookieSameSite: parsed.auth.cookieSameSite ?? parsed.cas.cookieSameSite,
      cookieDomain: parsed.auth.cookieDomain ?? parsed.cas.cookieDomain,
    },
    legacySso: parsed.legacySso,
    database: parsed.database,
  }
}

export async function loadConfig(configPath = process.env.DNSMGR_HELPER_CONFIG): Promise<AppConfig> {
  const resolvedPath = path.resolve(configPath || 'config/dnsmgr-helper.json')
  let source: string
  try {
    source = await readFile(resolvedPath, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取 dnsmgr-helper 配置文件 ${resolvedPath}: ${reason}`)
  }

  let input: unknown
  try {
    input = JSON.parse(source) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`dnsmgr-helper 配置文件不是有效 JSON: ${reason}`)
  }

  const mergedInput = await mergeThinkphpDatabaseConfig(input, resolvedPath)
  return parseConfig(mergedInput, resolvedPath)
}
