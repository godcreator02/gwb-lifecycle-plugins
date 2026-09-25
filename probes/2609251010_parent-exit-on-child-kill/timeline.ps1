# 从每个 home 的 gwb.log 里摘出一段时间内的启动（kernel up）与正常退出（清理完成），按时间排好写进 runs/<Run>-timeline.txt
param(
  [string]$From = '2026-09-24T17:00',
  [string]$To = '2026-09-24T17:16',
  [string]$Run = '02'
)
$ErrorActionPreference = 'Stop'
$homes = Join-Path $env:APPDATA 'gwb-kernel\homes'
$rows = foreach ($dir in Get-ChildItem $homes -Directory) {
  $log = Join-Path $dir.FullName 'gwb.log'
  if (-not (Test-Path $log)) { continue }
  foreach ($hit in Select-String -Path $log -Pattern ' info kernel (清理完成|up，)') {
    $stamp = $hit.Line.Substring(0, 24)
    if ($stamp -ge $From -and $stamp -lt $To) {
      [pscustomobject]@{ At = $stamp; Home = $dir.Name; What = $(if ($hit.Line -match '清理完成') { '正常退出（清理完成）' } else { '启动（kernel up）' }) }
    }
  }
}
$lines = @("gwb.log 里 $From 到 $To（UTC）之间的启动与正常退出，按时间排序：") + ($rows | Sort-Object At | ForEach-Object { "$($_.At)  $($_.Home.PadRight(34)) $($_.What)" })
Set-Content (Join-Path $PSScriptRoot "runs\$Run-timeline.txt") -Value $lines -Encoding utf8
$lines
