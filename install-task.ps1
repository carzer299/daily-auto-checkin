# daily-auto-checkin 安装脚本：注册 Windows 计划任务，开机自动签到
# 用法: .\install-task.ps1 [-Time "09:30"] [-RunNow]
param(
    [string]$Time = "09:30",
    [switch]$RunNow
)

$ErrorActionPreference = 'Stop'

# 1) 检查 Node.js
try {
    $node = (Get-Command node -ErrorAction Stop).Source
    $version = & node -v
    if ($version -match 'v(\d+)\.' -and [int]$Matches[1] -lt 18) {
        Write-Host "[错误] Node.js 版本过低 ($version)，需要 >= 18: https://nodejs.org/" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Node.js $version ($node)"
} catch {
    Write-Host "[错误] 未找到 node，请先安装 Node.js 18 或更高版本: https://nodejs.org/" -ForegroundColor Red
    exit 1
}

# 2) 部署脚本到用户目录（稳定路径，与 git 仓库解耦）
$dest = Join-Path $env:USERPROFILE '.daily-checkin'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'daily-checkin.js') (Join-Path $dest 'daily-checkin.js') -Force
Write-Host "[OK] 脚本已部署到 $dest\daily-checkin.js"

# 2.5) 生成无窗口启动器：node.exe 是控制台程序，计划任务直接运行它时
#      每次触发都会在桌面弹出黑色命令行窗口；改由 wscript（GUI 程序，
#      本身无控制台）以隐藏窗口方式启动 node，触发时全程不弹任何窗口
$vbsPath = Join-Path $dest 'hidden-run.vbs'
$vbsContent = @'
' 后台隐藏运行签到脚本：wscript 无控制台窗口，node 以隐藏窗口执行，全程不弹窗
' 固定带 --once（单次执行后退出，适配计划任务）；附加参数原样追加给 daily-checkin.js
' 用法: wscript.exe hidden-run.vbs [附加参数...]（如 --dry-run）
Set sh = CreateObject("WScript.Shell")
extra = ""
For Each a In WScript.Arguments
    extra = extra & " """ & a & """"
Next
exitCode = sh.Run("""__NODE__"" ""__SCRIPT__"" ""--once""" & extra, 0, True)
WScript.Quit exitCode
'@
# 替换占位符为本机的 node 与脚本绝对路径；用 ANSI 编码保存以兼容含中文的用户目录
$vbsContent = $vbsContent.Replace('__NODE__', $node).Replace('__SCRIPT__', (Join-Path $dest 'daily-checkin.js'))
Set-Content -Path $vbsPath -Value $vbsContent -Encoding Default
Write-Host "[OK] 无窗口启动器已生成: $vbsPath"

# 3) 校验签到时间格式
if ($Time -notmatch '^\d{1,2}:\d{2}$') {
    Write-Host "[错误] 时间格式应为 HH:MM，当前为: $Time" -ForegroundColor Red
    exit 1
}

# 4) 注册计划任务：登录时 + 每日定时 双触发
#    通过无窗口启动器（wscript + hidden-run.vbs）运行，触发时桌面不再弹出黑色窗口
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" `
    -Argument "`"$dest\hidden-run.vbs`"" -WorkingDirectory $dest

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logonTrigger.Delay = 'PT30S'   # 登录后 30 秒再执行，等网络就绪

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $Time

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName 'DailyCheckin' `
    -Description "每日自动签到(后台无弹窗): 杜搭子(DuMate) / WorkBuddy / Trae Work CN (登录时与每天 $Time 触发, 幂等可重复执行)" `
    -Action $action -Trigger $logonTrigger, $dailyTrigger -Settings $settings -Force | Out-Null

Write-Host "[OK] 计划任务 DailyCheckin 已注册（无窗口后台运行）" -ForegroundColor Green
Write-Host "     - 每次登录后 30 秒自动签到"
Write-Host "     - 每天 $Time 自动签到"
Write-Host "     - 错过时间点(电脑关机)会在下次开机自动补签"

# 5) 立即执行一轮（可选）
if ($RunNow) {
    Write-Host ""
    Write-Host "立即执行一轮签到..." -ForegroundColor Cyan
    & $node "$dest\daily-checkin.js" --once
}

Write-Host ""
Write-Host "完成。签到日志: $dest\logs\  (问题记录: $dest\critical.log)"
