$name = 'DSH QQ Bot Supervisor'
$t = Get-ScheduledTask -TaskName $name

Write-Host '=== 任务 ==='
Write-Host ("  名称   : " + $t.TaskName)
Write-Host ("  状态   : " + $t.State)
Write-Host ("  路径   : " + $t.TaskPath)

Write-Host ''
Write-Host '=== 触发器 ==='
foreach ($tr in $t.Triggers) {
  Write-Host ("  类型   : " + $tr.CimClass.CimClassName)
  Write-Host ("  启用   : " + $tr.Enabled)
  if ($tr.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') {
    Write-Host ("  用户   : " + $(if ($tr.UserId) { $tr.UserId } else { '(任意用户)' }))
    Write-Host ("  延迟   : " + $tr.Delay)
  }
}

Write-Host ''
Write-Host '=== 动作 ==='
foreach ($a in $t.Actions) {
  Write-Host ("  执行   : " + $a.Execute)
  Write-Host ("  参数   : " + $a.Arguments)
}

Write-Host ''
Write-Host '=== 运行身份 ==='
Write-Host ("  用户   : " + $t.Principal.UserId)
Write-Host ("  登录方式: " + $t.Principal.LogonType)
Write-Host ("  运行级别: " + $t.Principal.RunLevel)

Write-Host ''
Write-Host '=== 设置 ==='
Write-Host ("  超时限制: " + $(if ($t.Settings.ExecutionTimeLimit) { $t.Settings.ExecutionTimeLimit } else { '(无限制)' }))
Write-Host ("  多实例  : " + $t.Settings.MultipleInstances)

Write-Host ''
$info = Get-ScheduledTaskInfo -TaskName $name
Write-Host '=== 最近运行 ==='
Write-Host ("  上次运行: " + $info.LastRunTime)
Write-Host ("  上次结果: " + $info.LastTaskResult + "  (267009=正在运行, 0=成功)")
Write-Host ("  下次运行: " + $(if ($info.NextRunTime) { $info.NextRunTime } else { '(下次登录时)' }))
