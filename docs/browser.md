# Bot 浏览器：一条命令给 Bot 装上真实 Chrome

ds-bot 自带 12 个浏览器工具（打开网页、读快照、点击、输入、截图、人机接力…），但它**不自带浏览器**：
需要你自己准备一个 `playwright-core` 和一个 Chrome 可执行文件，然后把路径写进 profile patch。
它的启动参数还是写死的 `args: ['--disable-dev-shm-usage']`，**没有代理配置项** —— 在只能访问国内网络的服务器上，Bot 等于打不开任何境外站点。

这套脚本把这几件事一次做完，并且把代理能力补上（不改 ds-bot 一行源码）。

```bash
node scripts/setup-browser.mjs --proxy http://127.0.0.1:7890
```

装完 `systemctl restart dsh-web`，Bot 就能自己开网页了。

---

## 一条命令做了什么

| 步骤 | 产物 | 失败时会怎样 |
| --- | --- | --- |
| 1. 下载 Chrome for Testing（当前 Stable） | `<prefix>/chrome/chrome` | 官方源不通时自动换国内镜像；全都不通可 `--chrome-zip` 用本地包 |
| 2. 装系统库 | apt 包 | 批量失败会自动**逐个重装**，一个错名不会拖垮整条命令 |
| 3. 装 playwright-core | `<prefix>/pw/node_modules/playwright-core` | 缺 npm 会直接提示装 Node |
| 4. 装代理 shim + 写代理配置 | `<prefix>/pw/pw-proxy-shim.mjs`、`browser-proxy.json` | 无 |
| 5. 真开一个网页验证 | JSON 报告（标题 / 截图字节数 / 出口 IP） | 退出码 1，报告里带真实错误 |
| 6. 写 profile patch | `<profile>/cordis.patch.yml` 的 `- id: bot` 块（先备份） | profile 不存在时打印 YAML 让你手动贴 |

默认安装根目录：

- Linux/macOS：`/opt/dsbot-browser`
- Windows：`%LOCALAPPDATA%\dsbot-browser`
- 覆盖：`--prefix <dir>` 或 `DSBOT_BROWSER_HOME`

装完的目录结构：

```
/opt/dsbot-browser/
├── chrome/chrome                     # Chrome for Testing 可执行文件
└── pw/
    ├── package.json                  # 只为隔离 npm 上下文（避免父级 pnpm link: 协议报错）
    ├── node_modules/playwright-core/
    ├── pw-proxy-shim.mjs             # 代理 + 去自动化特征
    └── browser-proxy.json            # {"proxy": "...", "bypass": "..."}（可选）
```

### 国内网络：下载源会自动回退

`storage.googleapis.com`（官方二进制域名）在国内基本不可达，但版本索引
`googlechromelabs.github.io` 常常能通 —— 于是最糟的失败是「解析出版本号，然后下载挂掉」。
所以下载会按顺序试：

1. 官方源（索引里给的地址，或 `chrome-for-testing-public` 的固定模式）
2. `cdn.npmmirror.com/binaries/chrome-for-testing/<版本>/<平台>/`
3. `registry.npmmirror.com/-/binary/chrome-for-testing/...`

连版本索引都拿不到时，会改从镜像的目录列表里取最高版本。要自己指定：

```bash
node scripts/setup-browser.mjs --mirror https://my.internal/chrome-for-testing
node scripts/setup-browser.mjs --no-mirror    # 只用官方源（国内会失败）
```

---

## 为什么需要那个 shim

ds-bot 的 `src/host/browser/session.js` 里：

```js
await chromium.launchPersistentContext(userDataDir, {
  headless, viewport: {...}, acceptDownloads: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--disable-dev-shm-usage'],   // ← 写死，且没有 proxy 字段
})
```

