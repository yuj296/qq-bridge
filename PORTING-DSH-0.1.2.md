# 移植说明：适配 DSH 0.1.2 gateway 协议

> ## ⚠️ 时效说明（后加的，不是移植当时写的）
>
> **本仓库在移植之后又做了一次大改：群聊能力被彻底移除，现在只服务「主人（`ownerQQ`）
> ↔ 机器人的私聊」。** 群消息（`group_id` 非空的事件）会被直接忽略；MCP 工具从 36 个减到
> **30 个**（6 个群工具全删）；`allow.groups` / `deny.groups` 等 **16 个群相关配置字段**已删除
> （设置项 156 → **140**）；`/api/send/group` 路由已删除，私聊引用回复改走
> `/api/send/reply` + `body.userId`。
>
> 因此：**本文档里所有与「群」相关的内容 —— 缺陷复盘中的群语境举例、156 项设置的记录、
> 群工具/群白名单的描述 —— 都是移植当时的历史状态，不代表当前行为。**
> 这些历史事实**原样保留、不再修订**（本文是历史记录）。
> 当前行为一律以 [`AGENTS.md`](AGENTS.md) 为准；「群聊已移除」这条边界由
> `node scripts/test-no-group.mjs` 盯着。

本仓库原本基于 `@deepseek-ai/dsh-host-apiproxy`（DSH ≤ 0.1.1）的 HTTP API。
该包在 **DSH 0.1.2-alpha.1 起被删除**（npm 上最终版本停在 `0.1.1-rc.2`），
DSH Desktop 0.8.2 内置的 harness 是 `0.1.2-rc.1`，因此原版桥接连不上。

本文件记录这次移植改了什么、为什么改、以及怎么验证。

---

## 1. 协议差异（实测确认）

| 维度 | 0.1.1（原版桥接） | 0.1.2（本移植） |
|---|---|---|
| 鉴权 | 回环地址直接放行 | **每次调用都要鉴权**。启动令牌只以 `GET /?token=<token>` 在根路径被接受（不在 `/api` 路径、不在 `Authorization` 头），换回 `dsh-auth-*` 会话 cookie |
| 一元 RPC | `POST /api/<method>`（点号，如 `session.list`） | `POST /api/<namespace>/<method>`（**斜杠**，如 `session/list`） |
| 参数 | 直接作为 payload | `payload = { args: { <wire 名>: <值> } }`，按端点 descriptor 校验 |
| 服务端下行 | 全局 `GET /api/events.mux`（WebSocket） | **全局流已取消**。会话事件改为每会话一条 `session/follow` 流；提问/审批改走 `$events` waterfall |
| 流载体 | `/api/events.mux` | `/api/remote.mux`（WebSocket，多路复用，需带 cookie） |
| 提问/审批回执 | `POST /api/respond` 回显 rpcId | `POST /api/$events/result`，`outcome = {kind:'result',value}` / `{kind:'next'}` / `{kind:'rejected'}` |
| 端点发现 | — | 每个包带自动生成的 `lib/typert.remote-client.js`，含端点名、参数 wire 名与 zod schema（共 75 个端点） |

流协议（`/api/remote.mux`）：

```
客户端 → Host:  {"type":"open","streamId":…,"endpoint":…,"payload":{"args":{…}}}
                {"type":"cancel","streamId":…}
Host → 客户端:  {"type":"item","streamId":…,"value":…}
                {"type":"end","streamId":…}
                {"type":"error","streamId":…,"error":{code,message,details}}
```

`$events` 流的帧：

```
{"type":"ready","clientId":…,"host":{…}}
{"type":"waterfall","event":"user-questions/request","eventId":…,"agentId":…,"request":{…}}
{"type":"waterfall","event":"approval/request","eventId":…,"agentId":…,"request":{…}}
```

---

## 2. 改动清单

### `src/dsh-client.js` —— 整体重写（原文件保留为 `src/dsh-client.0.1.1.js.bak`）

对外**保持 0.1.1 的调用面与返回契约**（`{ rpcId, result:{ ok, value|error } }`），
所以 `bridge.js` 的业务逻辑基本没动：

- 新增 token→cookie 鉴权；**401 时自动重新发现令牌重试**（DSH 重启会换令牌）
- 新增 baseUrl/令牌自动发现：DSH Desktop 每次启动换端口和令牌，桥接默认的
  `http://127.0.0.1:3080` 会过期。客户端改为读取
  `%APPDATA%\dsh-desktop\logs\harness.log` 里最后一条 `dsh web: <url>?token=…`。
  配置里显式写了非默认 `baseUrl` 时以其为准。
