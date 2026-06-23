# 一键启动：Cloudflare 隧道 + 服务，二维码自动指向公网地址
# 用法：在项目目录下右键“使用 PowerShell 运行”，或执行  ./start-public.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$cf = "$PSScriptRoot\tools\cloudflared.exe"
if (-not (Test-Path $cf)) {
  Write-Host "首次运行，正在下载 cloudflared..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force "$PSScriptRoot\tools" | Out-Null
  Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $cf
}

# 启动隧道，输出写入日志文件
$log = "$PSScriptRoot\tools\tunnel.log"
if (Test-Path $log) { Remove-Item $log -Force }
Write-Host "正在启动 Cloudflare 隧道..." -ForegroundColor Cyan
$tunnel = Start-Process -FilePath $cf `
  -ArgumentList "tunnel","--url","http://localhost:3000","--no-autoupdate" `
  -RedirectStandardError $log -RedirectStandardOutput "$PSScriptRoot\tools\tunnel.out" `
  -NoNewWindow -PassThru

# 等待并抓取公网网址
$url = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 800
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}
if (-not $url) { Write-Host "未能获取隧道地址，请查看 tools\tunnel.log" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Green
Write-Host " 公网地址： $url" -ForegroundColor Green
Write-Host " 二维码、表单链接都会用这个地址。别人扫码即可填写。" -ForegroundColor Green
Write-Host " 管理后台也可用这个地址访问，或继续用 http://localhost:3000" -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host " 关闭此窗口即停止服务与隧道。" -ForegroundColor DarkGray
Write-Host ""

$env:BASE_URL = $url
try {
  node server/index.js
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
}