它唯一对外开放的接缝是 `playwrightUrl`：ds-bot 会 `await import(playwrightUrl)`，然后只取 `.chromium`。
所以把 `playwrightUrl` 指向 `pw-proxy-shim.mjs`，就能在不 fork ds-bot、不依赖内部 API 的前提下改启动参数：

- `--proxy-server=<proxy>`、`--proxy-bypass-list=<bypass>`（仅在配置了代理时加）
- `--disable-blink-features=AutomationControlled`（去掉 `navigator.webdriver` 与顶部自动化横幅）

shim 对 `launch` 和 `launchPersistentContext` 都做了包装，参数形态 `(options)` / `(userDataDir, options)` 都覆盖。
`playwright-core` 是**懒加载**的：只 import 不调用时不会加载浏览器栈，所以插件挂载阶段不会因为 Playwright 缺失而失败。

### 代理怎么选（优先级从高到低）

1. 环境变量 `DSBOT_BROWSER_PROXY`
2. 与 shim 同目录的 `browser-proxy.json`
3. 都没有 → **直连**，shim 只加去自动化标志

> 为什么还要文件？DSH 的 `ctx.subprocess` 会洗掉子进程环境里的凭据和 `DSH_*` 事实，systemd 重启后导出的变量不一定还在；写进文件才活得久。
> 想让浏览器走系统里已有的代理（xray / clash / ssh 隧道都行），只要是一个 HTTP 代理地址。

---

## Bot 拿到的是什么

`browserPlugin: refs` 挂上 12 个工具：

`browser_open` · `browser_snapshot` · `browser_click` · `browser_type` · `browser_select` ·
`browser_press` · `browser_tabs` · `browser_back` · `browser_screenshot` · `browser_upload` ·
`browser_handoff` · `browser_resume`

其中两个决定了体验：

- **`browser_screenshot` 返回 `{ text, image }`** —— 前端把 `image` 渲染成 `{type:'image', data, mediaType:'image/jpeg'}`，
  截图**直接出现在对话里**，不是一行工具日志。
- **`browser_handoff`** 带 `reason: login | payment | captcha`：遇到登录/支付/验证码时把浏览器交给人，
  人处理完 Bot 用 `browser_resume` 接着干。

每个 Bot 有独立持久 profile：`$DSH_HOME/browser-profiles/<botId>/`（含 `cookies.json`），
所以登录态是**按 Bot 隔离**的，不会互相串。删掉 Bot 时 profile 一起清掉。

---

## 配置项

`scripts/setup-browser.mjs --print-config` 只打印 YAML，不装东西：

```yaml
- id: bot
  name: ds-bot
  config:
    browserPlugin: refs
    browserHeadless: true
    playwrightUrl: file:///opt/dsbot-browser/pw/pw-proxy-shim.mjs
    browserExecutablePath: /opt/dsbot-browser/chrome/chrome
```

| 键 | 说明 |
| --- | --- |
| `browserPlugin` | `refs`（默认，ARIA 快照 + 稳定 ref）/ `script` / `task`；不写则**完全不启用**浏览器 |
| `browserHeadless` | 服务器上必须 `true`（没有显示设备） |
| `playwrightUrl` | 指向 shim；必须是 `file://` URL，Windows 上形如 `file:///C:/...` |
| `browserExecutablePath` | Chrome 可执行文件绝对路径 |

> patch 是**整块替换**语义：写了 `- id: bot` 的 `config`，原来的 `config` 就整个被替换，所以上面四行要写全。

---

## 代理：让境外站点能用

只配一个 HTTP 代理就能让浏览器出得去，但**服务器上通常要分流**：国内站点走代理会绕一圈回来，反而更慢甚至超时。

### 常见错误配置

```json
"routing": {
  "domainStrategy": "IPIfNonMatch",
  "rules": [{ "type": "field", "outboundTag": "proxy" }]
}
```

两个问题：

1. **第一条规则无条件**：没有任何匹配字段，等于「全部走代理」。
2. **`IPIfNonMatch` 会先解析域名**，而解析请求本身也要经过代理 → 在代理还没连上时死锁。