- `events.mux()` 改为多路复用：一条 `$events`（提问/审批）+ 每个被登记会话一条
  `session/follow`，统一产出 0.1.1 形状的信封 `{ rpcId, payload: frame }`
- **新增 `trackSession(id)`**：0.1.2 没有全局会话事件流，必须按会话订阅
- 提问/审批的 waterfall 帧翻译回旧形状（`question/requested` / `approval/requested`），
  `respond()` 再把旧形状回执翻译成 `$events/result` 的 outcome
- `onOpen` 改为「各条流真正接上后」才回调（否则投 prompt 会漏掉开头的 turn 事件）
- `close()` 用 `ws.terminate()` 而非 `close()`：优雅关闭握手会和进程退出抢跑，
  在 Windows 上触发 libuv 断言 `async.c: UV_HANDLE_CLOSING`
- **新增导出 `exitCleanly(code)`**：不要在 await 完成的同一个 tick 里直接
  `process.exit()`。实测（Node 24.9.0 / Windows）这会和 undici 在途的异步句柄抢跑，
  触发同一个 libuv 断言，进程以 `-1073740791`(abort) 退出。
  推迟一个 tick 即可规避。`self-test`、两个测试脚本、bridge 的 SIGINT/SIGTERM 都改用它。
- **`events.mux(payload, signal, onOpen)` 现在真的接受 `signal`**：移植初版把它吃掉了，
  导致调用方 abort 后生成器不结束（旧接口 `openMux(payload, signal, onOpen)` 是带 signal 的）。
- **abort 时同时关闭内部 queue**：否则生成器永远挂在 `for await (const frame of queue)` 上，
  `finally` 不执行、调用方的 `await muxTask` 永不返回（实测会把测试脚本整个挂死）。
- **新增会话就绪闸门 `waitForSessionReady()`，`sessions.prompt()` 内部自动等待**：
  0.1.2 的会话事件是按会话订阅的，`session/follow` 从发起到生效有一个往返。
  若在这之前投 prompt，开头的 `turn/start` 会落进建立之前的窗口 ——
  实测表现为「只收到 turn/end、收不到 turn/start」，于是 `createTurnCollector`
  拼不出完整回合，桥接认不出回合结束、回复不会被转发到 QQ。
  这是最隐蔽的一个缺陷，因为它只在 follow 建立较慢时偶发。
- **snapshot 回放策略**：`session/follow` 的首帧是 snapshot。
  - mux 启动时就已登记的会话（桥接重启后从 `state/sessions.json` 恢复的）：只收实时事件，
    回放历史回合会导致旧回复被重复发到 QQ。
  - mux 运行期间才登记的会话（桥接刚建的）：回放 snapshot 里的 event，
    作为 follow 慢于第一回合时的兜底。
  - `maxMessages` 从 1 调到 20，否则 snapshot 可能只装得下一条消息、回放拿不到完整回合。

### `scripts/setup-dsh.mjs` —— 0.1.2 适配（见下方第 6 节）

### `src/bridge.js` —— 4 处小改

| 位置 | 改动 |
|---|---|
| `const api = new NodeApiClient(...)` | 加 `.configure({ token, harnessLog })`；`activeApi` 模块级引用 |
| 启动恢复 `state.sessions` 处 | 每个 sessionId 调 `api.trackSession()` |
| 新建会话处 | 同上 |
| 黑话学习会话（3 处） | 同上 |
| SIGINT/SIGTERM | 退出前 `activeApi?.close()`，拆掉 mux WebSocket |

### `src/self-test.js` —— 2 处小改

`trackSession()` + 收尾归档会话并 `api.close()`。

### 新增测试

- `scripts/test-dsh-012.mjs` —— 一元调用 + 工作区 + 会话 + prompt + 事件流全链路
- `scripts/test-dsh-question-012.mjs` —— 真实触发一次 `ask_user_question` 并作答

---

## 3. 端点映射

