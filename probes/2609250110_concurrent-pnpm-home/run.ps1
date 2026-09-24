# 两个 pnpm 同时改同一个 home 时会发生什么：package.json 丢不丢依赖、锁文件与 node_modules 对不对得上、pnpm outdated 写不写文件
# 跑法：pwsh ./run.ps1   （重建临时目录下的 work，结果写进 runs/*.txt）
# home 放在 %TEMP% 下、不带 pnpm-workspace.yaml，和真 home 的布局一样（本目录在 gwb-devkit 仓里，往上会找到仓根的 workspace）；
# 存储与元数据缓存经环境变量指到 work 下，不动用户的全局存储
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$probe = $PSScriptRoot
$runs = Join-Path $probe 'runs'
$work = Join-Path $env:TEMP 'gwb-probe-2609250110'
$vendor = Join-Path $work 'vendor'
$src = Join-Path $work 'src'
$homes = Join-Path $work 'homes'
$logs = Join-Path $work 'logs'
$delayMs = 1000
$rounds = 5

# 和插件管理找 pnpm 的规则一样：两个固定位置，第一个存在的作数
$pnpm = @((Join-Path $env:LOCALAPPDATA 'pnpm\bin\pnpm.exe'), (Join-Path $env:APPDATA 'npm\node_modules\pnpm\pnpm.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pnpm) { throw '两个固定位置都没有 pnpm.exe' }

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
foreach ($dir in $work, $vendor, $src, $homes, $logs, $runs) { New-Item -ItemType Directory -Force $dir | Out-Null }
Get-ChildItem $runs -Filter '*.txt' | Remove-Item

# 插件管理启动 pnpm 时带的环境变量，加上把存储与缓存指到 work 下
$probeEnv = @{
  pnpm_config_auto_install_peers = 'false'
  pnpm_config_store_dir = (Join-Path $work 'store')
  pnpm_config_cache_dir = (Join-Path $work 'cache')
}
$savedEnv = @{}
foreach ($key in $probeEnv.Keys) { $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $probeEnv[$key]) }

function Write-Run([string]$file, [string]$text) {
  Add-Content -Path (Join-Path $runs $file) -Value $text -Encoding utf8
}

function Invoke-Pnpm([string]$file, [string]$cwd, [string[]]$pnpmArgs) {
  Push-Location $cwd
  $out = & $pnpm @pnpmArgs 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  Write-Run $file ("> pnpm " + ($pnpmArgs -join ' ') + "`n" + (Get-Tail $out 15) + "`nexit=$code")
  return $code
}

function Get-Tail([string]$text, [int]$lines) {
  (($text -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last $lines) -join "`n"
}

function Get-HomeState([string]$homeDir) {
  (& node (Join-Path $probe 'check.cjs') $homeDir 'probe-base' 'probe-x' 'probe-y' 2>&1 | Out-String).Trim()
}

function New-FixturePackage([string]$name, [string]$version) {
  $dir = Join-Path $src "$name-$version"
  New-Item -ItemType Directory -Force $dir | Out-Null
  [ordered]@{ name = $name; version = $version; main = 'index.js'; files = @('index.js') } | ConvertTo-Json | Set-Content (Join-Path $dir 'package.json') -Encoding utf8
  "module.exports = { name: '$name', version: '$version' };" | Set-Content (Join-Path $dir 'index.js') -Encoding utf8
  Push-Location $dir
  $out = & $pnpm pack --pack-destination $vendor 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "pnpm pack $name@$version 失败，exit=$code`n$out" }
}

# 新 home：装好 probe-base 1.0.0（源上还有 1.1.0，所以 outdated 有一条过期）
function New-TestHome([string]$name) {
  $homeDir = Join-Path $homes $name
  New-Item -ItemType Directory -Force $homeDir | Out-Null
  [ordered]@{ name = 'gwb-home'; private = $true; dependencies = [ordered]@{ 'probe-base' = '1.0.0' } } | ConvertTo-Json | Set-Content (Join-Path $homeDir 'package.json') -Encoding utf8
  Set-Content (Join-Path $homeDir '.npmrc') "registry=$registryUrl/" -Encoding utf8
  Push-Location $homeDir
  $out = & $pnpm install 2>&1 | Out-String
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "新 home $name 的首次 pnpm install 失败，exit=$code`n$out" }
  return $homeDir
}

function Start-Pnpm([string]$homeDir, [string[]]$pnpmArgs, [string]$logName) {
  $proc = Start-Process -FilePath $pnpm -ArgumentList $pnpmArgs -WorkingDirectory $homeDir -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logs "$logName.out") -RedirectStandardError (Join-Path $logs "$logName.err")
  $null = $proc.Handle  # 先取一次句柄，进程退出后 ExitCode 才读得到
  return $proc
}

function Get-ProcessReport([System.Diagnostics.Process]$proc, [string]$logName, [datetime]$origin) {
  $proc.WaitForExit()
  $out = (Get-Content (Join-Path $logs "$logName.out") -Raw) + (Get-Content (Join-Path $logs "$logName.err") -Raw)
  [pscustomobject]@{
    exit = $proc.ExitCode
    startMs = [int]($proc.StartTime - $origin).TotalMilliseconds
    exitMs = [int]($proc.ExitTime - $origin).TotalMilliseconds
    tail = Get-Tail $out 8
  }
}

