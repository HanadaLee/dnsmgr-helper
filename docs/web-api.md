# dnsmgr-helper Web API

前端只应调用 `/api/web/v1` 下的稳定接口。响应统一使用：

```json
{
  "code": "OK",
  "data": {},
  "message": "可选的成功提示",
  "meta": { "page": 1, "pageSize": 20, "total": 0 }
}
```

业务失败沿用非 2xx HTTP 状态和 `{ "code", "message", "details?" }`。前端不应读取 helper Cookie，也不应展示兼容层、上游版本或认证协议名称。

## 域名账户

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/domain-account-providers` | 供应商字段定义、默认值和能力 |
| `GET` | `/domain-accounts` | 脱敏后的账户列表 |
| `POST` | `/domain-accounts` | 新增并由原 dnsmgr 验证账户 |
| `GET` | `/domain-accounts/:accountId` | 管理员编辑回填；包含账户配置 |
| `PUT` | `/domain-accounts/:accountId` | 完整更新并重新验证账户 |
| `DELETE` | `/domain-accounts/:accountId` | 删除无关联域名的账户 |
| `GET` | `/domain-accounts/:accountId/available-domains` | 从 DNS 供应商发现可导入域名 |

账户列表绝不返回原表的 `config` 字段。只有原 dnsmgr 已允许访问编辑页面时，详情接口才返回配置值。

```json
{
  "providerType": "cloudflare",
  "name": "admin@example.com",
  "config": {
    "email": "admin@example.com",
    "api_token": "replace-me",
    "proxy": "0"
  },
  "remark": "生产账户"
}
```

## 域名与分类

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/domains` | 分页、筛选和排序 |
| `POST` | `/domains` | 添加已有域名或在供应商创建新域名 |
| `GET` | `/domains/:domainId` | 域名详情 |
| `PATCH` | `/domains/:domainId` | 局部修改；helper 会保留未提交字段 |
| `DELETE` | `/domains/:domainId` | 删除域名及原版关联任务 |
| `POST` | `/domains/import` | 批量导入供应商域名 |
| `PATCH` | `/domains/batch-remark` | 批量备注 |
| `PATCH` | `/domains/batch-notice` | 批量到期提醒开关 |
| `POST` | `/domains/batch-delete` | 批量删除 |
| `POST` | `/domains/expiry-refresh` | 批量提交到期时间刷新 |
| `POST` | `/domains/:domainId/refresh-expiry` | 立即刷新一个域名的到期时间 |
| `GET/PUT` | `/domains/expiry-settings` | 到期提醒天数和五类通知开关 |
| `GET` | `/domain-categories` | 分类列表 |
| `POST` | `/domain-categories` | 新增分类 |
| `PUT` | `/domain-categories/:categoryId` | 完整更新分类 |
| `DELETE` | `/domain-categories/:categoryId` | 删除空分类 |
| `PATCH` | `/domain-category-assignment` | 批量分配分类 |

添加供应商中已有的域名：

```json
{
  "accountId": 7,
  "mode": "existing",
  "name": "example.com",
  "providerDomainId": "provider-zone-id",
  "recordCount": 12
}
```

域名局部更新：

```json
{
  "hidden": false,
  "noticeEnabled": true,
  "categoryId": 3,
  "expiresAt": "2027-08-31 00:00:00",
  "remark": "生产域名"
}
```

