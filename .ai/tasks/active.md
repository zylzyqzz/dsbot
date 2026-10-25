# 当前任务 · active

> 复杂任务进展；简单任务可在 STATE 直接记。

## T-当前：v0.2.1 对齐 DSH 官方 0.2.x（✅ 代码完成 + ✅ ser8 部署验证）
- [x] 核对官方最新版与插件基线（官方 `@deepseek-ai/dsh` latest=0.2.1-rc.2 / next=0.2.1-rc.3）
- [x] 盘点插件对 DSH 的硬假设（端口 / slot / env / 插件 manifest / 推送 / 鉴权）
- [x] `package.json` 升 0.2.1 + `engines.dsh` 兼容区间
- [x] `lan-gate.mjs`：从 `webStartup` 解析目标地址 + 显式传 `env` + 取 launch token
- [x] `lib/lan-gate-server.cjs`：目标主机可配 + Host 原样透传 + 会话自举 + 真 Web Push + 0.2 选择器
- [x] 新增 `lib/web-push.cjs`（VAPID / ECDH / HKDF / AES-128-GCM，零依赖）
- [x] `pwa/app.css` 全量改写为 0.2 slot 词表
- [x] `pwa/inject.js`：VAPID 订阅修正 + `[data-chat-running]` 判定 agent 完成 + SW 以 `scope:'/'` 注册
- [x] `pwa/sw.js`：缓存版本 + `pushsubscriptionchange` + 离线页与 app shell 分离 + 不缓存自身
- [x] `cordis.patch.yml`：追加 `connection` 行，把 `LAN_GATE_TRUSTED_HOSTS` 并进 trustedHosts
- [x] 删除失效的宿主插件 `dsh-push.mjs`
- [x] 测试扩到 10 项全绿（含推送加解密回环、VAPID JWT、Host 透传、会话自举、SW 作用域）
- [x] 文档同步（README 中英 / AGENTS.md / llms.txt / .ai）
- [x] ser8 装 Node 24.22.1 + pnpm 11.28.8 + DSH CLI 0.2.1-rc.2
- [x] ser8 装 web profile + 插件 + MiniMax 自定义模型 API + systemd 常驻
- [x] 端到端验证：首次 303 → 带 cookie 200 真页面 → PWA 资产 200 → 公网可达
- [x] 云安全组：实测公网 3088 已可达（本机直连 200 / 75ms），无需额外放行
- [ ] npm 发布 0.2.1（需用户 `npm login` 后 `npm publish`）
- [ ] 手机真机验证：添加到主屏 / 触屏手势 / agent 完成通知

## T-真机反馈修复（✅ 完成 · 18/18 测试通过）
- [x] 定位「需要重新授权」根因：一个 IP 只有一枚令牌 + `issued` 标志，先到先占
- [x] 新增 `lib/lan-gate-auth.cjs`：审批绑 IP、令牌绑浏览器（令牌数**不设上限**）
- [x] 令牌随 302 直接下发 cookie，撤掉 `?t=` 中转 URL
- [x] `set-kind` 保留令牌（改访问方式不再踢人下线）
- [x] 旧版单令牌状态文件自动迁移，已登录浏览器不掉线
- [x] `/pwa/push/send` 放开「已批准设备 + 持令牌」；无订阅时返回 200
- [x] manifest 合并为唯一一份（PNG 图标优先、`display:standalone`、整页 1 个 manifest / 1 个 theme-color）
- [x] **可选访问密码**（`LAN_GATE_PASSWORD`）：登录页 + HMAC 会话 cookie + 恒定时间比较；本地管理端点豁免
- [x] 测试 21 项全绿；文档同步（README 中英 / AGENTS.md / llms.txt / .ai）

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
