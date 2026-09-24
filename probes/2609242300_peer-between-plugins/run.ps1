# 插件 A 把另一个插件 B 写进 peerDependencies、B 同时也是 home 的直接依赖时，pnpm 怎么装、升级 B 时 A 搬不搬家
# 跑法：pwsh ./run.ps1   （重建 work/ 与 vendor/，结果写进 runs/*.txt）
# 每个场景跑两遍：file 系列用 file: 指向 tgz；registry 系列用本目录 registry.mjs 起的本机只读源、按版本号装，
# 后者才和真 home（从团队源按版本号装）一致——file: 装的包 pnpm 判不满足任何 peer 范围（见 probes/2609181423_file-peer-and-prerelease）
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$pnpm = 'C:\Users\godamericatb14\AppData\Roaming\npm\node_modules\pnpm\pnpm.exe'
$probe = $PSScriptRoot
$work = Join-Path $probe 'work'
$vendor = Join-Path $probe 'vendor'
$runs = Join-Path $probe 'runs'
# 每个 home 自带 pnpm-workspace.yaml：pnpm 往上找 workspace 根时在这里停下，不会找到 gwb-devkit 仓根那份；
# storeDir / cacheDir 指到 work/ 下，不往用户的全局存储与元数据缓存里加东西
$store = Join-Path $work 'store'
$cache = Join-Path $work 'cache'

foreach ($dir in $work, $vendor) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
foreach ($dir in $work, $vendor, $runs) { New-Item -ItemType Directory -Force $dir | Out-Null }
Get-ChildItem $runs -Filter '*.txt' | Remove-Item

function Write-Run([string]$file, [string]$text) {
  Add-Content -Path (Join-Path $runs $file) -Value $text -Encoding utf8
}

function Invoke-Pnpm([string]$file, [string]$cwd, [string[]]$pnpmArgs) {
  Write-Run $file ("`n### cwd=$(Split-Path -Leaf $cwd)`n> pnpm " + ($pnpmArgs -join ' '))
  Push-Location $cwd
  $out = & $pnpm @pnpmArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  Write-Run $file ($out.TrimEnd() + "`nexit=$code")
}

function Write-Inspect([string]$file, [string]$homeDir, [string]$label) {
  Write-Run $file "`n--- inspect: $label"
  Write-Run $file ((& node (Join-Path $probe 'inspect.cjs') $homeDir 2>&1 | Out-String).TrimEnd())
}

function New-FixturePackage([string]$name, [string]$version, [hashtable]$peers) {
  $dir = Join-Path $work "src\$name-$version"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $manifest = [ordered]@{ name = $name; version = $version; main = 'index.js'; files = @('index.js') }
  if ($peers) { $manifest.peerDependencies = $peers }
  $manifest | ConvertTo-Json | Set-Content (Join-Path $dir 'package.json') -Encoding utf8
  "module.exports = { name: '$name', version: '$version' };" | Set-Content (Join-Path $dir 'index.js') -Encoding utf8
  Set-Content (Join-Path $dir 'pnpm-workspace.yaml') "storeDir: '$store'`ncacheDir: '$cache'" -Encoding utf8
  Push-Location $dir
  $out = & $pnpm pack --pack-destination $vendor 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  Write-Run '01-pack.txt' "`n> pnpm pack --pack-destination vendor   (cwd=src/$name-$version)`n$($out.TrimEnd())`nexit=$code"
  if ($code -ne 0) { throw "pnpm pack $name@$version 失败，exit=$code" }
}

# 场景里按 (包名, 版本) 写依赖；file 系列翻成 file: 指向 tgz，registry 系列就写准确版本号
function Get-DependencySpec([string]$mode, [string]$name, [string]$version) {
  if ($mode -eq 'file') { return "file:../../../vendor/$name-$version.tgz" }
  return $version
}

function New-TestHome([string]$mode, [string]$name, [string[][]]$dependencies, [string]$extraYaml) {
  $homeDir = Join-Path $work "homes\$mode-$name"
  New-Item -ItemType Directory -Force $homeDir | Out-Null
  $deps = [ordered]@{}
  foreach ($dep in $dependencies) { $deps[$dep[0]] = Get-DependencySpec $mode $dep[0] $dep[1] }
  [ordered]@{ name = "home-$name"; private = $true; dependencies = $deps } | ConvertTo-Json | Set-Content (Join-Path $homeDir 'package.json') -Encoding utf8
  Set-Content (Join-Path $homeDir 'pnpm-workspace.yaml') ("storeDir: '$store'`ncacheDir: '$cache'`n" + $extraYaml) -Encoding utf8
  if ($mode -eq 'registry') { Set-Content (Join-Path $homeDir '.npmrc') "registry=$registryUrl/" -Encoding utf8 }
  return $homeDir
}

