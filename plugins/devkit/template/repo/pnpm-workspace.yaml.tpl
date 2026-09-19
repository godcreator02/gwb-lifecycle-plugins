# pnpm 11 的设置家就是这个文件（package.json 的 pnpm 字段已不读）。
#
# 只有一种仓形——薄壳 workspace：件住 plugins/<短名>/，加第二个件就是
# devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"} 往 plugins/ 再铺一个目录。
# 长出非件包（repo-kit 那类仓侧工具）时加一行 `- packages/*`，
# 根 package.json 的 build 过滤器同步加 --filter "./packages/*"。
#
# 文档站不收进来：六区那套站自带 pnpm-workspace.yaml、自己一棵依赖树、自己 install——
# 收进来就是工作区里套工作区，pnpm 会为难。

packages:
  - plugins/*

allowBuilds:
  # @tailwindcss/node 拖进来的，构建脚本不需要跑
  '@parcel/watcher': false
  # 浏览器半的打包器要下二进制——不批它，pnpm build 当场死
  esbuild: true
