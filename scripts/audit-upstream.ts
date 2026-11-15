import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalizeDynamicField } from '../src/adapters/v1051/dynamic-fields.js'

function scalar(token: string): unknown {
  if (token.startsWith("'")) return token.slice(1, -1).replace(/\\(['\\])/g, '$1')
  if (token === 'true' || token === 'false') return token === 'true'
  return token === 'null' ? null : Number(token)
}

// Inspect literal metadata only; never execute PHP from the repository under audit.
export function auditFieldDefinitions(source: string) {
  const fields = [...source.matchAll(/^ {16}'([^']+)'\s*=>\s*\[\r?\n([\s\S]*?)^ {16}\]/gm)]
    .filter((match) => /'type'\s*=>/.test(match[2] ?? ''))
    .map((match) => {
      const key = match[1]!
      const raw = Object.fromEntries([...match[2]!.matchAll(/^ {20}'([^']+)'\s*=>\s*('(?:\\.|[^'\\])*'|true|false|null|-?\d+(?:\.\d+)?)/gm)]
        .map((property) => [property[1]!, scalar(property[2]!)]))
      const prefix = source.slice(0, match.index)
      const provider = [...prefix.matchAll(/^ {8}'([^']+)'\s*=>\s*\[/gm)].at(-1)?.[1] ?? '?'
      const normalized = normalizeDynamicField(key, raw)
      assert.ok(normalized, `${provider}.${key} was silently omitted`)
      assert.equal(normalized.control, raw.type, `${provider}.${key} changed control type`)
      return { provider, key, control: normalized.control }
    })
  assert.ok(fields.length, 'No fields found: review the upstream metadata format')
  assert.equal(fields.length, [...source.matchAll(/'type'\s*=>\s*'[^']+'/g)].length, 'Some upstream field declarations were not inspected')
  return fields
}

export function upstreamRoutes(source: string) {
  return [...source.matchAll(/Route::(get|post|any)\('([^']+)'\s*,\s*'([^']+)'/g)]
    .map((match) => `${match[1]!.toUpperCase()} ${match[2]} => ${match[3]}`)
}

export function auditUpstream(root: string) {
  const fields = ['DnsHelper', 'CertHelper', 'DeployHelper'].flatMap((name) => auditFieldDefinitions(readFileSync(resolve(root, `app/lib/${name}.php`), 'utf8')))
  const routes = upstreamRoutes(readFileSync(resolve(root, 'route/app.php'), 'utf8'))
  const baseline = JSON.parse(readFileSync(new URL('../test/fixtures/upstream-route-baseline.json', import.meta.url), 'utf8')) as string[]
  assert.deepEqual(routes, baseline, 'Upstream routes changed: audit new/changed workflows and update the reviewed baseline')
  let settings = 0
  for (const [view, adapter] of [
    ['system/loginset', 'system-settings'], ['system/noticeset', 'system-settings'],
    ['system/proxyset', 'system-settings'], ['system/cronset', 'system-settings'],
    ['domain/expire_notice', 'domain-actions'], ['cert/certset', 'certificate-settings'], ['dmonitor/overview', 'monitoring'],
  ]) {
    const html = readFileSync(resolve(root, `app/view/${view}.html`), 'utf8')
    const code = readFileSync(new URL(`../src/adapters/v1051/${adapter}.ts`, import.meta.url), 'utf8')
    const keys = new Set([...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bname=["']([A-Za-z_]\w*)["']/g)].map((match) => match[1]!))
    keys.delete('submit')
    for (const key of keys) assert.ok(code.includes(key), `${view}: setting ${key} is missing from ${adapter}`)
    settings += keys.size
  }
  return { fields: fields.length, tagFields: fields.filter((field) => field.control === 'tags'), settings, routes: routes.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(auditUpstream(resolve(process.argv[2] ?? '../dnsmgr')), null, 2))
}
