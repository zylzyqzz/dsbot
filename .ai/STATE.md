# STATE.md · dsh-mobile-pwa

<!-- 阶段：stage / 当前任务 task / 状态 status / 下一步 next -->

- **stage**: `v0.2.0 · 对齐 DSH 官方 0.2.x`
- **task**: 把插件从 DSH 0.1 时代迁移到官方 0.2.x，修掉失效的 DOM 假设，并部署到真实服务器验证
- **status**: `代码完成 · 8/8 测试通过 · 真实服务器部署中`
- **本轮变更（0.1.0 → 0.2.0）**:
  - `engines.dsh: ">=0.2.0 <0.3.0"`（0.2 新增的安装期兼容性闸门，缺了会被拒装）
  - 移动端 CSS 全部改用 0.2 slot 词表；0.1 的 `[data-slot="conversation"]` 等选择器已彻底移除
  - 目标地址改为从 `webStartup` 服务读取（`dsh web --port/--host` 都生效），不再写死 3080
  - 显式向子进程传 `env`（0.2 的 `ctx.subprocess` 会洗掉环境变量与 `DSH_*` 事实）
  - Web Push 换成真实现：RFC 8291 aes128gcm 加密体 + RFC 8292 VAPID ES256 鉴权，VAPID 密钥自动生成并持久化
  - agent-done 判定改到浏览器侧（0.2 的 `[data-chat-running]`），删除依赖 0.1 服务的宿主插件 `dsh-push.mjs`
  - `/pwa/push/send` 额外允许「已批准设备」调用（手机可把完成事件带给其他设备）
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
