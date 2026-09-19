import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createDnsmgrUserToken } from '../src/auth/dnsmgr-token.js'
import { DNSMGR_SESSION_TTL_SECONDS } from '../src/dnsmgr-constants.js'

function md5(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex')
}

function decodeAuthcode(token: string, systemKey: string): string {
  const keyC = token.slice(0, 4)
  const key = md5(systemKey)
  const keyA = md5(key.slice(0, 16))
  const keyB = md5(key.slice(16, 32))
  const cryptKey = Buffer.from(`${keyA}${md5(`${keyA}${keyC}`)}`, 'ascii')
  const input = Buffer.from(token.slice(4), 'base64')
  const box = Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + box[i]! + cryptKey[i % cryptKey.length]!) % 256
    ;[box[i], box[j]] = [box[j]!, box[i]!]
  }

  const decoded = Buffer.allocUnsafe(input.length)
  let a = 0
  j = 0
  for (let i = 0; i < input.length; i += 1) {
    a = (a + 1) % 256
    j = (j + box[a]!) % 256
    ;[box[a], box[j]] = [box[j]!, box[a]!]
    decoded[i] = input[i]! ^ box[(box[a]! + box[j]!) % 256]!
  }

  const value = decoded.toString('utf8')
  const payload = value.slice(26)
  expect(value.slice(0, 10)).toBe('0000000000')
  expect(value.slice(10, 26)).toBe(md5(`${payload}${keyB}`).slice(0, 16))
  return payload
}

describe('dnsmgr user token', () => {
  it('matches the authcode payload expected by dnsmgr', () => {
    const now = 1_789_689_600
    const user = { id: 42, password: '$2y$10$stored-password-hash' }
    const token = createDnsmgrUserToken(user, 'system-key', now)

    expect(decodeAuthcode(token, 'system-key')).toBe(
      `user\t42\t${md5(`${user.id}${user.password}`)}\t${now + DNSMGR_SESSION_TTL_SECONDS}`,
    )
  })
})
