# dnsmgr-helper

`dnsmgr-helper` 是放在原版 dnsmgr 与独立 Web 前端之间的兼容 BFF。它不修改 dnsmgr 源码，也不直接连接 dnsmgr 数据库；所有业务权限仍由原系统的 `user_token` 和原控制器判定。

当前适配器面向 dnsmgr `1051`，已实现第一阶段只读契约：

- 登录态探测与菜单能力识别
- 域名分页、搜索、排序及单域名详情
- 解析记录分页、搜索、排序
- 旧字段名、状态值和 client/server 两种分页响应的统一转换
- 可选或强制的 OpenResty CAS JWT 校验
- 统一 JSON 错误与敏感响应字段隔离
- 配置到未知上游版本时只开放兼容性探测，拒绝误用 `v1051` 翻译规则

写操作当前会明确报告为不支持；在核对每个原版操作的 CSRF、权限和供应商差异前，不会透传任意路径。

## 与现有 SSO 的关系

现有 `auth_sso_adapter_dnsmgr.lua` 可以原样继续承担登录适配：CAS 登录后，它仍向原 dnsmgr `/login` 提交托管凭据并把原系统返回的 `user_token` 写回浏览器。helper 只把浏览器 Cookie 转发给受限的原版接口。

在当前 Hanada 网关场景，推荐同时设置：

```dotenv
DNSMGR_REQUIRE_CAS_JWT=true
DNSMGR_CAS_JWT_SECRET=<通过密钥管理注入，需与 auth_cas.lua 使用的密钥一致>
```

这样每次 Web API 请求必须同时满足：

1. CAS JWT 有效，证明网关 SSO 会话仍有效；
2. 原 dnsmgr `user_token` 有效，证明原系统业务登录及权限仍有效。

CAS 用户资料只用于显示，不会替代原 dnsmgr 的权限判断。完整的路径融合方案见 [docs/openresty-sso.md](docs/openresty-sso.md)。

## 本地运行

要求 Node.js 22 或更高版本。

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

默认监听 `127.0.0.1:3001`。`dev` 和 `start` 会在文件存在时加载 `.env`；生产也可以由进程管理器直接注入环境变量。

主要配置：

| 变量 | 说明 |
| --- | --- |
| `DNSMGR_UPSTREAM_URL` | 原版 dnsmgr 的 HTTP 基地址；允许带私有路径前缀并应以 `/` 结尾 |
| `DNSMGR_UPSTREAM_HOST` | 可选的上游 Host，例如 `dns.hanada.info` |
| `DNSMGR_UPSTREAM_VERSION` | 适配器版本，当前为 `1051` |
| `DNSMGR_REQUIRE_CAS_JWT` | 是否强制 CAS JWT；现有 SSO 部署建议设为 `true` |
| `DNSMGR_CAS_JWT_COOKIE` | CAS Cookie 名，默认 `resty_cas_jwt` |
| `DNSMGR_CAS_JWT_SECRET` | CAS HS256 密钥，只能通过部署环境注入 |
| `DNSMGR_CAS_LOGIN_PATH` | API 401 返回给前端的登录路径 |
| `DNSMGR_CAS_LOGOUT_PATH` | 前端使用的退出路径 |

## Web API

所有业务响应都使用稳定字段，不暴露旧版 PHP 的行结构。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 进程健康检查 |
| `GET` | `/api/web/v1/compatibility` | 适配版本与功能边界 |
| `GET` | `/api/web/v1/session` | 双登录态探测和用户能力 |
| `GET` | `/api/web/v1/domains` | 域名列表 |
| `GET` | `/api/web/v1/domains/:id` | 域名详情 |
| `GET` | `/api/web/v1/domains/:id/records` | 解析记录列表 |

API 未登录时返回 HTTP 401：

```json
{
  "code": "AUTH_REQUIRED",
  "message": "请通过统一身份认证登录",
  "details": { "loginPath": "/cas/login" }
}
```

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

测试使用模拟的 dnsmgr 响应，覆盖 Cookie 转发、CAS 强制校验、登录失效、参数翻译、稳定字段转换和两种旧分页格式；不会访问真实 DNS 供应商。
