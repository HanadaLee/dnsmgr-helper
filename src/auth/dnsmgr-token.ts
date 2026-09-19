import { createHash, randomBytes } from 'node:crypto'

import { DNSMGR_SESSION_TTL_SECONDS } from '../dnsmgr-constants.js'

function md5(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex')
}

function rc4(value: Buffer, key: Buffer): Buffer {
  const box = Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + box[i]! + key[i % key.length]!) % 256
    ;[box[i], box[j]] = [box[j]!, box[i]!]
  }

  const result = Buffer.allocUnsafe(value.length)
  let a = 0
  j = 0
  for (let i = 0; i < value.length; i += 1) {
    a = (a + 1) % 256
    j = (j + box[a]!) % 256
    ;[box[a], box[j]] = [box[j]!, box[a]!]
    result[i] = value[i]! ^ box[(box[a]! + box[j]!) % 256]!
  }
  return result
}

export function createDnsmgrUserToken(
  user: { id: number; password: string },
  systemKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const expiresAt = nowSeconds + DNSMGR_SESSION_TTL_SECONDS
  const payload = `user\t${user.id}\t${md5(`${user.id}${user.password}`)}\t${expiresAt}`
  const key = md5(systemKey)
  const keyA = md5(key.slice(0, 16))
  const keyB = md5(key.slice(16, 32))
  const keyC = randomBytes(2).toString('hex')
  const cryptKey = Buffer.from(`${keyA}${md5(`${keyA}${keyC}`)}`, 'ascii')
  const cleartext = Buffer.from(`0000000000${md5(`${payload}${keyB}`).slice(0, 16)}${payload}`, 'utf8')
  return `${keyC}${rc4(cleartext, cryptKey).toString('base64')}`
}
