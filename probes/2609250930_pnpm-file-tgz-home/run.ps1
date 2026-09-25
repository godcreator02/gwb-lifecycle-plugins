# devkit.dev 打算改成「pnpm pack 出 tgz、存进 home、pnpm add <包>@file:<tgz 绝对路径>」装开发版；这里实测 pnpm 12 在 home 里对 file: tgz 的七个行为
# 跑法：pwsh ./run.ps1   （重建 %TEMP%\gwb-probe-2609250930，结果写进 runs/*.txt）
# home 放在 %TEMP% 下、不带 pnpm-workspace.yaml，和真 home 的布局一样；存储与元数据缓存经环境变量指到临时目录，不动用户的全局存储。
# 从源装的包由本目录 registry.mjs 在本机起的只读源提供，每个 home 的 .npmrc 指向它，不访问任何网络上的源
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$probe = $PSScriptRoot
$runs = Join-Path $probe 'runs'

# 和插件管理找 pnpm 的规则一样：两个固定位置，第一个存在的作数
$pnpm = @((Join-Path $env:LOCALAPPDATA 'pnpm\bin\pnpm.exe'), (Join-Path $env:APPDATA 'npm\node_modules\pnpm\pnpm.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pnpm) { throw '两个固定位置都没有 pnpm.exe' }

# %TEMP% 可能是 8.3 短路径（GODAME~1）；真 home 在 %APPDATA% 下是长路径，这里也展开成长路径，免得 file: 路径的写法跟真实情况不一样
$tempLong = (& node -e "console.log(require('fs').realpathSync.native(process.argv[1]))" $env:TEMP).Trim()
$work = Join-Path $tempLong 'gwb-probe-2609250930'
$src = Join-Path $work 'src'
$staging = Join-Path $work 'staging'
$vendor = Join-Path $work 'vendor'
$registryVendor = Join-Path $work 'registry-vendor'
$homes = Join-Path $work 'homes'

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
foreach ($dir in $work, $src, $staging, $vendor, $registryVendor, $homes, $runs) { New-Item -ItemType Directory -Force $dir | Out-Null }
Get-ChildItem $runs -Filter '*.txt' | Remove-Item

# 插件管理、devkit 在 home 里启动 pnpm 时带的环境变量，加上把存储与缓存指到 work 下
$probeEnv = @{
  pnpm_config_auto_install_peers = 'false'
  pnpm_config_store_dir = (Join-Path $work 'store')
  pnpm_config_cache_dir = (Join-Path $work 'cache')
}
$savedEnv = @{}
foreach ($key in $probeEnv.Keys) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $probeEnv[$key]) }

$script:packCount = 0

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
  return $code
}

function Write-Inspect([string]$file, [string]$homeDir, [string]$label, [string[]]$pkgs) {
  Write-Run $file "`n--- inspect：$label"
  Write-Run $file ((& node (Join-Path $probe 'inspect.cjs') $homeDir @pkgs 2>&1 | Out-String).TrimEnd())
}

function Write-FileDump([string]$file, [string]$homeDir, [string]$name, [string]$label) {
  $path = Join-Path $homeDir $name
  Write-Run $file "`n--- $name（$label）"
  if (Test-Path $path) { Write-Run $file (Get-Content $path -Raw).TrimEnd() } else { Write-Run $file '（文件不存在）' }
}

# 造一个假插件包并 pnpm pack，tgz 移到 $destPath（已有同名文件就覆盖）。每次都用新的源目录，同名同版本也互不影响
function New-Tgz([string]$name, [string]$version, [string]$marker, [hashtable]$peers, [string]$destPath) {
  $script:packCount++
  $dir = Join-Path $src ("{0:d2}-{1}-{2}" -f $script:packCount, ($name -replace '[@/]', ''), $version)
  New-Item -ItemType Directory -Force $dir | Out-Null
  $manifest = [ordered]@{ name = $name; version = $version; main = 'index.js'; files = @('index.js'); keywords = @('gwb-plugin') }
  if ($peers) { $manifest.peerDependencies = $peers }
  $manifest | ConvertTo-Json | Set-Content (Join-Path $dir 'package.json') -Encoding utf8
  "module.exports = { name: '$name', version: '$version', marker: '$marker' };" | Set-Content (Join-Path $dir 'index.js') -Encoding utf8
  $packOut = Join-Path $staging "$($script:packCount)"
  New-Item -ItemType Directory -Force $packOut | Out-Null
  Push-Location $dir
  $out = & $pnpm pack --pack-destination $packOut 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "pnpm pack $name@$version 失败，exit=$code`n$out" }
  $produced = @(Get-ChildItem $packOut -Filter '*.tgz')
  if ($produced.Count -ne 1) { throw "pnpm pack $name@$version 之后 $packOut 里有 $($produced.Count) 个 tgz" }
  New-Item -ItemType Directory -Force (Split-Path -Parent $destPath) | Out-Null
  Move-Item $produced[0].FullName $destPath -Force
  Write-Run '01-pack.txt' "$name@$version marker=$marker  pnpm pack 产出 $($produced[0].Name) → $destPath  sha256=$((Get-FileHash $destPath -Algorithm SHA256).Hash.Substring(0, 16))"
  return [pscustomobject]@{ path = $destPath; manifest = $manifest }
}

