# 在系统临时目录下按三种清单起点各跑一次 pnpm add cordis@<号>，打印写进清单的写法与实际装上的版本。
# 需要 pwsh 7、pnpm 12、能访问 npm 源（cordis 4.0.0-rc.9 与 rc.10 都要在源上）
$ErrorActionPreference = 'Stop'
$base = Join-Path ([IO.Path]::GetTempPath()) ('pnpm-exact-probe-' + (Get-Date -Format 'yyMMddHHmmss'))
"pnpm $(pnpm --version)；工作目录 $base"

function Invoke-Case([string]$label, [hashtable]$startDependencies, [string]$spec, [switch]$saveExact) {
  $dir = Join-Path $base $label
  New-Item -ItemType Directory -Force $dir | Out-Null
  [ordered]@{ name = 'probe'; private = $true; dependencies = $startDependencies } | ConvertTo-Json | Set-Content "$dir\package.json"
  Push-Location $dir
  try {
    if ($startDependencies.Count -gt 0) { pnpm install *> $null }
    $addArgs = @('add', $spec)
    if ($saveExact) { $addArgs += '--save-exact' }
    pnpm @addArgs *> $null
    $exitCode = $LASTEXITCODE
    $written = (Get-Content package.json -Raw | ConvertFrom-Json).dependencies.cordis
    $installed = (Get-Content node_modules\cordis\package.json -Raw | ConvertFrom-Json).version
    '{0,-28} pnpm {1,-34} exit={2} 清单={3,-14} 装上={4}' -f $label, ($addArgs -join ' '), $exitCode, $written, $installed
  } finally {
    Pop-Location
  }
}

Invoke-Case 'caret-start' @{ cordis = '^4.0.0-rc.9' } 'cordis@4.0.0-rc.9' -saveExact
Invoke-Case 'exact-start' @{ cordis = '4.0.0-rc.9' } 'cordis@4.0.0-rc.10'
Invoke-Case 'exact-start-flag' @{ cordis = '4.0.0-rc.9' } 'cordis@4.0.0-rc.10' -saveExact
Invoke-Case 'absent-flag' @{} 'cordis@4.0.0-rc.9' -saveExact
Invoke-Case 'absent-noflag' @{} 'cordis@4.0.0-rc.9'