| 原调用 | 0.1.2 端点 | args |
|---|---|---|
| `sessions.create({workspaceId?,cwd?,agentPreset?})` | `session/create` | `{request:{…}}` |
| `sessions.prompt({sessionId,mode,content})` | `session/prompt` | `{request:{requestId,sessionId,mode,content}}` |
| `sessions.selectModel({…})` | `session/selectModel` | `{request:{…}}` |
| `workspace.create({path})` | `workspace/create` | `{request:{path}}` |
| `workspace.rename({…})` / `delete` / `archiveSession` | 同名 | `{request:{…}}` |
| `workspace.list({})` | `workspace/follow` 的 baseline | 流式，取首帧后关闭 |
| `settings.describe({})` | `settings/describe` | `{}` |
| `agentPresets.list({})` | `agentPresets/list` | `{}` |
| `host.describe({})` | **无对应**；桥接只用它做存活探测，改用 `agentPresets/list` | `{}` |
| `events.mux({})` | `$events` + 每个会话 `session/follow` | 见上 |
| `respond({…})` | `$events/result` | `{clientId,eventId,outcome}` |

> `session/create`、`workspace/create`、`settings/describe`、`agentPresets/list`
> 的**返回形状与 0.1.1 一致**，所以 `unwrap()` 与上层逻辑无需改动。

---

## 4. 怎么验证

```bash
node scripts/dsh-status.mjs                        # DSH 侧状态总览（preset / 命名空间 / 插件清单）
node src/self-test.js                              # DSH 侧链路（不带 QQ）
node scripts/test-dsh-012.mjs                      # 全链路（会建/删临时工作区）
node scripts/test-dsh-question-012.mjs             # 提问 waterfall（较慢，会真实跑一轮 agent）
node scripts/test-preset-012.mjs [preset]          # preset 能否真实建会话并跑完一回合
node scripts/fake-onebot.mjs                       # 假的 OneBot 服务端（无 QQ 时端到端验证桥接）
```

### 实测结果（2026-09-14，本机 DSH Desktop 0.8.2 / harness 0.1.2-rc.1，端口 43129）

**a) `self-test` 与 `test-dsh-012` 全部通过，exit code 0。**

`session/follow` 实测收到的事件类型：
`turn/start`、`user/message`、`assistant/chunk`、`assistant/message`、`step/end`、`turn/end` 等。

**b) 提问 waterfall（`test-dsh-question-012`）实测通过。**

真实触发 `ask_user_question` 后，桥接层收到并翻译出旧形状的帧：

```json
{"type":"question/requested","sessionId":"session-…","questions":[{"id":"test","question":"测试","options":[{"label":"A"},{"label":"B"}]}]}
```

用旧形状 `respond()` 作答 → `$events/result` 回执 `{"accepted":true}` → agent 继续跑完。

**c) bridge.js 本体集成验证（用一个临时假 OneBot v11 服务端顶替 SnowLuma）。**

日志显示每一个 DSH 调用点都被真实命中：

```
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001        ← getLoginInfo() 走通
[bridge] 机器人昵称: 小鲸鱼
[bridge] 连接 DSH 事件流…                              ← events.mux()
[bridge] DSH 已就绪（模式: chat）                       ← host.describe 探测 + refreshMode(settings.describe)
[bridge] 已设置会话视觉模型 session-… -> deepseek-official/deepseek-flash (high)  ← sessions.selectModel
[bridge] 新会话 private:10001 -> session-…             ← sessions.create
[bridge] 已投递 private:10001: 【管理员】只回复两个字：收到   ← sessions.prompt
[bridge] agent 回复 (private:10001) 2 字               ← 事件流收到 turn/end
```

假服务端侧收到桥接转回 QQ 的消息：

```
📤 桥接发往 QQ 的消息: [{"type":"text","data":{"text":"收到"}}]
```

即 **QQ → 桥接 → DSH 会话 → agent 回复 → 转回 QQ** 整条回路闭环。

**d) 装上 preset 后的生产配置复测（`preset: qq-chat`）通过。**

```
[bridge] DSH 已就绪（模式: chat）
[bridge] 已设置会话视觉模型 session-… -> deepseek-official/deepseek-flash (high)
[bridge] 新会话 private:10001 -> session-…（模式 chat，preset: qq-chat）
[bridge] 已投递 private:10001: 【管理员】只回复两个字：收到
[bridge] agent 回复 (private:10001) 2 字
📤 桥接发往 QQ 的消息: [{"type":"text","data":{"text":"收到"}}]
```

**e) DSH 端安装（`setup-dsh.mjs`）验证 —— 见第 6 节。**

---

## 5. 尚未完成

- «DSH 关闭 → 停掉 SnowLuma 与桥接» 的分支由 `tools/dsh-qq-bot.ps1` 实现，
  但未做实测（测它需要关掉 DSH）。

