import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const domains = [
  { id: 1, name: 'example.com', aid: 7, type: 'cloudflare', typename: 'Cloudflare', aremark: '生产账号', recordcount: 4, addtime: '2025-02-03 04:05:06', expiretime: '2027-12-18 00:00:00', checkstatus: 1, is_notice: 1, is_hide: 0, is_sso: 0, category_name: '生产', remark: '官方网站' },
  { id: 2, name: 'example.net', aid: 8, type: 'aliyun', typename: '阿里云 DNS', recordcount: 2, addtime: '2025-04-10 09:30:00', expiretime: '2026-08-01 00:00:00', checkstatus: 1, is_notice: 1, is_hide: 0, is_sso: 0, category_name: '基础设施', remark: '邮件域名' },
  { id: 3, name: 'internal.example', aid: 9, type: 'technitium', typename: 'Technitium', recordcount: 1, addtime: '2026-01-08 15:20:00', expiretime: null, checkstatus: 0, is_notice: 0, is_hide: 0, is_sso: 1, category_name: '内网', remark: '' },
]

const records = [
  { RecordId: 'r1', Name: '@', Type: 'A', Value: '192.0.2.10', Line: '0', LineName: '默认', TTL: 600, Status: '1', Remark: '网站入口' },
  { RecordId: 'r2', Name: 'www', Type: 'CNAME', Value: 'example.com', Line: '0', LineName: '默认', TTL: 600, Status: '1' },
  { RecordId: 'r3', Name: 'mail', Type: 'MX', Value: 'mx.example.com', Line: '0', LineName: '默认', TTL: 300, MX: 10, Status: '1' },
  { RecordId: 'r4', Name: '_verify', Type: 'TXT', Value: 'dnsmgr-helper-browser-fixture', Line: 'oversea', LineName: '境外', TTL: 300, Status: '0' },
]

async function body(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:3101')
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>
      <span class="hidden-xs">hanada</span><small>2025-01-02 03:04:05</small>
      <a href="/">后台首页</a><a href="/domain">域名管理</a><a href="/account">域名账户</a>
      <a href="/domain/category">分类</a><a href="/system/cronset">设置</a><a href="/log">日志</a>
      <a href="/setpwd">密码</a><script src="//auth.example/app/dnsmgr.php?ver=1051"></script>
    </body></html>`)
    return
  }

  if (request.method === 'POST' && url.pathname === '/domain/data') {
    const form = await body(request)
    const id = Number(form.get('id'))
    const q = (form.get('kw') ?? '').toLowerCase()
    const filtered = domains.filter((domain) => (!id || domain.id === id)
      && (!q || domain.name.toLowerCase().includes(q) || domain.remark.toLowerCase().includes(q)))
    json(response, { total: filtered.length, rows: filtered })
    return
  }

  if (request.method === 'POST' && /^\/record\/data\/\d+$/.test(url.pathname)) {
    const form = await body(request)
    const q = (form.get('keyword') ?? '').toLowerCase()
    const filtered = records.filter((record) => !q
      || record.Name.toLowerCase().includes(q)
      || record.Value.toLowerCase().includes(q)
      || ('Remark' in record && record.Remark?.toLowerCase().includes(q)))
    json(response, { total: filtered.length, rows: filtered })
    return
  }

  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ code: -1, message: 'fixture route not found' }))
})

server.listen(3101, '127.0.0.1', () => {
  process.stdout.write('mock dnsmgr upstream listening on http://127.0.0.1:3101\n')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