## 解析记录

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/domains/:domainId/records` | 分页、筛选和排序记录 |
| `GET` | `/domains/:domainId/record-options` | 线路、最小 TTL、记录类型和供应商能力 |
| `GET` | `/domains/:domainId/record-lookup?name=www` | 获取同一主机名记录 |
| `POST` | `/domains/:domainId/records` | 新增记录 |
| `PATCH` | `/domains/:domainId/records/:recordId` | 修改记录 |
| `DELETE` | `/domains/:domainId/records/:recordId` | 删除记录 |
| `PATCH` | `/domains/:domainId/records/:recordId/status` | 启用或暂停 |
| `PATCH` | `/domains/:domainId/records/:recordId/remark` | 修改备注 |
| `POST` | `/domains/:domainId/records/:recordId/check` | 查询公共 DNS 生效状态 |
| `POST` | `/domains/:domainId/records/batch` | 批量启停、删除、备注、分组、值或线路 |
| `POST` | `/domains/:domainId/records/bulk` | 使用原版批量文本格式添加 |
| `PATCH` | `/domains/:domainId/records/by-name` | 智能解析使用的主机名快速更新 |

新增记录：

```json
{
  "name": "www",
  "type": "A",
  "value": "192.0.2.10",
  "lineId": "0",
  "ttl": 600,
  "mxPriority": 1,
  "weight": 0,
  "remark": "网站入口"
}
```

批量修改线路需要提交当前列表行的稳定快照，helper 会转换成原版 `recordinfo`：

```json
{
  "action": "line",
  "lineId": "oversea",
  "records": [
    {
      "id": "record-id",
      "name": "www",
      "type": "A",
      "value": "192.0.2.10",
      "lineId": "0",
      "ttl": 600,
      "mxPriority": 1,
      "weight": 0,
      "remark": "网站入口"
    }
  ]
}
```

`action` 还支持 `status`、`delete`、`remark`、`group` 和 `value`，各自只接受对应字段。

单项删除同样提交 `{ "current": { ...当前记录快照... } }`，使原 dnsmgr 能继续写入完整的解析操作日志；helper 不会从客户端接收任意上游字段。

## 高级解析

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/domains/:domainId/record-groups` | 阿里云/腾讯云记录分组 |
| `GET` | `/domains/:domainId/record-logs` | DNS 供应商操作日志 |
| `GET` | `/domains/:domainId/weighted-records` | 阿里云权重记录组 |
| `PUT` | `/domains/:domainId/weighted-records` | 设置线路权重 |
| `PATCH` | `/domains/:domainId/weighted-records/status` | 开关权重模式 |
| `GET` | `/domains/:domainId/aliases` | 腾讯云域名别名 |
| `POST` | `/domains/:domainId/aliases` | 新增别名 |
| `DELETE` | `/domains/:domainId/aliases/:aliasId` | 删除别名 |

## DNS 监控

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/monitoring/overview` | 进程、当日运行、24 小时告警/切换、Swoole 与通知开关 |
| `GET` | `/monitoring/worker-status` | 转换原公开状态入口为 `{ running }` |
| `PUT` | `/monitoring/notifications` | 更新邮件、微信、Telegram 和两类 Webhook 开关 |
| `POST` | `/monitoring/logs/clean` | 清理指定天数以前的切换日志 |
| `GET` | `/monitoring/form` | 可用域名、PING 能力和安全默认值 |
| `GET` | `/monitoring/tasks` | 任务分页、筛选和排序 |
| `POST` | `/monitoring/tasks` | 新增任务 |
| `GET` | `/monitoring/tasks/:taskId` | 编辑详情和 24 小时任务统计 |
| `PUT` | `/monitoring/tasks/:taskId` | 完整更新任务 |
| `PATCH` | `/monitoring/tasks/:taskId/status` | 启用或停用任务 |
| `DELETE` | `/monitoring/tasks/:taskId` | 删除任务及关联日志 |
| `POST` | `/monitoring/tasks/batch` | 批量删除、重试、启用或停用 |
| `GET` | `/monitoring/tasks/:taskId/logs` | 任务异常与恢复日志 |

任务写入使用稳定字段，helper 会自行生成原版 `recordinfo`：

```json
{
  "domainId": 42,
  "recordName": "www",
  "recordId": "provider-record-id",
  "action": "failover",
  "primaryValue": "192.0.2.10",
  "backupValue": "192.0.2.11",
  "checkType": "tcp",
  "checkUrl": null,
  "tcpPort": 443,
  "intervalSeconds": 10,
  "cycleCount": 3,
  "timeoutSeconds": 5,
  "useProxy": false,
  "enableCloudflareProxy": true,
  "remark": "生产入口",
  "record": { "lineId": "0", "lineLabel": "默认", "ttl": 600 }
}
```

`action` 支持 `none`、`disable`、`failover`、`conditional-enable`；`checkType` 支持 `ping`、`tcp`、`http`。通知接口只接受 `email`、`wechat`、`telegram`、`robotWebhook`、`customWebhook` 五个布尔字段，不接受任意系统设置键。

## 定时切换

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/schedules/form` | 可用域名与默认值 |
| `GET` | `/schedules` | 任务分页、筛选和排序 |
| `POST` | `/schedules` | 新增任务 |
| `GET` | `/schedules/:taskId` | 编辑详情 |
| `PUT` | `/schedules/:taskId` | 完整更新任务 |
| `PATCH` | `/schedules/:taskId/status` | 启用或停用任务 |
| `DELETE` | `/schedules/:taskId` | 删除任务 |
| `POST` | `/schedules/batch` | 批量删除、启用或停用 |

