/**
 * 这个站怎么挂机制：用哪个格式包、文档在哪、组件名册是什么。命令行和站读的是同一份。
 *
 * 项目根是这个站目录，钉的代码在仓根——引用里写 `../src/…`，读取器按项目根拼路径。
 * 比较器不写死：仓里有 git 就用 git 比，没有就退回按内容摘要比。
 *
 * outputs：仓根 AGENTS.md 是生成物，正本是 content/docs/agents.mdx。改 mdx 源之后跑
 * `pnpm livedoc render --target ai` 重摆，两份一起提交——check 守着生成物跟源一致，
 * 红了就是没重摆。README.md 眼下不是生成物（仓里没有），要的时候照这条形状加一行。
 *
 * 轨迹区 content/docs/trajectory/ **不钉活代码**：它冻结历史，钉了就变成会变黄的现状文档。
 */
import * as fumadocs from '@godcreator02/live-doc-format-fumadocs'

export default {
  formats: [fumadocs],
  docs: 'content/docs',
  out: 'out',
  outputs: {
    'content/docs/agents.mdx': ['../AGENTS.md'],
  },
  components: {
    ...fumadocs.defaultRoster,
  },
}
