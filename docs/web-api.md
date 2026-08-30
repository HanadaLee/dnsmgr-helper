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

## 兼容动作入口

`GET /actions` 与 `POST /actions/:operationId` 是开发迁移期的受控兜底，只接受 v1051 白名单中的固定动作和动态正整数路径参数。新前端应优先使用本文件中的类型化接口；每完成一个功能域，就不应再依赖该域的通用动作入口。