周期任务示例：

```json
{
  "domainId": 42,
  "recordName": "www",
  "recordId": "provider-record-id",
  "execution": "recurring",
  "cycle": "weekly",
  "action": "update",
  "switchDate": "1",
  "switchTime": "08:30",
  "value": "192.0.2.20",
  "lineMode": "unchanged",
  "remark": "每周一切换",
  "record": {
    "value": "192.0.2.10",
    "lineId": "0",
    "lineLabel": "默认",
    "ttl": 600
  }
}
```

`execution` 为 `once` 时，`switchTime` 使用 `YYYY-MM-DDTHH:mm`；为 `recurring` 时使用 `HH:mm`。`cycle` 支持 `daily`、`weekly`、`monthly`，每周的 `switchDate` 为 `0..6`，每月为 `1..31`。删除解析仅允许单次任务。

## 优选 IP

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/optimize-ip/settings` | 当前数据源、密钥、代理和更新间隔 |
| `PUT` | `/optimize-ip/settings` | 局部更新固定的四项设置 |
| `POST` | `/optimize-ip/account-balance` | 查询 wetest 或 HostMonit 余额 |
| `GET` | `/optimize-ip/form` | 可选域名、当前数据源和默认值 |
| `GET` | `/optimize-ip/worker-status` | 转换原公开状态入口为 `{ running }` |
| `GET` | `/optimize-ip/tasks` | 任务分页、筛选和排序 |
| `POST` | `/optimize-ip/tasks` | 新增任务 |
| `GET` | `/optimize-ip/tasks/:taskId` | 编辑详情 |
| `PUT` | `/optimize-ip/tasks/:taskId` | 完整更新任务 |
| `PATCH` | `/optimize-ip/tasks/:taskId/status` | 启用或停用任务 |
| `DELETE` | `/optimize-ip/tasks/:taskId` | 删除任务 |
| `POST` | `/optimize-ip/tasks/:taskId/run` | 立即执行一次 |

```json
{
  "domainId": 42,
  "recordName": "edge",
  "lineStrategy": "carrier-lines",
  "ipVersions": ["v4", "v6"],
  "cdnProvider": "edgeone",
  "recordCount": 2,
  "ttl": 600,
  "remark": "边缘入口"
}
```

`lineStrategy` 支持 `carrier-lines`、`default-unicom-mobile`；`cdnProvider` 支持 `cloudflare`、`cloudfront`、`gcore`、`edgeone`。优选 IP 表单接口只返回原版已允许的非 Cloudflare DNS 域名。

## 证书管理

### 证书账户

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/certificate-account-types?kind=issuance|deployment` | 签发或部署账户类型、动态字段和能力 |
| `GET` | `/certificate-accounts?kind=issuance|deployment` | 脱敏账户列表 |
| `POST` | `/certificate-accounts` | 新增账户并由原 dnsmgr 校验 |
| `GET` | `/certificate-accounts/:accountId?kind=...` | 管理员编辑回填；包含配置 |
| `PUT` | `/certificate-accounts/:accountId` | 完整更新并重新校验 |
| `DELETE` | `/certificate-accounts/:accountId?kind=...` | 删除没有关联订单/任务的账户 |