### 用脚本修

```bash
sudo node scripts/xray-split-route.mjs            # 改分流 + 补 geo 文件 + xray -test
sudo node scripts/xray-split-route.mjs --dry-run   # 只看结果，不落盘
sudo systemctl restart xray
```

它只重写 `routing`，并保证 `direct` / `block` outbound 存在：

```json
"routing": {
  "domainStrategy": "IPOnDemand",
  "rules": [
    { "type": "field", "ip": ["geoip:private"], "outboundTag": "direct" },
    { "type": "field", "domain": ["geosite:cn"], "outboundTag": "direct" },
    { "type": "field", "ip": ["geoip:cn"], "outboundTag": "direct" },
    ...你原有的规则...
  ]
}
```

- 删掉无条件的兜底规则，保留你自己的规则（顺序不动）。
- `IPOnDemand`：只在需要时才解析域名，不预解析。
- 缺 `geoip.dat` / `geosite.dat` 会自动下载到 `/usr/local/share/xray/`（`geoip:cn` 缺数据会让 xray **启动失败**）。
- 改完先跑 `xray -test`，不通过就**自动回滚备份**。
- 幂等：已经是正确分流时 `changed: false`，不会反复改文件。

实测效果（京东云北京 → 美国节点）：修前国内站点 0/3 通、修后 3/3 通、0.11~0.15s。

---

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `chrome_crashpad_handler: Permission denied (13)` | zip 解压丢了可执行位 | 脚本已 `chmod 755`；手工装的话自己补 |
| `apt install` 整条回滚、一个库都没装上 | Ubuntu 24.04 起 `libasound2` 改名 `libasound2t64` | 脚本按 `/etc/os-release` 自动选名，并逐个重装兜底 |
| `EUNSUPPORTEDPROTOCOL` / `npm install` 直接失败 | 在 DSH profile 目录里装（`package.json` 用 pnpm `link:` 协议） | 装到 `<prefix>/pw` 独立目录，脚本已这么做 |
| `xray` 起不来，报 geo 数据缺失 | 缺 `geoip.dat` / `geosite.dat` | 跑 `xray-split-route.mjs`，或手动下载到 `/usr/local/share/xray/` |
| 国内站点变慢/超时 | 分流没做，全部走代理 | 见上一节 |
| Bot 说没有浏览器工具 | `browserPlugin` 没配，或 patch 没生效 | `--print-config` 对照；改完重启 `dsh-web` |
| 装了但 Bot 打不开网页 | 代理不通 / DNS 解析失败 | `node scripts/verify-browser.mjs --chrome ... --shim ... --egress https://api.ipify.org` 看出口 IP |
| 下载卡住或 `fetch failed` | `storage.googleapis.com` 不可达 | 脚本已自动回退镜像；可 `--mirror <base>` 指定内网源 |

自检命令（装完随时可跑）：

```bash
node scripts/setup-browser.mjs --verify-only
# 或指定参数
node scripts/verify-browser.mjs \
  --chrome /opt/dsbot-browser/chrome/chrome \
  --shim /opt/dsbot-browser/pw/pw-proxy-shim.mjs \
  --url https://example.com --egress https://api.ipify.org
```

输出是一段 JSON：

| 字段 | 含义 |
| --- | --- |
| `ok` | 浏览器能用（主 URL 或兜底 URL 至少一个渲染成功） |
| `primaryOk` | **你指定的**那个 URL 通了 |
| `attempts` | 每次尝试的 URL / 状态码 / 标题 / 错误，按顺序 |
| `proxy` | 本次实际使用的代理（`null` = 直连） |
| `egress` | 浏览器真实出口（配了 `--egress https://api.ipify.org` 才有） |
| `bytes` | 截图字节数，0 说明根本没渲染 |