# 同时启动两个 pnpm，等都结束，报两者的时间段、退出码、三处记录、之后 --frozen-lockfile 能不能装
function Test-Concurrent([string]$file, [string]$label, [string[]]$argsA, [string[]]$argsB, [int]$round) {
  $homeDir = New-TestHome "$label-$round"
  Write-Run $file "`n===== 第 $round 轮（home=$(Split-Path -Leaf $homeDir)）"
  Write-Run $file "之前：$(Get-HomeState $homeDir)"
  $origin = Get-Date
  $procA = Start-Pnpm $homeDir $argsA "$label-$round-a"
  $procB = Start-Pnpm $homeDir $argsB "$label-$round-b"
  $a = Get-ProcessReport $procA "$label-$round-a" $origin
  $b = Get-ProcessReport $procB "$label-$round-b" $origin
  $overlap = [Math]::Max($a.startMs, $b.startMs) -lt [Math]::Min($a.exitMs, $b.exitMs)
  Write-Run $file "A> pnpm $($argsA -join ' ')   时间段 $($a.startMs)–$($a.exitMs) ms   exit=$($a.exit)`n$($a.tail)"
  Write-Run $file "B> pnpm $($argsB -join ' ')   时间段 $($b.startMs)–$($b.exitMs) ms   exit=$($b.exit)`n$($b.tail)"
  Write-Run $file "两者运行时间重叠：$overlap"
  Write-Run $file "之后：$(Get-HomeState $homeDir)"
  $null = Invoke-Pnpm $file $homeDir @('install', '--frozen-lockfile')
  Write-Run $file "frozen 之后：$(Get-HomeState $homeDir)"
}

function Get-FileFingerprints([string]$homeDir) {
  $fingerprints = @{}
  foreach ($file in Get-ChildItem $homeDir -Recurse -File -Force) {
    $fingerprints[$file.FullName.Substring($homeDir.Length)] = "$($file.Length)|$($file.LastWriteTimeUtc.Ticks)"
  }
  return $fingerprints
}

try {
  # ---------- 00 环境
  Write-Run '00-env.txt' "date=$(Get-Date -Format 'yyyy-MM-dd HH:mm')  pnpm=$(& $pnpm -v)（$pnpm）  node=$(node -v)  os=$([Environment]::OSVersion.VersionString)"
  Write-Run '00-env.txt' "gwb-devkit commit: $(git -C $probe log -1 --format='%h %s')"
  Write-Run '00-env.txt' "work=$work  源延迟=${delayMs}ms  每个同时运行的场景 $rounds 轮"
  Write-Run '00-env.txt' "环境变量：$(($probeEnv.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '  ')"

  New-FixturePackage 'probe-base' '1.0.0'
  New-FixturePackage 'probe-base' '1.1.0'
  New-FixturePackage 'probe-x' '1.0.0'
  New-FixturePackage 'probe-y' '1.0.0'

  $registryUrlFile = Join-Path $work 'registry-url.txt'
  $registry = Start-Process node -ArgumentList @((Join-Path $probe 'registry.mjs'), $vendor, $src, $registryUrlFile, "$delayMs") -PassThru -NoNewWindow
  try {
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path $registryUrlFile)) {
      if ((Get-Date) -gt $deadline) { throw '本机只读源 10 秒内没起来' }
      Start-Sleep -Milliseconds 100
    }
    $registryUrl = (Get-Content $registryUrlFile -Raw).Trim()
    Write-Run '00-env.txt' "本机只读源：$registryUrl"

    # ---------- 01 对照：先后运行两次 add
    $homeDir = New-TestHome 'sequential'
    Write-Run '00-env.txt' "存储确实在 work 下：$(Test-Path (Join-Path $work 'store'))"
    Write-Run '01-sequential-add.txt' "之前：$(Get-HomeState $homeDir)"
    $null = Invoke-Pnpm '01-sequential-add.txt' $homeDir @('add', 'probe-x')
    $null = Invoke-Pnpm '01-sequential-add.txt' $homeDir @('add', 'probe-y')
    Write-Run '01-sequential-add.txt' "之后：$(Get-HomeState $homeDir)"

    # ---------- 02 同时 add 两个不同的包
    for ($i = 1; $i -le $rounds; $i++) { Test-Concurrent '02-add-add.txt' 'add-add' @('add', 'probe-x') @('add', 'probe-y') $i }

    # ---------- 03 同时 add 一个、remove 另一个
    for ($i = 1; $i -le $rounds; $i++) { Test-Concurrent '03-add-remove.txt' 'add-remove' @('add', 'probe-x') @('remove', 'probe-base') $i }

    # ---------- 04 outdated 单独运行写不写文件
    $homeDir = New-TestHome 'outdated-alone'
    $before = Get-FileFingerprints $homeDir
    $null = Invoke-Pnpm '04-outdated-writes.txt' $homeDir @('outdated', '--json')
    $after = Get-FileFingerprints $homeDir
    $changed = @($after.Keys | Where-Object { $before[$_] -ne $after[$_] } | Sort-Object)
    $removed = @($before.Keys | Where-Object { -not $after.ContainsKey($_) } | Sort-Object)
    Write-Run '04-outdated-writes.txt' "home 里 $($before.Count) 个文件；outdated 之后新增或改动：$($changed.Count) 个，删掉：$($removed.Count) 个"
    foreach ($path in $changed) { Write-Run '04-outdated-writes.txt' "  改动/新增 $path" }
    foreach ($path in $removed) { Write-Run '04-outdated-writes.txt' "  删掉 $path" }

    # ---------- 05 add 与 outdated 同时运行
    for ($i = 1; $i -le $rounds; $i++) { Test-Concurrent '05-add-outdated.txt' 'add-outdated' @('add', 'probe-x') @('outdated', '--json') $i }
  } finally {
    Stop-Process -Id $registry.Id
  }
} finally {
  foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key]) }
}

"完成，结果在 $runs"
