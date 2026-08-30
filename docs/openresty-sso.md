# OpenResty / CAS 对接

## 结论

现有三个组成部分无需移入 helper，也不应由 Node.js 重写：

- `http_dns.hanada.info.conf` 继续维护公开入口与 Cookie 域；
- `auth_sso_adapter_dnsmgr.lua` 继续把 CAS 用户映射为原 dnsmgr 用户，并取得 `user_token`；
- `auth_cas.lua` 继续签发和校验 `resty_cas_jwt`。

helper 是第二层翻译器：它验证 CAS 证明（生产建议强制），再把同一请求的 `user_token` 交给原 dnsmgr 验证。两层任一失效都返回 JSON 401。

```text
浏览器
  ├─ /cas/login ──> 现有 auth_sso_adapter ──> 原 dnsmgr /login
  │                                      └─> Set-Cookie: user_token
  └─ /api/web/v1/* ──> dnsmgr-helper ──> 私有原版入口 ──> 原 dnsmgr
       │                    │                                  │
       │ CAS JWT            └─ 只翻译白名单接口                └─ 最终业务权限
       └─ user_token 全程保持同源 Cookie
```

## 必须保留的公开路径

以下路径应继续使用当前网关逻辑，不能交给 SPA 或 helper：

- `/login`
- `/logout`
- `/cas/login`
- `/cas/register`
- `/cas/logout`
- `/user/op/act/edit`
- `/setpwd`

原版 `/api` 也可以继续保留；新的浏览器 BFF 使用更具体的 `/api/web/v1/`，由 nginx 最长前缀匹配到 helper。

## 推荐上游拓扑

不要让 helper 通过最终的 SPA `/` 再访问公开站点，否则切换前端后会形成错误回环。应给原 dnsmgr 增加一个仅回环地址可访问的路径前缀，或直接提供一个仅内网监听的 HTTP 端口。

路径前缀方案示例：

```nginx
location ^~ /__dnsmgr_legacy/ {
    allow 127.0.0.1;
    allow ::1;
    deny all;

    rewrite ^/__dnsmgr_legacy/(.*)$ /$1 break;
    set $no_cache 1;
    include snippet/http_proxy_select_pass.conf;
}
```

对应 helper 配置：

```dotenv
DNSMGR_UPSTREAM_URL=http://127.0.0.1:<gateway-port>/__dnsmgr_legacy/
DNSMGR_UPSTREAM_HOST=dns.hanada.info
```

helper 会保留配置中的路径前缀。例如对稳定 API `/domains` 的请求最终会访问私有入口 `/__dnsmgr_legacy/domain/data`。私有入口本身不执行 CAS 跳转，但原 dnsmgr 中间件仍会严格验证转发的 `user_token`。

## helper 的公开入口

在现有 `location /api` 之外增加更具体的前缀：

```nginx
location ^~ /api/web/v1/ {
    set $no_cache 1;

    proxy_http_version 1.1;
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $edge_request_scheme;
    proxy_set_header X-Request-ID $request_id;
}
```

不要在这个 location 上直接使用会发出 302 的 `auth_cas authorize`。helper 在 `DNSMGR_REQUIRE_CAS_JWT=true` 时自行校验同一个 JWT，并以 JSON 401 返回 `/cas/login`，避免 `fetch()` 静默跟随到 CAS HTML 页面。

helper 应只监听回环地址，私有原版入口也必须限制回环访问。

## 前端切换

建议分两步发布：

1. 将前端以 `VITE_BASE_PATH=/next/` 构建，挂载到 `/next/` 做只读联调，保留当前 `location /`；
2. 联调通过后以 `VITE_BASE_PATH=/` 重建，用 SPA `try_files` 替换当前根页面代理。

可直接合并的完整 location 片段见 [`deploy/openresty-locations.conf.example`](../deploy/openresty-locations.conf.example)。阶段性部署应把构建产物放入 `/srv/dnsmgr-frontend/next/`；最终切换示例使用 `/srv/dnsmgr-frontend/current/`，两者不会覆盖原 PHP 源码。

最终根路径示意：

```nginx
location ^~ /assets/ {
    root /srv/dnsmgr-frontend;
    try_files $uri =404;
    expires 30d;
}

location / {
    set $no_cache 1;
    set $remote_user_avatar "";
    when !realip_remote_is_unix_domain {
        lua_config auth_cas authorize;
    }

    root /srv/dnsmgr-frontend;
    try_files $uri /index.html;
}
```

`location ^~ /assets/` 很重要：当前配置中已有匹配 `.js/.css` 的正则 location，没有 `^~` 时新前端静态资源会被送到原 dnsmgr。

## 密钥和权限边界

- 不要把 CAS JWT 密钥或 dnsmgr 托管密码写入两个 Git 仓库；使用服务环境或密钥管理器注入。
- `DNSMGR_REQUIRE_CAS_JWT=true` 时，缺失、过期或签名错误的 CAS Cookie 会在访问原版服务前被拒绝。
- CAS claim 只用于头像、显示名和邮箱；域名可见范围、管理员级别和记录权限仍完全来自原 dnsmgr。
- helper 只允许源码中声明的固定上游路径，不能作为通用反向代理使用。
- 当前写能力为 `false`，因此不会通过兼容层修改真实 DNS 数据。
