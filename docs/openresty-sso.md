# helper 接管 CAS 后的 OpenResty 对接

## 新的职责边界

OpenResty 不再加载或执行站点级 CAS/SSO 逻辑，只负责 TLS、公开路径反向代理和静态资源。以下职责全部由 `dnsmgr-helper` 完成：

- 生成 CAS 登录和退出地址；
- 使用回调的 Ticket 调用 `serviceValidate`；
- 解析 CAS 用户属性并签发 `dnsmgr_helper_session`；
- 使用托管密码登录原 dnsmgr；
- 用户不存在时，用管理员 Cookie 调用原注册控制器；
- 签发浏览器侧的原 `user_token`；
- 在每个 Web API 请求上验证 helper Session，并只向原系统转发 `user_token`。

```text
浏览器
  ├─ /cas/login ───────────────> dnsmgr-helper ──302──> CAS
  ├─ /cas/callback?ticket=... ─> dnsmgr-helper
  │                                  ├─ CAS serviceValidate
  │                                  ├─ 原 dnsmgr 登录/必要时注册
  │                                  └─ Set-Cookie: helper Session + user_token
  └─ /api/web/v1/* ────────────> dnsmgr-helper ──> 原 dnsmgr 白名单控制器

OpenResty：只转发以上路径，不解析 Ticket、不签 JWT、不托管用户密码。
```

## 网关需要移除的站点逻辑

切换完成后，`dns.hanada.info` 站点不再需要以下配置：

- `auth_cas_idp_url` 和站点级 `auth_cas authorize/logout`；
- `auth_sso_adapter dnsmgr` 及全部 `auth_sso_adapter_dnsmgr_*`；
- `/cas/login`、`/cas/register` 的 Lua access handler；
- `/login` 到 `/cas/login` 的网关重定向；
- `/logout` 到 CAS logout 的网关 header 改写；
- 为 SSO 注入的 `$remote_user_*` 变量。

全局 Lua 模块可以继续供其他站点使用；本次只要求 DNS 站点不再调用它们。

## 需要保留的网关路径

以现有 DNS 站点为基础审核并采用完整的 [`deploy/http_dns.hanada.info.conf.example`](../deploy/http_dns.hanada.info.conf.example)：

- `/api/web/v1/`、`/cas/`、`/login`、`/logout` 转发到 helper；
- 原 `/api` 可暂时保留给旧页面；
- `/setpwd`、`/system/loginset` 可以继续做普通外部跳转，它们不再参与认证。

helper 应继续只监听回环地址，并通过 `upstream.url` 直接访问原 dnsmgr；OpenResty 不再为 helper 提供 legacy 中转路径。

## 静态配置对应关系

网关不再保存 CAS 密钥或 dnsmgr 托管密码。它们应填写在被 Git 忽略的 `config/dnsmgr-helper.json`：

```json
{
  "upstream": {
    "url": "http://127.0.0.1:19101/",
    "host": "dns.example.com"
  },
  "cas": {
    "enabled": true,
    "baseUrl": "https://cas.example.com/cas/organization/application/",
    "sessionSecret": "<至少32字符随机值>"
  },
  "legacySso": {
    "adminUser": "<dnsmgr管理员>",
    "managedPassword": "<托管密码>"
  }
}
```

以上只是字段示意，不是完整配置文件。应在完整 JSON 上修改，并运行 `npm run config:check -- config/dnsmgr-helper.json`。

## 无中断迁移顺序

1. 填写 helper 静态配置，但暂时保持 `cas.enabled=false`；
2. 确认 helper `/healthz`、`/readyz` 和只读 API 可访问；
3. 填写 `sessionSecret`、管理员和托管密码，把 `cas.enabled` 改为 `true`；
4. 在本机验证 `/cas/login` 能完成回调并获得两个 Cookie；
5. 再把 DNS 站点的 CAS、login、logout 路径切到 helper，同时删除站点级 Lua SSO；
6. 验证登录、自动创建用户、退出、域名和解析记录；
7. 最后再切换 `/next/` 或根路径的新前端。

在第 4 步完成前直接删除网关 SSO 会造成登录中断，因此仓库中的实际站点配置不应提前切换。

## 前端发布

最终根路径不再需要 `auth_cas authorize`。外层 EdgeResty 使用定制的 `proxy_select` 路由，把静态资源和页面请求发送到映射在 `19103` 的前端容器：

```nginx
location ^~ /assets/ {
    lua_config proxy_select_local http://127.0.0.1:19103;
    proxy_cache_lock_timeout 5s;
    proxy_cache_valid 200 206 365d;
    lua_config client_cache immutable;
    response_header_control clear Set-Cookie;
    include snippet/http_proxy_select_pass.conf;
}

location / {
    lua_config proxy_select_local http://127.0.0.1:19103;
    lua_config client_cache bust;
    set $no_cache 1;
    include snippet/http_proxy_select_pass.conf;
}
```

未登录前端请求 API 时会收到 JSON 401，其中的 `details.loginPath` 指向 helper 的 `/cas/login`；不会再由 OpenResty 把 `fetch()` 重定向到 CAS HTML。