function Get-RealPackageDir([string]$homeDir, [string]$name) {
  (& node -e "console.log(require('fs').realpathSync(process.argv[1]))" (Join-Path $homeDir "node_modules\$name")).Trim()
}

function Set-ManifestDependency([string]$homeDir, [string]$name, [string]$spec) {
  $manifestPath = Join-Path $homeDir 'package.json'
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $manifest.dependencies.$name = $spec
  $manifest | ConvertTo-Json | Set-Content $manifestPath -Encoding utf8
}

function Write-PathComparison([string]$file, [string]$label, [string]$before, [string]$after) {
  Write-Run $file "$label 真实路径 前：$(Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $before)))"
  Write-Run $file "$label 真实路径 后：$(Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $after)))"
  Write-Run $file "$label 路径变了：$($before -ne $after)；旧目录还在磁盘上：$(Test-Path $before)"
}

# 场景一 + 场景二：B 1.0.0 + A + C 装好，再把 B 升到 1.1.0（$upgradeHow = edit 改清单写死再 install / add 用 pnpm add）
function Test-UpgradeB([string]$mode, [string]$file, [string]$homeName, [string]$upgradeHow, [string]$extraYaml) {
  $h = New-TestHome $mode $homeName @(@('probe-a', '1.0.0'), @('probe-b', '1.0.0'), @('probe-c', '1.0.0')) $extraYaml
  if ($extraYaml) { Write-Run $file "home 的 pnpm-workspace.yaml 另加：$extraYaml" }
  Invoke-Pnpm $file $h @('install')
  Write-Inspect $file $h '场景一：B 1.0.0 + A + C 装完'
  Invoke-Pnpm $file $h @('peers', 'check')
  $aBefore = Get-RealPackageDir $h 'probe-a'
  $bBefore = Get-RealPackageDir $h 'probe-b'
  $cBefore = Get-RealPackageDir $h 'probe-c'
  $b11 = Get-DependencySpec $mode 'probe-b' '1.1.0'
  if ($upgradeHow -eq 'edit') {
    Set-ManifestDependency $h 'probe-b' $b11
    Write-Run $file "`n改 package.json：probe-b -> $b11"
    Invoke-Pnpm $file $h @('install')
  } else {
    Invoke-Pnpm $file $h @('add', "probe-b@$b11")
  }
  Write-Inspect $file $h '场景二：B 升到 1.1.0 之后'
  Write-Run $file ''
  Write-PathComparison $file 'A' $aBefore (Get-RealPackageDir $h 'probe-a')
  Write-PathComparison $file 'B' $bBefore (Get-RealPackageDir $h 'probe-b')
  Write-PathComparison $file 'C' $cBefore (Get-RealPackageDir $h 'probe-c')
}

# 场景三：home 只有 A，没有 B
function Test-MissingPeer([string]$mode, [string]$file) {
  $variants = @(
    @{ label = '3a 默认设置'; name = 's3-default'; yaml = ''; args = @('install'); env = $null },
    @{ label = '3b home 的 pnpm-workspace.yaml 写 autoInstallPeers: false'; name = 's3-yaml-off'; yaml = 'autoInstallPeers: false'; args = @('install'); env = $null },
    @{ label = '3c 命令行 --config.auto-install-peers=false'; name = 's3-cli-config-off'; yaml = ''; args = @('install', '--config.auto-install-peers=false'); env = $null },
    @{ label = '3d 命令行 --auto-install-peers=false'; name = 's3-cli-off'; yaml = ''; args = @('install', '--auto-install-peers=false'); env = $null },
    @{ label = '3e 环境变量 pnpm_config_auto_install_peers=false'; name = 's3-env-off'; yaml = ''; args = @('install'); env = 'false' },
    @{ label = '3f 命令行 --config.autoInstallPeers=false'; name = 's3-cli-camel-off'; yaml = ''; args = @('install', '--config.autoInstallPeers=false'); env = $null }
  )
  foreach ($variant in $variants) {
    Write-Run $file "`n===== $($variant.label)"
    $h = New-TestHome $mode $variant.name @(, @('probe-a', '1.0.0')) $variant.yaml
    $env:pnpm_config_auto_install_peers = $variant.env
    Invoke-Pnpm $file $h $variant.args
    $env:pnpm_config_auto_install_peers = $null
    Write-Inspect $file $h "$($variant.label) 装完"
    Write-Run $file "装完的 package.json：$((Get-Content (Join-Path $h 'package.json') -Raw).Trim() -replace '\s+', ' ')"
    Invoke-Pnpm $file $h @('peers', 'check')
  }
}

