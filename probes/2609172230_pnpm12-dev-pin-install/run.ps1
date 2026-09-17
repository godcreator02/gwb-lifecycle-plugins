# 跑法：pwsh 7，在任意目录 `pwsh -File run.ps1`。要能访问个人源（用户级 ~/.npmrc 的 @godcreator scope 路由）。
# 在 $env:TEMP 下新建一个带时间戳的工作目录，每个场景×装法一个子目录，互不干扰；不删任何东西。
$ErrorActionPreference = 'Continue'
$work = Join-Path $env:TEMP ("pnpm12-dev-pin-" + (Get-Date -Format 'yyMMddHHmmss'))
New-Item -ItemType Directory $work | Out-Null
"pnpm $(pnpm --version) · work=$work"

# 一个场景：清单先写 $Locked 装一遍（锁定），再把清单与锁里的 specifier 改成 $Spec（模拟「上一趟写成了范围」），
# 然后用 $Method 装 $Target，读 node_modules 里装上的号
function Invoke-Case([string]$Id, [string]$Pkg, [string]$Locked, [string]$Spec, [string]$Target, [string]$Method) {
  $dir = Join-Path $work $Id
  New-Item -ItemType Directory $dir | Out-Null
  Push-Location $dir
  try {
    @{ name = "case-$Id"; version = '1.0.0'; dependencies = @{ '@godcreator/gwb-plugin-api' = '^0.1.1'; $Pkg = $Locked } } | ConvertTo-Json | Set-Content package.json
    pnpm install 2>&1 | Out-Null
    (Get-Content package.json -Raw).Replace("`"$Locked`"", "`"$Spec`"") | Set-Content package.json
    (Get-Content pnpm-lock.yaml -Raw).Replace("specifier: $Locked", "specifier: $Spec") | Set-Content pnpm-lock.yaml
    pnpm install 2>&1 | Out-Null
    $before = (Get-Content "node_modules\$Pkg\package.json" | ConvertFrom-Json).version
    switch ($Method) {
      'add' { pnpm add "$Pkg@$Target" 2>&1 | Out-Null }
      'add-save-exact' { pnpm add --save-exact "$Pkg@$Target" 2>&1 | Out-Null }
      'update' { pnpm update "$Pkg@$Target" 2>&1 | Out-Null }
      'pin-exact+install' {
        (Get-Content package.json -Raw).Replace("`"$Spec`"", "`"$Target`"") | Set-Content package.json
        pnpm install 2>&1 | Out-Null
      }
    }
    $code = $LASTEXITCODE
    $after = (Get-Content "node_modules\$Pkg\package.json" | ConvertFrom-Json).version
    $written = (Get-Content package.json | ConvertFrom-Json).dependencies.$Pkg
    $verdict = if ($after -eq $Target) { 'HIT ' } else { 'MISS' }
    "{0} {1,-18} 起点 {2} 锁在 {3} → 要 {4} → 清单写成 {5}，装上 {6}（退出码 {7}）" -f $verdict, $Method, $Spec, $before, $Target, $written, $after, $code
  } finally {
    Pop-Location
  }
}

$commands = '@godcreator/gwb-commands'
$shell = '@godcreator/gwb-shell'
"== S0 对照：正式版之间（^0.4.0 锁在 0.4.0，要源上正式最新 0.4.2），锁里的旧号不满足新范围就重解析——pnpm add 装得对"
Invoke-Case 'S0-add' $commands '0.4.0' '^0.4.0' '0.4.2' 'add'
"== S1 上一趟写成 ^同patch旧dev号、锁在它上；这一趟发了新 dev 号（事故原型）"
foreach ($m in 'add', 'add-save-exact', 'update', 'pin-exact+install') {
  Invoke-Case "S1-$m" $commands '0.4.2-dev.202609171612' '^0.4.2-dev.202609171612' '0.4.2-dev.202609171623' $m
}
"== S2 清单是 ^0.4.1（plugin-manager.install 写的），源上还有比目标更新的同 patch 号"
foreach ($m in 'add', 'update', 'pin-exact+install') {
  Invoke-Case "S2-$m" $commands '0.4.1' '^0.4.1' '0.4.2-dev.202609171612' $m
}
"== S3 清单 ^0.7.1、锁在同号正式版 0.7.2 上，要装 0.7.2 的 dev 号"
foreach ($m in 'add', 'update', 'pin-exact+install') {
  Invoke-Case "S3-$m" $shell '0.7.2' '^0.7.1' '0.7.2-dev.202609171837' $m
}

"== 虚拟仓目录名：同 patch 两个 dev 号装进同一个项目，目录名前段一样、哈希不同"
$dir = Join-Path $work 'store-dir-naming'
New-Item -ItemType Directory $dir | Out-Null
Push-Location $dir
try {
  '{"name":"naming","version":"1.0.0","private":true}' | Set-Content package.json
  pnpm add "$shell@0.7.2-dev.202609171834" 2>&1 | Out-Null
  pnpm add "$shell@0.7.2-dev.202609171837" 2>&1 | Out-Null
  node (Join-Path $PSScriptRoot 'dir-naming.mjs') $dir '@godcreator/gwb-shell'
} finally {
  Pop-Location
}
