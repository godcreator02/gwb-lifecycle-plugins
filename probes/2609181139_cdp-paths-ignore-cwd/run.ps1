# 跑法：pwsh 7，`pwsh -File run.ps1 -Cdp <某个 home 里装的 gwb-devkit 包>\bin\cdp.mjs -Target <一个开着调试口的隔离 home 名>`。
# 照 gwbNodeCli 运行器的样子起那支驱动：node 当可执行、工作目录是 cdp.mjs 自己所在的 bin/（运行器缺省就是它）。
# 六个场景：shot 缺省 / shot 给绝对路径 / shot 给相对路径 / shot 落进 node_modules / eval 给相对路径 / eval 给绝对路径。
# 事后核对：截图落在哪、包目录里多没多文件。只写 $env:TEMP 与目标 home 的 out\cdp\。
param(
  [Parameter(Mandatory)] [string]$Cdp,
  [Parameter(Mandatory)] [string]$Target
)
$ErrorActionPreference = 'Continue'
$bin = Split-Path -Parent (Resolve-Path $Cdp).Path
$pkg = Split-Path -Parent $bin
$work = Join-Path $env:TEMP ("cdp-paths-" + (Get-Date -Format 'yyMMddHHmmss'))
New-Item -ItemType Directory $work | Out-Null
Set-Content (Join-Path $work 'probe.js') '(args) => ({ title: document.title, echo: args })'
$before = Get-ChildItem $pkg -Recurse -File | ForEach-Object FullName
"node $(node -v) · pkg=$pkg · work=$work"

function Invoke-Cdp([string]$Label, [string[]]$Rest) {
  Push-Location $bin
  try {
    $out = & node $Cdp $Target @Rest 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  $line = ($out -split "`n" | Where-Object { $_ -match '"file"|"文件"|^Error:' } | Select-Object -First 1)
  "[{0}] exit={1} {2}" -f $Label, $code, ($line ?? '').Trim()
}

Invoke-Cdp 'shot 缺省' @('shot')
Invoke-Cdp 'shot 绝对' @('shot', (Join-Path $work 'given.png'))
Invoke-Cdp 'shot 相对' @('shot', 'rel\given.png')
Invoke-Cdp 'shot 进 node_modules' @('shot', (Join-Path $pkg 'x.png'))
Invoke-Cdp 'eval 相对' @('eval', 'probe.js')
Invoke-Cdp 'eval 绝对' @('eval', (Join-Path $work 'probe.js'), '{"k":1}')

$after = Get-ChildItem $pkg -Recurse -File | ForEach-Object FullName
"包目录文件数 前=$($before.Count) 后=$($after.Count) 多出=$(@(Compare-Object $before $after).Count)"
"work 下：$((Get-ChildItem $work -Name) -join ', ')"
