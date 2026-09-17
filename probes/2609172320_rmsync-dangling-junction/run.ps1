# 跑法：pwsh 7，`pwsh -File run.ps1 [宿主 exe 路径]`，缺省宿主是安装版 gwb-kernel.exe。
# 在 $env:TEMP 下造一棵带 junction 的小树，分别用「宿主 electron 带的 Node」（ELECTRON_RUN_AS_NODE）与系统 node
# 跑 fs.rmSync({recursive,force}) 与手写的自底向上删，报「抛没抛、目录还在不在」。不删 $env:TEMP 以外的任何东西。
param([string]$HostExe = (Join-Path $env:LOCALAPPDATA 'Programs\gwb-kernel\gwb-kernel.exe'))
$work = Join-Path $env:TEMP ("rmsync-junction-" + (Get-Date -Format 'yyMMddHHmmss'))
New-Item -ItemType Directory $work | Out-Null

# 树：a-target/f.txt，z/link → a-target（按名字序先删 a-target，删到 z/link 时它已悬空——pnpm home 里
# node_modules/.pnpm/<包>/node_modules/<依赖> 指向先删掉的兄弟目录，同一个形状）；外加一个指向树外的 junction，
# 核对删树时不跟进链接
function New-Tree([string]$Root, [string]$Outside) {
  New-Item -ItemType Directory $Outside | Out-Null
  'keep' | Set-Content (Join-Path $Outside 'keep.txt')
  New-Item -ItemType Directory (Join-Path $Root 'a-target') | Out-Null
  'x' | Set-Content (Join-Path $Root 'a-target\f.txt')
  New-Item -ItemType Directory (Join-Path $Root 'z') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $Root 'z\link') -Target (Join-Path $Root 'a-target') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $Root 'b-out') -Target $Outside | Out-Null
}

$script = Join-Path $PSScriptRoot 'rm.cjs'
foreach ($runner in 'host', 'node') {
  foreach ($way in 'rmSync', 'walk') {
    $tree = Join-Path $work "$runner-$way"
    $outside = Join-Path $work "$runner-$way-outside"
    New-Tree $tree $outside
    $out = Join-Path $work "$runner-$way.out"
    if ($runner -eq 'host') {
      $env:ELECTRON_RUN_AS_NODE = '1'
      Start-Process -FilePath $HostExe -ArgumentList "`"$script`"", $way, "`"$tree`"", "`"$out`"" -Wait -NoNewWindow
      $env:ELECTRON_RUN_AS_NODE = $null
    } else {
      node $script $way $tree $out
    }
    "{0,-5} {1,-7} {2}；树外 junction 指着的 keep.txt 还在 {3}" -f $runner, $way, (Get-Content $out), (Test-Path (Join-Path $outside 'keep.txt'))
  }
}
