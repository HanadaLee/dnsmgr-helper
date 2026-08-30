import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

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
  legacySso: z.object({
    adminUser: OptionalNonEmptyString,
    managedPassword: OptionalNonEmptyString,
    loginPath: RelativePath.default('/login'),
    registerPath: RelativePath.default('/user/op/act/add'),
    sessionCookie: CookieName.default('user_token'),
  }),
  database: z.object({
    enabled: z.boolean().default(false),
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).default(3306),
    socketPath: OptionalNonEmptyString,
    user: z.string().min(1).default('dnsmgr_helper'),
    password: z.string().default(''),
    name: z.string().min(1).default('dnsmgr'),
    connectionLimit: z.number().int().min(1).max(100).default(5),
    connectTimeoutMs: z.number().int().min(100).max(300_000).default(10_000),
    ssl: z.boolean().default(false),
  }),
}).superRefine((value, context) => {
  const authPaths = [value.cas.loginPath, value.cas.callbackPath, value.cas.logoutPath]
  if (new Set(authPaths).size !== authPaths.length) {
    context.addIssue({ code: 'custom', path: ['cas'], message: '登录、回调和退出路径不能重复' })
  }
  if (value.cas.sessionCookie === value.legacySso.sessionCookie) {
    context.addIssue({ code: 'custom', path: ['cas', 'sessionCookie'], message: 'helper Session Cookie 不能与原 dnsmgr Cookie 同名' })
  }
  if (value.cas.cookieSameSite === 'none' && !value.cas.cookieSecure) {
    context.addIssue({ code: 'custom', path: ['cas', 'cookieSecure'], message: 'SameSite=None 时必须启用 Secure' })
  }
  if (!value.cas.enabled) return

  if (!value.cas.baseUrl) {
    context.addIssue({ code: 'custom', path: ['cas', 'baseUrl'], message: '启用 CAS 时必须配置 baseUrl' })
  }
  if (!value.cas.sessionSecret || value.cas.sessionSecret.length < 32) {
    context.addIssue({
      code: 'custom',
      path: ['cas', 'sessionSecret'],
      message: '启用 CAS 时 sessionSecret 至少需要 32 个字符',
    })
  }
  if (!value.legacySso.adminUser) {
    context.addIssue({ code: 'custom', path: ['legacySso', 'adminUser'], message: '启用 CAS 时必须配置管理员用户' })
  }
  if (!value.legacySso.managedPassword) {
    context.addIssue({ code: 'custom', path: ['legacySso', 'managedPassword'], message: '启用 CAS 时必须配置托管密码' })
  }
})

type ParsedConfig = z.output<typeof ConfigSchema>

export type AppConfig = Omit<ParsedConfig, 'server' | 'upstream' | 'cas'> & {
  sourcePath?: string
  server: Omit<ParsedConfig['server'], 'publicUrl'> & { publicUrl: URL }
  upstream: Omit<ParsedConfig['upstream'], 'url'> & { url: URL }
  cas: Omit<ParsedConfig['cas'], 'baseUrl' | 'validationUrl'> & {
    baseUrl?: URL
    validationUrl?: URL
  }
}

function normalizedBaseUrl(value: string): URL {
  const url = new URL(value)
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

export function parseConfig(input: unknown, sourcePath?: string): AppConfig {
  const parsed = ConfigSchema.parse(input)
  const { baseUrl, validationUrl, ...cas } = parsed.cas
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
    cas: {
      ...cas,
      ...(baseUrl ? { baseUrl: normalizedBaseUrl(baseUrl) } : {}),
      ...(validationUrl
        ? { validationUrl: normalizedBaseUrl(validationUrl) }
        : {}),
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

  return parseConfig(input, resolvedPath)
}
