# STATE.md · dsh-mobile-pwa

<!-- 阶段：stage / 当前任务 task / 状态 status / 下一步 next -->

- **stage**: `v0.2.1 · 对齐 DSH 官方 0.2.x · 已真实部署`
- **task**: 把插件从 DSH 0.1 时代迁移到官方 0.2.x，修掉失效的 DOM 假设，并部署到真实服务器验证
- **status**: `代码完成 · 10/10 测试通过 · ser8 端到端验证通过`
- **真实部署（ser8 / 111.170.171.25）**:
  - 对外 URL：**http://111.170.171.25:3088/**（网关 0.0.0.0:3088 → DSH 127.0.0.1:3080）
  - Node 24.22.1 + pnpm 11.28.8 + `@deepseek-ai/dsh@0.2.1-rc.2`，systemd `dsh-web.service`
  - profile `web`，模型走 **MiniMax 自定义模型 API**（`openai-completions` + `api.minimaxi.com/v1`，9 个模型）
  - 实测：首次访问 303 换 session cookie → 带 cookie 200（真页面 47KB，manifest/PWA 注入齐全）→ 公网 IP 从本机可达 200
  - 待办：云安全组放行 3088（用户手动）；npm 发布 0.2.1（需用户 `npm login`）
- **本轮变更（0.1.0 → 0.2.1）**:
  - `engines.dsh: ">=0.2.0 <0.3.0"`（0.2 新增的安装期兼容性闸门，缺了会被拒装）
  - 移动端 CSS 全部改用 0.2 slot 词表；0.1 的 `[data-slot="conversation"]` 等选择器已彻底移除
  - 目标地址改为从 `webStartup` 服务读取（`dsh web --port/--host` 都生效），不再写死 3080
  - 显式向子进程传 `env`（0.2 的 `ctx.subprocess` 会洗掉环境变量与 `DSH_*` 事实）
  - **Host 原样透传**（0.2 的 Host/Origin 栅栏 + session cookie 都基于它），`LAN_GATE_REWRITE_HOST=1` 可退回旧行为
  - **浏览器会话自举**：插件从 `ctx.connection.authenticatedUrl()` 取 launch token 交给网关，网关替浏览器换 session cookie → 用户打开的是不带 token 的普通 URL
  - `LAN_GATE_TRUSTED_HOSTS` 由 bundle 的 `connection` 行并进 `--trusted-host` 列表
  - Web Push 换成真实现：RFC 8291 aes128gcm 加密体 + RFC 8292 VAPID ES256 鉴权，VAPID 密钥自动生成并持久化
  - agent-done 判定改到浏览器侧（0.2 的 `[data-chat-running]`），删除依赖 0.1 服务的宿主插件 `dsh-push.mjs`
  - `/pwa/push/send` 额外允许「已批准设备」调用（手机可把完成事件带给其他设备）
  - service worker 加 `Service-Worker-Allowed: /` 并以 `scope:'/'` 注册（否则只能管到 `/pwa/`）；离线页与 app shell 分开缓存
- **发布记录**:
  - npm: `dsh-mobile-pwa@0.1.0` public（https://www.npmjs.com/package/dsh-mobile-pwa）
  - GitHub: https://github.com/zylzyqzz/dsh-mobile-pwa（公开,带 dsh-plugin topic）
  - awesome 精选 PR #576：**✅ 已由维护者 fkysly 合并**
  - `0.2.0` 待发布（本机 npm 未登录，需用户 `npm login` 后 `npm publish`）
- **next**:
  1. **真机 / 真服务器端到端验证**：ser8 上 `dsh plugin --profile web add` + 手机访问网关 + 「添加到主屏」+ agent 通知
  2. 云安全组放行网关端口（需用户手动在京东云控制台操作）
  3. VAPID 推送落地（需手机侧真实 push service 出网）
  4. `0.2.0` 发 npm
