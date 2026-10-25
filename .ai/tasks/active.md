# 当前任务 · active

> 复杂任务进展；简单任务可在 STATE 直接记。

## T-当前：v0.2.0 对齐 DSH 官方 0.2.x（✅ 代码完成，⏳ 服务器部署中）
- [x] 核对官方最新版与插件基线（官方 `@deepseek-ai/dsh` latest=0.2.1-rc.2 / next=0.2.1-rc.3）
- [x] 盘点插件对 DSH 的硬假设（端口 / slot / env / 插件 manifest / 推送）
- [x] `package.json` 升 0.2.0 + `engines.dsh` 兼容区间
- [x] `lan-gate.mjs`：从 `webStartup` 解析目标地址 + 显式传 `env`
- [x] `lib/lan-gate-server.cjs`：目标主机可配 + 真 Web Push + 0.2 选择器
- [x] 新增 `lib/web-push.cjs`（VAPID / ECDH / HKDF / AES-128-GCM，零依赖）
- [x] `pwa/app.css` 全量改写为 0.2 slot 词表
- [x] `pwa/inject.js`：VAPID 订阅修正 + `[data-chat-running]` 判定 agent 完成
- [x] `pwa/sw.js`：缓存版本 + `pushsubscriptionchange`
- [x] 删除失效的宿主插件 `dsh-push.mjs`
- [x] 测试扩到 8 项（含推送加解密回环、VAPID JWT、订阅校验、0.2 选择器）全绿
- [x] 文档同步（README 中英 / AGENTS.md / llms.txt / .ai）
- [x] ser8 装 Node 24.22.1 + pnpm 11.28.8 + DSH CLI
- [ ] ser8 上 `dsh plugin --profile web add` + 配 MiniMax 自定义模型 API + 起服务
- [ ] 手机端验证：访问 / 添加到主屏 / 触屏手势 / agent 通知
- [ ] 云安全组放行网关端口（需用户手动）
- [ ] `0.2.0` 发 npm（本机 npm 未登录，需用户 `npm login` 后 `npm publish`）

## 历史：v0.1.0 收尾（✅ 已发布进社区）
- [x] 拉取参考基座并解析架构
- [x] 初始化项目骨架 + git
- [x] PWA 资产（manifest / sw.js / 图标 / offline）
- [x] 增强网关 + HTML PWA 注入
- [x] 触屏手势 + 移动布局
- [x] agent-done 推送（网关端点 + 可选宿主插件）
- [x] DSH 插件接入（manifest + cordis.patch.yml）
- [x] 冒烟测试 4 项通过
- [x] 文档（README 中英 + AGENTS.md + .ai）
- [x] npm 发布 `dsh-mobile-pwa@0.1.0` + 三方安装验证
- [x] GitHub 公开 + topics
- [x] awesome-dsh-plugin PR #576 **合并**
