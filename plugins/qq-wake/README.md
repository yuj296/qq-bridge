# qq-wake —— DSH 侧边栏「唤醒」按键

在 DSH Web GUI 的侧边栏**「技能中心」正下方**加一个「唤醒」按键：点一下 = 把 QQ 机器人
整条链路拉起来，并给管理员发一句 **「睡醒了」**。

```
点「唤醒」
   │  POST /api/qq-wake/wake            （同源，浏览器只跟 DSH 说话）
   ▼
宿主侧（DSH Node 进程）lib/index.js
   │  runWake()
   ├─ 1. 桥接控制台 3100 探活；连不上 → schtasks /run "DSH QQ Bot Supervisor"
   │       （守护进程起来后自己拉 SnowLuma + qq-bridge）
   ├─ 2. 等 OneBot /get_login_info 返回 ok（= SnowLuma 注入成功且 QQ 已登录）
   └─ 3. POST 桥接 /api/test-send → QQ 私聊管理员一句「睡醒了」
```

## 文件

| 文件 | 职责 |
|---|---|
| `package.json` | 声明 `dsh.client.platform = web` 与 `exports["./client"]`（客户端半侧的入口） |
| `lib/index.js` | **宿主半侧**：注册 `/api/qq-wake/*` 路由 + 本机信任围栏 |
| `lib/wake.js` | **唤醒流程**（纯逻辑，不依赖 DSH，可被脚本单独调用） |
| `lib/client.js` | **客户端半侧**：往侧边栏注入「唤醒」行（DOM 注入 + MutationObserver 自愈） |

## 路由

| 路由 | 说明 |
|---|---|
| `GET /api/qq-wake/status` | 守护心跳 / 桥接 / OneBot 登录态一眼看清，`awake` 是综合结论 |
| `POST /api/qq-wake/wake` | 跑一次唤醒。body 可选 `{ "send": false }` 只拉链路不发消息，`{ "message": "..." }` 换文案（≤40 字） |

两者都只接受**本机**请求（loopback socket + 本机 Host + 同源标记）；POST 还要求
`application/json`，否则 403。**控制台令牌只留在宿主侧**，不下发到页面。

## 安装（挂到 DSH）

由 `scripts/setup-dsh.mjs` 自动挂进用户 patch 层：

```yaml
- insert:
    - id: qq-wake
      name: 'file:///D:/dk/qq-bridge/plugins/qq-wake/lib/index.js'
      config: {}
```

**关键点**：客户端半侧不是靠这个路径指过去的，而是 `dsh-client-modules`
从「挂载文件**最近的** `package.json`」里读 `dsh.client` 声明与 `exports["./client"]` ——
所以入口指向 `lib/index.js` 就够了，它会顺着目录找到本包的 `package.json`。
（这也是**不能**把入口写成仓库根目录下某个散文件的原因。）

**生效方式**：patch 层是 live reload 的，宿主路由立刻可用；
但**已打开的页面**需要 **刷新一次（F5）** 才会加载新的客户端启动图 —— 不需要重启 DSH。

## 自测

```bash
node scripts/test-wake.mjs --status        # 只看状态（不动任何东西，awake 时 exit 0）
node scripts/test-wake.mjs --no-send       # 冷启动链路，但不发消息
node scripts/test-wake.mjs                 # 完整跑一遍（会真的发一条 QQ 消息）
node scripts/test-wake-client.mjs          # 客户端半侧：jsdom 造仿 DSH 侧边栏，验证行的位置与点击
```

`test-wake-client.mjs` 覆盖 4 个场景：技能中心存在（行必须紧贴它下面）、技能中心缺席
（退回功能行家族末尾）、点击（POST + JSON 到唤醒路由）、外壳未渲染（apply 不能抛）。
jsdom 不是本仓库依赖，脚本会自动去 DSH Desktop 自带的那份拿，拿不到就跳过。

## 坑（都踩过）

1. **侧边栏没有对外 slot**。官方 `dsh-client-ui-sidebar` 只声明
   `sidebar.brand.*` / `sidebar.workspaces` / `sidebar.settings` 三处席位，
   社区插件一律走「DOM 行 + MutationObserver 自愈」。所以本插件也是 DOM 注入，
   锚点是 `[data-dsh-skill-explorer-entry]`（技能中心那一行），
   找不到时退回功能行家族末尾、再退回「新会话」下方。
2. **客户端 bundle 是有固定外壳的**：`window.__ModuleLoader__.load({ id, factory })`，
   里面 `factory(require)` 返回 `module.exports`，并挂 `apply` / `inject`。
   直接写普通 ESM 导出不会被加载。`id` 必须等于 `package.json` 的 `name`。
3. **`apply` 绝不能抛**。客户端插件 apply 抛出会让整个 Web 外壳启动失败 ——
   本插件的 client 半侧所有 DOM 操作都包在 try/catch 里。
4. **别用 PowerShell 管道抓 `node` 输出**（沙箱会拦命名管道）；裸跑即可。
5. **`node scripts/test-wake.mjs` 不能在 await 之后立刻 `process.exit()`** ——
   libuv 会断言（`UV_HANDLE_CLOSING`，退出码 `-1073740791`）。脚本里用的是延迟退出。
6. **`schtasks` 在中文 Windows 上吐 GBK**，按 UTF-8 读会乱码；`wake.js` 里用
   `TextDecoder('gbk')` 解一次。
7. **唤醒不是万能的**：SnowLuma 是注入式的，**QQ 客户端没开 / 没登录**时链路起不来。
   这时路由会返回 `ok:false` 并说明卡在哪一步（前端按钮会显示「唤醒失败」与 tooltip 详情）。
