# 在一台「干净的机器」上（USERPROFILE、LOCALAPPDATA 都指向新建的临时目录）运行 pnpm config set @scope:registry，
# 看它写进了哪个文件、~/.npmrc 有没有生成、pnpm config list --json 与 config get 能不能读回。
# 运行：pwsh -File run.ps1（要本机装着 %APPDATA%\npm\node_modules\pnpm\pnpm.exe，版本写进输出）
$ErrorActionPreference = 'Stop'
$pnpm = "$env:APPDATA\npm\node_modules\pnpm\pnpm.exe"
$probeHome = Join-Path ([IO.Path]::GetTempPath()) "pnpm-config-set-probe-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory $probeHome | Out-Null
$env:LOCALAPPDATA = $probeHome
$env:USERPROFILE = $probeHome
$env:HOME = $probeHome
Set-Location $probeHome
try {
  "pnpm $(& $pnpm --version)"
  & $pnpm config set '@probe:registry' 'https://probe.example/npm/' | Out-Null
  "globalconfig = $(& $pnpm config get globalconfig)"
  "~/.npmrc 存在 = $(Test-Path (Join-Path $probeHome '.npmrc'))"
  "写出的文件 = $((Get-ChildItem $probeHome -Recurse -File | ForEach-Object { $_.FullName.Replace($probeHome, '') }) -join ', ')"
  $list = & $pnpm config list --json | ConvertFrom-Json
  "config list --json 里 @probe:registry = $($list.'@probe:registry')"
  "config get @probe:registry = $(& $pnpm config get '@probe:registry')"
  "config get 没配的凭据键 = $(& $pnpm config get '//nope.example/:_authToken')（退出码 $LASTEXITCODE）"
} finally {
  Set-Location ([IO.Path]::GetTempPath())
  Remove-Item -Recurse -Force $probeHome
}
