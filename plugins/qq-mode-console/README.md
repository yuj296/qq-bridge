# qq-mode-console —— DSH 设置页的「QQ 机器人」分区

把 qq-bridge 的 **整份 `config.json`**（140 项，机密除外）搬进 DSH 设置页 ——
**「通用设置」正下方**一个独立分区（`settings.section`，order=1），
每项都带中文名和一段详细说明，点几下就能改，不用手编 JSON。

> ⚠️ **字段表里已经没有任何群相关项**：`allow.groups` / `deny.groups`、群专属仿真参数
> （触发概率、必答词、活跃时长、主动开话题、选择性沉默）与 3 个群工具开关
> （`socialV2.tools.sendGroup` / `sendBurst` / `getActiveMembers`）都已随群聊能力一起删除
> （16 个字段）。本插件服务的桥接**只处理「用户 ↔ 机器人」私聊**。

```
DSH 设置页「QQ 机器人」分区（client，order=1）
   │  写入用户层（settings 提供方持久化）
   ▼
settings 命名空间 qq-mode（host）
   │  base = 挂载时的 config.json 快照；用户改过的字段进 user 层
   ▼
src/bridge.js 每 5s 拉一次 settings.describe → 深合并进自己的 cfg
```

## 文件

| 文件 | 职责 |
|---|---|
| `lib/schema.js` | **字段表（唯一真源）**：`[路径, 类型, '标签', '详细说明']` + 分组表 `GROUPS` |
| `lib/index.js` | host 半侧：按字段表建 schemastery schema，注册 `qq-mode` 命名空间，`base` 取自 `config.json` |
| `lib/client.js` | client 半侧：注册 `settings.section` 分区，**按 schema 自动生成页面**（加字段只改 `schema.js`） |

## 为什么必须自己写这个页面

DSH 的设置页**不会**自动把 settings 命名空间渲染成界面：

- 左边那列导航（通用设置 / 模型 / 插件 / …）每一项都是插件用 `settings.section`
  **自己注册**的，官方只为自己的几个命名空间写了页面；
- 「插件 → 插件配置」也只渲染**有人认领**的命名空间（`settings.plugin.item` 按 namespace 分键）。

所以在写这个插件之前，`qq-mode` 命名空间虽然注册了、桥接也在读它，
**但用户在界面上根本看不到、改不了**。

排序：官方 `general`（通用设置）= order 0、`models` = 10、`plugins` = 15；
本插件用 **order 1**，所以它紧跟在「通用设置」下面。

## 分组（10 组，140 项）

| 分组 | 项数 | 说明 |
|---|---|---|
| 基本 | 9 | 运行模式、管理员 QQ、preset、控制台端口、超时… |
| 通知 | 6 | 任务完成通知的开关与阈值（默认只报跑够 5 分钟的） |
| 白名单 / 黑名单 | 2 / 1 | **私聊**准入（`allow.private` / `deny.private`）；群白/黑名单字段已删除 |
| 安全 | 1 | 拦截时是否通知 |
| 黑话学习 | 8 | 提取阈值、冷却、注入上限、自动深研 |
| 一代仿真 social | 16 | 回复长度、上下文条数、活跃检查间隔、观望/重试、分条发送…（群相关项已删） |
| 二代仿真 socialV2 | 88 | 潜水/唤醒、发送限流、**26 个工具逐个开关**、表情包、上下文、主动找人… |
| 模型与 DSH 接线 | 4 | provider / model / 思考强度 / DSH 地址 |
| SnowLuma 接线（高级） | 5 | wsUrl / httpUrl / 启动脚本 / 安装目录 / 进程控制 |

前 8 组默认展开，`social` 与 `socialV2` 这两个超长组默认收起（点标题展开）。

## 优先级与生效

```
设置页里改过的字段  >  config.json（磁盘） = 桥接控制台改的值  >  代码默认值
```

- 桥接每 5s 读一次**命名空间的 user 层**（只含你在页面里显式改过的字段），
  **保存后 ~5 秒生效**（白名单、通知、仿真参数、工具开关…）。
- **没在页面里碰过的项，桥接一个字都不动** —— 所以你在桥接控制台里改的白名单/黑话/社交参数
  不会被设置页的快照覆盖回去。
  ⚠️ 早期实现是拿「解析后的整值」（base + user）去覆盖的，而 base 是 **DSH 启动那一刻的
  config.json 快照**，于是控制台改的东西会在 5 秒后被改回去。现在只认 user 层，
  规则抽在 `src/settings-merge.js`，有 `scripts/test-settings-merge.mjs` 盯着。
- 想撤销某一项：点它右边的「已改」→ 保存，桥接会把它**还原成磁盘上 config.json 的值**。
- 标了 ⚠️ 的接线项（`consolePort`、`snowluma.wsUrl/httpUrl`）**要重启桥接**。
- 手改 `config.json` 后想让改动生效：直接在页面里点那项「已改」重置即可（会读盘还原）。

## 哪些故意没放进来

| 键 | 原因 |
|---|---|
| `snowluma.accessToken`、`consoleToken`、`dsh.token` | 机密。设置协议强制 `redactSecrets`，宿主读回来是空的 —— 放进设置页只会变成只写陷阱。它们只认 `config.json` |
| `mode` | 不进 `base`：没在页面里选过，就沿用桥接控制台 / `state/mode.json`（老行为）；选过才覆盖 |
| 所有群相关字段 | 桥接只做私聊，群字段（`allow.groups` / `deny.groups` / 群仿真参数 / 群工具开关）已从字段表删除，**不允许加回来** —— `scripts/test-qq-settings.mjs` 有专门的断言盯着 |

## 自测

```bash
node scripts/test-qq-settings.mjs        # 字段表 ↔ schema ↔ config.json（覆盖率/重复/类型/说明长度/群字段不许回来）
node scripts/test-qq-settings-page.mjs   # 页面：注册到哪个槽位、order、渲染结果、字段说明
```

`test-qq-settings-page.mjs` 用真 schema + react-dom/server 把页面渲染成 HTML，验：
注册进 `settings.section`、`id=qq-bot`、`order=1`、10 个分组都在、每组的"N 项"对得上、
默认展开的分组行数 = 36（140 项减去收起的 social 16 + socialV2 88）、字段说明真的渲染出来了。

## 坑

1. **Schema 实例是函数**（可调用做校验）：判断「叶子 vs 分组」必须用
   `typeof x.type === 'string'`；用 `typeof x === 'object'` 会递归进 Schema 内部
   （有循环引用）→ 直接爆栈。
2. **schemastery 不认嵌套对象简写**：`z.object({ a: { b: z.string() } })` 会报
   `cannot infer schema from [object Object]`，必须显式 `z.object(...)` 层层包。
3. **schema 的嵌套结构 = config.json 的嵌套结构**（桥接要深合并），所以
   "通知"这类分组只能在**展示层**归类（`TOP_LEVEL_GROUPS`），不能真的把字段挪进
   `notify` 对象里。host 与 client 各有一份这个表，`test-qq-settings.mjs` 会校验两边一致。
4. **客户端半侧改完要重启 DSH**：客户端 bundle 在挂载时被快照进浏览器启动图，
   F5 只能拿到上次快照的内容。
5. **写入是原子批量的**：页面暂存草稿，点保存时把全部改动作为**一次**
   `scope.mutate(ops, revision)` 提交，revision 对不上会被拒（避免覆盖别的页面刚做的修改）。
