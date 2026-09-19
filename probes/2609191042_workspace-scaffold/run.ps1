# 探针：薄壳模板在真实 pnpm 里站不站得住
# 1) run.mjs 用 dist/scaffold.js 铺仓（两区装配的输出）
# 2) 在铺出来的仓根跑 pnpm install / build / check
# 生成物住本探针目录的 gen/ 下（不进 git，.gitignore 里已点名），结果记 results.txt
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

node run.mjs 2>&1 | Tee-Object -FilePath results.txt -Append

Push-Location (Join-Path $here 'gen/ws-probe')
try {
  "`n== pnpm install ==`n" | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
  pnpm install 2>&1 | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
  if ($LASTEXITCODE -ne 0) { throw "install 没过：$LASTEXITCODE" }

  "`n== pnpm build ==`n" | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
  pnpm build 2>&1 | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
  if ($LASTEXITCODE -ne 0) { throw "build 没过：$LASTEXITCODE" }

  "`n== pnpm check ==`n" | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
  pnpm check 2>&1 | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
  if ($LASTEXITCODE -ne 0) { throw "check 没过：$LASTEXITCODE" }
} finally {
  Pop-Location
}
"`n全部过。" | Tee-Object -FilePath (Join-Path $here 'results.txt') -Append
