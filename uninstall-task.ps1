# daily-auto-checkin 卸载脚本：删除计划任务（可选：同时删除数据目录）
# 用法: .\uninstall-task.ps1 [-RemoveData]
param(
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

try {
    Unregister-ScheduledTask -TaskName 'DailyCheckin' -Confirm:$false -ErrorAction Stop
    Write-Host "[OK] 计划任务 DailyCheckin 已删除" -ForegroundColor Green
} catch {
    Write-Host "[跳过] 计划任务不存在或已删除" -ForegroundColor Yellow
}

if ($RemoveData) {
    $dest = Join-Path $env:USERPROFILE '.daily-checkin'
    if (Test-Path $dest) {
        Remove-Item $dest -Recurse -Force
        Write-Host "[OK] 数据目录已删除: $dest" -ForegroundColor Green
    }
} else {
    Write-Host "保留数据目录 $env:USERPROFILE\.daily-checkin (如需彻底清理: .\uninstall-task.ps1 -RemoveData)"
}
