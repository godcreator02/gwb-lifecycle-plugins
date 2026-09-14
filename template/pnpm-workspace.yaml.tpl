# pnpm 11 的设置家就是这个文件（package.json 的 pnpm 字段已不读）。
# 独立单包仓也认它——没有 packages 列表就是「自己一个包的 workspace」。
allowBuilds:
  # @tailwindcss/node 拖进来的，构建脚本不需要跑
  '@parcel/watcher': false
  # 浏览器半的打包器要下二进制——不批它，pnpm build 当场死
  esbuild: true
