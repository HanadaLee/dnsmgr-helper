# dnsmgr-helper

`dnsmgr-helper` 是原版 dnsmgr 的独立兼容 BFF。它现在可以完整接管 CAS 登录、CAS Ticket 验证、helper Session、dnsmgr 托管登录和缺失用户自动创建；OpenResty 只需要反向代理，不再执行 SSO Lua。

当前业务接口仍通过原 dnsmgr 控制器读取数据，因此 DNS 平台权限和供应商差异继续由原系统处理。数据库连接是可选基础能力，尚未替代现有域名与解析记录适配器。

## 已实现能力

- CAS 登录、回调、退出和签名 Session Cookie
- 使用 CAS 用户名和托管密码登录原 dnsmgr
- 用户不存在时使用配置的管理员创建用户，然后重试登录
- 浏览器同时获得 helper Session 和原 `user_token`
- API 只向原系统转发 `user_token`，不会泄露 helper Session
- CAS 可关闭；关闭后 API 仅依赖已有的原 dnsmgr Cookie
- 可选 MySQL/MariaDB 连接池以及 `/readyz` 实际连通性检查
- 域名、单域名详情和解析记录的稳定只读 API
- 未知 dnsmgr 版本保护、统一 JSON 错误和固定上游路径白名单

## 静态配置

项目不再把业务配置散落在环境变量中。复制示例文件并填写：

```powershell
Copy-Item config/dnsmgr-helper.example.json config/dnsmgr-helper.json
npm run config:check -- config/dnsmgr-helper.json
```

`config/dnsmgr-helper.json` 已被 Git 忽略。进程默认读取该文件；如果部署系统使用其他位置，只需要用 `DNSMGR_HELPER_CONFIG` 指定配置文件路径。

### CAS 配置

当 `cas.enabled` 为 `true` 时必须填写：

- `server.publicUrl`：浏览器访问 dnsmgr 的公开站点根地址
- `cas.baseUrl`：CAS 应用根地址，helper 会追加 `login`、`serviceValidate` 和 `logout`
- `cas.sessionSecret`：至少 32 个字符的随机密钥，只由 helper 使用
- `legacySso.adminUser`：原 dnsmgr 管理员用户名
- `legacySso.managedPassword`：所有自动映射用户使用的托管密码

`cas.validationUrl` 可选，用于把服务端验票请求发送到内网地址；浏览器重定向仍使用公开的 `cas.baseUrl`。如内网地址需要指定 Host，可填写 `cas.validationHost`。

`cas.enabled=false` 时，helper 不签发或校验 CAS Session，`/cas/login` 会明确返回 `CAS_DISABLED`，业务 API 只把现有 `user_token` 交给原 dnsmgr 验证。

### 数据库配置

`database.enabled=true` 后 helper 会建立 `mysql2` 连接池。可以配置主机/端口或 Unix Socket、数据库名、用户、密码、连接数、超时和 TLS 开关。

- `/healthz` 只报告数据库功能是否启用；
- `/readyz` 会执行 `SELECT 1`，连接失败时返回 HTTP 503；
- 当前 Web API 尚不直接查询或修改数据库，避免绕过原 dnsmgr 的权限、审计和 DNS 供应商操作。

建议创建最小权限的独立数据库用户。等具体表结构和用途确认后，再按接口逐项授予 `SELECT` 或必要的写权限，不建议直接使用 root。

## 运行

要求 Node.js 22 或更高版本：

```powershell
npm install
npm run config:check -- config/dnsmgr-helper.json
npm run dev
```

默认监听 `127.0.0.1:3001`。生产环境使用：

```powershell
npm run build
npm start
```

## HTTP 路径

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 进程健康状态 |
| `GET` | `/readyz` | 可选数据库实际连通性 |
| `GET` | `/cas/login` | 跳转 CAS 登录 |
| `GET` | `/cas/callback` | 验证 Ticket、同步 dnsmgr 用户并签发 Cookie |
| `GET` | `/cas/register` | 兼容入口，重新进入统一登录 |
| `GET` | `/cas/logout` | 清除两个本地 Cookie 并退出 CAS |
| `GET` | `/login`、`/logout` | 原 dnsmgr 路径兼容别名 |
| `GET` | `/api/web/v1/compatibility` | 适配版本与功能边界 |
| `GET` | `/api/web/v1/session` | 当前用户、能力和上游版本 |
| `GET` | `/api/web/v1/domains` | 域名列表 |
| `GET` | `/api/web/v1/domains/:id` | 域名详情 |
| `GET` | `/api/web/v1/domains/:id/records` | 解析记录列表 |

OpenResty 的无认证融合方式和迁移顺序见 [docs/openresty-sso.md](docs/openresty-sso.md)。

## 验证

```powershell
npm run config:check -- config/dnsmgr-helper.json
npm run typecheck
npm test
npm run build
```

测试覆盖 CAS service URL、Ticket 验证、Session 签发、现有用户登录、缺失用户自动创建、退出清理、CAS 关闭模式、Cookie 隔离和 v1051 字段转换，不会连接真实 CAS、数据库或 DNS 供应商。
