# pnpm 严格 peer 检查：命令行参数、环境变量、仓级 pnpm-workspace.yaml 各怎么写才生效；预发布号满足不满足 ^
# 跑法：pwsh -File run.ps1   （输出贴进 results.txt）
$ErrorActionPreference = 'Continue'
# 夹具摆在系统临时目录：摆在仓里的话 pnpm 往上找到仓根的 pnpm-workspace.yaml，测的就成了仓根那份配置
$root = "$env:TEMP\gwb-probes\pnpm-strict-peer"
"pnpm $(pnpm -v)"

function Reset-Fixture([string]$bbVersion, [string]$peerRange) {
  foreach ($d in 'a', 'b', 'proj') { New-Item -ItemType Directory -Force "$root\work\$d" | Out-Null }
  Set-Content "$root\work\b\package.json" "{`"name`":`"bb`",`"version`":`"$bbVersion`"}"
  Set-Content "$root\work\a\package.json" "{`"name`":`"aa`",`"version`":`"1.0.0`",`"peerDependencies`":{`"bb`":`"$peerRange`"}}"
  Set-Content "$root\work\proj\package.json" '{"name":"proj","private":true,"dependencies":{"aa":"file:../a","bb":"file:../b"}}'
}

function Try-Install([string]$label, [string[]]$pnpmArgs, [string]$yaml) {
  if (Test-Path "$root\work\proj\node_modules") { Remove-Item -Recurse -Force "$root\work\proj\node_modules" }
  if (Test-Path "$root\work\proj\pnpm-lock.yaml") { Remove-Item -Force "$root\work\proj\pnpm-lock.yaml" }
  if (Test-Path "$root\work\proj\pnpm-workspace.yaml") { Remove-Item -Force "$root\work\proj\pnpm-workspace.yaml" }
  if ($yaml -ne '') { Set-Content "$root\work\proj\pnpm-workspace.yaml" $yaml }
  Push-Location "$root\work\proj"
  $out = & pnpm install @pnpmArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  $hit = ($out -split "`n" | Select-String -Pattern 'ERR_PNPM_PEER|Issues with peer|camelCase' | ForEach-Object { $_.Line.Trim() }) -join ' | '
  "{0,-58} exit={1}  {2}" -f $label, $code, $hit
}

"--- 一、aa 要 bb ^2.0.0，装着 bb 1.0.0（真不匹配）"
Reset-Fixture '1.0.0' '^2.0.0'
Try-Install '默认（不带参数）' @() ''
Try-Install '--strict-peer-dependencies' @('--strict-peer-dependencies') ''
Try-Install '--strict-peer-dependencies=false' @('--strict-peer-dependencies=false') ''
Try-Install '--config.strict-peer-dependencies=true' @('--config.strict-peer-dependencies=true') ''
Try-Install 'yaml strictPeerDependencies: true' @() 'strictPeerDependencies: true'
Try-Install 'yaml strict-peer-dependencies: true（烤串写法）' @() 'strict-peer-dependencies: true'
Try-Install 'yaml true + 命令行 --strict-peer-dependencies=false' @('--strict-peer-dependencies=false') 'strictPeerDependencies: true'
Try-Install 'yaml true + peerDependencyRules.allowAny [bb]' @() "strictPeerDependencies: true`npeerDependencyRules:`n  allowAny:`n    - bb"
Try-Install "yaml true + peerDependencyRules.allowedVersions bb: '1'" @() "strictPeerDependencies: true`npeerDependencyRules:`n  allowedVersions:`n    bb: '1'"
$env:pnpm_config_strict_peer_dependencies = 'true'
Try-Install '环境变量 pnpm_config_strict_peer_dependencies=true' @() ''
Try-Install '环境变量 true + 命令行 --strict-peer-dependencies=false' @('--strict-peer-dependencies=false') ''
$env:pnpm_config_strict_peer_dependencies = $null

"--- 二、aa 要 bb ^1.0.0，装着开发版 bb 1.0.1-dev.202609181300"
Reset-Fixture '1.0.1-dev.202609181300' '^1.0.0'
Try-Install '默认' @() ''
Try-Install '--strict-peer-dependencies' @('--strict-peer-dependencies') ''

if (Test-Path "$env:TEMP\gwb-probes\pnpm-strict-peer") { Remove-Item -Recurse -Force "$env:TEMP\gwb-probes\pnpm-strict-peer" }
