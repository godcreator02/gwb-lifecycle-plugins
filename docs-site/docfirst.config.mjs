/**
 * 这个站怎么挂机制：用哪个格式包、哪几区进 check、卡目录在哪、生成物摆哪、组件名册是什么。
 * 命令行和站读的是同一份。
 *
 * 项目根是这个站目录，钉的代码在件目录 `plugins/devkit/`——引用里写 `../plugins/devkit/src/…`，
 * 读取器按项目根拼路径。比较器不写死：仓里有 git 就用 git 比，没有就退回按内容摘要比。
 *
 * 六区里只有 docs（现状）与 outputs（生成正本）进 check——只有这两区对代码说话。
 * trajectory 指卡目录：check 顺带跑卡校验（卡是 .mdx，六个字段一个不沾的页不算卡）。
 *
 * 生成物全摆进件目录 `plugins/devkit/`：AGENTS、README、catalog，外加**随包发的说明书**——
 * `skills/gwb-devkit/SKILL.md`（写插件手册）与它的两份附件 `references/`，`skills/gwb-release/SKILL.md`
 * （发版规则）。两份 SKILL.md 要保留 frontmatter 的 `name` 与 `description`（gwb-skills 挂载时读它们），
 * 所以目标写成对象形式；附件经 `skill.read {name, file}` 读，不带 frontmatter。
 * 说明书是这个包对外的知识面，正本跟别的文档一样住站里，改它照样是 `doc:render` 重摆。
 */
import * as fumadocs from '@godcreator/docfirst-workflow/fumadocs'

export default {
  formats: [fumadocs],
  docs: ['content/docs', 'content/outputs'],
  trajectory: 'content/trajectory',
  out: 'out',
  outputs: {
    'content/outputs/agents.mdx': ['../plugins/devkit/AGENTS.md'],
    'content/outputs/readme.mdx': ['../plugins/devkit/README.md'],
    'content/outputs/catalog-devkit.mdx': ['../plugins/devkit/catalog.md'],
    'content/outputs/skills/gwb-devkit.mdx': [
      { to: '../plugins/devkit/skills/gwb-devkit/SKILL.md', frontmatter: ['name', 'description'] },
    ],
    'content/outputs/skills/gwb-devkit-evidence.mdx': ['../plugins/devkit/skills/gwb-devkit/references/evidence.md'],
    'content/outputs/skills/gwb-devkit-ui.mdx': ['../plugins/devkit/skills/gwb-devkit/references/ui.md'],
    'content/outputs/skills/gwb-release.mdx': [
      { to: '../plugins/devkit/skills/gwb-release/SKILL.md', frontmatter: ['name', 'description'] },
    ],
  },
  components: {
    ...fumadocs.defaultRoster,
  },
}