---

## 5.1 审批转发到手机（Harness 索要权限时用手机批）

**需求**：DSH 向用户索要权限（沙箱提权等）时，把请求转发到管理员 QQ，
人不在电脑前也能用手机批。

**实现**（2026-09-14 实测通过）：

1. `dsh-client.js`
   - `$events` 流新增处理 `{type:'cancel', eventId}` 帧：网关在请求**被别处回答**
     （最典型是用户在 DSH GUI 里直接点了审批）时会推这帧。收到就撤下挂起，
     避免上层拿着失效请求空等、之后回执报错。
   - 新增 `delegatePending(rpcId)` → 发 `{kind:'next'}`，把请求交还服务端
     顺延给下一个 answerer。
2. `bridge.js`
   - 审批原本只发给「映射到 QQ 会话」的会话（`if (!key) continue`），而 `qq-chat*`
     preset 按设计不带本地工具、根本触发不了审批 —— 等于这条链路永远不会响。
     现在**没有映射的会话（你自己在 DSH 里开的编码会话）转发到管理员私聊**，
     并附上会话来源（标题 · cwd）。开关：`config.json` 的 `relayApprovalsToOwner`
     （默认 `true`）。
   - **发给管理员私聊时不做敏感信息脱敏**：审批理由通常就是目标路径/命令，
     脱敏后人只看到「（含敏感信息，已隐藏）」，等于闭着眼睛批权限。
     群聊等其它会话仍照旧审计。
   - 收到 `pending/cancelled` 帧 → 撤下对应挂起，不再回执。
   - 审批**超时不再自动「拒绝」**，改为 `delegatePending` 交还 —— 拒绝等于替用户
     做决定，还会把 GUI 那边的审批权一起吃掉；交还后 GUI 仍可回答。

**实测证据**（真实触发一次沙箱提权审批）：

```
15:14:21 [bridge] 审批已转发 (private:<ownerQQ>)：pwsh [来自其它 DSH 会话]
15:14:30 [bridge] 已处理审批 (private:<ownerQQ>): allowed-once {"accepted":true}
```

管理员在手机上回复「通过」后，DSH 侧返回 `allowed-once`，**被拦的命令真的执行了**
（测试用的 `<用户目录>\approval-relay-test.txt` 被写出，时间戳与批复同一秒）。

> 协作要点：网关把同一个 waterfall **广播给所有客户端**，所以桥接和 DSH GUI 会
> 同时拿到审批，**谁先回答谁生效**，另一方通过 `cancel` 帧自动撤下。

---

## 5.2 DSH 任务完成通知

**需求**：Harness 的任务跑完后给管理员发一条 QQ 消息，人不在电脑前也知道活干完了。

**为什么不能「直接监听 turn/end」就完事**：桥接默认**只订阅它自己建的 QQ 会话**
（`session/follow` 是按会话订阅的），你在 DSH 里自己开的编码会话它压根收不到事件。
所以先要一个会话发现机制。

**实现**（2026-09-14 实测通过）：

1. `dsh-client.js`
   - 新增 `startSessionDiscovery(intervalMs)` / `stopSessionDiscovery()`：
     定期扫 `session/list`，把所有**非子代理**会话（没有 `parentSessionId` 的）
     都纳入事件订阅。子代理会话不订阅 —— 它们的事件属于父回合内部，单独通知是噪音。
   - 顺带修了一个隐患：`session/follow` 反复拿不到数据时（例如会话已归档）原本会
     每 2 秒无限重连。现在按失败次数退避，连续 5 次直接放弃该会话。
2. `bridge.js`
   - 非 QQ 会话、非黑话学习会话的 `turn/end` 进入「任务完成」判定。
   - **只通知跑够 `notifyTaskDoneMinTurnMs`（默认 5 分钟）的回合** ——
     阈值定在 5 分钟是用户的选择：只想被告知「大任务」跑完了，日常一问一答不打扰。
   - 回合结束后再等 `notifyTaskDoneDebounceMs`（默认 15 秒）：期间若又开了新回合，
     说明活没干完，撤销通知。多轮连续工作因此只会合成一条。
   - 通知内容：结果图标（✅/⏹️/⚠️）+ 历时 + reason + 会话来源（标题 · cwd）+
     结果摘要（截断到 `notifyTaskDoneMaxChars`，默认 200 字）。

**配置**（`config.json`，都有默认值，可全部省略）：

