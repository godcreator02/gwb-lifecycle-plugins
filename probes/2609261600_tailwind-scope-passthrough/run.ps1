# 跑法：pwsh ./run.ps1   （装依赖、跑 run.mjs，输出写进 runs/01.txt）
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location $PSScriptRoot
pnpm install
New-Item -ItemType Directory -Force runs | Out-Null
"node $(node --version)，$(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-File -Encoding utf8 runs/01.txt
node run.mjs 2>&1 | Out-File -Encoding utf8 -Append runs/01.txt
Get-Content runs/01.txt
