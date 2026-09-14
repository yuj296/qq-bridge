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

把 QQ 消息接进 **DSH（DeepSeek Harness）** agent：

```
QQ 消息 → SnowLuma(OneBot v11) → 本桥接进程 → DSH 会话 → agent 生成回复 → 回到 QQ
```

**本仓库是「DSH 0.1.2 适配版」。** 上游原版基于 `@deepseek-ai/dsh-host-apiproxy`
（DSH ≤ 0.1.1 的 HTTP API），该包在 **DSH 0.1.2-alpha.1 起被官方删除**，
所以原版在 0.1.2 上**完全连不上**。移植细节见 `PORTING-DSH-0.1.2.md`。

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
| `src/bridge.js` | **主程序**（~8.2k 行）。QQ 事件处理、会话映射、模式逻辑、控制台 HTTP、social/reserved2 仿真 | 业务逻辑 |
| `src/dsh-client.js` | **DSH 0.1.2 客户端**。鉴权、端点调用、事件流多路复用、提问/审批双向翻译 | DSH 协议变更时 |
| `src/dsh-client.0.1.1.js.bak` | 上游原文件（对照用，**不要改动、不要删**） | 永不 |
| `src/mcp-*.js` | 三个 MCP server，作为子进程被 DSH 拉起 | 给 agent 加工具时 |
| `dsh/agent-presets/qq-chat*/` | 两个 DSH agent preset（**安全边界在这**） | 改 agent 人格/权限时 |
| `plugins/qq-mode-console/` | DSH 设置页的 `qq-mode` 卡片 | 改设置项时 |
| `tools/dsh-qq-bot.ps1` | 守护脚本（自启/自愈） | 改运维策略时 |
| `scripts/setup-dsh.mjs` | DSH 端安装 | 安装流程变更时 |
| `scripts/dsh-status.mjs` | 状态总览（**排查第一步**） | — |
| `scripts/publish-fork.mjs` | **不依赖 git push** 的发布工具（走 GitHub Git Data API，只传变更文件） | 往 fork 推改动时 |
| `PORTING-DSH-0.1.2.md` | 移植记录（协议差异、缺陷复盘、实测证据） | 每次实质改动后 |

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

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh.baseUrl` | `http://127.0.0.1:3080` | 留默认即走自动发现；显式写了非默认值则以其为准 |
| `dsh.token` | 空 | 可选，覆盖自动发现 |
| `dsh.harnessLog` | 空 | 可选，自定义 `harness.log` 路径 |
| `snowluma.wsUrl` | `ws://127.0.0.1:3001` | SnowLuma 的 **WebSocket** 地址 |
| `snowluma.httpUrl` | `http://127.0.0.1:3000` | SnowLuma 的 **HTTP API** 地址。**填成纯 WS 端口会报 HTTP 426** |
| `snowluma.accessToken` | 空 | 两端**必须同一个值**；若用 3000 那条（见 §7）只需一个 token |
| `ownerQQ` | 必填 | **管理员本人的 QQ**，不是机器人号。见 §7 |
| `allow.private` / `allow.groups` | `[]` | 白名单。为空且 `allowAllWhenEmpty:false` ⇒ 什么都不放行 |
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

自启由 Windows 计划任务 **`DSH QQ Bot Supervisor`** 提供（登录时触发，
跑 `tools/dsh-qq-bot.ps1`）。守护逻辑见 §7 与 `tools/README.md`。

**改完 `config.json`、`bridge.js`、`dsh-client.js` 都必须重启桥接才生效**
（守护脚本会在 ~20s 内自动拉起）。

---

## 6. 验证（改完必须跑）