```json
"notifyTaskDone": true,
"notifyTaskDoneMinTurnMs": 300000,
"notifyTaskDoneDebounceMs": 15000,
"notifyTaskDoneMaxChars": 200,
"sessionDiscoveryMs": 30000
```

**实测证据**（一个跑了 101 秒的真实回合）：

```
15:20:52 [bridge] 任务完成通知已发 (private:<ownerQQ>)：PowerShell 延迟并回复测试完成 · *** · 1.7 分钟
```

> ⚠️ **注意噪音**：开启后你自己在 DSH 里干的长回合都会 ping 一次。
> 当前阈值定在 **5 分钟**（用户选择：只想知道大任务）。
> 觉得还是吵就继续调大 `notifyTaskDoneMinTurnMs`，或者 `notifyTaskDone: false` 整个关掉。
> 想反过来（连小活也要知道）就调小，例如 `60000` = 1 分钟。

---

## 6. DSH 端安装（setup-dsh.mjs 的 0.1.2 适配）

### 为什么旧做法在 DSH Desktop 上危险

旧脚本往 profile 的 `package.json` 写 `"qq-mode-console": "link:<绝对路径>"`，
并把它加进 `dsh.profile.bundles`，然后依赖 `dsh plugin --profile web install` 真正安装。
但在 DSH Desktop 环境里：

* profile 的 `package.json` 由 Desktop 的 market 生成器接管
  （`dsh.desktop.generationProjection` + `pnpm.overrides` 的 `link:` 机制），
  手写 `link:` 依赖会与其管理方式打架；
* `dsh` CLI 通常不在 PATH，`dsh plugin install` 这一步会被静默跳过；
* 于是 bundles 里登记了 `qq-mode-console` 却没人安装它 ——
  DSH 冷启动直接报 `cannot resolve profile bundle "qq-mode-console"`。

### 新做法

Cordis loader 的 `import(name)` 对非 `.` 开头的 specifier 直接走动态 `import()`，
而 `file://` URL 是合法 ESM specifier。因此把本地插件直接挂在**用户 patch 层**：

```yaml
- insert:
    - id: qq-mode-console
      name: 'file:///D:/dk/qq-bridge/plugins/qq-mode-console/lib/index.js'
      config: {}
```

这样：**不碰 profile 的 `package.json`、不需要 pnpm install、不依赖 `dsh` CLI**；
卸载时删掉 patch 里的条目即可，无残留。插件通过仓库自带的 `node_modules`
解析 `@deepseek-ai/schemastery`。

MCP 三个 server 的挂载方式不变（`@deepseek-ai/dsh-mcp-client` 的配置 schema
在 0.1.2 里完全没变：`transport/serverName/command/args/toolCallTimeoutMs`），
只是不再和插件注册混在一起。

另外脚本现在支持 `--dry-run` 并会在写 `cordis.patch.yml` 前自动备份。

### 实测结果（本机 DSH Desktop 0.8.2 / harness 0.1.2-rc.1）

```
[setup-dsh] preset installed: qq-chat
[setup-dsh] preset installed: qq-chat-v2
[setup-dsh] cordis.patch.yml: qq-bridge 区块已追加
[setup-dsh] 已备份原文件: cordis.patch.yml.bak-2026-09-14T13-35-42-514Z
[setup-dsh] state/mode.json 已创建（mode=reserved2，DSH settings 不可用时的兜底）
```

**全部热生效，没有重启 DSH：**

* `agentPresets/list` 立刻多出 `qq-chat`、`qq-chat-v2`（`trust=user`）
  —— preset 是按需从磁盘读取的；
* `settings.describe` 的命名空间从 33 变成 **34，含 `qq-mode`**；
* `pluginInventory/list` 里四个条目都是 `active`：

```
✅active  include:mcp-snowluma         @deepseek-ai/dsh-mcp-client
✅active  include:mcp-snowluma-host    @deepseek-ai/dsh-mcp-client
✅active  include:mcp-web-search-safe  @deepseek-ai/dsh-mcp-client
✅active  include:qq-mode-console      file:///D:/dk/qq-bridge/plugins/qq-mode-console/lib/index.js
```

* MCP 工具实测可用：`mcp__snowluma_host__snowluma_status` 返回
  `{"reachable": false}`（SnowLuma 没跑，行为正确）；
  `mcp__web-search-safe__web_search` 返回真实搜索结果。

### ⚠️ 装完之后的一个使用注意

