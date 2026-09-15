# dsh-qq-bot.ps1 —— qq-bridge 守护脚本
#
# 作用：让 QQ 机器人只在 DSH 开着的时候运行。
#   * 检测到 DSH Desktop 在跑 → 确保 SnowLuma 和 qq-bridge 都活着
#   * DSH 关掉了            → 把 SnowLuma 和 qq-bridge 停掉
#   * SnowLuma 的 OneBot 接口探活连续失败（QQ 客户端重启会把注入管道搞断，
#     症状是端口还在听但接口不响应）→ 自动重启 SnowLuma，并把桥接一起重启
#
# 由「任务计划程序」在登录时启动，常驻运行。

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ── 配置 ────────────────────────────────────────────────────────────────────
$SnowLumaDir   = 'C:\SnowLuma'
$SnowLumaEntry = Join-Path $SnowLumaDir 'index.mjs'
$BridgeDir     = 'D:\dk\qq-bridge'
$BridgeEntry   = Join-Path $BridgeDir 'src\bridge.js'
$BridgeConfig  = Join-Path $BridgeDir 'config.json'

$DshProcessName = 'DSH Desktop'   # DSH Desktop 的进程名
$SnowLumaPort   = 5099            # SnowLuma WebUI（用它判断进程是否起来）
$BridgePort     = 3100            # qq-bridge 本地控制台

$PollSeconds      = 20            # 主循环间隔
$HealthFailLimit  = 3             # OneBot 接口连续失败几次就重启 SnowLuma
$RestartStreakLimit = 3           # 连续重启这么多次仍不恢复就退避（通常是 QQ 没登录）
$GiveUpSleepSeconds = 600         # 退避时长
$AfterStartSleep  = 30            # 刚拉起进程后的冷却时间
$StartupWaitMs    = 60000         # 等端口就绪的最长时间

$StateDir = Join-Path $BridgeDir 'state\supervisor'
$LogFile  = Join-Path $StateDir 'supervisor.log'
$SnowLumaPidFile = Join-Path $StateDir 'snowluma.pid'
$BridgePidFile   = Join-Path $StateDir 'bridge.pid'
# 心跳文件：每次轮询都刷新。判断「守护进程还活着吗」看它就够了 ——
# 计划任务里的 State=Running 不可靠（进程被控制台关闭事件杀掉时任务会回到 Ready）。
$HeartbeatFile   = Join-Path $StateDir 'supervisor.heartbeat'

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Write-Host $line
  try {
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    # 日志超过 1MB 就截断，避免无限增长
    if ((Get-Item $LogFile).Length -gt 1MB) {
      $tail = Get-Content $LogFile -Tail 500
      Set-Content -Path $LogFile -Value $tail -Encoding UTF8
    }
  } catch {}
}

# ── 工具函数 ────────────────────────────────────────────────────────────────

# 端口是否在监听（连得上就算）
function Test-Port([int]$Port, [int]$TimeoutMs = 1500) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

