# uninstall-task.ps1 —— 卸载 qq-bridge 守护计划任务，并停掉守护进程管理的两个进程
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\uninstall-task.ps1

$ErrorActionPreference = 'Continue'
$TaskName = 'DSH QQ Bot Supervisor'

try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host '已停止正在运行的守护任务'
    Start-Sleep -Seconds 2
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "已卸载计划任务: $TaskName" -ForegroundColor Green
} catch {
  Write-Host "计划任务不存在或卸载失败: $($_.Exception.Message)"
}

# 按 PID 文件停掉守护脚本拉起的两个进程（不碰别的 node 进程）
$stateDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'state\supervisor'
foreach ($item in @(@('snowluma', 'snowluma.pid'), @('bridge', 'bridge.pid'))) {
  $pidFile = Join-Path $stateDir $item[1]
  if (-not (Test-Path $pidFile)) { continue }
  $raw = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $procId = 0
  if ([int]::TryParse(("$raw").Trim(), [ref]$procId)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -match 'node') {
      Stop-Process -Id $procId -Force
      Write-Host "已停止 $($item[0]) PID=$procId"
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Write-Host '完成。'