`refreshMode()` 是**先读 DSH 设置里的 `qq-mode` 命名空间、命中就直接 return**，
只有命名空间不存在时才回退到 `state/mode.json`。而桥接自己的控制台
（`POST /api/mode`）只写 `state/mode.json`，从不写 DSH 设置。

所以**装上 `qq-mode-console` 插件之后，切模式请用 DSH 设置页的 qq-mode 卡片**，
桥接控制台里的切换会在几秒后被设置值覆盖。这是原项目既有的交互，不是本次移植引入的。

---

## 7. 缺陷复盘：插件入口导出漂移 → 整个 harness 起不来（2026-09-15）

### 症状

DSH Desktop 启动直接失败，**不是后台静默报错，是整个 harness 拒绝启动**：

```
Harness could not start.
Error: dsh: plugin tree failed to load: failed to apply loader entry include
(cordis:include): failed to import loader entry qq-mode-console
(file:///D:/dk/qq-bridge/plugins/qq-mode-console/lib/index.js):
The requested module './schema.js' does not provide an export named 'GROUP_TITLES'
```

### 根因

一次重构把 `lib/schema.js` 里的分组表定名为 **`GROUPS`**（`{ core: { order, title, desc }, ... }`），
但 `lib/index.js` 还停在旧名 `GROUP_TITLES`：

```js
// 坏：schema.js 里没有 GROUP_TITLES 这个导出
import { buildSchema, GROUP_TITLES, FIELDS } from './schema.js';
//                        ^^^^^^^^^^^^ 链接期就炸
```

ESM 的**静态导入在链接期校验导出名**，命中不到就抛 `SyntaxError`，连模块体都不会执行。
而 `cordis:include` 是在启动时 import 插件入口的，一个入口炸掉 → 整棵插件树加载失败 →
harness 起不来。诊断日志的最后一条也停在这之前：

```
[2026-09-15T11:34:07.760Z] apply called, settings=object      ← 最后一次成功
[2026-09-15T11:34:07.762Z] registered qq-mode（156 个字段…）    ← 之后 schema.js 被改，再无记录
```

改文件的时间戳正好对得上：`index.js` 19:28 → `schema.js` 19:39（改名）→ `client.js` 19:40。
也就是说只有 `index.js` 掉队了。

### 为什么没被测出来（真正的教训）

`scripts/test-qq-settings.mjs` 与 `test-qq-settings-page.mjs` 都只加载
`schema.js` 和 `client.js`，**从来不 import 插件入口** —— 所以入口和 schema 漂移了，
两支测试照样全绿（本次事故时它们确实是绿的）。测试覆盖的是"数据对不对"，
而这次挂的是"模块能不能加载"，是两个层次。

`client.js` 不受影响，因为它是 `window.__ModuleLoader__.load` 的自包含 factory，
自带 `GROUP_FALLBACK` 兜底表，不从 `schema.js` 导入任何东西。

### 修法

```js
import { buildSchema, GROUPS, FIELDS } from './schema.js';   // GROUP_TITLES → GROUPS
...
groups=${Object.keys(GROUPS).length}                          // 同步改掉唯一的一处引用
```

`Object.keys(GROUPS).length` 与旧写法语义等价（都数分组个数，10 个）。

### 新增护栏

`scripts/test-plugin-entry.mjs` —— 补上"模块能不能加载"这一层：
遍历 `plugins/*/`，按 `package.json` 的 `exports["."].default` / `main` 找到入口，
**真的 import 一次**，并校验 `name`（与目录名一致）/`apply`/`inject` 契约、
`dsh.client` 声明的客户端半侧文件存在、`cordis.patch.yml` 的 id 与包名一致。

已用反例验证过它确实拦得住：临时塞一个 `import { NOPE } from './schema.js'` 的坏插件，
脚本报出同样的 `SyntaxError` 并以 `exit 1` 结束。

**照此办理**：以后改插件入口或 `schema.js` 的导出，先跑
`node scripts/test-plugin-entry.mjs` 再重启 DSH。同类错误只有在真启动时才暴露，
而它一旦暴露就是"整个 harness 起不来"，代价太高。

---

## 8. 缺陷复盘：设置页覆盖反噬控制台 + 唤醒按键 3 个隐患（2026-09-15）

一次专项审计（"检测插件还有没有漏洞"）在设置/唤醒两个插件里找出 4 个真问题，
其中两个是"用户一定会撞上"和"能把 DSH 搞崩"级别的。

