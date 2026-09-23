/**
 * 这个站的 docfirst 配置：用哪个格式包、哪几区进 check、轨迹卡目录在哪、生成物写到哪、组件规则表是什么。
 * 命令行和站读的是同一份。
 *
 * 项目根是这个站目录，引用的代码在两个插件目录 `plugins/devkit/` 与 `plugins/plugin-manager/`——
 * 引用里写 `../plugins/<目录>/src/…`，读取器按项目根拼路径。比较器不写死：仓里有 git 就用 git 比，
 * 没有就改用内容摘要比。
 *
 * 六区里只有 docs（现状）与 outputs（生成物的正本）进 check——只有这两区的论断跟代码对应。
 * trajectory 指轨迹卡目录：check 顺带校验轨迹卡（卡是 .mdx，六个字段一个都没有的页不算卡）。
 *
 * 生成物写到各自的插件目录。`plugins/devkit/`：AGENTS、CLAUDE、README、catalog，外加随包发布的说明书
 * `skills/gwb-devkit/SKILL.md`（写插件手册）与它的两份附件 `references/`、`skills/gwb-release/SKILL.md`
 * （发版规则）。`plugins/plugin-manager/`：说明书 `skills/gwb-plugin-manager/SKILL.md`。
 * SKILL.md 要保留 frontmatter 的 `name` 与 `description`（gwb-skills 登记说明书时读它们），
 * 所以目标写成对象形式；附件经 `skill.read {name, file}` 读，不带 frontmatter。
 * CLAUDE.md 第一行固定是 `@AGENTS.md`，只给 Claude 的指令写在它后面。它跟 AGENTS.md 在同一个目录，
 * 但不在 package.json 的 files 白名单里，不随包发布。
 * 说明书是包对外提供的知识，正本跟别的文档一样存放在站里，改它照样要运行 `doc:render` 重新生成。
 */
import * as fumadocs from '@godcreator/docfirst-workflow/fumadocs'

export default {
  formats: [fumadocs],
  docs: ['content/docs', 'content/outputs'],
  trajectory: 'content/trajectory',
  out: 'out',
  outputs: {
    'content/outputs/agents.mdx': ['../plugins/devkit/AGENTS.md'],
    'content/outputs/claude.mdx': ['../plugins/devkit/CLAUDE.md'],
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
    'content/outputs/skills/gwb-plugin-manager.mdx': [
      { to: '../plugins/plugin-manager/skills/gwb-plugin-manager/SKILL.md', frontmatter: ['name', 'description'] },
    ],
  },
  components: {
    ...fumadocs.defaultRoster,
    // 示意图：图本身 agent 看不见，生成 markdown 时只保留「[图] 标题」和子元素里的文字说明
    Diagram: (node, h) => [h.paragraph(`[图] ${h.attr(node, 'title') ?? h.attr(node, 'name') ?? ''}`), ...h.children()],
  },
}