动态字段的 `visibleWhen` 已转换为 `any -> all -> { field, operator, value }` 的结构化条件，前端不得执行原页面表达式或使用 `eval`。账户列表不返回 `config`、扩展凭据或其他密钥；只有详情接口返回原版编辑页面已经授权的配置。

```json
{
  "kind": "issuance",
  "type": "acme",
  "name": "生产证书账户",
  "config": { "email": "admin@example.com", "api_token": "replace-me" },
  "remark": "自动续签"
}
```

### 证书订单

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/certificate-orders/form` | 可选签发账户和 RSA/ECC 密钥参数 |
| `GET` | `/certificate-orders` | 订单分页、筛选和排序 |
| `POST` | `/certificate-orders` | 新建托管订单或导入手动证书 |
| `GET` | `/certificate-orders/:orderId` | 订单详情；手动证书包含编辑回填 PEM |
| `PUT` | `/certificate-orders/:orderId` | 完整更新订单 |
| `DELETE` | `/certificate-orders/:orderId` | 删除没有部署任务引用的订单 |
| `PATCH` | `/certificate-orders/:orderId/auto-renew` | 开关自动续签 |
| `POST` | `/certificate-orders/:orderId/reset` | 重置订单流程 |
| `POST` | `/certificate-orders/:orderId/revoke` | 吊销证书 |
| `POST` | `/certificate-orders/:orderId/process` | 立即执行，可提交 `{ "reset": true }` |
| `POST` | `/certificate-orders/batch` | 批量删除、重置、开关自动续签 |
| `GET` | `/certificate-orders/:orderId/log?processId=...` | 读取签发过程日志 |
| `GET` | `/certificate-orders/:orderId/artifacts` | 显式获取证书、私钥和 Base64 PFX |

托管订单示例：

```json
{
  "mode": "managed",
  "accountId": 3,
  "keyType": "RSA",
  "keySize": 2048,
  "domains": ["example.com", "*.example.com"]
}
```

手动导入使用 `{ "mode": "manual", "certificate": "PEM", "privateKey": "PEM" }`。制品接口是敏感操作，返回原版生成的 PFX，当前原版固定 PFX 密码为 `123456`。过程日志只接受 32 位十六进制 `processId`，不会把任意文件名交给原版日志读取逻辑。

### 自动部署

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/certificate-deployments/form` | 部署账户、证书订单和动态任务字段 |
| `GET` | `/certificate-deployments` | 任务分页、筛选和排序 |
| `POST` | `/certificate-deployments` | 新增任务 |
| `GET` | `/certificate-deployments/:deploymentId` | 编辑回填 |
| `PUT` | `/certificate-deployments/:deploymentId` | 完整更新任务 |
| `DELETE` | `/certificate-deployments/:deploymentId` | 删除任务 |
| `PATCH` | `/certificate-deployments/:deploymentId/status` | 启用或停用 |
| `POST` | `/certificate-deployments/:deploymentId/reset` | 重置任务 |
| `POST` | `/certificate-deployments/:deploymentId/process` | 立即部署，可先重置 |
| `POST` | `/certificate-deployments/batch` | 批量删除、重置、启停或更换证书 |
| `GET` | `/certificate-deployments/:deploymentId/log?processId=...` | 读取部署过程日志 |

```json
{
  "accountId": 4,
  "orderId": 9,
  "config": { "path": "/etc/nginx/cert.pem", "reload": true },
  "remark": "边缘入口"
}
```

批量更换证书使用 `{ "ids": [11, 12], "action": "assign-certificate", "orderId": 10 }`；其他批量动作是 `delete`、`reset`、`enable`、`disable`。