| 命令 | 验证什么 | 期望 |
|---|---|---|
| `node scripts/dsh-status.mjs` | DSH 侧状态：preset / 设置命名空间 / 插件清单 | 6 个 preset（含 `qq-chat*`）、命名空间含 `qq-mode`、四个 `qq-bridge` 插件 `active` |
| `node src/self-test.js` | DSH 链路（不发 QQ） | 打印 agent 回复、`exit 0` |
| `node scripts/test-dsh-012.mjs` | 全链路：工作区/会话/prompt/事件流 | 收到 `turn/start`…`turn/end`，`exit 0` |
| `node scripts/test-preset-012.mjs qq-chat` | preset 能否建会话并跑完回合 | `回合结束 reason = completed` |
| `node scripts/test-dsh-question-012.mjs` | 提问 waterfall（**慢**，真实跑一轮 agent） | 收到 `question/requested` 并能作答 |
| `node scripts/fake-onebot.mjs` | **无 QQ 也能端到端测桥接** | 注入私聊后打印桥接回发的消息 |
| `node scripts/scan-secrets.mjs` | **发布/提交前自检**：有没有把令牌、真实 QQ 号、本机路径写进会入库的文件 | `✅ 未发现敏感信息`，`exit 0` |

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
   所以只有本人号才有意义，且测试时要用**另一个号**给机器人发消息。
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
8. **`qq-mode` DSH 设置优先于 `state/mode.json`**：
   `refreshMode()` 先读设置命名空间、命中就 return。装了插件后**切模式要用 DSH 设置页**，
   桥接控制台的切换会在几秒后被覆盖。
9. **`config.json` / `state/` 含密钥与运行时数据，绝不入库**（`.gitignore` 已排除）。

---

## 8. 故障速查

| 症状 | 先看 | 大概率原因 |
|---|---|---|
| 桥接起不来、报「已有一个实例在运行」 | `state/bridge.lock` | 重复启动；守护会清过期锁 |
| `SnowLuma 连接断开（code=1006）` 刷屏 | 端口 3000/3001 | SnowLuma 的 QQ 会话掉了 → 见坑 1 |
| OneBot 端口在听但 `/get_login_info` 超时 | SnowLuma 日志 `EPIPE` | 注入管道断了；重启 SnowLuma（**不用重扫码**） |
| agent 收到消息但不回 | `state/bridge.log` | 模式是 `reserved2`（AI 自主决定/走工具），或 preset 未安装 |
| 回复没转发到 QQ | 日志找 `turn/end` | 见 §3.4 第一条（`turn/start` 缺失） |
| 审批没到手机 | `relayApprovalsToOwner` | 或该会话被映射到了别的 QQ 会话 |
| DSH 启动报 `cannot resolve profile bundle` | `profiles/*/cordis.patch.yml` | 是**旧版脚本**残留；见 `PORTING-DSH-0.1.2.md` §6 |

统一入口：**`state/supervisor/supervisor.log`** + `tools/README.md` 的故障速查表。

---

## 9. 改动约束（**不要动的东西**）

- **不要**把 `qq-mode-console` 改成往 profile 的 `package.json` 写 `link:` 依赖 +
  `dsh.profile.bundles` —— 在 DSH Desktop 上会**弄坏 DSH 启动**（详见 §6 of PORTING 文档）。
  正确做法是挂在用户 patch 层的 `file://` 条目上。
- **不要**为了「兼容」去改 `src/dsh-client.0.1.1.js.bak`。
- **不要**把 `ownerQQ` 填成机器人号。
- **不要**在发给管理员的审批里做敏感信息脱敏（会把目标路径藏掉，等于让用户闭眼批权限）；
  群聊等其它会话仍应照常审计。
- **不要**用 `process.exit()` 替代 `exitCleanly()`。
- **不要**把 `config.json`、`state/`、令牌、QQ 号写进仓库或文档。

---

## 10. 相关文档

| 文档 | 内容 |
|---|---|
| `PORTING-DSH-0.1.2.md` | 移植全过程：协议差异表、4 个缺陷复盘、DSH 端安装、两个手机端能力 |
| `docs/PROJECT_GUIDE.md` | 上游原版的项目指南（架构/数据流，协议部分已过时） |
| `docs/DSH_SETUP.md` | DSH 端安装步骤（已按 0.1.2 更新） |
| `tools/README.md` | 自启守护、常用命令、故障速查 |
| `RULES.md` | 运行模式（chat / closed-agent / reserved / reserved2）与权限边界 |
