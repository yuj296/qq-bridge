# AGENTS.md — 给 AI 代理的项目说明

> **这份文档是给 AI 编码代理读的，不是给人读的教程。**
> 目标：一个**没有任何上下文**的代理读完这份，就能知道项目是什么、文件在哪、改哪里、
> 怎么验证、哪些坑不能踩。
>
> **权威性顺序**：本文件 > [`PORTING-DSH-0.1.2.md`](PORTING-DSH-0.1.2.md) >
> [`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md) > 代码注释 > `README.md`。
> 发生冲突时以靠前者为准。

---

## 0. 一句话

把 QQ **私聊**消息接进 **DSH（DeepSeek Harness）** agent：

```
QQ 私聊消息 → SnowLuma(OneBot v11) → 本桥接进程 → DSH 会话 → agent 生成回复 → 回到 QQ 私聊
```

> ⚠️ **本仓库只服务「主人（`ownerQQ`）↔ 机器人的私聊」。群聊能力已被彻底移除：**
> 不注册群消息入口、没有群发送路由、MCP 工具里没有群工具、配置里没有 `allow.groups`
> / `deny.groups`。**群消息（`group_id` 非空的事件）会被直接忽略**，不进会话、不投喂
> agent、也不回复。护栏测试：`node scripts/test-no-group.mjs`（§6）。

**本仓库是「DSH 0.1.2 适配版」。** 上游原版基于 `@deepseek-ai/dsh-host-apiproxy`
（DSH ≤ 0.1.1 的 HTTP API），该包在 **DSH 0.1.2-alpha.1 起被官方删除**，
所以原版在 0.1.2 上**完全连不上**。移植细节见 `PORTING-DSH-0.1.2.md`
（**该文档是历史记录**：其中「群」相关的描述是移植当时的状态，不是现在的行为）。

---

## 1. 硬前提（缺一个都跑不起来）

| 依赖 | 要求 | 本机实测值 |
|---|---|---|
| Node.js | ≥ 22.13 | v24.9.0 |
| DSH | Web 形态可访问 | DSH Desktop 0.8.2（内置 harness 0.1.2-rc.1，`http://127.0.0.1:43129`） |
| SnowLuma | 已安装并**已登录 QQ** | v1.14.16，`C:\SnowLuma`，WebUI `127.0.0.1:5099` |
| 平台 | Windows（自启脚本与 SnowLuma 注入均为 Windows 专用） | Windows |

**SnowLuma 是注入式框架**（同 NapCat / LLOneBot）：它把 DLL 注入正在运行的 `QQ.exe`。
所以 **QQ 客户端必须开着且已登录**，否则收不到任何消息 —— 这是设计使然，不是 bug。
另外它的 `runtime.json` 里 **`hookAutoLoad` 必须为 `true`**（默认为 `false`，
此时它只会连「已经带 DLL 的 QQ 进程」、**不会注入新启动的 QQ 客户端**）。详见 §7。

---

## 2. 文件地图（决定「改哪里」）

| 路径 | 职责 | 什么时候改它 |
|---|---|---|
| `src/bridge.js` | **主程序**（~8.2k 行）。QQ 私聊事件处理、会话映射、模式逻辑、控制台 HTTP、social/reserved2 仿真 | 业务逻辑 |
| `src/settings-merge.js` | **设置页 → cfg 的合并规则**（纯函数：只覆盖 user 层、撤销时回磁盘值） | 改优先级/覆盖规则时 |
| `src/dsh-client.js` | **DSH 0.1.2 客户端**。鉴权、端点调用、事件流多路复用、提问/审批双向翻译 | DSH 协议变更时 |
| `src/dsh-client.0.1.1.js.bak` | 上游原文件（对照用，**不要改动、不要删**） | 永不 |
| `src/mcp-*.js` | 三个 MCP server，作为子进程被 DSH 拉起。`mcp-snowluma-safe.js` 对外 **30 个 `qq_*` 工具，全部是私聊语义**（没有群工具） | 给 agent 加工具时 |
| `dsh/agent-presets/qq-chat*/` | 两个 DSH agent preset（**安全边界在这**） | 改 agent 人格/权限时 |
| `plugins/qq-mode-console/` | **DSH 设置页的「QQ 机器人」分区**（host 注册 settings 命名空间 + client 渲染整页表单） | 加/改可调项时 |
| `plugins/qq-wake/` | **DSH 侧边栏「唤醒」按键**：host 路由 `/api/qq-wake/*` + client DOM 行 | 改唤醒行为时 |
| `scripts/test-qq-settings.mjs` | 设置项自测（字段表 ↔ schema ↔ config.json 覆盖率、说明长度） | — |
| `scripts/test-qq-settings-page.mjs` | 设置页自测（注册槽位/order + SSR 渲染结果） | — |
| `scripts/test-plugin-entry.mjs` | **插件入口冒烟**（真的 import 一次入口，挡「导入了不存在的导出」这类让 harness 起不来的错误） | 加/改插件入口或 `schema.js` 导出时 |
| `scripts/test-settings-merge.mjs` | **设置覆盖规则**（纯函数单测：只覆盖 user 层、控制台改动不被冲掉、撤销回磁盘值） | 改 `src/settings-merge.js` 时 |
| `scripts/test-wake.mjs` | 唤醒流程自测（`--status` / `--no-send` / `--guards` 守护规则） | — |
| `scripts/test-wake-client.mjs` | 唤醒按键**客户端半侧**自测（jsdom 造仿 DSH 侧边栏） | — |
| `scripts/test-wake-fence.mjs` | **唤醒路由的信任围栏**自测（主机名严格字面量、回环、同源标记、写操作 JSON）；`--live` 打真路由 | 改围栏判定时 |
| `scripts/test-no-group.mjs` | **「只有私聊」的回归测试**（隔离实例 + 假 OneBot：灌群消息断言零影响、灌私聊断言正常处理） | 改消息入口 / 白名单 / 发送链时 |
| `tools/dsh-qq-bot.ps1` | 守护脚本（**可选自启**，默认不装） | 改运维策略时 |
| `scripts/setup-dsh.mjs` | DSH 端安装 | 安装流程变更时 |
| `scripts/dsh-status.mjs` | 状态总览（**排查第一步**） | — |
| `scripts/publish-fork.mjs` | **不依赖 git push** 的发布工具（走 GitHub Git Data API，只传变更文件） | 往 fork 推改动时 |
| `PORTING-DSH-0.1.2.md` | 移植记录（协议差异、缺陷复盘、实测证据）。**历史文档**：其中的「群」相关描述是移植当时的状态 | 每次实质改动后 |

**关键认知**：`bridge.js` 虽然大，但**业务逻辑与 DSH 协议是解耦的**。
`dsh-client.js` 对外保持旧协议的调用面与返回契约
（`{ rpcId, result: { ok, value | error } }`），所以改 DSH 协议只需动 `dsh-client.js`。
**不要为了适配 DSH 去改 `bridge.js` 的业务逻辑。**

---

## 3. 数据流（含关键不变量）

### 3.1 鉴权（DSH 0.1.2 起强制）

```
GET http://127.0.0.1:<port>/?token=<launchToken>   ← 令牌只在根路径被接受
  → 303 + Set-Cookie: dsh-auth-*
  → 之后所有请求（含 /api/remote.mux 的 WS 升级）都带该 cookie
```

- 令牌与端口**每次 DSH 重启都会变**，客户端从
  `%APPDATA%\dsh-desktop\logs\harness.log` 的最后一条 `dsh web: <url>?token=…` 自动发现。
- 401 时客户端会**重新发现令牌并重试一次**。
- 令牌是**敏感信息**：不要写进文档、不要提交进仓库。

### 3.2 一元调用

```
POST /api/<namespace>/<method>          ← 斜杠，不是点号
body: {"type":"client-request","rpcId":"<uuid>","method":"<namespace>/<method>",
       "payload":{"args":{<wire 名>: <值>}}}
resp: {"type":"server-response","rpcId":…,"result":{"ok":true,"value":…}}
```

参数**必须**用 `{ args: {...} }` 包一层，字段名按端点 descriptor（`wire` 名）。

### 3.3 事件流（`/api/remote.mux` WebSocket，多路复用）

```
客户端→Host: {"type":"open","streamId":…,"endpoint":…,"payload":{"args":{…}}}
             {"type":"cancel","streamId":…}
Host→客户端: {"type":"item","streamId":…,"value":…} / {"type":"end",…} / {"type":"error",…}
```

两条来源，由 `dsh-client.js` 合并成旧形状信封 `{ rpcId, payload: frame }`：

1. **每个被登记会话一条 `session/follow`** —— 产出
   `{type:'session/event', sessionId, event}`。
2. **一条 `$events`** —— 服务端→客户端请求（提问 / 审批）。帧类型：
   - `{type:'ready', clientId}` —— 必须先拿到它才能回执
   - `{type:'waterfall', event, eventId, agentId, request}` ——
     `event` 为 `user-questions/request` 或 `approval/request`
   - `{type:'cancel', eventId}` —— **该请求已在别处被回答**，必须撤下本地挂起

   回执：`POST /api/$events/result`，payload `{args:{clientId,eventId,outcome}}`，
   `outcome` ∈ `{kind:'result',value}` / `{kind:'next'}` / `{kind:'rejected',error}`。

### 3.4 不变量（违反会出难查的 bug）

- **`turn/start` 必须能被观察到**，否则 `createTurnCollector` 拼不出回合 →
  桥接认不出回合结束 → **回复不会转发到 QQ**。因此
  `sessions.prompt()` 内部会先 `await waitForSessionReady(sessionId)`。
- **ask 超时不要替用户「拒绝」**：走 `{kind:'next'}` 交还，否则会吃掉 DSH GUI 的审批权。
- **`process.exit()` 不能在 await 完成的同一个 tick 里调用**（libuv 断言），
  统一用导出的 `exitCleanly()`；WebSocket 用 `terminate()` 而非 `close()`。
- **snapshot 回放策略**：mux 启动时就登记的会话（重启恢复的）**丢弃** snapshot；
  mux 运行期间新登记的会话**回放**（防 follow 慢于第一回合）。

---

## 4. 配置（`config.json`，**不入库**；模板见 `config.example.json`）

**改配置的首选入口是 DSH 设置页的「QQ 机器人」分区**（见 §5.2；在设置左边导航里，
「通用设置」正下方）—— 它把下面这张表整份搬到了 UI 上，140 项全可改，每项都带详细说明。优先级：
**设置页里改过的字段 > config.json（磁盘） = 桥接控制台改的值 > 代码默认值**
（桥接只覆盖「你在设置页里动过的那几项」，没动过的它一个字都不碰）。

> 字段清单的唯一真源是 `plugins/qq-mode-console/lib/schema.js` 的 `FIELDS` 表；
> 下面这张表只是**重点项的速查**，不是全集。
> **里面没有任何群相关字段**：`allow.groups` / `deny.groups` / 群仿真参数等 16 个字段
> 已随群聊能力一起删除，别再往 `config.json` 里写。

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.baseUrl` | `http://127.0.0.1:3080` | 留默认即走自动发现；显式写了非默认值则以其为准 |
| `dsh.token` | 空 | 可选，覆盖自动发现 |
| `dsh.harnessLog` | 空 | 可选，自定义 `harness.log` 路径 |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | SnowLuma 的 **WebSocket** 地址 |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | SnowLuma 的 **HTTP API** 地址。**填成纯 WS 端口会报 HTTP 426** |
| `snowluma.accessToken` | 空 | 两端**必须同一个值**；若用 3000 那条（见 §7）只需一个 token |
| `ownerQQ` | 必填 | **管理员本人的 QQ**，不是机器人号。见 §7 |
| `allow.private` | `[]` | **私聊**白名单（QQ 号数组）。为空且 `allowAllWhenEmpty:false` ⇒ 什么都不放行。**没有 `allow.groups`** —— 群聊已移除 |
| `deny.private` | `[]` | **私聊**黑名单，优先级高于白名单 |
| `relayApprovalsToOwner` | `true` | 把非 QQ 会话的审批转发到管理员私聊 |
| `notifyTaskDone` | `true` | DSH 任务完成通知总开关 |
| `notifyTaskDoneMinTurnMs` | `300000` | 只通知跑够这么久的回合（**用户选定 5 分钟**） |
| `notifyTaskDoneDebounceMs` | `15000` | 回合结束后静默期，期间开新回合则撤销通知 |
| `sessionDiscoveryMs` | `30000` | 扫描 DSH 会话列表的间隔 |
| `agentPreset` / `socialV2.agentPreset` | `qq-chat` / `qq-chat-v2` | DSH 侧 agent preset |
| `consolePort` | `3100` | 本桥接的本地控制台 |

---

## 5. 运行与自启

```bash
node src/bridge.js          # 直接跑（前台）
# 或双击 start.bat / restart.bat
```

**默认没有自动启动。** 机器人只在 DSH 侧边栏点「唤醒」时才起来（见 §5.1）——
不注册计划任务、不开机自启、不做常驻守护。这是用户的明确要求，别自作主张加回去。

`tools/` 里的自启守护（`dsh-qq-bot.ps1` + 计划任务 `DSH QQ Bot Supervisor`）是
**可选件、默认不装**。真要「开机自启 + 自愈」时再手动跑 `tools/install-task.ps1`；
那一套的要点在 `tools/README.md`（两个触发器缺一不可；判断守护死活看
`state/supervisor/supervisor.heartbeat`，别看计划任务的 `State` —— 它被杀后照样显示 `Ready`）。

**改完 `config.json`、`bridge.js`、`dsh-client.js` 都必须重启桥接才生效**：
装了自启守护的话它会在 ~20s 内自动拉起；**默认没装，所以要么点一次「唤醒」，
要么手动跑 `node src/bridge.js`**。

**注意 `bridge.log` 的时间戳是 UTC**（比本地时间少 8 小时），`supervisor.log` 是本地时间 ——
对时间线时先换算，别以为桥接是几小时前死的。

### 5.1 侧边栏「唤醒」按键（`plugins/qq-wake/`）

DSH Web GUI 侧边栏「技能中心」正下方那个**唤醒**按键 = 「把机器人拉起来 + 给管理员发一句
『睡醒了』」。它是**双半侧插件**：

| 半侧 | 文件 | 怎么被加载 |
|---|---|---|
| 宿主 | `lib/index.js` | 用户 patch 层的 `file://` 条目（同 `qq-mode-console`） |
| 客户端 | `lib/client.js` | `dsh-client-modules` 从**挂载文件最近的 `package.json`** 里读 `dsh.client` + `exports["./client"]`，组进浏览器启动图 |

要点（改这个插件前必读）：

- **改插件源码必须重启 DSH**：宿主进程在启动那一刻就把插件入口 `import` 进来了，
  Node 的模块缓存不会因为文件变了就失效。**实测证据**：改完围栏判定后，运行中的
  `/api/qq-wake/status` 照旧按老代码放行伪装 Host（`test-wake-fence.mjs --live` 会直接点出来）。
  只有改 patch 层条目（`cordis.patch.yml`）才是重跑 `setup-dsh.mjs` 即可生效；
  客户端半侧的启动图也是启动时快照的，**F5 不够**。
- **客户端半侧不是普通 ESM**：必须有 `window.__ModuleLoader__.load({id, factory})` 外壳，
  `id` 等于包名，`factory` 返回 `module.exports` 并挂 `apply`/`inject`。
- **客户端 `apply` 绝不能抛**（抛了整个 Web 外壳起不来）；本插件全部包在 try/catch 里。
- **侧边栏没有对外 slot**：只能 DOM 注入 + MutationObserver 自愈，锚点是
  `[data-dsh-skill-explorer-entry]`（技能中心那一行）。
- **控制台令牌不下发到页面**：浏览器只跟同源的 `/api/qq-wake/*` 说话，宿主侧再带
  `x-console-token` 去敲桥接控制台；路由有本机 + 同源信任围栏。
- 细节与坑见 `plugins/qq-wake/README.md`。

### 5.2 设置页「QQ 机器人」分区（`plugins/qq-mode-console/`）

配置的**主入口**：DSH「设置」左边导航里**「通用设置」正下方**那个 **QQ 机器人**分区
（`settings.section`，order=1），140 个字段按 10 组分好
（基本 / 通知 / 白名单 / 黑名单 / 安全 / 黑话学习 / 一代仿真 / 二代仿真 / 模型与 DSH 接线 / SnowLuma 接线），
每个字段都带一段中文说明，改完点保存 → 桥接 5 秒内生效。

机制（改之前必读）：

| 半侧 | 文件 | 干什么 |
|---|---|---|
| host | `lib/schema.js` | **字段表（唯一真源）**：`[路径, 类型, '标签', '详细说明']` + 分组表 `GROUPS` |
| host | `lib/index.js` | 按字段表建 schema，注册 `qq-mode` 命名空间；`base` = 当前 `config.json`（机密与 `mode` 除外） |
| client | `lib/client.js` | 注册 `settings.section` 分区；**按 schema 自动生成页面**，所以加字段只改 `schema.js` |
| bridge | `src/settings-merge.js` + `bridge.js` 的 `applySettingsOverrides()` | 每 5s 拉一次**命名空间的 user 层**合并进 cfg（只覆盖用户改过的字段） |

- **只认 `ns.user`，不要用 `ns.value`**：`ns.value` = base + user，而 base 是 **DSH 启动那一刻的
  config.json 快照**，用它整体覆盖会把运行期间**桥接控制台**改的配置（白名单/黑话/社交参数）
  在 5 秒后改回去 —— 这个坑真踩过，见 PORTING §8.1。用户没碰过的字段必须一个字都不动。
- **撤销要回磁盘值**：用户点「已改」重置后该字段从 user 层消失，桥接靠"上一轮施加过的路径" +
  重读 `config.json` 把它还原（不然会卡在旧覆盖上）。规则在 `src/settings-merge.js`，
  单测 `scripts/test-settings-merge.mjs`。
- **DSH 的设置页不会自动渲染 settings 命名空间**：左边导航每个分区都是插件用
  `settings.section` 自己注册的（官方 order：通用设置 0 / 模型 10 / 插件 15 / Agent 预设 20），
  「插件 → 插件配置」也只渲染有人认领的命名空间（`settings.plugin.item` 按 namespace 分键）。
  **光调 `ctx.settings.register()` 界面上什么都没有** —— 必须自带 client 半侧写页面。
- **分组只活在展示层**：schema 的嵌套结构必须等于 `config.json` 的嵌套结构（桥接要深合并），
  所以 `notifyTaskDone*` 这些顶格字段归到"通知"组靠的是 host/client 各一份的
  `TOP_LEVEL_GROUPS` 表（`test-qq-settings.mjs` 校验两边一致），不能真把字段挪进 `notify` 对象。
- **机密不进 schema**：`snowluma.accessToken` / `consoleToken` / `dsh.token` 只认 `config.json`。
  设置协议强制 redactSecrets，桥接读不回来，写进去只会变成只写陷阱。
- **`mode` 不进 base**：没在页面里选过模式，就沿用桥接控制台 / `state/mode.json`（老行为）。
- **改了要重启桥接的项**：`consolePort`、`snowluma.wsUrl/httpUrl`（字段说明里标了 ⚠️）。
  其余项（白名单、通知、仿真参数、工具开关…）都是下一拍就生效。

---

## 6. 验证（改完必须跑）

| 命令 | 验证什么 | 期望 |
|---|---|---|
| `node scripts/dsh-status.mjs` | DSH 侧状态：preset / 设置命名空间 / 插件清单 | 6 个 preset（含 `qq-chat*`）、命名空间含 `qq-mode`、**五个** `qq-bridge` 插件 `active`（含 `qq-wake`） |
| `node src/self-test.js` | DSH 链路（不发 QQ） | 打印 agent 回复、`exit 0` |
| `node scripts/test-dsh-012.mjs` | 全链路：工作区/会话/prompt/事件流 | 收到 `turn/start`…`turn/end`，`exit 0` |
| `node scripts/test-preset-012.mjs qq-chat` | preset 能否建会话并跑完回合 | `回合结束 reason = completed` |
| `node scripts/test-dsh-question-012.mjs` | 提问 waterfall（**慢**，真实跑一轮 agent） | 收到 `question/requested` 并能作答 |
| `node scripts/fake-onebot.mjs` | **无 QQ 也能端到端测桥接** | 注入私聊后打印桥接回发的消息 |
| `node scripts/test-no-group.mjs` | **「群聊已彻底移除」回归测试**：起隔离实例 + 假 OneBot，灌群消息断言零影响（不建会话、不投递、不回复），再灌私聊断言照常处理作为对照 | 17 项全 ✓、`✅ 群聊已被彻底移除，私聊不受影响`、`exit 0` |
| `node scripts/test-wake.mjs --status` | 侧边栏「唤醒」按键的宿主侧逻辑：守护/桥接/OneBot 登录态 | `awake: true`，`exit 0` |
| `node scripts/test-wake.mjs --no-send` | 唤醒的**冷启动**链路（不发 QQ 消息） | 三步全 ✓，`exit 0` |
| `node scripts/test-wake.mjs --guards` | **唤醒的守护规则**：并发调用复用同一次（单飞）、锁会释放、SnowLuma 目录不存在时干净失败 | 3 项全 ✓、`exit 0` |
| `node scripts/test-wake-client.mjs` | **客户端半侧**（jsdom 造仿 DSH 侧边栏）：行是否落在「技能中心」正下方、点击是否打唤醒路由、外壳未就绪时是否不抛 | 13 项全 ✓，`exit 0`（缺 jsdom 则跳过） |
| `node scripts/test-wake-fence.mjs [--live]` | **唤醒路由的信任围栏**（38 项：主机名严格字面量、socket 回环、`sec-fetch-site`/`Origin`、写操作必须 JSON）。加 `--live` 再打一遍运行中的真路由（自动发现端口） | 38 项全 ✓、`exit 0`；`--live` 时「本机 200 / 伪装 Host 403 / 跨站 Origin 403」 |
| `node scripts/test-qq-settings.mjs` | **设置项**：字段表 ↔ schema ↔ `config.json` 是否对得上（覆盖率/重复/类型/说明长度/两边分组表一致） | 140 项全 ✓、`config.json` 全覆盖（机密除外）、`exit 0` |
| `node scripts/test-settings-merge.mjs` | **设置覆盖规则**（纯函数单测，24 项）：只覆盖 user 层、控制台改动不被冲掉、撤销回磁盘值、深拷贝隔离 | 24 项全 ✓、`exit 0` |
| `node scripts/test-qq-settings-page.mjs` | **设置页**：注册进 `settings.section`、`order=1`、SSR 渲染出 10 个分组与字段说明 | 15 项全 ✓、`exit 0`（缺 react 则跳过） |
| `node scripts/test-plugin-entry.mjs` | **插件入口**：每个 `plugins/<name>` 的入口真能 import 进来、导出了 `name`/`apply`/`inject`、客户端半侧文件在、`cordis.patch.yml` 的 id 对得上 | 15 项全 ✓、`exit 0`。**入口写错会让整个 harness 起不来，改完插件务必先跑这支** |
| `node scripts/scan-secrets.mjs` | **发布/提交前自检**：有没有把令牌、真实 QQ 号、本机路径写进会入库的文件 | `✅ 未发现敏感信息`，`exit 0` |

> 已删除：`scripts/send-test-group.mjs`（群发测试脚本）—— 群聊移除后它没有存在意义，
> 别再在任何命令列表里引用它。

**沙箱/CI 注意**：本机 PowerShell 管道捕获 `node` 输出会被沙箱拦（命名管道），
裸跑 `node x.js` 让输出继承 stdout 即可。改完 `.ps1` 必须确认 **UTF-8 BOM** 还在（见 §7）。

---

## 7. 已知坑（**AI 最容易搞错的地方，按踩坑代价排序**）

1. **SnowLuma 的 `hookAutoLoad` 默认 `false`** —— 它只连「已带 DLL 的 QQ 进程」。
   QQ 客户端一重启，新进程没 DLL，SnowLuma 就**永远** `login detected` 不出来，
   日志只剩 `SnowLuma starting` + WebUI 监听。
   **极易误判成「QQ 没登录」**。排查时先看日志里有没有
   `hook auto-load enabled` 和 `[Hook] login detected`。
2. **`ownerQQ` 是本人 QQ，不是机器人 QQ。** 代码用 `event.user_id`（发送者）与它比对判定
   管理员；且 `user_id === self_id`（机器人自己发的）消息会被**直接丢弃**。
   所以只有本人号才有意义。**测私聊要用机器人号以外的 QQ 号**给机器人发消息：
   用机器人号自己发会被丢弃，用不在 `allow.private` 里的号发则会被白名单忽略
   （群消息现在是整体忽略，压根进不了这条链路）。
3. **`httpUrl` 必须是 HTTP API 端口**，填成纯 WS 端口报 `HTTP 426`。
   SnowLuma 的「HTTP 服务端」条目若 `enableWebSocket=true`，
   则**同一端口同时提供 HTTP API 与 WebSocket 且共用一个 token** ——
   此时 `wsUrl`/`httpUrl` 都指向它、只填一个 token，**不必去统一两端 token**。
4. **PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解析**，中文把引号/花括号吞掉 →
   一堆莫名的语法错误（报错里能看到 `鎵嬪姩` 这类乱码）。
   `tools/*.ps1` **必须保持 UTF-8 with BOM**；`pwsh`(7) 没这问题，用 pwsh 测不出来。
5. **审批/提问是「广播给所有客户端」的**：桥接与 DSH GUI 会同时拿到，
   **谁先回答谁生效**，另一方靠 `cancel` 帧撤下。所以超时**不能替用户拒绝**。
6. **`qq-chat*` preset 按设计不挂任何本地工具**（无 bash/文件/子代理）——
   这是安全边界，不是 bug。**因此 QQ 会话触发不了工具审批**；
   要测审批得用带工具的 preset（如 `standard`）。
7. **DSH 每个会话的事件必须单独订阅**（`session/follow`），没有全局会话流。
   想订阅「用户自己的编码会话」需显式 `startSessionDiscovery()`。
8. **`qq-mode` 命名空间只覆盖「卡片里写过」的字段**：`refreshMode()` 先读设置命名空间，
   只有 `mode` 真在命名空间里（也就是在设置卡片里选过）才用它，否则回退
   `state/mode.json`（= 桥接控制台）。
   ⚠️ **本条以前写的是「装了插件后切模式要用 DSH 设置页」，那是错的** ——
   在 §5.2 那张卡片存在之前，命名空间根本没有 UI（见坑 10），切模式只能用桥接控制台。
9. **`config.json` / `state/` 含密钥与运行时数据，绝不入库**（`.gitignore` 已排除）。
10. **DSH 的设置页不会自动渲染 settings 命名空间**：插件配置分区只渲染**有人认领**的命名空间
    （`settings.plugin.item` 按 namespace 分派卡片），官方只给自己的几个命名空间写了卡片。
    **光调 `ctx.settings.register()` 是不会出现任何 UI 的** —— 必须自带 client 半侧写卡片，
    否则用户永远看不到（这正是 qq-mode 之前的状况）。
11. **schemastery 的 Schema 实例是「函数」**（可调用做校验），不是普通对象。
    写「叶子 vs 分组」判断时用 `typeof x.type === 'string'`，
    用 `typeof x === 'object'` 会递归进 Schema 内部（有循环引用）→ 直接爆栈。
12. **设置覆盖只认 `ns.user`**：`ns.value` = base + user，而 base 是 **DSH 启动那一刻的
    config.json 快照** —— 拿它整体覆盖会把运行期间**桥接控制台**改的配置在 5 秒后改回去
    （真踩过，见 PORTING §8.1）。撤销（字段从 user 层消失）要靠"上一轮施加过的路径 +
    重读 config.json"还原，否则会卡在旧覆盖值上。
13. **`spawn()` 的失败是异步 `emit('error')`**：没挂 `error` 监听器时 Node 抛未捕获异常 ——
    在宿主插件里就是**把 DSH harness 打崩**。同理**杀进程前先确认那个 pid 现在还是 node**
    （pid 会被系统复用，陈旧 pid 文件可能指向别的程序）。`plugins/qq-wake/lib/wake.js` 两处都有防护，
    见 PORTING §8.2/§8.3。
14. **判「请求来自本机」不能用字符串前缀**：`host.startsWith('127.')` 会把
    `127.0.0.1.evil.com`、`127.0.0.1.nip.io` 当成回环 —— 只要攻击者有个「以 `127.` 开头、
    A 记录指向 127.0.0.1」的域名，DNS 重绑定就能整条穿过围栏（`Host` 过了、`Origin` 过了、
    浏览器还老实报 `sec-fetch-site: same-origin`），实测拿到 **200**，见 PORTING §8.5。
    必须按 **IP 字面量严格解析**（四段十进制 + 每段 ≤255 + 首段 127）。
    另外记住：**测围栏要穷举「攻击者能构造的请求头」，只测自己想到的那几种等于没测** ——
    上一轮审计就是漏了这一种才误判成"没问题"。护栏：`scripts/test-wake-fence.mjs`。
15. **群聊是「已移除」而不是「没配」**：收到带 `group_id` 的事件时没有降级路径、
    没有开关能打开它 —— 别去 `config.json` 里找 `allow.groups`（那字段已被删，
    写了也无效），也别期待 `/api/send/group` 之类的路由（已删）。
    **私聊引用回复走 `POST /api/send/reply` + `body.userId`**（旧版是 groupId）。
    要确认这条边界还在，跑 `node scripts/test-no-group.mjs`。

---

## 8. 故障速查

| 症状 | 先看 | 大概率原因 |
|---|---|---|
| **什么都没启动（端口 5099/3000/3100 全不通）** | 先点一次侧边栏「唤醒」 | **这是预期状态**：默认不自动启动，机器人只在点唤醒时起来（§5.1）。唤醒失败就看按钮 tooltip 里卡在哪一步 |
| （仅当装了可选自启守护时）日志只有一行 `守护启动` 之后没有下文 | `supervisor.heartbeat` 时间戳走不走；任务 `LastTaskResult` | 守护进程被杀（`0xC000013A` = 控制台关闭事件）→ 每 5 分钟看门狗会补位；或干脆改用「唤醒」按键 |
| 桥接起不来、报「已有一个实例在运行」 | `state/bridge.lock` | 重复启动；守护会清过期锁 |
| `SnowLuma 连接断开（code=1006）` 刷屏 | 端口 3000/3001 | SnowLuma 的 QQ 会话掉了 → 见坑 1 |
| OneBot 端口在听但 `/get_login_info` 超时 | SnowLuma 日志 `EPIPE` | 注入管道断了；重启 SnowLuma（**不用重扫码**） |
| agent 收到消息但不回 | `state/bridge.log` | 模式是 `reserved2`（AI 自主决定/走工具），或 preset 未安装 |
| 回复没转发到 QQ | 日志找 `turn/end` | 见 §3.4 第一条（`turn/start` 缺失） |
| 审批没到手机 | `relayApprovalsToOwner` | 或该会话被映射到了别的 QQ 会话 |
| **群里的消息完全没有反应** | —— | **设计如此**：群聊能力已移除，群消息被直接忽略（§0、坑 15）。只有私聊会被处理 |
| 侧边栏**没有「唤醒」按键** | 页面是否刷新过（F5）；`/api/qq-wake/status` 是否 200 | 插件挂了但页面是旧的 → 刷新即可；路由也 404 则是 patch 层没挂上（重跑 `setup-dsh.mjs`） |
| 点唤醒报「唤醒失败」 | tooltip 里那几行步骤 | 多半是 QQ 客户端没开/没登录（SnowLuma 注入不了），或桥接 60s 内没起来 |
| 设置页里**找不到「QQ 机器人」分区** | 设置左边导航里「通用设置」下面有没有；DSH 重启过没有 | 分区由 client 半侧注册（`settings.section`）；改完插件要**重启 DSH** 才会加载（F5 不够） |
| 设置页改了但机器人行为没变 | `state/bridge.log` 找「已从 DSH 设置页应用 N 项配置」 | 桥接每 5s 拉一次；`consolePort`/`snowluma` 地址这类接线项要重启桥接 |
| **在控制台改的配置过几秒自己变回去** | `state/bridge.log` 找「已从 DSH 设置页应用」 | 历史缺陷（已修，见 PORTING §8.1）：以前拿 base+user 整体覆盖。确认 `src/settings-merge.js` 在位、`refreshMode()` 读的是 `ns.user` |
| 保存设置报「写入后状态异常」 | 设置提供方是否可写（`settings.describe` 的 `writable`） | 本机设置存储只读或 revision 冲突（另一个页面刚改过）→ 重新加载页面再存 |
| DSH 启动报 `cannot resolve profile bundle` | `profiles/*/cordis.patch.yml` | 是**旧版脚本**残留；见 `PORTING-DSH-0.1.2.md` §6 |

统一入口：**侧边栏「唤醒」按键的 tooltip**（卡在哪一步一目了然）+ `state/bridge.log`；
装了可选自启守护时再加 `state/supervisor/supervisor.log` 与 `tools/README.md` 的故障速查表。

---

## 9. 改动约束（**不要动的东西**）

- **不要**把 `qq-mode-console` 改成往 profile 的 `package.json` 写 `link:` 依赖 +
  `dsh.profile.bundles` —— 在 DSH Desktop 上会**弄坏 DSH 启动**（详见 §6 of PORTING 文档）。
  正确做法是挂在用户 patch 层的 `file://` 条目上。
- **不要**为了「兼容」去改 `src/dsh-client.0.1.1.js.bak`。
- **不要**把 `ownerQQ` 填成机器人号。
- **不要**在发给管理员的审批里做敏感信息脱敏（会把目标路径藏掉，等于让用户闭眼批权限）；
  非 QQ 会话（你在 DSH 里开的编码会话等）的审批仍应照常审计。
- **不要**把群聊能力「兼容回来」：不要再注册群消息入口、不要恢复群发送/群工具/群白名单字段
  （已按用户要求彻底移除，见 §0、坑 15）。确实需要群聊时先问用户，别自作主张。
- **不要**用 `process.exit()` 替代 `exitCleanly()`。
- **不要**把带客户端半侧的插件入口写成仓库里的散文件 —— `dsh-client-modules` 是
  从「挂载文件**最近的 `package.json`**」里读 `dsh.client` 声明的，散文件找不到声明，
  按键就永远不出现。必须挂在插件包自己的目录里（见 §5.1）。
- **不要在客户端半侧（`lib/client.js`）里抛异常**：客户端插件 apply 抛出会让整个
  Web 外壳启动失败。
- **不要**把桥接控制台令牌（`state/console-token`）下发到浏览器；一律由宿主半侧代发。
- **不要**用 `ns.value`（= base + user）去覆盖运行中的 cfg —— base 是 DSH 启动时的 config.json
  快照，会把控制台运行期改的东西改回去；**只认 `ns.user`**（见 §5.2、PORTING §8.1）。
- **不要**在宿主插件里 `spawn()` 却不挂 `error` 监听器（未捕获的 child error 会把 DSH 打崩）；
  也**不要**只凭一个陈旧 pid 就 `process.kill()`（pid 会被复用，先确认它还是 node）。
- **不要**用 `startsWith('127.')` 这类字符串前缀去判 IP / 主机名（`127.0.0.1.evil.com`
  会命中，等于围栏没设）—— 按 IP 字面量严格解析，见坑 14。
- **不要**把 `config.json`、`state/`、令牌、QQ 号写进仓库或文档。

---

## 10. 相关文档

| 文档 | 内容 |
|---|---|
| `PORTING-DSH-0.1.2.md` | 移植全过程：协议差异表、**6 个缺陷复盘**（§7 入口导出漂移、§8 设置覆盖反噬 + 唤醒 4 隐患（含围栏被伪装 Host 穿过））、DSH 端安装、两个手机端能力。**历史文档**：开头有「群聊已移除」的时效说明，群相关段落是移植当时的状态 |
| `docs/PROJECT_GUIDE.md` | 项目说明书（架构/数据流/配置，已按「仅私聊」更新；协议细节以本文件与 PORTING 为准） |
| `docs/DSH_SETUP.md` | DSH 端安装步骤（已按 0.1.2 与「仅私聊」更新） |
| `tools/README.md` | 自启守护、常用命令、故障速查 |
| `RULES.md` | 运行模式（chat / closed-agent / reserved / reserved2）与权限边界 |
| `README.md` / `README.en.md` / `plugins/qq-mode-console/README.md` | 对外说明：功能、安装、设置页插件机制 |