### DCV 托管校验与计划设置

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/certificate-cnames/form` | 可作为 CNAME 目标的本系统域名 |
| `GET` | `/certificate-cnames` | 代理列表和验证状态 |
| `POST` | `/certificate-cnames` | 新增代理 |
| `PUT` | `/certificate-cnames/:cnameId` | 修改目标记录 |
| `DELETE` | `/certificate-cnames/:cnameId` | 删除代理 |
| `POST` | `/certificate-cnames/:cnameId/check` | 立即验证 CNAME |
| `GET` | `/certificate-settings` | 续签天数、部署时段和五类通知模式 |
| `PUT` | `/certificate-settings` | 局部更新固定的证书设置键 |

```json
{
  "renewBeforeDays": 30,
  "deploymentWindow": { "startHour": 1, "endHour": 22 },
  "notifications": {
    "email": "failures-only",
    "telegram": "all"
  }
}
```

通知模式支持 `off`、`all`、`failures-only`。helper 只会写入证书续签、部署时段和五个通知键，不接受任意系统设置名称。

## AxisNow 调度管理

AxisNow 接口按平台账户隔离，helper 只访问原 dnsmgr 已登记的控制器，不直接持有或调用 AxisNow API 令牌。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/axisnow/accounts` | 可用 AxisNow 平台账户 |
| `GET/POST` | `/axisnow/domains` | DNS 路由域名列表和新增 |
| `GET/DELETE` | `/axisnow/accounts/:accountId/domains/:uuid` | 域名详情和删除 |
| `PUT` | `/axisnow/domains/:uuid` | 修改域名；账户与托管类型保持不变 |
| `GET` | `/axisnow/accounts/:accountId/options?scope=domain|eip|rule` | 托管后缀、DNS 提供商、EIP、标签、线路和监控模板 |
| `GET/POST` | `/axisnow/accounts/:accountId/domains/:domainUuid/rules` | 路由规则列表和新增 |
| `GET/PUT/DELETE` | `/axisnow/accounts/:accountId/domains/:domainUuid/rules/:ruleUuid` | 路由规则详情、修改和删除 |
| `PATCH` | `/axisnow/accounts/:accountId/domains/:domainUuid/rules/:ruleUuid/status` | 启用或暂停路由规则 |
| `GET/POST` | `/axisnow/eips` | 自有及共享订阅 EIP 列表和新增 |
| `PUT` | `/axisnow/eips/:uuid` | 修改可管理 EIP |
| `POST` | `/axisnow/eips/batch-delete` | 按平台账户批量删除 EIP |
| `GET/POST` | `/axisnow/tags` | 标签列表和新增 |
| `GET/DELETE` | `/axisnow/accounts/:accountId/tags/:uuid` | 标签编辑详情和删除 |
| `PUT` | `/axisnow/tags/:uuid` | 修改标签 |

AxisNow 托管域名提交 `providerSource: "platform"`、所选 `dnsProviderUuid` 与 `dnsZoneUuid`；前端只允许填写前缀并从后缀列表选择。自托管提交 `providerSource: "self-hosted"` 和联动的 DNS 提供商 UUID。EIP 列表的 `dataOrigin` 区分 `own` 与 `subscribed`，共享订阅项会返回 `canManage: false` 和 `providerName`，前端不会允许编辑或删除。

路由规则列表通过 `poolGroups`、`poolAddresses`、`poolAddressCount` 和 `poolTruncated` 描述完整地址池，通过 `strategyQuantity`、`strategyInterval` 描述选取策略；`resolvedAddresses` 只包含过滤不可用候选后、按策略数量截取的实际解析地址，不等同于完整候选地址池。

## CloudFlare

