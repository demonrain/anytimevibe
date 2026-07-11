# 随码管理后台

访问地址：`https://你的域名/admin`

## 谁可以进入

- 使用 `SETUP_TOKEN` 初始化创建的**首个账号**自动成为管理员。
- 已有部署在服务启动时，若库中尚无管理员，会把最早注册的用户提升为管理员。
- 管理员可在后台把其他用户设为管理员。

## 功能一览

| 模块 | 能力 |
|------|------|
| **总览** | 用户/主机/在线 Agent/浏览器/会话/24h 密文事件/Push 订阅/待配对 等运营指标；查看公网地址、下载链接、更新源、VAPID 状态 |
| **用户** | 搜索与筛选、设管理员、停用/启用、备注、强制下线、重置密码、删除用户 |
| **主机** | 跨用户查看主机、在线状态、断开 WebSocket、撤销主机并清理密文事件 |
| **策略** | 覆盖开放注册开关与用户上限（可回退到环境变量） |
| **审计** | 记录管理员关键操作，便于追责 |

## 设计原则

1. **只管理控制面数据**：账号、主机元数据、会话、注册策略。不解密、不展示任务正文/源码。
2. **危险操作有护栏**：不能删除/停用最后一个管理员；不能删除自己。
3. **停用即失效**：停用用户会清除会话并断开浏览器连接。
4. **策略可热更新**：注册开关与人数上限可在后台覆盖，无需改 `.env` 重启（下载链接、更新源仍走环境变量）。

## 入口

1. 管理员登录工作台。
2. 右上角头像菜单 → **管理后台**，或直接打开 `/admin`。

## API 前缀

所有接口要求管理员会话 Cookie：

- `GET /api/admin/overview`
- `GET /api/admin/users`
- `GET /api/admin/users/:userId`
- `PATCH /api/admin/users/:userId`
- `DELETE /api/admin/users/:userId`
- `POST /api/admin/users/:userId/sessions/revoke`
- `GET /api/admin/hosts`
- `POST /api/admin/hosts/:hostId/revoke`
- `POST /api/admin/hosts/:hostId/disconnect`
- `GET|PATCH /api/admin/settings`
- `GET /api/admin/audit`
- `GET /api/admin/pairings`

## 数据库变更

服务启动时自动迁移：

- `users.is_admin` / `users.disabled_at` / `users.note`
- `admin_audit_logs`
- `service_settings`

## 推荐运营流程

1. 初始化后用管理员账号进入后台，确认总览数据正常。
2. 若对外公测：先在「策略」限制用户上限或临时关闭注册。
3. 发现滥用：停用用户 → 撤销其主机 → 查看审计记录。
4. 用户忘记密码：后台重置密码（会踢掉全部会话）。
5. Agent 异常占用连接：在主机列表「断开连接」；确认废弃后再「撤销」。