### 8.1 设置页把控制台改的配置冲掉（用户一定会撞上）

**症状**：在桥接控制台里改了白名单 / 黑话参数 / 社交参数，5 秒后自己变回原样，
控制台看起来"改了没用"。

**根因**：桥接原本拿命名空间**解析后的整值**去覆盖 cfg：

```js
applySettingsOverrides(ns.value);   // ns.value = base + user
```

而 `base` 是 **DSH 启动那一刻的 config.json 快照**，在进程里冻结。
控制台改配置时会写 config.json 并更新内存里的 cfg —— 但 5 秒后的下一轮轮询
会把那份陈旧快照重新盖回去，于是改动被静默撤销。范围覆盖 schema 里所有可调项
（allow / deny / slang / social / socialV2 / security / consolePort…）。

**修法**：只认 `ns.user`（用户真正在设置页里显式改过的字段），并且处理"撤销"：

```js
const overrides = ns?.user ?? null;      // 不是 ns.value
applyOverrides({ target: cfg, user: overrides, applied: settingsApplied,
                 freshConfig: readJsonSafe(path.join(ROOT, 'config.json'), null) });
```

- 用户没在设置页碰过的字段 → 一个字都不动（控制台 / 手改 config.json 照旧说了算）；
- 用户改过的字段 → 设置页说了算；
- 用户在设置页点了「已改」重置 → 该字段**回到磁盘上 config.json 的值**
  （靠记住上一轮施加过的叶子路径 + 重新读盘；否则会卡在旧的覆盖值上）。

**护栏**：合并规则被抽成纯函数 `src/settings-merge.js`，由
`scripts/test-settings-merge.mjs` 单测（24 项），其中两条专门盯这个场景：
"用户没改过 → 一个字都不动" 与 "撤销 → 还原成磁盘值"。

### 8.2 `spawn` 没有 error 监听 → 点唤醒能把 DSH 搞崩

**症状**：`node.exe` 路径不存在时（换机器、换 node 版本），点一次唤醒，
DSH harness 进程直接**未捕获异常退出**。

**根因**：`spawn()` 的失败是**异步** `emit('error')` 的，而 ChildProcess 的 `error`
事件没有监听器时 Node 会把它抛成未捕获异常。`plugins/qq-wake/lib/wake.js` 的
`spawnDetached()` 当时既没监听 `error`，也没检查可执行文件是否存在。

**修法**：先 `fs.existsSync(nodeExe)` 同步挡一道；`spawn` 外面包 try/catch；
补 `child.on('error', ...)` 兜底；拿不到 `child.pid` 时**不写 pid 文件**
（写 `"undefined"` 会让下次唤醒读到脏值）；两处调用点拿到 0 直接返回失败，
不再空等 4 分钟。

### 8.3 pid 复用 → 可能杀掉无关进程

**症状**：潜在（未实际触发）。pid 文件是陈旧的，而该 pid 已被系统分给别的程序时，
唤醒流程里的"重启 SnowLuma"会 `process.kill()` 掉那个无辜进程。

**根因**：`killTracked()` 只检查 `isAlive(pid)`，没确认那还是不是 node 进程。

**修法**：杀之前用 `tasklist /FI "PID eq N" /FO CSV /NH` 确认进程名匹配 `node.exe`
（Windows 中文输出的 GBK 解码与 `schtasks` 同处理）；问不出来就**不杀**（宁可不重启）。

### 8.4 并发唤醒 → 起两个 SnowLuma

**症状**：连点两次唤醒（或两个页面同时点）会各自看到"SnowLuma 没在跑"，
于是各起一个：端口打架、QQ 被重复注入。

**修法**：`runWake()` 加单飞锁 —— 进行中的唤醒被复用（返回同一个 Promise），
结束后释放。客户端按钮的 busy 态只是 UI 层，不能当并发控制。

**护栏**：`node scripts/test-wake.mjs --guards` 断言
"并发调用返回同一个 Promise" + "上一轮结束后锁已释放"。

### 8.5 唤醒路由围栏被「借前缀的域名」穿过（DNS 重绑定）

**症状**：`plugins/qq-wake/lib/index.js` 的 `isLoopbackHostname()` 用
`bare.startsWith('127.')` 判断主机名是不是本机。字符串前缀判断不是 IP 判断 ——
`127.0.0.1.evil.com` 也以 `127.` 开头，于是**整条围栏全线放行**：