### 自定义主机名

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/cloudflare/domains/:domainId/custom-hostnames` | 主机名、源站、所有权和证书验证状态 |
| `POST` | `/cloudflare/domains/:domainId/custom-hostnames` | 新建主机名 |
| `PUT` | `/cloudflare/domains/:domainId/custom-hostnames/:hostnameId` | 修改源站和证书参数 |
| `DELETE` | `/cloudflare/domains/:domainId/custom-hostnames/:hostnameId` | 删除主机名 |
| `POST` | `/cloudflare/domains/:domainId/custom-hostnames/:hostnameId/refresh` | 重新发起验证 |
| `POST` | `/cloudflare/domains/:domainId/custom-hostnames/batch-add` | 批量新增 |
| `PUT` | `/cloudflare/domains/:domainId/custom-hostnames/batch` | 批量修改 |
| `POST` | `/cloudflare/domains/:domainId/custom-hostnames/batch-delete` | 批量删除 |
| `GET` | `/cloudflare/domains/:domainId/txt-targets?hostname=...` | 为 TXT/CNAME 验证记录匹配本地 DNS 域名和主机记录 |
| `GET/PUT/DELETE` | `/cloudflare/domains/:domainId/fallback-origin` | 查询、设置或清空 Fallback Origin |
| `GET` | `/cloudflare/domains/:domainId/dcv-delegation` | DCV 委派 UUID |
| `GET` | `/cloudflare/domains/:domainId/default-line` | 快速创建验证记录时使用的线路列表和默认线路 |

```json
{
  "hostname": "app.example.com",
  "customOrigin": "origin.example.com",
  "validationMethod": "txt",
  "minTlsVersion": "1.2"
}
```

`customOrigin` 使用 `null` 表示清空；只接受不带协议、端口、路径、通配符的域名。批量新增把 `hostname` 替换为 `hostnames` 数组；批量更新提交 `ids`、必填的 `customOrigin` 以及可选的验证方法/TLS 版本。列表已把原版嵌套结构整理为 `ownershipVerification`、`ssl.validationRecords` 和 `validationErrors`，足够实现主机名 TXT、证书 TXT、DCV CNAME 的单项和批量快速添加。

验证记录写入流程使用稳定接口组合：先调用 `txt-targets`，再调用目标域名的 `record-options` 或 `default-line`，最后使用 `/domains/:domainId/records` 创建 TXT/CNAME。CF 优选解析复用 `/optimize-ip/tasks` 和记录查询/写入接口，不依赖通用动作入口。

### CloudFlare Tunnel

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET/POST` | `/cloudflare/accounts/:accountId/tunnels` | Tunnel 列表和创建 |
| `DELETE` | `/cloudflare/accounts/:accountId/tunnels/:tunnelId` | 删除 Tunnel |
| `GET` | `/cloudflare/accounts/:accountId/tunnels/:tunnelId/token` | 显式获取敏感 Token 和启动命令 |
| `GET/PUT/DELETE` | `/cloudflare/accounts/:accountId/tunnels/:tunnelId/public-hostnames` | 公网主机名列表、保存和删除；同步 CNAME |
| `GET/POST/DELETE` | `/cloudflare/accounts/:accountId/tunnels/:tunnelId/cidr-routes` | CIDR 路由列表、新增和删除 |
| `GET/POST/DELETE` | `/cloudflare/accounts/:accountId/tunnels/:tunnelId/hostname-routes` | 主机名路由列表、新增和删除 |

公网主机名保存示例：

```json
{
  "hostname": "app.example.com",
  "service": "http://127.0.0.1:8080",
  "path": "/api/*"
}
```

删除公网主机名提交 `{ "hostname": "app.example.com", "path": "/api/*" }`。新增 CIDR 提交 `{ "network": "10.0.0.0/8", "comment": "private" }`，删除 CIDR/主机名路由提交 `{ "routeId": "..." }`。Tunnel Token 只由显式 Token 接口返回，不出现在列表或其他详情中。

