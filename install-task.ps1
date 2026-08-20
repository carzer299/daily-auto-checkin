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

# 3) 校验签到时间格式
if ($Time -notmatch '^\d{1,2}:\d{2}$') {
    Write-Host "[错误] 时间格式应为 HH:MM，当前为: $Time" -ForegroundColor Red
    exit 1
}

# 4) 注册计划任务：登录时 + 每日定时 双触发
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$dest\daily-checkin.js`" --once" -WorkingDirectory $dest

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logonTrigger.Delay = 'PT30S'   # 登录后 30 秒再执行，等网络就绪

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $Time

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName 'DailyCheckin' `
    -Description "每日自动签到: 杜搭子(DuMate) / WorkBuddy / Trae Work CN (登录时与每天 $Time 触发, 幂等可重复执行)" `
    -Action $action -Trigger $logonTrigger, $dailyTrigger -Settings $settings -Force | Out-Null

Write-Host "[OK] 计划任务 DailyCheckin 已注册" -ForegroundColor Green
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