# 找 node 可执行文件：优先系统 node，其次 DSH 自带的那份
function Resolve-NodeExe {
  $candidates = @(
    'C:\Program Files\nodejs\node.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\resources\app\node_modules\node\bin\node.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

# 读 PID 文件并返回仍活着的进程对象（PID 被复用时靠启动时间兜底不可靠，这里只做基本校验）
function Get-ProcessFromPidFile([string]$PidFile) {
  if (-not (Test-Path $PidFile)) { return $null }
  $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $procId = 0
  if (-not [int]::TryParse(("$raw").Trim(), [ref]$procId)) { return $null }
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -match 'node') { return $p }
  return $null
}

# 后台启动一个 node 脚本，记录 PID
function Start-NodeScript([string]$NodeExe, [string]$Script, [string]$WorkDir, [string]$PidFile, [string]$Label) {
  try {
    $p = Start-Process -FilePath $NodeExe -ArgumentList @($Script) `
         -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru
    Set-Content -Path $PidFile -Value $p.Id -Encoding ASCII
    Write-Log "[$Label] 已启动 PID=$($p.Id)  ($Script)"
    return $p
  } catch {
    Write-Log "[$Label] 启动失败: $($_.Exception.Message)"
    return $null
  }
}

function Stop-Tracked([string]$PidFile, [string]$Label) {
  $p = Get-ProcessFromPidFile $PidFile
  if (-not $p) { return }
  try {
    Stop-Process -Id $p.Id -Force -ErrorAction Stop
    Write-Log "[$Label] 已停止 PID=$($p.Id)"
  } catch {
    Write-Log "[$Label] 停止失败: $($_.Exception.Message)"
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# 等端口就绪
function Wait-Port([int]$Port, [int]$MaxMs) {
  $deadline = (Get-Date).AddMilliseconds($MaxMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $Port 2000) { return $true }
    Start-Sleep -Milliseconds 1500
  }
  return $false
}

# OneBot 接口探活：读 config.json 的 token，问 get_login_info
function Test-OneBotHealth {
  if (-not (Test-Path $BridgeConfig)) { return $true }   # 拿不到配置就不判断，避免误重启
  try {
    $cfg = Get-Content $BridgeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $url = "$($cfg.snowluma.httpUrl)/get_login_info"
    $token = "$($cfg.snowluma.accessToken)"
    $headers = @{}
    if ($token) { $headers['Authorization'] = "Bearer $token" }
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 10 -ErrorAction Stop
    return ($resp.status -eq 'ok')
  } catch {
    return $false
  }
}

# ── 主循环 ──────────────────────────────────────────────────────────────────
$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
  Write-Log '找不到 node.exe，无法继续。'
  exit 1
}
Write-Log "守护启动：node=$nodeExe  轮询=${PollSeconds}s  DSH 进程名='$DshProcessName'"

$healthFails = 0
$waitingForQq = $false
$restartStreak = 0
$oneBotOk = $false
$startedAt = Get-Date

while ($true) {
  try {
    try { Set-Content -Path $HeartbeatFile -Value ("pid=$PID {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -Encoding ASCII } catch {}
    $dsh = Get-Process -Name $DshProcessName -ErrorAction SilentlyContinue

    if (-not $dsh) {
      # DSH 没开：机器人没有意义，停掉两个进程让它安静
      Stop-Tracked $BridgePidFile 'bridge'
      Stop-Tracked $SnowLumaPidFile 'snowluma'
      $healthFails = 0
      Start-Sleep -Seconds $PollSeconds
      continue
    }

    # ── QQ 客户端 ──
    # SnowLuma 是注入式的，必须有一个正在运行的 QQ.exe 当宿主。
    # QQ 没开时重启 SnowLuma 毫无意义（起来了也永远登录不上），
    # 只会把守护变成无意义的重启循环 —— 所以这里只等，不折腾。
    $qq = Get-Process -Name 'QQ' -ErrorAction SilentlyContinue
    if (-not $qq) {
      if (-not $waitingForQq) {
        $waitingForQq = $true
        Write-Log '未检测到 QQ.exe —— SnowLuma 依赖它做注入，暂停守护（把 QQ 客户端开起来即可恢复）'
      }
      $healthFails = 0
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    if ($waitingForQq) {
      $waitingForQq = $false
      Write-Log '检测到 QQ.exe 已启动，恢复守护'
    }

    # ── SnowLuma ──
    $slProc = Get-ProcessFromPidFile $SnowLumaPidFile
    $slPort = Test-Port $SnowLumaPort
    if (-not $slProc -and -not $slPort) {
      Start-NodeScript $nodeExe $SnowLumaEntry $SnowLumaDir $SnowLumaPidFile 'snowluma' | Out-Null
      if (Wait-Port $SnowLumaPort $StartupWaitMs) { Write-Log '[snowluma] 端口就绪' }
      else { Write-Log '[snowluma] 等了 60s 端口仍未就绪' }
      $healthFails = 0
      Start-Sleep -Seconds $AfterStartSleep
      continue
    }

    # SnowLuma 在跑，但它可能在「注入管道断了」的状态（端口在听、接口不响应）
    $oneBotOk = $false
    if (Test-Port $SnowLumaPort) {
      if (Test-OneBotHealth) {
        $oneBotOk = $true
        if ($healthFails -gt 0 -or $restartStreak -gt 0) { Write-Log '[snowluma] 探活恢复正常' }
        $healthFails = 0
        $restartStreak = 0
      } else {
        $healthFails++
        Write-Log "[snowluma] OneBot 接口无响应（$healthFails/$HealthFailLimit）—— 可能是 QQ 客户端重启把注入管道搞断了"
        if ($healthFails -ge $HealthFailLimit) {
          $restartStreak++
          # 连续重启仍不好，通常不是「管道断了」而是 QQ 客户端压根没登录
          # （SnowLuma 只能注入已登录的 QQ）。这时候继续重启只会变成死循环，退避等待。
          if ($restartStreak -ge $RestartStreakLimit) {
            Write-Log "[snowluma] 已连续重启 $restartStreak 次仍未恢复 —— 请检查 QQ 客户端是否真的登录了（SnowLuma 无法注入未登录的 QQ）。暂停 10 分钟后再试。"
            $healthFails = 0
            $restartStreak = 0
            Stop-Tracked $BridgePidFile 'bridge'
            Start-Sleep -Seconds $GiveUpSleepSeconds
            continue
          }
          Write-Log "[snowluma] 连续失败，重启 SnowLuma（第 $restartStreak 次；登录态在本地，不需要重新扫码）"
          Stop-Tracked $SnowLumaPidFile 'snowluma'
          Stop-Tracked $BridgePidFile 'bridge'
          Start-Sleep -Seconds 3
          Start-NodeScript $nodeExe $SnowLumaEntry $SnowLumaDir $SnowLumaPidFile 'snowluma' | Out-Null
          if (Wait-Port $SnowLumaPort $StartupWaitMs) { Write-Log '[snowluma] 重启后端口就绪' }
          $healthFails = 0
          Start-Sleep -Seconds $AfterStartSleep
          continue
        }
      }
    }

    # ── qq-bridge ──
    # 只在 OneBot 接口真的能用时才拉桥接：桥接连不上 SnowLuma 会 fail-fast 直接退出，
    # 不然就会变成「起来→立刻死→再起来」的空转。
    if (-not $oneBotOk) { Start-Sleep -Seconds $PollSeconds; continue }
    $brProc = Get-ProcessFromPidFile $BridgePidFile
    if (-not $brProc -and -not (Test-Port $BridgePort)) {
      Start-NodeScript $nodeExe $BridgeEntry $BridgeDir $BridgePidFile 'bridge' | Out-Null
      if (Wait-Port $BridgePort $StartupWaitMs) { Write-Log '[bridge] 控制台端口就绪' }
      else { Write-Log '[bridge] 等了 60s 控制台端口仍未就绪' }
      Start-Sleep -Seconds $AfterStartSleep
      continue
    }
  } catch {
    Write-Log "主循环异常: $($_.Exception.Message)"
  }

  Start-Sleep -Seconds $PollSeconds
}