## 仪表盘、用户与日志

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/dashboard` | 总量、监控、优选 IP、证书/部署状态和服务器信息 |
| `GET` | `/dashboard/release` | 非阻断版本检查；失败时返回 `unavailable` |
| `POST` | `/dashboard/cache/clear` | 清理原 dnsmgr 缓存 |
| `GET` | `/users/form` | 用户域名权限选项 |
| `GET/POST` | `/users` | 脱敏用户列表和新增用户 |
| `GET/PUT/DELETE` | `/users/:userId` | 用户详情、完整更新和删除 |
| `PATCH` | `/users/:userId/status` | 启用或封禁用户 |
| `GET` | `/logs` | `userId`、`domain`、`q` 条件的操作日志分页 |

用户列表不会返回密码哈希、API Key 或 TOTP 密钥。只有管理员显式打开编辑详情时，`GET /users/:userId` 才返回该用户现有的 `apiKey`；详情仍不返回密码哈希和 TOTP 密钥。新增用户示例：

```json
{
  "username": "operator",
  "password": "initial-password",
  "apiEnabled": true,
  "apiKey": "32-char-key",
  "role": "user",
  "permissions": ["example.com"]
}
```

更新请求用 `resetPassword` 选择性重置密码，其余字段与新增一致；管理员角色的 `permissions` 会被清空。状态请求是 `{ "enabled": false }`。

## 个人安全与系统设置

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/profile/security` | 本地凭据是否可用及 TOTP 状态 |
| `PUT` | `/profile/password` | `{ "currentPassword", "newPassword" }` |
| `POST` | `/profile/totp/enrollment` | 生成 TOTP 密钥和 `otpauth://` URI |
| `PUT/DELETE` | `/profile/totp` | 绑定 `{ "secret", "code" }` 或关闭 TOTP |
| `PUT` | `/profile/legacy-theme` | 保留原站皮肤写入能力；新前端主题不依赖它 |
| `GET/PUT` | `/system/login-settings` | 原站图形验证码开关 |
| `GET/PUT` | `/system/notifications` | 邮件、微信、Telegram、群机器人及自定义 Webhook |
| `POST` | `/system/notifications/test` | 显式测试 `email`、`telegram`、`robot-webhook` 或 `custom-webhook` |
| `GET/PUT` | `/system/proxy` | HTTP/HTTPS/SOCK4/SOCK5/SOCK5H 代理设置 |
| `POST` | `/system/proxy/test` | 使用提交的代理参数测试连通性 |
| `GET/PUT` | `/system/cron` | 执行模式、密钥、公开 URL 和五类任务运行时间 |

外部托管登录启用时，`profile/security.localCredentialsAvailable` 为 `false`，前端应隐藏本地密码和 TOTP 表单；helper 也会拒绝这些无效写入，避免破坏托管会话。通知设置使用按通道完整对象、通道之间可局部更新的结构，例如：

```json
{
  "telegram": {
    "token": "bot-token",
    "chatId": "123456",
    "topicId": "",
    "proxyMode": "system",
    "customBaseUrl": ""
  }
}
```

系统写接口只接受各页面明确列出的固定键，不能通过它写入任意原站配置。

## 原公开 API 与后台入口

以下路径不使用 `/api/web/v1` 前缀，并保留原 dnsmgr 的响应格式：

- `POST /api/domain`、`POST /api/domain/:id`；
- `POST /api/record/data/:id` 以及 `add`、`update`、`delete`、`status`、`remark`、`batch`；
- `POST /api/cert/order`；
- `GET /quicklogin?domain=...&token=...`；
- `GET /cron?key=...`；
- `ANY /dmtask/status`、`ANY /optimizeip/status`（与原 `Route::any` 一致）。

公开 API 同时接受 `application/x-www-form-urlencoded` 和 JSON 对象，再以原表单字段转发 `uid`、`timestamp`、`sign` 及业务参数。签名仍由原 dnsmgr 按 `md5(uid + timestamp + apikey)` 验证，HTTP 状态与原 JSON 正文不转换。`/quicklogin` 保留原令牌验证与跳转语义，并在成功时同步签发域名受限浏览器会话。helper 只登记上述固定路径，不能用它访问任意原站控制器。

## 兼容动作入口

`GET /actions` 与 `POST /actions/:operationId` 是开发迁移期的受控兜底，只接受 v1051 白名单中的固定动作和动态正整数路径参数。新前端应优先使用本文件中的类型化接口；每完成一个功能域，就不应再依赖该域的通用动作入口。
