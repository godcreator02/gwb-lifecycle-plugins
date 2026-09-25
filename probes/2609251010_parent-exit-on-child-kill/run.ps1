# 隔离 home A 里的 devkit 用 devkit.home.new 开隔离 home B，再用 Stop-Process 结束 B，看 A 会不会跟着走一遍正常退出。
# 全程不碰 default：A 由本脚本直接用安装版启动，B 由 A 里的 devkit 启动；结果写进 runs/<序号>-<场景>.txt
param(
  [string]$Kernel = '0.6.1',
  [string]$Cordis = '4.0.0-rc.10',
  [int]$PortA = 9431,
  # kill：Stop-Process -Force 结束 B 的主进程（与总控台那次同一个做法）；close：CloseMainWindow 正常关 B 的窗口（对照）
  [ValidateSet('kill', 'close')][string]$Scenario = 'kill',
  [int]$WatchSeconds = 20,
  [string]$Run = '01'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
# pnpm.ps1 转发数组参数时会在包名后面多带一个空格，直接调 pnpm.cmd
$pnpm = Join-Path $env:APPDATA 'npm\pnpm.cmd'
$stamp = Get-Date -Format 'yyMMddHHmm'
$homes = Join-Path $env:APPDATA 'gwb-kernel\homes'
$nameA = "exit-probe-a-$stamp"
$homeA = Join-Path $homes $nameA
$exe = Join-Path $env:LOCALAPPDATA 'Programs\gwb-kernel\gwb-kernel.exe'
$cdp = Join-Path $PSScriptRoot '..\..\plugins\devkit\bin\cdp.mjs'
$report = Join-Path $PSScriptRoot "runs\$Run-$Scenario.txt"
New-Item -ItemType Directory -Force (Split-Path $report) | Out-Null
$lines = [System.Collections.Generic.List[string]]::new()
function Note([string]$text) { $line = "$(Get-Date -Format 'HH:mm:ss.fff') $text"; $lines.Add($line); Write-Host $line }

Note "场景 $Scenario；A=$nameA；内核 $Kernel；安装版 $exe"

# 1. 建 A：内核包、cordis、基础插件与 devkit（devkit.home.new 装的那一套再加 devkit）
New-Item -ItemType Directory $homeA | Out-Null
$plugins = [ordered]@{
  commands = '@godcreator/gwb-commands'; shell = '@godcreator/gwb-shell'; data = '@godcreator/gwb-data'
  settings = '@godcreator/gwb-settings'; skills = '@godcreator/gwb-skills'; 'plugin-manager' = '@godcreator/gwb-plugin-manager'
  baseui = '@godcreator/gwb-baseui'; devkit = '@godcreator/gwb-devkit'
}
Set-Content (Join-Path $homeA 'cordis.yml') -Value (($plugins.GetEnumerator() | ForEach-Object { "- id: $($_.Key)`n  name: '$($_.Value)'" }) -join "`n")
$env:pnpm_config_auto_install_peers = 'false'
Push-Location $homeA
try {
  & $pnpm add --save-exact "@godcreator/gwb-kernel-desktop@$Kernel" | Out-Null
  & $pnpm add --save-exact "cordis@$Cordis" | Out-Null
  & $pnpm add @($plugins.Values) | Out-Null
} finally {
  Pop-Location
  Remove-Item Env:pnpm_config_auto_install_peers
}
Note "A 装好了：$((Get-Content (Join-Path $homeA 'package.json') -Raw) -replace '\s+', ' ')"

# 2. 起 A：父进程是本脚本，不是 default
$env:GWB_HOME = $nameA
$procA = Start-Process $exe -ArgumentList "--remote-debugging-port=$PortA", '--disable-backgrounding-occluded-windows' -PassThru
Remove-Item Env:GWB_HOME
Note "A 起了：pid $($procA.Id)"
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
  Start-Sleep 1
  $PSNativeCommandUseErrorActionPreference = $false
  $null = node $cdp $nameA cmd plugin-manager.list 2>$null
  $ready = $LASTEXITCODE -eq 0
  $PSNativeCommandUseErrorActionPreference = $true
}
if (-not $ready) { throw "A 60 秒没就绪" }
Note 'A 就绪（plugin-manager.list 答话了）'

# 3. A 里的 devkit 开 B
$raw = node $cdp $nameA --timeout 600 cmd devkit.home.new '{"short":"exit-probe-b"}'
$receipt = ($raw -join "`n" | ConvertFrom-Json).'回执'
if (-not $receipt.ok) { throw "devkit.home.new 没成：$($receipt.error)" }
$nameB = $receipt.data.name
$pidB = [int]$receipt.data.pid
$homeB = $receipt.data.home
Note "A 的 devkit 开了 B：$nameB pid $pidB（$($receipt.data.note)）"
Start-Sleep 5

# 4. 结束 B
$logA = Join-Path $homeA 'gwb.log'
$baseline = (Get-Item $logA).Length
if ($Scenario -eq 'kill') {
  Stop-Process -Id $pidB -Force
  Note "Stop-Process -Id $pidB -Force"
} else {
  $closed = (Get-Process -Id $pidB).CloseMainWindow()
  Note "CloseMainWindow($pidB) → $closed"
}

# 5. 看 A
Start-Sleep $WatchSeconds
$aliveA = $null -ne (Get-Process -Id $procA.Id -ErrorAction SilentlyContinue)
$aliveB = $null -ne (Get-Process -Id $pidB -ErrorAction SilentlyContinue)
Note "$WatchSeconds 秒后：A pid $($procA.Id) 还在=$aliveA；B pid $pidB 还在=$aliveB"
$fs = [System.IO.File]::Open($logA, 'Open', 'Read', 'ReadWrite')
try { $null = $fs.Seek($baseline, 'Begin'); $newLog = [System.IO.StreamReader]::new($fs).ReadToEnd() } finally { $fs.Dispose() }
Note "A 的 gwb.log 在结束 B 之后新增的行："
foreach ($l in ($newLog -split "`r?`n" | Where-Object { $_ -ne '' })) { $lines.Add("    $l") }
$lines.Add("    （共 $(($newLog -split "`r?`n" | Where-Object { $_ -ne '' }).Count) 行；含「清理完成」=$($newLog -match '清理完成')）")

# 6. 收尾：停 A（B 已结束）；两个 home 目录留着当物证
if ($aliveA) { Stop-Process -Id $procA.Id -Force; Note "收尾：Stop-Process A" }
if ($aliveB) { Stop-Process -Id $pidB -Force; Note "收尾：Stop-Process B" }
Note "home 目录留着：$homeA、$homeB"
Set-Content $report -Value $lines -Encoding utf8
