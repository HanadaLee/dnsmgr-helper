import { z } from 'zod'

const OptionalNonEmptyString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
)

const BooleanString = z.enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1')

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DNSMGR_UPSTREAM_URL: z.string().url().default('http://127.0.0.1:8081/'),
  DNSMGR_UPSTREAM_HOST: OptionalNonEmptyString,
  DNSMGR_UPSTREAM_VERSION: z.string().regex(/^\d+$/).default('1051'),
  DNSMGR_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(15_000),
  DNSMGR_CAS_LOGIN_PATH: z.string().startsWith('/').default('/cas/login'),
  DNSMGR_CAS_LOGOUT_PATH: z.string().startsWith('/').default('/cas/logout'),
  DNSMGR_CAS_JWT_COOKIE: z.string().min(1).default('resty_cas_jwt'),
  DNSMGR_CAS_JWT_SECRET: OptionalNonEmptyString,
  DNSMGR_REQUIRE_CAS_JWT: BooleanString,
}).superRefine((value, context) => {
  if (value.DNSMGR_REQUIRE_CAS_JWT && !value.DNSMGR_CAS_JWT_SECRET) {
    context.addIssue({
      code: 'custom',
      path: ['DNSMGR_CAS_JWT_SECRET'],
      message: 'DNSMGR_REQUIRE_CAS_JWT=true 时必须配置 CAS JWT 密钥',
    })
  }
})

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  upstreamUrl: URL
  upstreamHost?: string
  upstreamVersion: string
  requestTimeoutMs: number
  casLoginPath: string
  casLogoutPath: string
  casJwtCookie: string
  casJwtSecret?: string
  requireCasJwt: boolean
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.parse(environment)
  const upstreamUrl = new URL(parsed.DNSMGR_UPSTREAM_URL)
  if (!upstreamUrl.pathname.endsWith('/')) upstreamUrl.pathname += '/'

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    upstreamUrl,
    ...(parsed.DNSMGR_UPSTREAM_HOST ? { upstreamHost: parsed.DNSMGR_UPSTREAM_HOST } : {}),
    upstreamVersion: parsed.DNSMGR_UPSTREAM_VERSION,
    requestTimeoutMs: parsed.DNSMGR_REQUEST_TIMEOUT_MS,
    casLoginPath: parsed.DNSMGR_CAS_LOGIN_PATH,
    casLogoutPath: parsed.DNSMGR_CAS_LOGOUT_PATH,
    casJwtCookie: parsed.DNSMGR_CAS_JWT_COOKIE,
    requireCasJwt: parsed.DNSMGR_REQUIRE_CAS_JWT,
    ...(parsed.DNSMGR_CAS_JWT_SECRET
      ? { casJwtSecret: parsed.DNSMGR_CAS_JWT_SECRET }
      : {}),
  }
}
