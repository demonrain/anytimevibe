# 更新传输服务部署说明

`apps/relay/src/update-relay.ts` 是严格 allowlist 的更新传输模块。它不是通用代理：更新文件只能来自 `UPDATE_FEED_URL`，引擎版本探针只能来自固定的 Cursor/Antigravity 官方地址，npm 只允许官方引擎包和元数据中声明的依赖。

## 推荐拓扑

```text
Agent -- HTTPS --> updates.example.com (existing Traefik)
                         |
                         +--> update-transfer:8788 (流式更新/npm relay + 校验缓存)

Agent -- HTTPS --> vibe.example.com (业务 relay)
                         |
                         +--> /api/agent/config（旧 feed + 新传输地址）
```

传输服务不连接业务数据库。业务 relay 可使用同一个 `registerUpdateRelayRoutes`，也可把 `UPDATE_TRANSFER_URL` 指向独立服务。生产环境使用 HTTPS；明文 HTTP 仅支持 loopback 测试。
更新传输容器加入已有的外部 Docker 网络 `traefik-net`，Traefik 使用动态 file provider 路由到容器，不要再启动另一个绑定宿主机 80/443 的 Caddy。

## 配置

```dotenv
UPDATE_FEED_URL=https://github.com/demonrain/anytimevibe/releases/latest/download
UPDATE_TRANSFER_URL=https://updates.example.com
NPM_REGISTRY_ORIGIN=https://registry.npmjs.org
UPDATE_CACHE_DIR=/app/apps/relay/data/update-cache
```

`UPDATE_CACHE_DIR` 必须是持久卷。中继会写入校验过的 npm tarball 和 metadata；临时 `.part` 文件在失败时删除。不要把缓存目录映射到公开静态文件根目录。

## Native maintenance proxy

CONNECT 代理是独立进程 `apps/relay/src/update-proxy-server.ts`，默认只允许 loopback 明文监听。公网部署必须提供 `UPDATE_PROXY_TLS_CERT`、`UPDATE_PROXY_TLS_KEY` 和 `UPDATE_PROXY_TOKEN_SECRET`（至少 32 字符），并设置：

```dotenv
UPDATE_PROXY_BIND=0.0.0.0
UPDATE_PROXY_PORT=9443
UPDATE_PROXY_URL=https://proxy.example.com:9443
UPDATE_PROXY_TOKEN_SECRET=<random-secret>
UPDATE_PROXY_CERT_DIR=./update-proxy-certs
```

凭据格式是带 HMAC 的短期 Basic 认证，生命周期 15 分钟；服务按凭据、客户端地址和总连接数限流。凭据只能由已配对且未撤销的 Agent 获取；未配对主机可以使用公共 npm 传输接口，但不能获得代理凭据。代理只接受 `CONNECT <allowlisted-vendor-host>:443`，DNS 解析出的所有地址必须是公共地址，且连接空闲 60 秒或总时长 30 分钟会断开。

CONNECT 中的目标 TLS 会话保持端到端加密，代理无法区分同一允许域名上的下载与其他 URL。应用只把代理变量注入安装/升级子进程，服务端也不接受任意目标域名；不能把它当成按 HTTP 路径限制的下载代理。

## 运行/验证

```bash
pnpm --filter @anytimevibe/relay build
docker build -t anytimevibe-relay:updates -f apps/relay/Dockerfile .
docker compose -f docker-compose.update.yml config --quiet
docker compose -f docker-compose.update.yml up -d update-transfer
install -m 0644 traefik-anytimevibe-updates.yml /home/docker/traefik/config/dynamic/anytimevibe-updates.yml
curl -fsS https://updates.example.com/api/health
curl -fsSI https://updates.example.com/api/agent/update/latest.yml
```

代理服务只有在证书和 DNS 已就绪后才启用：

```bash
docker compose -f docker-compose.update.yml --profile native-proxy up -d --build update-proxy
```

证书必须与 `UPDATE_PROXY_URL` 的主机名匹配，续期后执行 `docker compose -f docker-compose.update.yml --profile native-proxy restart update-proxy`。业务 relay 和 proxy 服务必须配置同一 `UPDATE_PROXY_TOKEN_SECRET`；仅在代理 HTTPS 健康检查和厂商下载验证通过后才下发 `UPDATE_PROXY_URL`。

## 已验证和限制

- 测试覆盖 Range、HEAD、ETag/304、流式大文件、桌面端断连取消、路径/编码分隔符/开放代理拒绝、npm tarball integrity、持久缓存恢复、真实 npm 安装和真实 curl HTTPS CONNECT 下载。
- 2026-10-12 已部署到 `updates.demonrain.top`：health、Codex npm 元数据和 tarball、Cursor 安装脚本、Antigravity release API 均通过公网验证；tarball 首次请求通过 SHA-512 校验并缓存，后续响应为 HIT。业务 Relay 返回的 feed/engine/npm 地址均指向更新域名。
- Cursor 版本脚本通过固定 relay 路由读取；官方安装脚本本身把包地址硬编码到 `downloads.cursor.com`，当前没有可验证的镜像开关。
- Antigravity 版本 API 通过固定 relay 路由读取。Grok/Antigravity 二进制包含标准 proxy 环境变量支持的静态证据，但未在本地执行真实升级，因此不能把所有原生自更新宣称为完全中转。
- 独立 HTTPS CONNECT 原生更新代理未启用，`engineUpdateProxyUrl` 为空；不使用 Relay 更新地址的厂商原生自更新仍可能受客户端网络限制。
- 不要把 `UPDATE_PROXY_TOKEN_SECRET`、证书私钥或裸 IP HTTP 地址写入仓库。
