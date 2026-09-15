# 安装说明（qq-bridge · DSH 0.1.2 适配版）

> 从**零**开始把 QQ 私聊接进 DSH agent：装依赖 → 配 SnowLuma → 写配置 → 装 DSH 端（preset + MCP + 插件）→ 启动 → 验证。
> 本文按「先能跑通、再谈调优」的顺序写；每一步都给了**验证命令**，卡住时直接跳 [§9 故障速查](#9-故障速查)。

> ⚠️ **本仓库只服务「私聊」**：桥接只处理**主人（`ownerQQ`）↔ 机器人**的私聊。
> 群聊能力已**彻底移除**：没有群消息入口、没有群发送路由、没有任何群 MCP 工具、
> 配置里没有 `allow.groups` / `deny.groups`，**群消息会被直接忽略**（设计如此，不是 bug）。
> 护栏测试：`node scripts/test-no-group.mjs`。

> ⚠️ **本仓库是 DSH 0.1.2 适配版 fork**：上游原版依赖的 `@deepseek-ai/dsh-host-apiproxy`
> 在 DSH 0.1.2-alpha.1 起被官方删除，**原版在新 DSH 上完全连不上**。
> 移植细节见 [`PORTING-DSH-0.1.2.md`](PORTING-DSH-0.1.2.md)。

---

## 0. 它是什么/长什么样

```
QQ 私聊消息 → SnowLuma(注入 QQ 客户端, OneBot v11) → 本桥接进程 → DSH 会话 → agent 回复 → 回到 QQ 私聊
                                     ↑                                      ↓
                              本地控制台 127.0.0.1:3100            DSH 设置页「QQ 机器人」分区
```

三个部件，缺一跑不起来：

| 部件 | 作用 | 装在哪 |
|---|---|---|
| **DSH Desktop** | 宿主。agent 会话、设置页、MCP、插件都由它拉起 | 你的电脑（官方安装包） |
| **SnowLuma** | 把 QQ 变成 OneBot v11 接口（DLL 注入 `QQ.exe`） | 你的电脑（`C:\SnowLuma`） |
| **本仓库 qq-bridge** | 桥接进程 + DSH 插件 + 2 个 agent preset | 任意目录（本文用 `D:\dk\qq-bridge`） |

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | **Windows 10/11** | SnowLuma 注入机制、`tools/*.ps1`、`start.bat` 都是 Windows 专用 |
| Node.js | **≥ 22.13**（`package.json` 的 `engines`） | 实测 v24.9.0 可用；`node -v` 确认 |
| DSH Desktop | 能打开 Web 形态界面即可 | 实测 0.8.2（内置 harness 0.1.2-rc.1） |
| SnowLuma | v1.14.x | 实测 v1.14.16 |
| QQ 客户端 | **必须开着且已登录** | SnowLuma 是注入式的（同 NapCat/LLOneBot），QQ 不在跑就收不到任何消息 |
| 端口（本机自用） | 3000/3001（SnowLuma）、3100（桥接控制台）、5099（SnowLuma WebUI） | 被别的程序占用就改配置（见 §5） |

> **两个 QQ 号**：一个当机器人（登录 SnowLuma 用），一个是你本人（`ownerQQ`）。
> **`ownerQQ` 必须填你本人的号，不是机器人号** —— 桥接用它判断"谁是主人"，
> 而且机器人自己发的消息（`user_id === self_id`）会被直接丢弃。

---

## 2. 装 SnowLuma 并确认 QQ 已注入

1. 到 SnowLuma 官方渠道下载并解压到 `C:\SnowLuma`（其它目录也行，后面配置里指过去）。
2. **确认 `C:\SnowLuma\config\runtime.json` 里 `hookAutoLoad` 为 `true`**（默认是 `false`）：
   它在 `false` 时只连「已经带 DLL 的 QQ 进程」，**不会注入新启动的 QQ 客户端** ——
   QQ 一重启就永远 login 不到，**极易被误判成"QQ 没登录"**。
3. 启动 SnowLuma（`node index.mjs` 或它的启动脚本），打开 WebUI `http://127.0.0.1:5099`，
   **扫码登录机器人 QQ**，并在 WebUI 里启用 **OneBot v11 正向 WebSocket + HTTP API**：
   - WebSocket 端口 `3001`
   - HTTP API 端口 `3000`
   - 如果 HTTP 服务端那条勾了 `enableWebSocket=true`，则**同一个端口同时提供 HTTP 与 WS 且共用一个 token**
     —— 此时 `wsUrl`/`httpUrl` 都填它、只填一个 token 即可，不用去统一"两端 token"。
4. 保持 QQ 客户端运行。

**验证**：

```bash
node -e "fetch('http://127.0.0.1:3000/get_login_info').then(r=>r.json()).then(j=>console.log(j)).catch(e=>console.log('失败:',e.message))"
```

期望：拿到 `{ status:'ok', retcode:0, data:{ user_id: <机器人QQ>, nickname: ... } }`。
拿不到 → 见 [§9](#9-故障速查) 第 2、3 条。

---

## 3. 获取本仓库并装依赖

```bash
git clone https://github.com/yuj296/qq-bridge.git
cd qq-bridge
npm install
```

> `npm install` 会自动跑 `postinstall`：修补 `@snowluma/sdk` 的 ESM 打包 bug（`scripts/patch-snowluma-sdk.mjs`）。
> 依赖里保留的 `@deepseek-ai/dsh-host-apiproxy` 是**上游遗留**（npm 上仍可安装），
> 运行时不 import 它，只被 `src/dsh-client.0.1.1.js.bak` 用作对照。

没有 git 也可以：下载 ZIP 解压，然后照样 `npm install`。

---

## 4. 写 `config.json`（唯一必填的是 `ownerQQ` 和白名单）

```bash
cp config.example.json config.json      # Windows CMD: copy config.example.json config.json
```

最小可用示例：

```jsonc
{
  "ownerQQ": 123456789,                       // ← 你本人的 QQ 号（不是机器人号！）
  "allow": { "private": [123456789] },        // 允许私聊机器人的号；就你自己一个就够
  "deny":  { "private": [] },
  "allowAllWhenEmpty": false,                 // 保持 false：白名单为空时谁都不放行
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",       // ⚠️ 必须是 HTTP API 端口，填成 WS 端口会报 HTTP 426
    "accessToken": ""                          // SnowLuma 设了 token 就填一样的；没设留空
  },
  "consolePort": 3100,                        // 本地控制台端口
  "agentPreset": "qq-chat",                   // 一代模式用的 preset
  "socialV2": { "agentPreset": "qq-chat-v2" } // reserved2（二代仿真）用的 preset
}
```

### 常改的几项

| 键 | 作用 | 备注 |
|---|---|---|
| `ownerQQ` | 主人 QQ | **必填**；填成机器人号会让你的消息被当成陌生人处理 |
| `allow.private` / `deny.private` | 私聊白/黑名单 | 黑名单优先；**两边都空 + `allowAllWhenEmpty:false` ⇒ 谁都不回** |
| `allowAllWhenEmpty` | 白名单为空时是否放行所有人 | 默认 `false`；开之前想清楚，等于把机器人公开 |
| `dsh.baseUrl` / `dsh.token` / `dsh.harnessLog` | DSH 接线 | **留默认即可**：桥接每 30s 从 `harness.log` 自动发现 DSH 的 URL 与新令牌 |
| `notifyTaskDone` / `notifyTaskDoneMinTurnMs` | 「DSH 任务完成」通知 | 默认只通知跑够 **5 分钟**的回合，避免日常一问一答也 ping 你 |
| `relayApprovalsToOwner` | 把 DSH 里的审批转发到 QQ | 默认开：你人在外面也能用手机批权限 |
| `sessionCwd` | QQ 会话的工作目录 | 留空 = 每个会话在 `state/agents/<key>` 下建独立目录 |
| `security.interceptNotify` | 安全拦截时是否通知你 | 默认开 |

> `config.json` 和 `state/` 都含密钥/运行时数据，**已被 `.gitignore` 排除，绝不入库**。
> 完整字段表（140 项）在 `plugins/qq-mode-console/lib/schema.js`，装好后能在 DSH 设置页里可视化改。

---

## 5. 装 DSH 端：preset + MCP + 设置页插件（`setup-dsh.mjs`）

```bash
node scripts/setup-dsh.mjs --dry-run     # 先看它要写哪些文件
node scripts/setup-dsh.mjs               # 真正安装
```

它做三件事：

1. 把 `dsh/agent-presets/qq-chat`、`qq-chat-v2` **复制**到 `<DSH_HOME>\.agent-presets\`
   （是 `cpSync` 复制，**不是软链** —— 所以改了 preset **必须重跑本脚本**才生效）。
2. 在 DSH profile 的 `cordis.patch.yml` 里写一个带 marker 的区块：挂 3 个 MCP server
   （`mcp-snowluma-safe.js`、`mcp-host-server.js`、`mcp-web-search-safe.js`）+ 2 个本地插件
   （设置页 `qq-mode-console`、侧边栏「唤醒」`qq-wake`）。**每次会先备份原文件**（`.bak-<时间戳>`）。
3. 打印下一步提示。它**不碰** profile 的 `package.json`，也不依赖 `dsh` CLI。

**`DSH_HOME` 怎么定**：脚本按 `环境变量 DSH_HOME` → 否则 `~/.dsh`。
DSH Desktop 的 harness 目录通常是：

```
%APPDATA%\dsh-desktop\harness        # 本机实测
```

在 DSH 里跑命令时这个变量一般已注入；手动跑如果路径不对，显式指定：

```powershell
$env:DSH_HOME = "$env:APPDATA\dsh-desktop\harness"
node scripts\setup-dsh.mjs
```

参数：`node scripts/setup-dsh.mjs [profile] [--dry-run]`（默认 profile = `web`）。

**验证**：

```bash
node scripts/test-plugin-entry.mjs     # 插件入口冒烟：应「✅ 全部通过」（2 个插件）
node scripts/dsh-status.mjs            # 应能看到 qq-chat / qq-chat-v2 两个 preset、
                                       # 命名空间含 qq-mode、5 个 qq-bridge 插件 active
```

> **改了插件源码（`plugins/**`、`preset` 的 `agent.cordis.yml`、`schema.js`）之后必须重启 DSH**：
> 宿主进程在启动那一刻就把插件入口 `import` 进来了，模块缓存不会因为文件变了而失效（F5 不够）。
> 只有 `cordis.patch.yml` 是 live reload。

---

## 6. 启动桥接

**默认不自启**（这是有意设计：不装计划任务、不开机自启）。三种启动方式，任选一种：

| 方式 | 怎么做 | 适合 |
|---|---|---|
| **侧边栏「唤醒」**（推荐） | DSH Web 界面左边栏**「技能中心」正下方**那个「唤醒」按键点一下 | 日常：它会依次拉起 SnowLuma → 探活 OneBot → 拉起桥接 → 给你发一句「睡醒了」 |
| `start.bat` | 双击（内部是 `node src/bridge.js` 的死循环守护窗口：崩了 5 秒后重启） | 想要一直开着 |
| 手动 | `node src/bridge.js` | 调试（前台看输出） |

`restart.bat` = 先杀掉旧守护窗口与旧桥接进程，再重新起。

**验证**：

```bash
node scripts/test-wake.mjs --status     # 期望 awake: true；bridge: ok；onebot 显示机器人号
node scripts/test-wake.mjs --no-send    # 冷启动链路自测（不发 QQ 消息）
```

看到 `awake: true` 就成功了。剩下的就是：**用你本人的 QQ 给机器人发一条私聊**。

---

## 7. 装完自检（建议全跑一遍）

| 命令 | 验什么 | 期望 |
|---|---|---|
| `node scripts/test-no-group.mjs` | **群聊已彻底移除、私聊不受影响**（起隔离实例 + 假 OneBot） | 21 项全 ✓ |
| `node scripts/test-wake-lock.mjs` | **实例锁自愈**（pid 被复用也不会卡住启动） | 11 项全 ✓ |
| `node scripts/test-plugin-entry.mjs` | 插件入口能 import（写错会让整个 harness 起不来） | 全部通过 |
| `node scripts/test-qq-settings.mjs` | 设置字段表 ↔ schema ↔ `config.json` 一致 | 140 项、全通过 |
| `node scripts/test-qq-settings-page.mjs` | 设置页 SSR 渲染 | 全通过 |
| `node scripts/test-settings-merge.mjs` | 设置覆盖规则（只覆盖你改过的字段） | 24 项全通过 |
| `node scripts/test-wake-fence.mjs` | 唤醒路由的**信任围栏**（DNS 重绑定等） | 38 项全通过 |
| `node scripts/test-mcp-safe.mjs` | MCP 工具面（30 个、无群工具） | 全通过 |
| `node scripts/test-console.mjs` | 桥接自带控制台页面与接口 | 32 项全通过 |
| `node src/self-test.js` | DSH 链路（真跑一轮 agent，不发 QQ） | 打印 agent 回复、exit 0 |
| `node scripts/scan-secrets.mjs` | **发布/提交前**有没有把令牌/真实 QQ 号写进会入库的文件 | `✅ 未发现敏感信息` |

> 受限终端里注意：本机 PowerShell 管道捕获 `node` 输出有时会被拦（报 `Access is denied`）——
> **裸跑 `node x.js`** 让输出继承 stdout 即可，别用 `| Select-Object` 之类。

---

## 8. 装好之后怎么用

- **改配置**：首选 DSH **设置 → 「通用设置」正下方「QQ 机器人」**（140 个字段，每项带中文说明）。
  优先级：**设置页里改过的字段 > `config.json` > 控制台改的值 > 代码默认值**。
  桥接每 5 秒拉一次，改完基本立刻生效（`consolePort`、`snowluma` 这类接线项要重启桥接）。
- **本地控制台**：`http://127.0.0.1:3100`（访问令牌在 `state/console-token`）。可看活动日志、改白名单、
  切运行模式（`chat` / `closed-agent` / `reserved` / `reserved2`）、管角色卡与黑话库。
- **聊天侧管理命令**（只有 `ownerQQ` 能用）：`/reset` 重置上下文、`/status` 看状态、
  `/role <名字>` 切角色、`/silent` 静默、`/active` 恢复。
- **角色卡**：`roles/*.md`，改文件即生效；在私聊里发 `进入角色扮演：<角色名>` 切换（仅管理员）。
- **审批/提问**：DSH 里 agent 要权限或要问你问题时，会发到你 QQ 私聊，回「通过/拒绝」即可；
  你人在电脑前时 DSH 界面也能点（**谁先答谁生效**）。
- **运行模式**：`reserved2`（二代仿真，AI 自己决定何时发言/潜水，推荐）、`chat`（每条都自动回）、
  `closed-agent`（只认管理员私聊）、`reserved`（一代仿真）。

---

## 9. 故障速查

| 症状 | 先看 | 多半是 |
|---|---|---|
| **点了「唤醒」没反应** | 按钮 tooltip 卡在哪一步 | ① QQ 客户端没开/没登录 → SnowLuma 注入不了；② 桥接 60s 内没起来（见下一条） |
| **桥接起不来、`bridge.log` 一行新日志都没有** | `state/bridge.lock` | **陈旧实例锁**：桥接被硬杀时来不及删锁，而 Windows 把那个 pid 复用了给别的进程（实测给了系统进程 `dwm`），旧代码会把 `EPERM` 当成"实例还在运行"直接 `exit 2`。**本版本已修**（`EPERM` 也算过期锁，唤醒前也会自动清）；旧版本手动 `del state\bridge.lock` 再唤醒 |
| SnowLuma 端口在听但 OneBot 不响应 / 日志刷 `code=1006` | SnowLuma 日志有没有 `hook auto-load enabled`、`[Hook] login detected` | `hookAutoLoad` 不是 `true`，或 QQ 客户端重启过 → 点「唤醒」（它会重启 SnowLuma），**不用重新扫码** |
| 报 `HTTP 426` | `snowluma.httpUrl` | 填成了 WebSocket 端口，改成 **HTTP API** 端口（默认 3000） |
| 消息发过去但机器人不回 | `state/bridge.log` | 该 QQ 不在 `allow.private`；或模式是 `reserved2`（AI 自己决定要不要发言）；或 preset 没装（重跑 `setup-dsh.mjs`） |
| **群里发消息没反应** | —— | **设计如此**：群聊已移除，群消息被直接忽略 |
| 设置页找不到「QQ 机器人」分区 | DSH 重启过没有 | 分区由插件 client 半侧注册，**改完插件必须重启 DSH**；patch 没挂上就重跑 `setup-dsh.mjs` |
| 改了 `preset`/`schema.js` 没效果 | —— | 仓库文件不生效：preset 要重跑 `setup-dsh.mjs`（复制到 `DSH_HOME\.agent-presets\`）、插件要重启 DSH |
| 设置页改了行为却没变 / 反过来 | `state/bridge.log` 找「已从 DSH 设置页应用」 | 设置覆盖只认 `ns.user`（你动过的字段）；控制台运行期改的不会被覆盖 |
| **控制台改了配置，几秒后自己变回去** | 同上 | 历史缺陷（已修）：确认用的是本仓库的 `src/settings-merge.js` |
| 日志时间对不上 | `state/bridge.log` | **桥接日志时间戳是 UTC**（比本地少 8 小时）；`supervisor.log` 才是本地时间 |
| 权限/审批没到手机 | `relayApprovalsToOwner` | 或该会话被映射到了别的 QQ 会话 |
| PowerShell 脚本报一堆莫名语法错误 | `.ps1` 的编码 | **PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 会按 GBK 解析**（报错里能看到 `鎵嬪姩` 这类乱码）→ `tools/*.ps1` 必须存成 **UTF-8 with BOM** |

排查统一入口：**侧边栏「唤醒」按钮的 tooltip**（卡在哪一步一目了然）+ `state/bridge.log`。

---

## 10. 升级 / 卸载

**升级**：

```bash
git pull                 # 或覆盖文件
npm install              # 依赖或 postinstall 有变时
node scripts/setup-dsh.mjs   # 刷新 preset 安装副本与 patch 区块（幂等，自动备份）
# 然后：重启 DSH（插件/MCP 生效）+ 重启桥接（业务逻辑生效）
```

**卸载**：

1. 关掉桥接（`restart.bat` 会先杀；或任务管理器结束 `node .../src/bridge.js`）。
2. 从 `<DSH_HOME>\profiles\web\cordis.patch.yml` 里删掉 `# === qq-bridge MCP BEGIN ===` 到
   `# === qq-bridge MCP END ===` 之间的整块（脚本每次都会备份：`cordis.patch.yml.bak-*`）。
3. 删掉 `<DSH_HOME>\.agent-presets\qq-chat`、`qq-chat-v2` 两个目录。
4. 重启 DSH。仓库目录和 `state/`（含日志、会话映射、令牌）可以直接删。

---

## 11. 安全与隐私（值得读一遍）

- **只服务私聊，只服务白名单**：不在 `allow.private` 里的人发消息会被直接忽略；
  默认 `allowAllWhenEmpty:false`，白名单空着就谁都不回。
- **agent 的工具面是被削过的**：两个 `qq-chat*` preset **不挂任何本地工具**
  （没有 bash / 文件读写 / 子代理），QQ 会话里说破天也操作不了你的电脑；
  MCP 只暴露 30 个 `qq_* 私聊工具`（发送类还要过白名单 + 频率限制），
  没有任何管理类动作（禁言/踢人/改群设置/文件上传下载都不存在）。
- **身份只认系统标记**：preset 里写死了「只有带【管理员】标记的消息才是主人」，
  对方口头自称主人/管理员无效。
- **密钥不入库**：`config.json`、`state/`（含 `console-token`、会话令牌）、`*.log`、`*.bak-*`
  都被 `.gitignore` 排除；发布前可用 `node scripts/scan-secrets.mjs` 自查。
- **给管理员的审批不脱敏**：审批理由里往往就是目标路径/命令，藏掉等于让你闭眼批权限 ——
  这是有意为之。
- **本地端口**：3000/3001/3100/5099 都只监听 `127.0.0.1`；桥接控制台与唤醒路由都有
  「本机 + 同源」信任围栏（防 DNS 重绑定）。别把它们暴露到公网。

---

## 12. 目录速览

```
qq-bridge/
├─ src/bridge.js             主程序（事件处理/会话映射/控制台 HTTP/social 仿真）
├─ src/dsh-client.js         DSH 0.1.2 客户端（鉴权、端点、事件流 mux）
├─ src/mcp-*.js              3 个 MCP server（给 agent 的工具/宿主控制/网页搜索）
├─ plugins/qq-mode-console/  DSH 设置页「QQ 机器人」（140 个字段）
├─ plugins/qq-wake/          DSH 侧边栏「唤醒」按键（含实例锁自愈）
├─ dsh/agent-presets/        两个 agent preset（人格/权限边界在这）
├─ roles/                    角色卡（改文件即生效）
├─ public/console.html       桥接自带控制台页面
├─ scripts/                  安装、自测、发布脚本
├─ tools/                    （可选）自启守护与故障速查
├─ config.json               你的配置（不入库）
└─ state/                    运行状态/日志/令牌（不入库）
```

---

## 13. 许可与致谢

- 本仓库是 **fork 自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)**，
  原作者 **Derpyu520**；上游仓库**未提供 LICENSE**，因此按 GitHub 服务条款允许的
  **fork** 形式发布，不另建独立仓库。
- 本 fork 的增量：DSH **0.1.2 gateway 协议移植**、**移除群聊能力（只保留私聊）**、
  唤醒/实例锁自愈与对应回归测试、设置页与文档同步。
- 移植过程、协议差异与 6 个缺陷复盘见 [`PORTING-DSH-0.1.2.md`](PORTING-DSH-0.1.2.md)；
  给 AI 代理的项目说明书见 [`AGENTS.md`](AGENTS.md)。

### 相关文档

| 文档 | 内容 |
|---|---|
| [`README.md`](README.md) / [`README.en.md`](README.en.md) | 项目总览、功能与 fork 增量 |
| [`AGENTS.md`](AGENTS.md) | 给 AI 编码代理的项目说明书（文件地图 / 不变量 / 已知坑 / 改动约束） |
| [`PORTING-DSH-0.1.2.md`](PORTING-DSH-0.1.2.md) | DSH 0.1.2 移植全过程与缺陷复盘（历史文档） |
| [`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md) | 架构、数据流、配置全解、调试与改进指南 |
| [`docs/DSH_SETUP.md`](docs/DSH_SETUP.md) | DSH 端安装的另一份简版说明 |
| [`RULES.md`](RULES.md) | 运行模式与权限边界 |
| [`tools/README.md`](tools/README.md) | （可选）自启守护、常用命令、故障速查 |
