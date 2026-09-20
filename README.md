# dnsmgr-helper

`dnsmgr-helper` 是原版 dnsmgr 的独立兼容 BFF。它现在可以完整接管 CAS 登录、CAS Ticket 验证、helper Session、dnsmgr 托管登录和缺失用户自动创建；OpenResty 只需要反向代理，不再执行 SSO Lua。

当前业务接口仍通过原 dnsmgr 控制器读取数据，因此 DNS 平台权限和供应商差异继续由原系统处理。数据库连接是可选基础能力，尚未替代现有域名与解析记录适配器。

> 兼容性要求：生产环境应使用 [HanadaLee/dnsmgr](https://github.com/HanadaLee/dnsmgr) 的 `ext` 分支。helper 的 AxisNow、证书模板和部分兼容接口与该分支同步维护；直接搭配原版 `main` 可能缺少字段或控制器能力，产生不可预期的问题。

## 已实现能力

- CAS 登录、回调、退出和签名 Session Cookie
- 使用 CAS 用户名和托管密码登录原 dnsmgr
- 用户不存在时使用配置的管理员创建用户，然后重试登录
- 浏览器同时获得 helper Session、helper 专用桥接 Cookie 和原 `user_token`
- API 优先从桥接 Cookie 读取原站令牌，再翻译为上游 `user_token`，不会受同名历史 Cookie 干扰
- CAS 可关闭；关闭后 API 仅依赖已有的原 dnsmgr Cookie
- 可选 MySQL/MariaDB 连接池以及 `/readyz` 实际连通性检查
- 域名账户列表脱敏、供应商动态字段、编辑回填、增删改和供应商域名发现
- 域名、分类、解析记录及高级解析的稳定类型化读写 API
- 解析线路、最小 TTL、供应商能力、分组、日志、权重和域名别名转换
- DNS 监控概览、任务、通知、日志与进程状态的稳定类型化 API
- 定时切换任务及 CF 优选 IP 设置、额度、任务和立即执行 API
- 证书账户、订单、制品、证书部署、DCV 托管校验和证书计划设置的完整类型化 API
- 动态证书字段转换为结构化显示条件，列表凭据脱敏，日志文件标识和系统设置键严格校验
- CloudFlare 自定义主机名、所有权/证书验证、Fallback、DCV 委派与批量操作 API
- CloudFlare Tunnel、敏感令牌、Public Hostname、CIDR 和主机名路由的完整 API
- AxisNow DNS 路由、线路规则、潮汐/故障备份自动调度、EIP（含共享订阅）和标签管理的完整类型化 API
- 仪表盘统计/服务器信息/缓存清理、用户全生命周期、域名权限与脱敏操作日志 API
- 登录、通知、代理和计划任务的固定字段设置，以及邮件、Telegram、Webhook 和代理测试 API
- 原 `/api/domain`、`/api/record/*`、`/api/cert/order` 的表单、签名和响应语义兼容
- 域名级 `/quicklogin` 令牌校验、受限会话签发和跳转语义兼容
- `/cron`、`/dmtask/status`、`/optimizeip/status` 的公开执行与探活语义兼容
- 远程版本检查的服务端 JSONP 转换；失败时不影响仪表盘其余数据
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

数据库启用时，helper 会直接创建或读取 dnsmgr 用户并签发 `user_token`，不需要配置管理员用户名或托管密码。只有不启用数据库时，才需要填写 `legacySso.adminUser` 和 `legacySso.managedPassword`，通过原 dnsmgr HTTP 接口完成兼容登录。

原 dnsmgr 的登录路径、用户创建路径和 `user_token` Cookie 名称均为协议固定值，不提供配置项；helper 的桥接 Cookie 名称同样固定。

`cas.validationUrl` 可选，用于把服务端验票请求发送到内网地址；浏览器重定向仍使用公开的 `cas.baseUrl`。如内网地址需要指定 Host，可填写 `cas.validationHost`。

`cas.enabled=false` 时，helper 不签发或校验 CAS Session，`/cas/login` 会明确返回 `CAS_DISABLED`，业务 API 只把现有 `user_token` 交给原 dnsmgr 验证。

前端只使用稳定入口 `/login` 和 `/logout`。helper 内部的 CAS 路径仍可配置，但不会作为前端登录状态接口返回，从而保持认证实现对界面透明。

### 版本检查

`releaseCheck` 控制仪表盘的版本信息：

```json
{
  "releaseCheck": {
    "enabled": true,
    "url": "https://auth.cccyun.cc/app/dnsmgr.php",
    "requestTimeoutMs": 10000
  }
}
```

helper 只接受 HTTP(S) 地址，将原 JSONP 转换为固定结构；响应过大、超时或格式变化都会返回 `unavailable`，不会阻断仪表盘。完全不需要版本检查时可设为 `false`。

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
docker build --build-arg APP_VERSION=0.8.20 -t dnsmgr-helper:local .
$env:DNSMGR_HELPER_IMAGE = 'dnsmgr-helper:local'
docker compose up -d
```

Compose 使用 Linux host 网络。这与静态配置的回环监听方式配套：容器内的 `127.0.0.1` 就是宿主机，helper 可以通过 `upstream.url` 直接访问同机原 dnsmgr（当前部署为 `http://127.0.0.1:19101/`）以及本机 MySQL，同时不会通过 Docker 额外发布端口。默认还会只读挂载 `/usr/local/dnsmgr/etc/thinkphp.env`；若数据库改用 Unix Socket，还需要按 `docker-compose.yml` 中的注释挂载对应 Socket。

镜像和 Compose 健康检查都读取同一个 `dnsmgr-helper.json`，不会固定使用 `3001`。当前生产示例把 helper 配置为 `127.0.0.1:19102`；修改 `server.host` 或 `server.port` 后，需要同步修改 `deploy/http_dns.hanada.info.conf.example` 中所有 helper 路由的 `proxy_select_local`。`/healthz` 只用于容器存活检查；数据库实际可用性仍由 `/readyz` 判断。

helper 访问原 dnsmgr 时会分别输出 `dnsmgr upstream request` 和 `dnsmgr upstream response` 日志，包含父请求 ID、方法、上游路径、请求模式、是否携带会话、响应状态、耗时、响应大小和重定向路径。日志不会记录 Cookie 值、托管密码、POST 表单或响应正文；入口日志还会隐藏 `/quicklogin` 的完整查询串和回调中的 Ticket。会话接口探测 dnsmgr 首页时使用 `document` 模式，不会携带 `X-Requested-With`；登录和数据接口继续使用 `ajax` 模式。

## GitHub Actions 镜像发布

镜像构建职责已全部迁移到 GitHub Actions，helper 仓库不再代为构建 dnsmgr。每次推送 `main` 都会在原生 `linux/amd64`、`linux/arm64` Runner 上执行容器化校验；只有根目录 `VERSION` 变化且尚未存在同名标签时，才发布生产镜像并创建 GitHub tag/release。

发布目标包括：

- `registry.hanada.info/hanada/dnsmgr-helper:${VERSION}` 与 `latest`；
- `docker.io/hanadalee/dnsmgr-helper:${VERSION}` 与 `latest`；
- `ghcr.io/hanadalee/dnsmgr-helper:${VERSION}` 与 `latest`。

GitHub 仓库需要配置 `HARBOR_USERNAME`、`HARBOR_PASSWORD`、`DOCKERHUB_USERNAME`、`DOCKERHUB_PASSWORD`；GHCR 使用仓库自动提供的 `GITHUB_TOKEN`。`VERSION` 必须与 `package.json` 完全一致。dnsmgr 镜像已由 [dnsmgr](https://github.com/HanadaLee/dnsmgr) 仓库自身的工作流构建和发布。

## HTTP 路径

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 进程健康状态 |
| `GET` | `/readyz` | 可选数据库实际连通性 |
| `GET` | `/cas/login` | 跳转 CAS 登录 |
| `GET` | `/cas/callback` | 验证 Ticket、同步 dnsmgr 用户并签发 Cookie |
| `GET` | `/cas/logout` | 清除三个本地 Cookie 并退出 CAS |
| `GET` | `/login`、`/logout` | 原 dnsmgr 路径兼容别名 |
| `GET` | `/quicklogin` | 原域名级快速登录入口及受限会话 |
| `GET` | `/api/web/v1/compatibility` | 适配版本与功能边界 |
| `GET` | `/api/web/v1/session` | 当前用户、能力和上游版本 |
| `GET` | `/api/web/v1/domains` | 域名列表 |
| `POST/PATCH/DELETE` | `/api/web/v1/domains...` | 域名单项与批量写操作 |
| `GET` | `/api/web/v1/domains/:id` | 域名详情 |
| `GET` | `/api/web/v1/domains/:id/records` | 解析记录列表 |
| `GET/POST/PUT/DELETE` | `/api/web/v1/domain-accounts...` | 域名账户与供应商字段 |
| `GET/POST/PUT/DELETE` | `/api/web/v1/domain-categories...` | 域名分类与批量分配 |
| `GET/POST/PATCH/DELETE` | `/api/web/v1/domains/:id/records...` | 记录、分组、日志、权重与别名 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/monitoring...` | 监控概览、任务、通知与日志 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/schedules...` | 定时切换任务 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/optimize-ip...` | 优选 IP 设置、额度、状态与任务 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/certificate-accounts...` | 签发与部署账户、类型和动态字段 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/certificate-orders...` | 订单、续签、执行、日志和证书制品 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/certificate-deployments...` | 证书部署任务、批量操作和日志 |
| `GET/POST/PUT/DELETE` | `/api/web/v1/certificate-cnames...` | DCV 托管校验和立即验证 |
| `GET/PUT` | `/api/web/v1/certificate-settings` | 自动续签、部署时段和通知设置 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/axisnow...` | 平台账户、DNS 路由、线路规则、自动调度、EIP 和标签 |
| `GET/POST/PUT/DELETE` | `/api/web/v1/cloudflare/domains/:id...` | 自定义主机名、验证、Fallback、DCV 和默认线路 |
| `GET/POST/PUT/DELETE` | `/api/web/v1/cloudflare/accounts/:id/tunnels...` | Tunnel、Token、公网主机名、CIDR 和主机名路由 |
| `GET/POST` | `/api/web/v1/dashboard...` | 仪表盘统计、服务器信息、版本检查和缓存清理 |
| `GET/POST/PUT/PATCH/DELETE` | `/api/web/v1/users...` | 用户、域名权限、API Key、启停与删除 |
| `GET` | `/api/web/v1/logs` | 按用户、域名和关键字筛选操作日志 |
| `GET/PUT/POST/DELETE` | `/api/web/v1/profile...` | 本地凭据模式下的密码、TOTP 与原站主题兼容 |
| `GET/PUT/POST` | `/api/web/v1/system...` | 登录、通知、代理、计划任务设置与连通性测试 |
| `POST` | `/api/domain...`、`/api/record...`、`/api/cert/order` | 保留原 API Key 签名与原响应格式的公开 API |
| `GET` / `ANY` | `/cron`、`/dmtask/status`、`/optimizeip/status` | 原计划任务与状态入口 |
| `GET` | `/api/web/v1/actions` | 当前适配版本允许执行的操作目录 |
| `POST` | `/api/web/v1/actions/:operationId` | 执行白名单中的 dnsmgr 操作并转换响应 |

账户、域名、分类、解析记录和证书管理的完整路径、请求字段及示例见 [Web API 文档](docs/web-api.md)。操作入口只接受注册在 v1051 适配器中的固定操作，不接受任意上游 URL。请求体由 `path` 与 `form` 两部分组成；`path` 只填充注册路径中的正整数参数，`form` 会转换成 ThinkPHP/jQuery 兼容的 URL 编码表单。当前操作目录覆盖 142 个原版服务端列表与动作入口，完整功能对应关系见 [迁移矩阵](docs/migration-matrix.md)。

OpenResty 的无认证融合方式和迁移顺序见 [docs/openresty-sso.md](docs/openresty-sso.md)。

## 验证

```powershell
npm run config:check -- config/dnsmgr-helper.json
npm run typecheck
npm test
npm run build
```

测试覆盖身份认证 URL、Ticket 验证、Session 签发、现有用户登录、缺失用户自动创建、退出清理、认证关闭模式、Cookie 隔离、上游日志脱敏、v1051 字段转换、账户密钥脱敏、版本化页面状态解析、域名局部更新、记录单项与批量转换、监控/定时/优选 IP 全操作转换、证书账户/订单/部署/DCV 托管校验/设置全操作转换、证书制品与日志边界、CloudFlare 自定义主机名与 Tunnel 全操作转换、AxisNow 路由/自动调度/EIP/标签转换、仪表盘、用户脱敏/权限/CRUD、操作日志、个人安全、固定系统设置、通知/代理测试、公开 API 原响应与后台执行入口、全量操作白名单、PHP 表单编码与动态路径拦截，不会连接真实认证服务、数据库或 DNS 供应商。
