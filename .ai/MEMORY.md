# MEMORY.md · 已验证事实（只记跑过/确认过的）

- DSH 客户端插件基于 Cordis，装法 `dsh plugin --profile web add <dir>`，manifest 字段 `dsh.bundle.patch`。
- DSH 官方 npm 包名 `@deepseek-ai/dsh`，dist-tags：latest=0.2.1-rc.2 / next=0.2.1-rc.3；官方仓库默认分支 **master**。
- DSH 0.2 要求 **Node >= 24.9.0**、pnpm 11；官方 Web UI 默认端口仍是 **3080**。
- **DSH 0.2 起官方直接拒绝通配监听地址**（`--host 0.0.0.0` 在加载期报错），Web UI 只能绑一个具体的本机地址 → 远程访问必须走本插件网关。
- DSH 0.2 的 `--host/--port` 等参数由 `webStartup` 普通服务提供（`ctx.webStartup.host/port/trustedHosts`），配置行用 `!!js ctx.webStartup.port ?? 3080` 读取。
- **DSH 0.2 的 `ctx.subprocess` 会先洗掉子进程环境里的凭据与 `DSH_*` 事实**，再叠加调用方给的 `env` → 所有 `LAN_GATE_*` 必须显式传。
- `ctx.subprocess` API 形态未变：`resolveExecutable` / `spawn({argv,cwd,env,stdio,graceMs})` / `handle.done` / `handle.collected.stdout.readFrom(0)`。
- 兼容性闸门在 `packages/boot/app-boot/src/plugin-compatibility.ts`：`semver.satisfies(runtime, range, { includePrerelease: true })` → `engines.dsh: ">=0.2.0 <0.3.0"` 能匹配 `0.2.1-rc.x`。
- DSH 0.2 的 Web UI slot 词表（上游 `packages/client` 实测提取）：`root` / `main` / `main.conversation` / `conversation.view` / `conversation.chat.flow` / `conversation.chat.node` / `conversation.composer.bar|dock` / `conversation.input.dock|left|right|model|model.label|overlay|plan|permission` / `sidebar` / `sidebar.panellist` / `rightbar` / `settings.*` … 0.1 的 `conversation` 顶层 slot 已不存在。
- DSH 0.2 的 data 标记：`data-composer-dock|card|input|seat|chip|overlay`、`data-chat-flow|node-key|running|turn`、`data-streaming`、`data-phase`、`data-model-id`。
- 智能体运行态的可靠信号是 **`[data-chat-running]`**（`RunningStatus.tsx`），它消失即本轮结束。
- 主题 `--dsw-font-*` token 名在 0.2 未变（`--dsw-font-s-14-font-size` / `--dsw-font-markdown-base-font-size` 等），可在手机端安全覆写。
- DSH 支持**自定义模型 API**：provider id + baseURL + 协议（`openai-completions` / `openai-responses` / `anthropic-messages`）+ 模型列表，写在 profile 的 `cordis.patch.yml` 的 `llm-pi-ai` 行 → 可以接 MiniMax 等 OpenAI 兼容网关。
- 网关零依赖单文件 CJS；`pwa/` 资产由网关注入/供出；SW 固定路径 `/pwa/sw.js`。
- 冒烟测试 **8 项全通过**（资产、注入、状态、0.2 选择器、脚本括号、订阅校验、**推送加解密回环**、VAPID JWT）。
- 真 Web Push 的 body 帧必须是 `salt(16) || rs(4 BE) || idlen(1) || ciphertext || keyid`，AAD = rs 的 4 字节大端；早先版本漏掉 rs/idlen/keyid 会被推送服务拒收。
- DSH CLI 官方禁止 `--host 0.0.0.0`（/api 无认证），必须走网关做远程访问。
