# install-task.ps1 —— 把 qq-bridge 守护脚本注册成「登录时自动启动」的计划任务
#
# 用法（在本仓库根目录下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-task.ps1
#
# 卸载：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-task.ps1

$ErrorActionPreference = 'Stop'

$TaskName   = 'DSH QQ Bot Supervisor'
$ScriptPath = Join-Path $PSScriptRoot 'dsh-qq-bot.ps1'

if (-not (Test-Path $ScriptPath)) {
  throw "找不到守护脚本: $ScriptPath"
}

Write-Host "守护脚本: $ScriptPath"

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

# 触发条件（两个）：
#   1. 登录时启动 —— 正常路径。
#   2. 每 5 分钟重试一次 —— 看门狗。守护是常驻进程，而「登录时启动」只触发一次；
#      一旦守护进程被杀（实测：控制台关闭事件会让 powershell.exe 以 0xC000013A 退出，
#      日志里只留下第一行「守护启动」就没了），在没有看门狗的情况下它会一直缺席，
#      直到下次登录 —— 表现就是「机器人根本没启动」。
#      配合 MultipleInstances=IgnoreNew：守护活着时这次触发是空转，死了才会真正起来。
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerWatchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

$desc = 'DSH 在运行时自动拉起/守护 SnowLuma 与 qq-bridge；DSH 关闭时停掉它们。'

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger @($triggerLogon, $triggerWatchdog) `
  -Settings $settings `
  -Principal $principal `
  -Description $desc `
  -Force | Out-Null

Write-Host "`n已注册计划任务: $TaskName" -ForegroundColor Green

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("  状态      : " + $task.State)
Write-Host ("  触发      : 登录时 + 每 5 分钟看门狗")
Write-Host ("  运行身份  : " + $principal.UserId + " (" + $principal.LogonType + ")")
Write-Host ("  上次结果  : " + $info.LastTaskResult)

Write-Host "`n提示：" -ForegroundColor Cyan
Write-Host "  * 现在就想启动：Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  * 手动跑一次  ：powershell -NoProfile -ExecutionPolicy Bypass -File tools\dsh-qq-bot.ps1"
Write-Host "  * 看日志      ：Get-Content `"$PSScriptRoot\..\state\supervisor\supervisor.log`" -Tail 30 -Wait"
Write-Host "  * 看心跳      ：Get-Content `"$PSScriptRoot\..\state\supervisor\supervisor.heartbeat`""
Write-Host "  * 卸载        ：powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-task.ps1"