**`ok: true` 但 `primaryOk: false`** 是最常见的一种结果：浏览器本身没问题，
只是那个站点通过当前代理连不上。主 URL 会重试 `--retries`（默认 2）次，仍失败才走兜底 URL
（默认 `https://www.baidu.com`），并在 `note` 里写清楚是哪一侧的问题。

> 租来的代理节点抖动是常态。实测某美国节点从国内服务器访问同一站点，**3 次里只有 1 次成功**，
> 而同一时刻 `curl -x` 也能通 —— 这属于线路质量，不是浏览器或脚本的问题。
> 要稳定访问境外站点，换香港/日本/新加坡的 CN2 GIA 线路，别在应用层重试。

---

## 截图为什么必须走 attachments

装上浏览器后第一次让 Bot 截图，很容易遇到这个报错：

```
This turn failed: Cannot read properties of undefined (reading 'attachmentId')
```

原因不在浏览器，而在**消息形状**。ds-bot 的 `browserOutput.render` 把截图塞成：

```js
{ type: 'image', data: '<base64>', mediaType: 'image/jpeg' }
```

但 DSH 只渲染**带 attachment 引用**的图片块，它的图片管线无条件读
`block.attachment.attachmentId`（`ds-bot/src/host/images.js`）。裸 `data` 字段一路撞到这个读取，
整个 turn 直接失败，截图永远到不了用户面前。

正解是让截图走 DSH 自己的 attachments 服务：

```js
const [ref] = await attachments.saveImages([{ mediaType: 'image/jpeg', data, name: 'Browser screenshot' }])
// render 输出 { type: 'image', attachment: ref }
```

这是同一个形状 DSH 用来显示用户粘贴的图片的形状。

### 还有个更阴的坑：坏消息会永久污染会话

那一轮崩溃时，**坏掉的图片块已经写进会话历史了**。之后这个会话的每一轮都会在构建上下文时
重新读到 `block.attachment.attachmentId`，于是永远报同一个错 —— 看起来像"插件缓存的会话是坏的"，
重启服务也没用。

所以补丁要打两处：

| 文件 | 改动 |
| --- | --- |
| `src/host/browser/mount.js` | 截图先存进 attachments，`render` 输出 `{type:'image', attachment}`；schema 显式声明 `attachment` |
| `src/host/images.js` | 读到没有 `attachment` 的图片块时**跳过**而不是抛错，让历史里的坏数据不再拖垮会话 |

> schema 里 `attachment: { type: 'object' }` 是不够的：DSH 的 JSON Schema 编译器要求
> `additionalProperties` 显式写 `true` 或 `false`，否则整个浏览器插件**挂载失败**（12 个工具全部消失），
> 比原来的 bug 更严重。

一条命令应用（幂等，自动备份，源码不匹配就拒绝改并报出缺哪个锚点）：

```bash
node scripts/patch-ds-bot-image.mjs            # 打两处补丁
node scripts/patch-ds-bot-image.mjs --dry-run   # 只看会改什么
node scripts/patch-ds-bot-image.mjs --revert    # 还原备份
sudo systemctl restart dsh-web
```

`--path <ds-bot 目录>` 用于非默认安装位置。

### 中文显示成方框

无头 Chrome 所在的服务器如果没装中文字体，截图里汉字会全部变成 □。装一次即可：

```bash
sudo apt-get install -y fonts-noto-cjk fonts-wqy-zenhei
fc-cache -f
```

---

## 安全

- **代理凭据不入库**：`browser-proxy.json` 只写在本机，仓库里只有 `.example` 形状的说明。
- **每个 Bot 独立 profile**：登录态按 Bot 隔离，删除 Bot 即清理。
- **站点审批**：ds-bot 的 `refs` 插件在敏感动作（提交、上传、支付类页面）上会请求用户批准，`browser_handoff` 把控制权交还给人。
- **不要用 root 长期跑浏览器**：生产建议单独用户；root 下 Playwright 会自动加 `--no-sandbox`，隔离性变弱。
