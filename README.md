# dsh-mobile-pwa · 让 DeepSeek Harness 在手机上变成真 PWA

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）变成**手机上的完整 PWA**：安全远程访问你的自建 DSH + 一键「添加到主屏」成独立 App + 离线可用 + 触屏手势 + 任务完成通知。

基于 MIT 的 [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate)（安全网关基座）做差异化增强。

**当前版本 `0.2.0` —— 对齐 DSH 官方 `0.2.x`**（`engines.dsh: ">=0.2.0 <0.3.0"`）。

[![npm version](https://img.shields.io/npm/v/dsh-mobile-pwa)](https://www.npmjs.com/package/dsh-mobile-pwa)
[![license](https://img.shields.io/github/license/zylzyqzz/dsh-mobile-pwa)](https://github.com/zylzyqzz/dsh-mobile-pwa/blob/main/LICENSE)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-ready-4c8dff)](https://github.com/topics/dsh-plugin)

📍 生态定位：社区现有移动端方案都停留在「窄屏 CSS 微调」，本项目做的是**移动端 PWA 一站式完整方案**。

---

## ✨ 特性

| 模块 | 说明 |
| --- | --- |
| 📡 **安全远程访问** | 独立子进程网关，首次访问**本机审批**（审批绑 IP、令牌绑浏览器，同一出口 IP 下的手机和电脑可同时在线）+ **可选访问密码** + **每 IP 限流**。DSH 主服务仍只监听本机回环，`/api` 信任栅栏不受影响 |
| 📱 **真 PWA** | `manifest.json` + `service worker`：手机浏览器「**添加到主屏**」后全屏独立窗口运行，带图标/启动屏/主题色 |
| 🧩 **可安装** | 主屏图标、`standalone` 显示、`apple-touch-icon`、maskable 图标 |
| 🌐 **离线可用** | service worker：静态壳缓存优先、API 网络优先、导航离线回退页 |
| 👆 **触屏手势** | 下拉刷新、边缘右滑返回、**捏合缩放字体**（可重置） |
| 🔔 **任务完成通知** | 真正的 Web Push（RFC 8291 aes128gcm 加密 + RFC 8292 VAPID 鉴权），切到别的 App 也能收到 |
| 📐 **触屏布局** | 44px 触摸目标、safe-area 适配、全屏弹窗、紧凑排版、代码横向滚动——桌面零影响 |
| 🔒 **桌面不受影响** | 所有规则都以 `html[data-lan-device="phone"]` 或以排除 `data-lan-device="desktop"` 的 `@media` 为根 |
| 🎯 **0.2 版 DOM 对齐** | 移动端 CSS 全部改用 DSH 0.2 的 slot 词表（`main.conversation` / `conversation.view` / `conversation.chat.flow` / `conversation.input.model` / `conversation.composer.dock` …），0.1 时代已失效的选择器全部移除 |

---

## 🏗️ 架构

```
手机 ──> 网关 (独立 Node 子进程 · 0.0.0.0:3088)
           ├─ 未批准 -> 「等待本机批准」页面（轮询 /lan-gate/admin）
           ├─ 已批准+令牌Cookie -> 反向代理到 DSH Web UI (本机地址:端口)（每个浏览器各领一枚令牌）
           │      └─ HTML 注入：manifest link + PWA bootstrap + 触屏CSS + randomUUID polyfill
           ├─ /pwa/* -> 直接提供 manifest / sw.js / app.css / 图标 / offline.html
           ├─ /pwa/push/* -> 订阅 / 发送（真实加密推送）
           └─ 超限 -> 429 限流页
电脑 127.0.0.1:3088/lan-gate/admin  -> 批准/拒绝/撤销设备、选择访问方式(手机/电脑/自动)
```

- 网关是**独立子进程**，与 DSH 主进程隔离：挂掉不影响主服务，插件停止时自动终止。
- **DSH 0.2 起官方直接拒绝 `--host 0.0.0.0`（通配地址一律报错）**，所以 Web UI 永远只监听一个具体的本机地址。远程访问只能靠本网关：它独占对外端口并做审批，DSH 侧的 `/api` 信任栅栏完好。
- 网关的目标地址**不是写死的**：插件从 `webStartup` 服务读出本次启动真实的 host/port（`dsh web --port 0` / `--host <addr>` 都照样工作），再显式传给子进程。

---

## 🚀 快速开始（在你自己的 DSH 服务器上）

### 方式零：npm 一键安装（推荐，已发布）

```bash
npm add dsh-mobile-pwa@0.2.0
dsh plugin --profile web add dsh-mobile-pwa
```

> 已声明 `dsh.bundle` manifest，安装后自动激活配置层，无需手写 patch。
> 包：https://www.npmjs.com/package/dsh-mobile-pwa

### 方式一：从 GitHub 本地安装

```bash
git clone https://github.com/zylzyqzz/dsh-mobile-pwa.git
cd dsh-mobile-pwa
dsh plugin --profile web add ./dsh-mobile-pwa
```

> 源码安装需要给 pnpm 放行构建脚本（见官方 `publish` 文档的 allowBuilds 说明）。本包是纯 JS、无构建步骤，npm 预构建包不需要任何授权。

### 方式二：静态挂载

参考 [`cordis.patch.yml.example`](cordis.patch.yml.example)，把绝对路径替换进你的 profile patch。

### 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LAN_GATE_PORT` | `3088` | 网关监听端口 |
| `LAN_GATE_HOST` | `0.0.0.0` | 网关监听地址 |
| `LAN_GATE_TARGET_HOST` | `127.0.0.1` | 本机 DSH Web UI 地址（插件会自动填 `webStartup.host`，此变量优先） |
| `LAN_GATE_TARGET_PORT` | `3080` | 本机 DSH Web UI 端口（插件会自动填 `webStartup.port`，此变量优先） |
| `LAN_GATE_RATE_LIMIT` | `120` | 每 IP 每分钟请求上限 |
| `LAN_GATE_PASSWORD` | 空 | 访问密码。设了之后打开网关先要输密码，密码只存在服务器上，浏览器拿到的是 HMAC 派生的会话 cookie |
| `LAN_GATE_TRUSTED_HOSTS` | 空 | **对外服务地址白名单**，逗号分隔（如 `111.170.171.25,app.example`）。DSH 0.2 的 Host/Origin 栅栏按浏览器看到的 Host 校验，网关原样透传 Host，所以这里必须声明对外地址；不带端口的条目匹配任意端口 |
| `LAN_GATE_REWRITE_HOST` | 空 | 设为 `1` 时把 Host 改写成回环地址（仅老版本 DSH 需要） |
| `LAN_GATE_DSH_TOKEN` | 自动 | DSH 进程 launch token，插件从 `ctx.connection` 自动读取并交给网关 |
| `LAN_GATE_PUBLIC_URL` | 空 | 仅用于生成 token 化 URL 时的基准地址 |
| `LAN_GATE_VAPID_PUBLICKEY` | 自动生成 | Web Push VAPID 公钥（base64url） |
| `LAN_GATE_VAPID_PRIVATEKEY` | 自动生成 | Web Push VAPID 私钥（base64url PKCS#8） |
| `LAN_GATE_VAPID_SUBJECT` | `mailto:dsh-mobile-pwa@localhost` | VAPID 联系方式 |

> VAPID 密钥对未提供时会自动生成一次并保存到 `~/.dsh/lan-gate-vapid.json`（权限 600），重启不失效。

### DSH 0.2 的浏览器鉴权是怎么打通的

DSH 0.2 起，浏览器要拿一个**签名 session cookie** 才能用 Web UI，而这个 cookie 的首次签发需要一个**进程 launch token**（每次重启都会变）。本插件的做法：

1. 插件在 DSH 进程内从 `ctx.connection.authenticatedUrl()` 读出本次启动的 launch token，交给网关子进程；
2. 网关**原样透传浏览器 Host**（DSH 的 Host/Origin 栅栏与 cookie 的 authority 都基于它），并在浏览器还没有 session cookie 时，用这个 token 去上游换一张 cookie，直接转交给浏览器；
3. 于是**用户打开的就是一个不带 token 的普通 URL**，不需要复制启动日志里的 tokenized 链接。

前提是 DSH 侧要信任对外地址：把 `LAN_GATE_TRUSTED_HOSTS` 设成对外的 `host` 或 `host:port`（bundle 的 `connection` 行会自动把它并进 `--trusted-host` 列表），或直接在启动参数里加 `--trusted-host <对外地址>`。


### 使用流程

1. **服务端**：启动 DSH + 本插件，看到 `[lan-gate] listening on 0.0.0.0:3088 -> <host>:<port> (pwa=on)`。
2. **手机**：浏览器打开 `http://<你的IP>:3088` → 出现「等待本机批准」。
3. **电脑**：打开 `http://127.0.0.1:3088/lan-gate/admin` → 批准该设备并选「手机」。
4. **手机**：下拉刷新 → 进入 DSH Web UI（已注入 PWA）。
5. **添加到主屏**：浏览器菜单 → 「添加到主屏」→ 变成独立 App。
6. **（可选）任务完成通知**：页面左下角会出现「开启」提示，允许后即可收到。

---

## 🔔 任务完成通知是怎么判定的

DSH 0.2 在智能体工作期间会渲染 `[data-chat-running]`。注入脚本用 `MutationObserver` 盯着它：
一旦从「有」变成「没有」，说明这一轮跑完了 —— 此时

1. 立刻弹一个本机 `Notification`（页面在前台时最直接）；
2. 同时把消息发给网关的 `/pwa/push/send`，网关按订阅加密后推给**其他**设备。

> 0.2 版移除了旧的宿主侧 `dsh-push.mjs` 插件：它依赖 DSH 0.1 的 `conversation`/`http` 服务接口，在 0.2 已不存在。判定逻辑改到浏览器侧，反而更准（DSH 自己的 DOM 就是事实来源），也不再占用宿主进程。

---

## ⚙️ 本机安装测试

```bash
npm test   # 起 mock 上游，验证 /pwa 资产、HTML 注入、状态上报、Web Push 加解密回环
```

---

## 🗂️ 项目结构

| 路径 | 作用 |
| --- | --- |
| `lan-gate.mjs` | Cordis 插件入口：解析目标地址 + spawn 网关子进程 + 生命周期管理 |
| `lib/lan-gate-server.cjs` | 网关本体：零依赖单文件（HTTP 代理 + 审批 + 令牌 + 限流 + PWA 注入） |
| `lib/web-push.cjs` | 真 Web Push：VAPID 密钥对 + ES256 JWT + ECDH/HKDF 派生 + AES-128-GCM 加密 |
| `pwa/manifest.json` | PWA 安装清单 |
| `pwa/sw.js` | service worker（离线缓存 + 推送通知 + 订阅轮换） |
| `pwa/inject.js` | 注入页引导：注册 SW + 加载手势 + 通知订阅 + 任务完成判定 |
| `pwa/touch-gestures.js` | 下拉刷新 / 边缘返弹 / 捏合缩放 |
| `pwa/app.css` | 移动触屏布局（`data-lan-device` 前缀，桌面零影响） |
| `pwa/offline.html` | 离线回退页 |
| `pwa/icons/` | SVG 源 + 192/512 PNG + maskable 图标 |
| `cordis.patch.yml` / `.example` | 插件 bundle 挂载层 |
| `test/gateway.test.cjs` | 冒烟测试 |

---

## 🧑‍💻 开发贴士

- **隔离**：网关是子进程，`lan-gate.mjs` 只负责 spawn + 生命周期，永不 import 它的服务代码进 DSH 进程。
- **环境变量要显式传**：DSH 0.2 的 `ctx.subprocess` 会**先洗掉**子进程环境里的凭据和 `DSH_*` 事实，再叠加调用方给的 `env`。所以 `LAN_GATE_*`、`DSH_HOME`、VAPID 密钥必须在 spawn 请求里显式给出。
- **移动 CSS 前缀**：新规则一律挂 `html[data-lan-device="phone"]` 或排除 `desktop` 的 `@media(max-width:820px)`，**桌面必须永不受影响**。
- **稳定选择器**：用 `[data-slot=...]` / `[data-*]` / ARIA 而非 hash 类名，避免前端构建后失效。DSH 改 slot 名时移动端样式会**静默失效** —— 升级 DSH 后记得回上游 `packages/client` 重新核一遍 slot 词表。
- **注入页的单引号坑**：`lib/lan-gate-server.cjs` 里的注入脚本字符串，历史上有「双引号套双引号」bug，注意字面量转义。
- **推送必须加密**：推送服务拒收明文 body，必须走 `lib/web-push.cjs` 的 `encryptPayload` + `buildVapidAuthorization`。

---

## 🙏 致谢

- [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate)（MIT）——安全网关基座。
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) —— 社区插件精选列表。

---

## ⚠️ 安全须知

安装插件 = 在你的机器上运行第三方代码，权限与你本人相同。收录/发布不等于安全审查。请：**只在你自己的服务器上跑、别放密钥到不熟悉的环境、定期审计 `lib/lan-gate-server.cjs` 的变更**。远程访问务必走审批 + 令牌，别把网关端口裸奔到公网。

## License

MIT。网关 `lib/lan-gate-server.cjs` 基于 `dsh-mobile-gate` 扩展，保留原 MIT 版权与许可，详见 [LICENSE](LICENSE)。
