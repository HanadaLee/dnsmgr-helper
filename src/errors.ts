import type { FastifyInstance, FastifyReply } from 'fastify'
import { ZodError } from 'zod'

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function sendApiError(reply: FastifyReply, error: ApiError) {
  return reply.code(error.statusCode).send({
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  })
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.code === 'AUTH_REQUIRED') {
        const details = error.details && typeof error.details === 'object'
          ? error.details as Record<string, unknown>
          : undefined
        request.log.warn({ authSource: details?.source }, 'authentication required')
      }
      return sendApiError(reply, error)
    }

    if (error instanceof ZodError) {
      return reply.code(422).send({
        code: 'VALIDATION_ERROR',
        message: '请求参数不合法',
        details: error.issues,
      })
    }

    app.log.error(error)
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: '服务内部错误',
    })
  })
}
