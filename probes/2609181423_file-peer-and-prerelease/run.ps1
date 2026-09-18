# pnpm 的 peer 检查：file: 目录依赖当 peer 时满足不满足范围；开发版号（预发布段）满足不满足 ^
# 跑法：pwsh -File run.ps1 > results.txt
$ErrorActionPreference = 'Continue'
# 夹具摆在系统临时目录：摆在仓里的话 pnpm 往上找到仓根的 pnpm-workspace.yaml，测的就成了仓根那份配置
$root = "$env:TEMP\gwb-probes\file-peer-and-prerelease"
"pnpm $(pnpm -v)"

function Try-Case([string]$label, [string]$bbVersion, [string]$peerRange, [string]$form) {
  $dir = "$root\$label"
  foreach ($d in 'a', 'b', 'proj') { New-Item -ItemType Directory -Force "$dir\$d" | Out-Null }
  Set-Content "$dir\b\package.json" "{`"name`":`"bb`",`"version`":`"$bbVersion`"}"
  Set-Content "$dir\a\package.json" "{`"name`":`"aa`",`"version`":`"1.0.0`",`"peerDependencies`":{`"bb`":`"$peerRange`"}}"
  $bbSpec = 'file:../b'
  if ($form -eq 'tgz') {
    Push-Location "$dir\b"; pnpm pack --pack-destination .. 2>&1 | Out-Null; Pop-Location
    $bbSpec = "file:../bb-$bbVersion.tgz"
  }
  Set-Content "$dir\proj\package.json" "{`"name`":`"proj`",`"private`":true,`"dependencies`":{`"aa`":`"file:../a`",`"bb`":`"$bbSpec`"}}"
  Push-Location "$dir\proj"
  $out = & pnpm install --config.strict-peer-dependencies=true 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  $hit = ($out -split "`n" | Select-String -Pattern 'ERR_PNPM_PEER|Installed:' | ForEach-Object { $_.Line.Trim() }) -join ' | '
  "{0,-8} {1,-26} 对 {2,-8} exit={3}  {4}" -f $form, $bbVersion, $peerRange, $code, $hit
}

"--- 一、bb 以 file: 目录装（严格）"
Try-Case 'dir-100' '1.0.0' '^1.0.0' 'dir'
Try-Case 'dir-101dev' '1.0.1-dev.202609181300' '^1.0.0' 'dir'
"--- 二、bb 以 file: 打好的 tgz 装（严格）"
Try-Case 'tgz-100' '1.0.0' '^1.0.0' 'tgz'
Try-Case 'tgz-101dev' '1.0.1-dev.202609181300' '^1.0.0' 'tgz'
Try-Case 'tgz-091dev' '0.9.1-dev.202609181300' '^0.9.0' 'tgz'
Try-Case 'tgz-0100dev' '0.10.0-dev.1' '^0.9.0' 'tgz'
Try-Case 'tgz-100-vs-2' '1.0.0' '^2.0.0' 'tgz'

Remove-Item -Recurse -Force "$env:TEMP\gwb-probes\file-peer-and-prerelease"