```
curl -H "Host: 127.0.0.1.evil.com:43129" \
     -H "Origin: http://127.0.0.1.evil.com:43129" \
     -H "Sec-Fetch-Site: same-origin" \
     http://127.0.0.1:43129/api/qq-wake/status
→ HTTP 200（实测，见下表）
```

**为什么其它几道关卡都拦不住**：

| 关卡 | 为什么失效 |
|---|---|
| socket 回环检查 | 浏览器确实连到 127.0.0.1，`remoteAddress` 就是回环 |
| `Host` 检查 | `127.0.0.1.evil.com` 命中了 `startsWith('127.')` |
| `sec-fetch-site` | 攻击页与目标**同源**（都是 `127.0.0.1.evil.com`），浏览器老实报 `same-origin` |
| `Origin` 检查 | 同一个 `startsWith` 漏判，`Origin` 也过了 |

**攻击条件**：攻击者控制一个**以 `127.` 开头、A 记录指向 127.0.0.1** 的域名
（`127.0.0.1.nip.io` 这类现成服务即可），再让用户浏览器打开该域名下的页面。
若再配上 `Content-Type: application/json`（同源 fetch 可以自由设置，无预检），
就能直接打 `/api/qq-wake/wake` —— 在用户机器上拉起进程、并以管理员身份发一条 QQ 消息。
影响面止于「启动机器人 + 发 ≤40 字消息」和「读到状态里最近几条 QQ 活动」，
但这是**没有鉴权的本地写接口被远程触发**，不能留白。

**修法**：主机名判定改成**严格字面量解析**（`plugins/qq-wake/lib/index.js`）：

- `isLoopbackIpv4()` 用 `/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/` 取四段十进制，
  校验每段 ≤255 且首段是 127；`127.0.0.1.evil.com`、`127.0.0.1.nip.io`、`0x7f.0.0.1`
  自然全部落空。
- `bareHostname()` 只把**唯一一个冒号**当端口分隔符（多于一个是没加方括号的 IPv6），
  方括号 IPv6 单独解析；`localhost` 只认精确匹配。
- `::ffff:127.0.0.1` 这类 IPv4-mapped 地址先剥前缀再判。
- `passFence()` / `isLoopbackHostname()` 一并导出，供自测直接钉住规则。

**护栏**：`node scripts/test-wake-fence.mjs`（38 项：主机名 / socket / 同源标记 /
写操作 content-type），加 `--live` 会真的打一遍运行中的路由（自动发现 DSH 端口），
断言「本机 200、伪装 Host 403、跨站 Origin 403」。**注意**：宿主侧插件是启动时
import 的，改完必须重启 DSH 才生效 —— `--live` 打不通/仍 200 时脚本会直接提示这一点。

### 审计结论

| # | 问题 | 级别 | 状态 |
|---|---|---|---|
| 1 | 插件入口导出漂移 → harness 起不来 | 致命 | 已修（§7），有 `test-plugin-entry.mjs` 护栏 |
| 2 | 设置页覆盖反噬控制台改动 | 高（必撞） | 已修（§8.1），有 `test-settings-merge.mjs` |
| 3 | spawn 无 error 监听 → 崩 harness | 高 | 已修（§8.2） |
| 4 | pid 复用误杀 | 中（潜在） | 已修（§8.3） |
| 5 | 并发唤醒重复起进程 | 中 | 已修（§8.4），有 `test-wake.mjs --guards` |
| 6 | 唤醒路由围栏被伪装 Host 穿过（DNS 重绑定） | 中（需诱导访问恶意域名） | 已修（§8.5），有 `test-wake-fence.mjs` |

另外核查过、**没有发现问题**的点：设置写入的多段路径支持
（`dsh-settings` 的 `applyPathOp` 递归处理嵌套路径）、机密未被写进 schema
（`redactSecrets` 会让宿主读回空值）、`tools/*.ps1` 的 UTF-8 BOM、发布前的
敏感信息扫描、`mode` 不进设置命名空间的 base（没在页面里选过时沿用 `state/mode.json`）、
156 项设置与 `config.json` 的覆盖率与分组表一致性。

> 上一版这里还写着「信任围栏没有问题」—— 那是只测了跨站 Origin / 跨站
> `sec-fetch-site` / 非 JSON content-type 三种情况得出的结论。**测围栏要按「攻击者能构造的
> 请求头」穷举**，只测自己想到的几种等于没测；这次补的 `test-wake-fence.mjs` 就是把这几种
> 一次性钉死。


