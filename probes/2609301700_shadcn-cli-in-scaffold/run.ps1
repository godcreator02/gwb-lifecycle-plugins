# 在一个刚写好 components.json 与 @/ 别名、还没 install 过的插件包里，非交互运行 shadcn 官方 CLI 加 button，
# 看它用哪个包管理器装依赖、写了哪些文件、把依赖写进哪张表、组件 import 的包有没有装全；再看一次 pnpm add -D 能不能把它们都放进 devDependencies。
# 两组：A 组插件包在 workspace 仓的 plugins/ 下（仓根有 pnpm-workspace.yaml，同建仓命令生成的仓）；B 组是同一个包单独放、往上没有 pnpm 的任何文件。
# 运行：pwsh -NoProfile -File run.ps1（要联网；用 PATH 上的 pnpm，版本写进输出；CLI 钉在 4.21.0，建仓命令用的是 latest）
$ErrorActionPreference = 'Stop'
$cli = 'shadcn@4.21.0'

function New-PluginPackage([string]$dir) {
  New-Item -ItemType Directory (Join-Path $dir 'src\client') | Out-Null
  Set-Content (Join-Path $dir 'package.json') '{ "name": "shadcn-probe", "private": true, "type": "module", "devDependencies": { "react": "19.2.8", "react-dom": "19.2.8", "tailwindcss": "^4.3.0", "typescript": "^7.0.2" } }'
  Set-Content (Join-Path $dir 'components.json') '{ "$schema": "https://ui.shadcn.com/schema.json", "style": "new-york", "rsc": false, "tsx": true, "tailwind": { "config": "", "css": "src/client/styles.css", "baseColor": "zinc", "cssVariables": true, "prefix": "probe" }, "aliases": { "components": "@/components", "ui": "@/components/ui", "lib": "@/lib", "utils": "@/lib/utils" }, "iconLibrary": "lucide" }'
  Set-Content (Join-Path $dir 'tsconfig.json') '{ "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx", "paths": { "@/*": ["./src/client/*"] } } }'
  Set-Content (Join-Path $dir 'src\client\styles.css') "@import 'tailwindcss/theme.css' theme(reference) prefix(probe);`n@import 'tailwindcss/utilities.css' layer(utilities) source(none);`n@source `"./`";"
}

function Show-Tables {
  $m = Get-Content package.json -Raw | ConvertFrom-Json
  "  dependencies = $(($m.dependencies | ConvertTo-Json -Compress))"
  "  devDependencies 里的组件依赖 = $((@('cn', 'radix-ui', 'class-variance-authority') | ForEach-Object { "$_=$($m.devDependencies.$_)" }) -join ', ')"
}

$root = Join-Path ([IO.Path]::GetTempPath()) "shadcn-probe-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
try {
  "pnpm $(pnpm --version)；CLI $cli"

  '== A 组：workspace 仓的 plugins/probe/'
  $repo = Join-Path $root 'repo'
  New-Item -ItemType Directory $repo | Out-Null
  Set-Content (Join-Path $repo 'pnpm-workspace.yaml') "packages:`n  - plugins/*"
  Set-Content (Join-Path $repo 'package.json') '{ "name": "probe-workspace", "private": true }'
  $pkg = Join-Path $repo 'plugins\probe'
  New-PluginPackage $pkg
  Set-Location $pkg
  $started = Get-Date
  pnpm dlx $cli add button --yes *> cli.log
  "dlx 退出码 $LASTEXITCODE，用时 $([int]((Get-Date) - $started).TotalSeconds) 秒；仓根有 pnpm-lock.yaml = $(Test-Path (Join-Path $repo 'pnpm-lock.yaml'))，包里有 package-lock.json = $(Test-Path (Join-Path $pkg 'package-lock.json'))"
  "写出的组件文件 = $((Get-ChildItem src -Recurse -File -Filter *.tsx | ForEach-Object { $_.FullName.Replace("$pkg\", '') }) -join ', ')"
  "包根下有没有名字叫 @ 的目录 = $(Test-Path (Join-Path $pkg '@'))"
  'button.tsx 的 import：'
  Select-String -Path src\client\components\ui\button.tsx -Pattern '^import ' | ForEach-Object { "  $($_.Line)" }
  'CLI 跑完：'
  Show-Tables
  $m = Get-Content package.json -Raw | ConvertFrom-Json
  $declared = @($m.dependencies.PSObject.Properties.Name) + @($m.devDependencies.PSObject.Properties.Name)
  $imported = Select-String -Path src\client\components\ui\button.tsx -Pattern 'from "([^"./@][^"]*)"' | ForEach-Object { $_.Matches[0].Groups[1].Value }
  $missing = @($imported | Where-Object { $declared -notcontains $_ })
  "组件 import 了、两张表里都没有的包 = $($missing -join ', ')"
  $specs = @($m.dependencies.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" }) + $missing
  pnpm add -D @specs *> add-dev.log
  "pnpm add -D $($specs -join ' ') 退出码 $LASTEXITCODE；之后："
  Show-Tables

  '== B 组：同一个包单独放，往上没有 pnpm-workspace.yaml 与 pnpm-lock.yaml'
  $alone = Join-Path $root 'alone'
  New-PluginPackage $alone
  Set-Location $alone
  pnpm dlx $cli add button --yes *> cli.log
  "dlx 退出码 $LASTEXITCODE；包里有 package-lock.json = $(Test-Path (Join-Path $alone 'package-lock.json'))，有 pnpm-lock.yaml = $(Test-Path (Join-Path $alone 'pnpm-lock.yaml'))"
} finally {
  Set-Location ([IO.Path]::GetTempPath())
  Remove-Item -Recurse -Force $root
}
