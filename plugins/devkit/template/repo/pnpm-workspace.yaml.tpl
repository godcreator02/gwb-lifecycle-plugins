# pnpm 11 起，设置都写在这个文件里（package.json 的 pnpm 字段已不再读取）。
#
# 仓只有一种布局——workspace：仓根是不发布的 private 包，插件放在 plugins/<短名>/；加第二个插件用
# devkit.scaffold.plugin {"repo":"<仓根>","name":"<短名>"}，它在 plugins/ 下再建一个目录。
# 有了不是插件的包（插件共用的库之类）时加一行 `- packages/*`，
# 根 package.json 的 build 过滤器同步加 --filter "./packages/*"。
#
# 文档站不收进来：docfirst 文档站自带 pnpm-workspace.yaml、自己一套依赖、自己 install——
# 收进来就成了 workspace 里嵌套 workspace，pnpm 不支持这种结构。

packages:
  - plugins/*

allowBuilds:
  # @tailwindcss/node 间接依赖的包，它的安装脚本不需要运行
  '@parcel/watcher': false
  # 浏览器侧的打包器，安装脚本要下载二进制——不允许它运行，pnpm build 直接失败
  esbuild: true
