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

`database.enabled=true` 后 helper 会建立 `mysql2` 连接池。数据库信息既可以直接写在 JSON 中，也可以通过 `database.thinkphpEnvPath` 读取原 dnsmgr 的 `thinkphp.env`。后一种方式会从 `[DATABASE]` 加载 `HOSTNAME`、`HOSTPORT`、`DATABASE`、`USERNAME`、`PASSWORD`、`CHARSET` 和 `PREFIX`，并覆盖 JSON 中的对应字段；连接池大小、超时、TLS 和 Unix Socket 仍由 helper JSON 控制。

Docker Compose 默认把宿主机 `/usr/local/dnsmgr/etc/thinkphp.env` 只读映射为 `/app/config/thinkphp.env`。宿主机路径可通过 Compose 变量 `DNSMGR_THINKPHP_ENV_PATH` 调整。启用时只需要：

```json
{
  "database": {
    "enabled": true,
    "thinkphpEnvPath": "/app/config/thinkphp.env"
  }
}
```

这里是字段示意；请在完整示例 JSON 上修改。helper 不会输出数据库密码，`thinkphp.env` 也不会被复制到镜像。

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

监听地址和端口由静态配置决定，例如：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3101
  }
}
```

省略配置字段时，程序默认监听 `127.0.0.1:3001`；仓库里的生产示例显式使用 `127.0.0.1:19102`。生产环境使用：

```powershell
npm run build
npm start
```

## Docker 部署

镜像不会包含真实配置。首次部署先在宿主机生成并校验静态配置：

```powershell
Copy-Item config/dnsmgr-helper.example.json config/dnsmgr-helper.json
npm run config:check -- config/dnsmgr-helper.json
```

默认 Compose 镜像为 `registry.hanada.info/hanada/dnsmgr-helper:latest`，配置文件以只读方式挂载：

```powershell
docker compose pull
docker compose run --rm --no-deps --entrypoint node dnsmgr-helper dist/config-check.js /app/config/dnsmgr-helper.json
docker compose up -d
docker compose ps
```

上面的容器内校验会同时读取已经映射的 `thinkphp.env`，适用于 JSON 中配置了容器路径 `/app/config/thinkphp.env` 的情况。两个挂载文件都必须对镜像中的非 root 用户（UID 1000）可读；无需、也不应赋予写权限。

也可以在本地构建后指定镜像：

```powershell
docker build --build-arg APP_VERSION=0.1.3 -t dnsmgr-helper:local .
$env:DNSMGR_HELPER_IMAGE = 'dnsmgr-helper:local'
docker compose up -d
```

Compose 使用 Linux host 网络。这与静态配置的回环监听方式配套：容器内的 `127.0.0.1` 就是宿主机，helper 可以通过 `upstream.url` 直接访问同机原 dnsmgr（当前部署为 `http://127.0.0.1:19101/`）以及本机 MySQL，同时不会通过 Docker 额外发布端口。默认还会只读挂载 `/usr/local/dnsmgr/etc/thinkphp.env`；若数据库改用 Unix Socket，还需要按 `docker-compose.yml` 中的注释挂载对应 Socket。

镜像和 Compose 健康检查都读取同一个 `dnsmgr-helper.json`，不会固定使用 `3001`。当前生产示例把 helper 配置为 `127.0.0.1:19102`；修改 `server.host` 或 `server.port` 后，需要同步修改 `deploy/http_dns.hanada.info.conf.example` 中四个 helper 路由的 `proxy_select_local`。`/healthz` 只用于容器存活检查；数据库实际可用性仍由 `/readyz` 判断。

## GitLab CI 镜像发布

`.gitlab-ci.yml` 沿用 CPA-Helper 的发布方式：

- 在 `debian-x86_64` Runner 上执行示例配置校验、类型检查、测试和构建；
- 分别在 `debian-x86_64`、`debian-aarch64` Runner 上构建并推送架构镜像；
- 合并为 `${VERSION}` 和 `latest` 两个多架构 Harbor manifest；
- 只在 `main` 或 `ext` 分支发布镜像，其他分支和合并请求只执行验证。

GitLab 项目需要提供受保护的 `HARBOR_USERNAME`、`HARBOR_PASSWORD` 变量。发布版本读取根目录 `VERSION`，并由 Docker 构建检查它与 `package.json` 的 `version` 完全一致。

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
