# qq-wake —— DSH 侧边栏「唤醒」按键

在 DSH Web GUI 的侧边栏**「技能中心」正下方**加一个「唤醒」按键：点一下 = 把 QQ 机器人
整条链路拉起来，并给管理员发一句 **「睡醒了」**。

```
点「唤醒」
   │  POST /api/qq-wake/wake            （同源，浏览器只跟 DSH 说话）
   ▼
宿主侧（DSH Node 进程）lib/index.js
   │  runWake()
   ├─ 1. SnowLuma：OneBot 不通就起来（注入 QQ.exe）
   │       端口 5099 在听但接口不通 = 注入管道断了 → 只重启「我们启过的那一个」
   ├─ 2. qq-bridge：控制台 3100 不通就起来
   │       （必须在 OneBot 可用之后 —— 桥接连不上 SnowLuma 会 fail-fast 直接退出）
   └─ 3. POST 桥接 /api/test-send → QQ 私聊管理员一句「睡醒了」
```

**这是唯一的启动方式：点一下才醒。** 不注册计划任务、不开机自启、不做常驻守护。
两个 node 进程由本插件 `spawn(detached)` 拉起，DSH 关掉后它们继续跑，下次唤醒直接复用。
（`tools/` 里那套自启守护脚本仍在仓库里，但**默认不安装**；想要开机自启得手动跑
`tools/install-task.ps1`。）

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

「本机 Host」是**按 IP 字面量严格解析**的（四段十进制、每段 ≤255、首段 127，或精确的
`localhost` / `::1`）—— 不能用 `startsWith('127.')`，否则 `127.0.0.1.evil.com` 这种
「借前缀的域名」会连 `Origin` 检查一起穿过去（DNS 重绑定），详见「坑」第 11 条。

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

**生效方式**：patch 层条目（`cordis.patch.yml`）是 live reload 的，重跑 `setup-dsh.mjs` 即可；
**但改 `lib/*.js` 的源码必须重启 DSH** —— 宿主进程在启动时就把入口 `import` 进来了，
模块缓存不会因为你改了文件就失效（实测：改完围栏判定，运行中的路由照旧按老代码返回 200）。
客户端半侧的启动图同样是启动时组装的，**F5 不够**。

## 自测

```bash
node scripts/test-wake.mjs --status        # 只看状态（不动任何东西，awake 时 exit 0）
node scripts/test-wake.mjs --no-send       # 冷启动链路，但不发消息
node scripts/test-wake.mjs                 # 完整跑一遍（会真的发一条 QQ 消息）
node scripts/test-wake.mjs --guards        # 守护规则（单飞锁 / 锁释放 / 缺目录时干净失败）
node scripts/test-wake-client.mjs          # 客户端半侧：jsdom 造仿 DSH 侧边栏，验证行的位置与点击
node scripts/test-wake-fence.mjs           # 信任围栏（38 项纯函数判定）
node scripts/test-wake-fence.mjs --live    # 再打一遍运行中的真路由（本机 200 / 伪装 Host 403 / 跨站 403）
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
6. **子进程要 `detached + unref + stdio:'ignore'`**：这样 DSH 关掉后机器人不会被一起带走，
   也不会因为父进程没有消费 stdout 而在管道写满时卡住。
7. **只重启「自己启过的那一个」，而且要确认它还是 node**：SnowLuma 端口在听但 OneBot 不通时
   要重启它，但 pid 只认 `state/supervisor/snowluma.pid` 里记的（本插件写入的）。
   没有那个 pid 就说明是别人起的进程，这时**不杀**，只报错让用户自己处理。
   就算有 pid 也要再验一次（pid 文件可能很旧，而 **pid 会被系统复用**）：
   杀之前用 `tasklist /FI "PID eq N"` 确认进程名是 `node.exe`，问不出来就不杀。
8. **`spawn()` 失败是异步 `emit('error')` 的**：没挂 `error` 监听器时 Node 会把它抛成
   **未捕获异常 —— 那是把整个 DSH harness 搞崩**。所以 `spawnDetached()`：
   先 `existsSync(nodeExe)` 同步挡一道、`spawn` 包 try/catch、补 `on('error')`、
   拿不到 pid 时不写 pid 文件、调用点拿到 0 直接失败（不空等 4 分钟）。
9. **同一时刻只允许一次唤醒**：`runWake()` 有单飞锁（并发调用复用同一个 Promise，结束后释放）。
   否则连点两次会各自看到「SnowLuma 没在跑」→ 起两个，端口打架、QQ 被重复注入。
   客户端按钮的 busy 态只是 UI，不能当并发控制。自测：`node scripts/test-wake.mjs --guards`。
10. **唤醒不是万能的**：SnowLuma 是注入式的，**QQ 客户端没开 / 没登录**时链路起不来。
    这时路由会返回 `ok:false` 并说明卡在哪一步（前端按钮会显示「唤醒失败」与 tooltip 详情）。
11. **判「来自本机」绝不能用字符串前缀**：老实现是 `host.startsWith('127.')`，
    于是 `127.0.0.1.evil.com`（A 记录指向 127.0.0.1）也过 —— `Host` 过了、`Origin` 过了、
    浏览器还老实报 `sec-fetch-site: same-origin`，整条围栏等于没设，实测该请求拿到 **200**。
    现在按 IP 字面量严格解析（四段十进制 + 首段 127；`localhost` 只认精确匹配，
    `::ffff:127.0.0.1` 先剥前缀）。教训：**测围栏要穷举「攻击者能构造的请求头」**，
    只测自己想到的那几种等于没测。护栏：`node scripts/test-wake-fence.mjs [--live]`。
