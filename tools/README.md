# tools/ —— 开机/登录自动启动（Windows 任务计划程序）

让 QQ 机器人只在 DSH 开着的时候运行，不用每次手动双击两个 bat。

## 装了什么

| 文件 | 作用 |
|---|---|
| `dsh-qq-bot.ps1` | 守护脚本（常驻）。核心逻辑在文件末尾的主循环里 |
| `install-task.ps1` | 注册计划任务「DSH QQ Bot Supervisor」 |
| `uninstall-task.ps1` | 卸载任务并停掉它拉起的进程 |
| `show-task.ps1` | 打印任务的触发器/动作/身份/设置，用来确认配置没被改坏 |

## 守护脚本干什么

每 20 秒检查一次：

1. **DSH Desktop 在跑吗？**
   - 不在 → 把 SnowLuma 和 qq-bridge 停掉（机器人没意义，也省得空转）
   - 在 → 继续下面两步
2. **SnowLuma**：端口 5099 不通就拉起来（`node C:\SnowLuma\index.mjs`）
3. **qq-bridge**：控制台端口 3100 不通就拉起来（`node src\bridge.js`）

另外还有一条**自动修复**：SnowLuma 端口在听、但 OneBot 的 `get_login_info`
连续 3 次探活失败时，判定为「QQ 客户端重启把注入管道搞断了」，
自动重启 SnowLuma 并连带重启桥接。登录态存在 SnowLuma 本地，**不需要重新扫码**。

进程 PID 记在 `state/supervisor/*.pid`，日志在 `state/supervisor/supervisor.log`（超过 1MB 自动截断）。

## 常用命令

```powershell
# 看日志（实时跟随）
Get-Content D:\dk\qq-bridge\state\supervisor\supervisor.log -Tail 30 -Wait

# 现在立刻启动守护（不用等下次登录）
Start-ScheduledTask -TaskName 'DSH QQ Bot Supervisor'

# 看任务状态
Get-ScheduledTask -TaskName 'DSH QQ Bot Supervisor' | Select TaskName,State
Get-ScheduledTaskInfo -TaskName 'DSH QQ Bot Supervisor'

# 看任务状态
powershell -NoProfile -ExecutionPolicy Bypass -File tools\show-task.ps1

# 停掉守护（进程会被一起停掉）
Stop-ScheduledTask -TaskName 'DSH QQ Bot Supervisor'

# 完全卸载
powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-task.ps1
```

## 注意

- **SnowLuma 必须开 `hookAutoLoad`**（`C:\SnowLuma\config\runtime.json` 里
  `"hookAutoLoad": true`）。默认是 `false`，此时 SnowLuma **只会连上那些
  「已经带着 SnowLuma DLL」的 QQ 进程**（`index.mjs` 里的
  `if (this.autoLoadOnDiscovery && ...) this.runAutoLoad(session)`），
  **不会注入新启动的 QQ 客户端**。
  后果：QQ 客户端一重启，新进程没有 DLL，SnowLuma 就永远 `login detected` 不出来
  （日志里只有 `SnowLuma starting` + WebUI 监听，之后一片空白）。
  开着之后每次启动会打印 `hook auto-load enabled: every discovered QQ process will be injected`。
- 任务用 **Windows PowerShell 5.1**（`powershell.exe`）运行，不是 PowerShell 7。
  5.1 读**无 BOM** 的 UTF-8 脚本会按 GBK 解析，中文会把引号/花括号吞掉导致语法错误 ——
  **这几个 `.ps1` 都是带 UTF-8 BOM 的，用编辑工具改完务必确认 BOM 还在**
  （很多编辑器/工具会把它吃掉）。
- 任务以 `Interactive`（仅登录时）身份运行，因为机器人依赖你登录的 QQ 客户端。
- 「DSH 关闭 → 停掉两个进程」这条分支逻辑是照着需求写的，但**没有实测过**
  （实测需要关掉 DSH，会连带终止当前会话）。

## 故障速查

| 症状 | 原因 / 处理 |
|---|---|
| 日志刷 `未检测到 QQ.exe … 暂停守护` | QQ 客户端没开。开起来即可 |
| 日志反复 `OneBot 接口无响应` 且 SnowLuma 启动后没有任何 `Hook` 行 | QQ 客户端开着但**没登录**，或 `hookAutoLoad` 是 false。先确认登录，再确认 autoload |
| 日志出现 `已连续重启 N 次仍未恢复…暂停 10 分钟` | 上面两种情况之一。修好后守护会在下一轮自动恢复（或手动重启任务） |
| 桥接反复「已启动」又「端口未就绪」 | OneBot 没起来。新版守护已加门控，不会在 OneBot 不可用时拉桥接 |
