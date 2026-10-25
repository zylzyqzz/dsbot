# DECISIONS.md · 已确认重大决策

| 决策 | 理由 |
| --- | --- |
| 复用 `dsh-mobile-gate` 网关并增强，而非从零写 | MIT 许可，隔离子进程架构成熟，专注 PWA 差异化 |
| 首版做「完整版」而非 MVP | 用户明确选完整 PWA（手势+通知+离线一次做齐） |
| 用 PWA 插件（不建独立 React Native/Flutter App） | 定位是用户自建服务器+手机浏览器访问，插件装一行 `dsh plugin add`，天然进生态 |
| 网关保持零依赖单文件 CJS | 符合参考架构约定，易维护、易审计 |
| PWA 资产独立成文件（`pwa/`）由网关供出 | SW/manifest 需要固定 URL，不能只内嵌字符串 |
| 移动 CSS 走 `data-lan-device` 前缀 + 稳定 selector | 桌面零影响 + 抗前端构建 hash 变更 |
| 项目文档两套都要（普通开源 + `.ai/` 体系） | 用户明确选择 |
| **目标地址从 `webStartup` 服务读，不再写死 3080** | 0.2 支持 `--port/--host`，写死会让自定义端口的部署直接坏掉 |
| **spawn 时显式传 `env`** | 0.2 的 `ctx.subprocess` 会洗掉环境变量与 `DSH_*` 事实，不显式传网关就读不到配置 |
| **目标地址逻辑放在宿主插件、纯文件服务器不依赖 DSH** | 网关保持可独立启动（测试即如此），DSH 相关解析只在 `lan-gate.mjs` 一处 |
| **删掉宿主侧 `dsh-push.mjs`，agent-done 判定移到浏览器** | 它依赖 0.1 的 `conversation`/`http` 服务，0.2 已不存在；0.2 有 `[data-chat-running]` 这样的确定性 DOM 信号，浏览器侧判定更准 |
| **推送改成真加密（aes128gcm + VAPID）** | 推送服务拒收明文 body，原实现等于没推送 |
| **VAPID 密钥自动生成并持久化到 `~/.dsh/`** | 免手工配置，重启不丢订阅 |
| **声明 `engines.dsh: ">=0.2.0 <0.3.0"`** | 0.2 安装期会校验并拒绝不兼容的 bundle；官方用 `includePrerelease` 比较，rc 版也能满足 |
| **`/pwa/push/send` 额外放行「已批准设备」** | 手机端要能把完成事件带给其他已订阅设备；限流与审批闸门仍在 |