# 场景四：home 里 B 是 2.0.0，A 要 ^1.0.0
function Test-UnmetPeerRange([string]$mode, [string]$file) {
  $variants = @(
    @{ label = '4a 默认设置'; name = 's4-default'; yaml = '' },
    @{ label = '4b autoInstallPeers: false'; name = 's4-auto-off'; yaml = 'autoInstallPeers: false' },
    @{ label = '4c strictPeerDependencies: true'; name = 's4-strict'; yaml = 'strictPeerDependencies: true' }
  )
  foreach ($variant in $variants) {
    Write-Run $file "`n===== $($variant.label)：B 2.0.0 + A（peer ^1.0.0）"
    $h = New-TestHome $mode $variant.name @(@('probe-a', '1.0.0'), @('probe-b', '2.0.0')) $variant.yaml
    Invoke-Pnpm $file $h @('install')
    Write-Inspect $file $h "$($variant.label) 装完"
    Invoke-Pnpm $file $h @('peers', 'check')
  }
}

# ---------- 00 环境与 workspace 隔离核对
Write-Run '00-env.txt' "date=$(Get-Date -Format 'yyyy-MM-dd HH:mm')  pnpm=$(& $pnpm -v)  node=$(node -v)  os=$([Environment]::OSVersion.VersionString)"
Write-Run '00-env.txt' "gwb-devkit commit: $(git -C $probe log -1 --format='%h %s')"
$repoRoot = (git -C $probe rev-parse --show-toplevel).Trim()
Write-Run '00-env.txt' "`n仓根 pnpm-workspace.yaml：`n$((Get-Content (Join-Path $repoRoot 'pnpm-workspace.yaml')) -join "`n")"
Write-Run '00-env.txt' "`n仓根 workspace 的成员（不含 probes/ 才对）："
Invoke-Pnpm '00-env.txt' $repoRoot @('ls', '-r', '--depth', '-1')

# ---------- 01 造包打包
New-FixturePackage 'probe-b' '1.0.0' $null
New-FixturePackage 'probe-b' '1.1.0' $null
New-FixturePackage 'probe-b' '2.0.0' $null
New-FixturePackage 'probe-a' '1.0.0' @{ 'probe-b' = '^1.0.0' }
New-FixturePackage 'probe-c' '1.0.0' $null
Write-Run '01-pack.txt' "`nvendor/：`n$((Get-ChildItem $vendor | ForEach-Object Name) -join "`n")"

# ---------- 本机只读源
$registryUrlFile = Join-Path $work 'registry-url.txt'
$registry = Start-Process node -ArgumentList @((Join-Path $probe 'registry.mjs'), $vendor, (Join-Path $work 'src'), $registryUrlFile) -PassThru -NoNewWindow
try {
  $deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Path $registryUrlFile)) {
    if ((Get-Date) -gt $deadline) { throw '本机只读源 10 秒内没起来' }
    Start-Sleep -Milliseconds 100
  }
  $registryUrl = (Get-Content $registryUrlFile -Raw).Trim()
  Write-Run '01-pack.txt' "`n本机只读源：$registryUrl（registry 系列的 home 在 .npmrc 里写 registry=$registryUrl/）"

  foreach ($mode in 'file', 'registry') {
    $n = if ($mode -eq 'file') { 1 } else { 2 }
    Test-UpgradeB $mode "${n}1-$mode-upgrade-b-edit-manifest.txt" 's2-edit' 'edit' ''
    Test-UpgradeB $mode "${n}2-$mode-upgrade-b-pnpm-add.txt" 's2-add' 'add' ''
    Test-UpgradeB $mode "${n}3-$mode-upgrade-b-cache-max-age-0.txt" 's2-maxage0' 'edit' 'modulesCacheMaxAge: 0'
    Test-MissingPeer $mode "${n}4-$mode-missing-peer.txt"
    Test-UnmetPeerRange $mode "${n}5-$mode-peer-range-unmet.txt"
  }
} finally {
  Stop-Process -Id $registry.Id
}

"完成，结果在 $runs"