# 新 home：写清单与 .npmrc，清单里有依赖就先 pnpm install（输出记进 $file）
function New-TestHome([string]$file, [string]$name, [System.Collections.Specialized.OrderedDictionary]$deps) {
  $homeDir = Join-Path $homes $name
  New-Item -ItemType Directory -Force $homeDir | Out-Null
  [ordered]@{ name = 'gwb-home'; private = $true; dependencies = $deps } | ConvertTo-Json | Set-Content (Join-Path $homeDir 'package.json') -Encoding utf8
  Set-Content (Join-Path $homeDir '.npmrc') "registry=$registryUrl/" -Encoding utf8
  Write-Run $file "`n===== home $name"
  if ($deps.Count -gt 0) {
    $code = Invoke-Pnpm $file $homeDir @('install')
    if ($code -ne 0) { throw "新 home $name 的首次 pnpm install 失败，exit=$code" }
  }
  return $homeDir
}

function Get-DevTgzPath([string]$homeDir, [string]$fileName) { Join-Path $homeDir "dev-packs\$fileName" }

# node_modules 里没有这个包时返回空串
function Get-RealPackageDir([string]$homeDir, [string]$pkg) {
  $link = Join-Path $homeDir "node_modules\$pkg"
  if (-not (Test-Path $link)) { return '' }
  (& node -e "console.log(require('fs').realpathSync(process.argv[1]))" $link).Trim()
}

