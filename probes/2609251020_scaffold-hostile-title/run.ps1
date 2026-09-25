# 探针：title 带各种特殊字符时，建仓生成的仓能不能 install / build / check
# 1) run.mjs 用 dist/scaffold.js 铺仓到 gen/hostile（不进 git）
# 2) 在铺出来的仓根跑 pnpm install / build / check，全程记 runs/01-hostile-title.txt
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
$log = Join-Path $here 'runs/01-hostile-title.txt'
New-Item -ItemType Directory -Force (Join-Path $here 'runs') | Out-Null

node run.mjs 2>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) { throw "铺仓没过：$LASTEXITCODE" }

Push-Location (Join-Path $here 'gen/hostile')
try {
  foreach ($step in 'install', 'build', 'check') {
    "`n== pnpm $step ==`n" | Tee-Object -FilePath $log -Append
    pnpm $step 2>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) { throw "$step 没过：$LASTEXITCODE" }
  }
} finally {
  Pop-Location
}
"`n全部过。" | Tee-Object -FilePath $log -Append
