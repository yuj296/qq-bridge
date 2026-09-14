# install-task.ps1 —— 把 qq-bridge 守护脚本注册成「登录时自动启动」的计划任务
#
# 用法（在 D:\dk\qq-bridge 目录下）：
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

# 登录时触发。守护脚本自己会等 DSH 出现，所以不需要更精细的触发条件。
$trigger = New-ScheduledTaskTrigger -AtLogOn

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
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description $desc `
  -Force | Out-Null

Write-Host "`n已注册计划任务: $TaskName" -ForegroundColor Green

$task = Get-ScheduledTask -TaskName $TaskName
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("  状态      : " + $task.State)
Write-Host ("  触发      : 登录时")
Write-Host ("  运行身份  : " + $principal.UserId + " (" + $principal.LogonType + ")")
Write-Host ("  上次结果  : " + $info.LastTaskResult)

Write-Host "`n提示：" -ForegroundColor Cyan
Write-Host "  * 现在就想启动：Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  * 手动跑一次  ：powershell -NoProfile -ExecutionPolicy Bypass -File tools\dsh-qq-bot.ps1"
Write-Host "  * 看日志      ：Get-Content `"$PSScriptRoot\..\state\supervisor\supervisor.log`" -Tail 30 -Wait"
Write-Host "  * 卸载        ：powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-task.ps1"
