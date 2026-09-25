# 跑法：pwsh ./run.ps1   （装依赖、跑 run.mjs，输出写进 results.txt）
# 块笔记那一段要读 gwb-block-note 仓里构建好的 gwb-bn-core/dist/client.js；那个文件不在就只跑语料对照
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location $PSScriptRoot
pnpm install
$env:BLOCK_NOTE_CLIENT = 'D:\unitfolders\evew5-gwbapps\gwb-block-note\plugins\gwb-bn-core\dist\client.js'
"node $(node --version)，$(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-File -Encoding utf8 results.txt
node run.mjs 2>&1 | Out-File -Encoding utf8 -Append results.txt
Get-Content results.txt