function Write-PathComparison([string]$file, [string]$label, [string]$before, [string]$after) {
  $virtual = { param($p) if (-not $p) { '（node_modules 里没有）' } else { ($p -split '\\node_modules\\\.pnpm\\')[1].Split('\')[0] } }
  Write-Run $file "$label 真实目录 前：$(& $virtual $before)"
  Write-Run $file "$label 真实目录 后：$(& $virtual $after)"
  Write-Run $file "$label 真实目录变了：$($before -ne $after)；旧目录还在磁盘上：$(if ($before) { Test-Path $before } else { '—' })"
}

try {
  # ---------- 00 环境
  Write-Run '00-env.txt' "date=$(Get-Date -Format 'yyyy-MM-dd HH:mm')  pnpm=$(& $pnpm -v)（$pnpm）  node=$(node -v)  os=$([Environment]::OSVersion.VersionString)"
  Write-Run '00-env.txt' "gwb-devkit commit: $(git -C $probe log -1 --format='%h %s')"
  Write-Run '00-env.txt' "work=$work"
  Write-Run '00-env.txt' "环境变量：$(($probeEnv.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '  ')"

  # ---------- 本机只读源上的包：@probe/a 0.1.0 / 0.2.0（开发版装之前 home 里从源装的那个）、@probe/r 0.1.0 / 0.2.0（别的插件，outdated 用）、
  #            @probe/rb 0.1.0（从源装、peer 写 @probe/a 的插件）
  $registryEntries = @()
  foreach ($spec in @(@('@probe/a', '0.1.0', $null), @('@probe/a', '0.2.0', $null), @('@probe/r', '0.1.0', $null), @('@probe/r', '0.2.0', $null), @('@probe/rb', '0.1.0', @{ '@probe/a' = '^0.1.0' }))) {
    $tgz = New-Tgz $spec[0] $spec[1] "registry-$($spec[1])" $spec[2] (Join-Path $registryVendor "$(($spec[0] -replace '@', '') -replace '/', '-')-$($spec[1]).tgz")
    $registryEntries += [ordered]@{ name = $spec[0]; version = $spec[1]; tarball = $tgz.path; manifest = $tgz.manifest }
  }
  $registryIndex = Join-Path $work 'registry-index.json'
  ConvertTo-Json -InputObject $registryEntries -Depth 5 | Set-Content $registryIndex -Encoding utf8
  $registryUrlFile = Join-Path $work 'registry-url.txt'
  $registry = Start-Process node -ArgumentList @((Join-Path $probe 'registry.mjs'), $registryIndex, $registryUrlFile) -PassThru -NoNewWindow
  try {
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path $registryUrlFile)) {
      if ((Get-Date) -gt $deadline) { throw '本机只读源 10 秒内没起来' }
      Start-Sleep -Milliseconds 100
    }
    $registryUrl = (Get-Content $registryUrlFile -Raw).Trim()
    Write-Run '00-env.txt' "本机只读源：$registryUrl（每个 home 的 .npmrc 写 registry=$registryUrl/）；源上有：$(($registryEntries | ForEach-Object { "$($_.name)@$($_.version)" }) -join ', ')"

    $pA = @{ '@probe/a' = '^0.1.0' }

    # ---------- 01 file: tgz 写进清单与锁文件的样子
    $f = '11-q1-spec-and-lock.txt'
    foreach ($variant in @(
        @{ name = 'q1-tgz-in-home'; label = '1a tgz 在 home 的 dev-packs 下，反斜杠绝对路径'; inHome = $true; slash = $false },
        @{ name = 'q1-tgz-outside-home'; label = '1b tgz 在 home 之外，反斜杠绝对路径'; inHome = $false; slash = $false },
        @{ name = 'q1-tgz-in-home-slash'; label = '1c tgz 在 home 的 dev-packs 下，正斜杠绝对路径'; inHome = $true; slash = $true },
        @{ name = 'q1-tgz-in-home-relative'; label = '1d tgz 在 home 的 dev-packs 下，给相对 home 的路径 ./dev-packs/…'; inHome = $true; relative = $true })) {
      Write-Run $f "`n##### $($variant.label)"
      $h = New-TestHome $f $variant.name ([ordered]@{ '@probe/r' = '^0.1.0' })
      $dest = if ($variant.inHome) { Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz' } else { Join-Path $vendor "$($variant.name)\probe-a-0.1.1-dev.1.tgz" }
      $tgz = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null $dest).path
      if ($variant.slash) { $tgz = $tgz -replace '\\', '/' }
      if ($variant.relative) { $tgz = './dev-packs/probe-a-0.1.1-dev.1.tgz' }
      $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$tgz")
      Write-FileDump $f $h 'package.json' 'add 之后'
      Write-FileDump $f $h 'pnpm-lock.yaml' 'add 之后'
      Write-Inspect $f $h 'add 之后' @('@probe/a', '@probe/r')
    }

    # ---------- 02 换 tgz 之后真实目录变不变
    $f = '21-q2-version-changes.txt'
    Write-Run $f '##### 2a 版本号不同：tgz1 = 0.1.1-dev.1（marker one），tgz2 = 0.1.1-dev.2（marker two），文件名各不相同'
    $h = New-TestHome $f 'q2-version-changes' ([ordered]@{ '@probe/r' = '^0.1.0' })
    $t1 = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
    $t2 = (New-Tgz '@probe/a' '0.1.1-dev.2' 'two' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.2.tgz')).path
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$t1")
    Write-Inspect $f $h '装 tgz1 之后' @('@probe/a')
    $before = Get-RealPackageDir $h '@probe/a'
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$t2")
    Write-Inspect $f $h '装 tgz2 之后' @('@probe/a')
    Write-FileDump $f $h 'package.json' '装 tgz2 之后'
    Write-Run $f ''
    Write-PathComparison $f '@probe/a' $before (Get-RealPackageDir $h '@probe/a')
    Write-Run $f "`n##### 2a 续：清单已换成 tgz2，删掉不再被引用的 tgz1，再 pnpm add 另一个包"
    Remove-Item $t1
    Write-Run $f "（已删 $t1）"
    $tc = (New-Tgz '@probe/c' '0.1.0' 'c' $null (Join-Path $vendor 'q2\probe-c-0.1.0.tgz')).path
    $null = Invoke-Pnpm $f $h @('add', "@probe/c@file:$tc")
    Write-Inspect $f $h '删掉 tgz1、add c 之后' @('@probe/a', '@probe/c')

    $f = '22-q2-same-version-other-file.txt'
    Write-Run $f '##### 2b 版本号相同（0.1.1-dev.3）、内容不同（marker three-x / three-y），两个 tgz 放在不同路径'
    $h = New-TestHome $f 'q2-same-version-other-file' ([ordered]@{ '@probe/r' = '^0.1.0' })
    $tx = (New-Tgz '@probe/a' '0.1.1-dev.3' 'three-x' $null (Get-DevTgzPath $h 'x\probe-a-0.1.1-dev.3.tgz')).path
    $ty = (New-Tgz '@probe/a' '0.1.1-dev.3' 'three-y' $null (Get-DevTgzPath $h 'y\probe-a-0.1.1-dev.3.tgz')).path
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$tx")
    Write-Inspect $f $h '装 x 之后' @('@probe/a')
    $before = Get-RealPackageDir $h '@probe/a'
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$ty")
    Write-Inspect $f $h '装 y 之后' @('@probe/a')
    Write-Run $f ''
    Write-PathComparison $f '@probe/a' $before (Get-RealPackageDir $h '@probe/a')

    $f = '23-q2-same-version-same-file.txt'
    Write-Run $f '##### 2c 版本号相同（0.1.1-dev.4）、内容不同（marker four-old / four-new），新 tgz 覆盖写到同一个路径'
    $h = New-TestHome $f 'q2-same-version-same-file' ([ordered]@{ '@probe/r' = '^0.1.0' })
    $tp = Get-DevTgzPath $h 'probe-a-0.1.1-dev.4.tgz'
    $null = New-Tgz '@probe/a' '0.1.1-dev.4' 'four-old' $null $tp
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$tp")
    Write-Inspect $f $h '装旧 tgz 之后' @('@probe/a')
    $before = Get-RealPackageDir $h '@probe/a'
    $null = New-Tgz '@probe/a' '0.1.1-dev.4' 'four-new' $null $tp
    Write-Run $f "`n（同一路径的 tgz 已换成 marker four-new 的内容）"
    foreach ($step in @(@('add', "@probe/a@file:$tp"), @('install'), @('install', '--force'))) {
      $null = Invoke-Pnpm $f $h $step
      Write-Inspect $f $h "pnpm $($step -join ' ') 之后" @('@probe/a')
      Write-PathComparison $f '@probe/a（与装旧 tgz 时比）' $before (Get-RealPackageDir $h '@probe/a')
    }

    # ---------- 03 peer 写了 a 的插件，a 换 tgz 时真实目录变不变
    $f = '31-q3-dependent-realpath.txt'
    Write-Run $f '##### b = @probe/b 0.1.0，file: tgz 装（peer @probe/a ^0.1.0）；rb = @probe/rb 0.1.0，从本机只读源按版本号装（peer 同样写 @probe/a ^0.1.0）'
    $h = New-TestHome $f 'q3-dependent' ([ordered]@{ '@probe/r' = '^0.1.0' })
    $t1 = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
    $t2 = (New-Tgz '@probe/a' '0.1.1-dev.2' 'two' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.2.tgz')).path
    $t2b = (New-Tgz '@probe/a' '0.1.1-dev.2' 'two-other-file' $null (Get-DevTgzPath $h 'other\probe-a-0.1.1-dev.2.tgz')).path
    $tb = (New-Tgz '@probe/b' '0.1.0' 'b' $pA (Get-DevTgzPath $h 'probe-b-0.1.0.tgz')).path
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$t1")
    $null = Invoke-Pnpm $f $h @('add', "@probe/b@file:$tb")
    $null = Invoke-Pnpm $f $h @('add', '@probe/rb@0.1.0')
    $pkgs = @('@probe/a', '@probe/b', '@probe/rb')
    Write-Inspect $f $h 'a=tgz1、b、rb 装完' $pkgs
    $null = Invoke-Pnpm $f $h @('peers', 'check')
    $before = @{}; foreach ($p in $pkgs) { $before[$p] = Get-RealPackageDir $h $p }
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$t2")
    Write-Inspect $f $h 'a 换成 tgz2（0.1.1-dev.2）之后' $pkgs
    Write-Run $f ''
    $mid = @{}; foreach ($p in $pkgs) { $mid[$p] = Get-RealPackageDir $h $p; Write-PathComparison $f $p $before[$p] $mid[$p] }
    Write-Run $f "`n##### 再把 a 换成同版本号（0.1.1-dev.2）、放在另一个路径的 tgz"
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$t2b")
    Write-Inspect $f $h 'a 换成另一路径的同版本 tgz 之后' $pkgs
    Write-Run $f ''
    foreach ($p in $pkgs) { Write-PathComparison $f $p $mid[$p] (Get-RealPackageDir $h $p) }
    Write-FileDump $f $h 'pnpm-lock.yaml' '全部做完之后'

    # ---------- 04 装完删掉 tgz，之后在这个 home 里再运行 pnpm
    $f = '41-q4-tgz-deleted.txt'
    $tc = (New-Tgz '@probe/c' '0.1.0' 'c' $null (Join-Path $vendor 'probe-c-0.1.0.tgz')).path
    $ops = @(
      @{ name = 'add-c'; args = @('add', "@probe/c@file:$tc") },
      @{ name = 'install'; args = @('install') },
      @{ name = 'add-r'; args = @('add', '@probe/r@0.2.0') },
      @{ name = 'frozen'; args = @('install', '--frozen-lockfile') },
      @{ name = 'no-modules'; args = @('install'); dropModules = $true }
    )
    foreach ($deleteTgz in $false, $true) {
      foreach ($op in $ops) {
        $label = if ($deleteTgz) { '删掉 tgz' } else { '不删（对照）' }
        Write-Run $f "`n##### $label；之后运行 pnpm $($op.args -join ' ')$(if ($op.dropModules) { '（先删掉整个 node_modules）' })"
        $h = New-TestHome $f "q4-$(if ($deleteTgz) { 'del' } else { 'keep' })-$($op.name)" ([ordered]@{ '@probe/r' = '^0.1.0' })
        $ta = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
        $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$ta")
        if ($deleteTgz) { Remove-Item $ta; Write-Run $f "（已删 $ta）" }
        if ($op.dropModules) { Remove-Item -Recurse -Force (Join-Path $h 'node_modules'); Write-Run $f '（已删 node_modules）' }
        $null = Invoke-Pnpm $f $h $op.args
        Write-Inspect $f $h "$label、pnpm $($op.args -join ' ') 之后" @('@probe/a', '@probe/c', '@probe/r')
      }
    }

    $f = '42-q4-tgz-deleted-peer-moves.txt'
    Write-Run $f '##### b 用 file: tgz 装、peer 写 @probe/a；a 从源装 0.1.0。删掉 b 的 tgz 后把 a 升到 0.2.0，b 要换目录，看 pnpm 还要不要 b 的 tgz'
    foreach ($deleteTgz in $false, $true) {
      $label = if ($deleteTgz) { '删掉 b 的 tgz' } else { '不删（对照）' }
      Write-Run $f "`n##### $label"
      $h = New-TestHome $f "q4-peer-$(if ($deleteTgz) { 'del' } else { 'keep' })" ([ordered]@{ '@probe/a' = '0.1.0' })
      $tb = (New-Tgz '@probe/b' '0.1.1-dev.1' 'b' $pA (Get-DevTgzPath $h 'probe-b-0.1.1-dev.1.tgz')).path
      $null = Invoke-Pnpm $f $h @('add', "@probe/b@file:$tb")
      Write-Inspect $f $h '装完' @('@probe/a', '@probe/b')
      $before = Get-RealPackageDir $h '@probe/b'
      if ($deleteTgz) { Remove-Item $tb; Write-Run $f "（已删 $tb）" }
      $null = Invoke-Pnpm $f $h @('add', '@probe/a@0.2.0')
      Write-Inspect $f $h "$label、a 升到 0.2.0 之后" @('@probe/a', '@probe/b')
      Write-PathComparison $f '@probe/b' $before (Get-RealPackageDir $h '@probe/b')
    }

    # ---------- 05 一次 pnpm add 同时给两个 file: tgz
    $f = '51-q5-two-tgz-one-add.txt'
    foreach ($variant in @(@{ name = 'q5-a-then-b'; label = '5a 参数顺序 a、b'; order = 'ab' }, @{ name = 'q5-b-then-a'; label = '5b 参数顺序 b、a'; order = 'ba' })) {
      Write-Run $f "`n##### $($variant.label)"
      $h = New-TestHome $f $variant.name ([ordered]@{ '@probe/r' = '^0.1.0' })
      $ta = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
      $tb = (New-Tgz '@probe/b' '0.1.1-dev.1' 'b' $pA (Get-DevTgzPath $h 'probe-b-0.1.1-dev.1.tgz')).path
      $specs = @("@probe/a@file:$ta", "@probe/b@file:$tb")
      if ($variant.order -eq 'ba') { [array]::Reverse($specs) }
      $null = Invoke-Pnpm $f $h (@('add') + $specs)
      Write-FileDump $f $h 'package.json' 'add 之后'
      Write-Inspect $f $h 'add 之后' @('@probe/a', '@probe/b')
    }

    # ---------- 06 home 里有 file: 依赖时 pnpm outdated --json
    $f = '61-q6-outdated.txt'
    Write-Run $f '源上 @probe/r 与 @probe/a 的 latest 都是 0.2.0'
    Write-Run $f "`n##### 6a 只有从源装的 @probe/r ^0.1.0（对照）"
    $h = New-TestHome $f 'q6-registry-only' ([ordered]@{ '@probe/r' = '^0.1.0' })
    $null = Invoke-Pnpm $f $h @('outdated', '--json')

    Write-Run $f "`n##### 6b @probe/r ^0.1.0 + @probe/a 用 file: tgz 装（0.1.1-dev.1）"
    $h = New-TestHome $f 'q6-mixed' ([ordered]@{ '@probe/r' = '^0.1.0' })
    $ta = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$ta")
    $null = Invoke-Pnpm $f $h @('outdated', '--json')
    $null = Invoke-Pnpm $f $h @('outdated')
    Write-Run $f "`n##### 6d 同一个 home，删掉 a 的 tgz 之后"
    Remove-Item $ta
    $null = Invoke-Pnpm $f $h @('outdated', '--json')

    Write-Run $f "`n##### 6c 只有 file: tgz 装的 @probe/a"
    $h = New-TestHome $f 'q6-file-only' ([ordered]@{})
    $ta = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
    $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$ta")
    $null = Invoke-Pnpm $f $h @('outdated', '--json')

    # ---------- 07 已经以 ^0.1.0 从源装着 a，再 pnpm add a@file:<tgz>
    $f = '71-q7-caret-then-file.txt'
    foreach ($variant in @(@{ name = 'q7-caret'; label = '7a 清单写 ^0.1.0（plugin-manager.install 写出来的样子）'; spec = '^0.1.0' }, @{ name = 'q7-exact'; label = '7b 清单写准确号 0.1.0（现在 devkit.dev 写死准确号之后的样子）'; spec = '0.1.0' })) {
      Write-Run $f "`n##### $($variant.label)"
      $h = New-TestHome $f $variant.name ([ordered]@{ '@probe/r' = '^0.1.0'; '@probe/a' = $variant.spec })
      Write-Inspect $f $h 'pnpm install 之后' @('@probe/a')
      $ta = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
      $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$ta")
      Write-FileDump $f $h 'package.json' 'add file: 之后'
      Write-FileDump $f $h 'pnpm-lock.yaml' 'add file: 之后'
      Write-Inspect $f $h 'add file: 之后' @('@probe/a')
    }

    # ---------- 08 附带：file: 装着的开发版，怎么回到源上的版本（插件管理 install / update 走的是 pnpm add <包>[@<号>]）
    $f = '81-extra-back-to-registry.txt'
    foreach ($variant in @(@{ name = 'q8-add-bare'; label = '8a pnpm add @probe/a（不带版本）'; spec = '@probe/a' }, @{ name = 'q8-add-version'; label = '8b pnpm add @probe/a@0.2.0'; spec = '@probe/a@0.2.0' })) {
      Write-Run $f "`n##### $($variant.label)"
      $h = New-TestHome $f $variant.name ([ordered]@{ '@probe/r' = '^0.1.0' })
      $ta = (New-Tgz '@probe/a' '0.1.1-dev.1' 'one' $null (Get-DevTgzPath $h 'probe-a-0.1.1-dev.1.tgz')).path
      $null = Invoke-Pnpm $f $h @('add', "@probe/a@file:$ta")
      $null = Invoke-Pnpm $f $h @('add', $variant.spec)
      Write-FileDump $f $h 'package.json' "pnpm add $($variant.spec) 之后"
      Write-Inspect $f $h "pnpm add $($variant.spec) 之后" @('@probe/a')
    }
  } finally {
    Stop-Process -Id $registry.Id
  }
} finally {
  foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key]) }
}

"完成，结果在 $runs"
