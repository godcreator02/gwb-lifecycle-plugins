/**
 * 这个站的 docfirst 配置：用哪个格式包、生成文件写到哪、组件规则表是什么。命令行和站读的是同一份。
 *
 * 项目根是这个站目录，引用的代码在 `plugins/devkit/`、`plugins/plugin-manager/`——
 * 引用里写 `../plugins/<目录>/…`，按项目根拼路径，页面在哪个子目录都一样。
 * 分区按约定：`content/` 下 `trajectory/` 与 `future/` 两个名字固定，其余目录都是现状区、都进 check；
 * 本站的现状区只有 `content/docs`。
 *
 * 生成文件写到各自的插件目录，正本都在 `content/docs/outputs/`。`plugins/devkit/`：AGENTS、CLAUDE、README，
 * 外加随包发布的说明书 `skills/gwb-devkit/SKILL.md`（写插件手册）与它的两份附件 `references/`、
 * `skills/gwb-release/SKILL.md`（版本号规则）。附件 `references/rules.md` 的正本是规矩总表
 * `content/docs/rules/index.mdx`：同一页既是站上的现状页、也生成随包发布的附件，不另写一份副本。
 * `plugins/plugin-manager/`：说明书 `skills/gwb-plugin-manager/SKILL.md`。
 * SKILL.md 要保留 frontmatter 的 `name` 与 `description`（gwb-skills 登记说明书时读它们），
 * 所以目标写成对象形式；附件经 `skill.read {name, file}` 读，不带 frontmatter。
 * CLAUDE.md 第一行固定是 `@AGENTS.md`，只给 Claude 的指令写在它后面。它跟 AGENTS.md 在同一个目录，
 * 但不在 package.json 的 files 白名单里，不随包发布。
 * 生成正本按原文渲染，里面不能用 JSX 组件。
 */
import * as fumadocs from '@godcreator/docfirst-workflow/fumadocs'

export default {
  formats: [fumadocs],
  outputs: {
    'content/docs/outputs/agents.mdx': ['../plugins/devkit/AGENTS.md'],
    'content/docs/outputs/claude.mdx': ['../plugins/devkit/CLAUDE.md'],
    'content/docs/outputs/readme.mdx': ['../plugins/devkit/README.md'],
    'content/docs/outputs/skills/gwb-devkit.mdx': [
      { to: '../plugins/devkit/skills/gwb-devkit/SKILL.md', frontmatter: ['name', 'description'] },
    ],
    'content/docs/outputs/skills/gwb-devkit-evidence.mdx': ['../plugins/devkit/skills/gwb-devkit/references/evidence.md'],
    'content/docs/rules/index.mdx': ['../plugins/devkit/skills/gwb-devkit/references/rules.md'],
    'content/docs/outputs/skills/gwb-release.mdx': [
      { to: '../plugins/devkit/skills/gwb-release/SKILL.md', frontmatter: ['name', 'description'] },
    ],
    'content/docs/outputs/skills/gwb-plugin-manager.mdx': [
      { to: '../plugins/plugin-manager/skills/gwb-plugin-manager/SKILL.md', frontmatter: ['name', 'description'] },
    ],
  },
  components: {
    ...fumadocs.defaultRoster,
    // 示意图：图本身 agent 看不见，生成 markdown 时只保留「[图] 标题」和子元素里的文字说明
    Diagram: (node, h) => [h.paragraph(`[图] ${h.attr(node, 'title') ?? h.attr(node, 'name') ?? ''}`), ...h.children()],
    // fumadocs 自带的骨架组件：分步与折叠只是排版，机读版保留里面的正文
    Steps: 'children',
    Step: 'children',
    Accordions: 'children',
    Accordion: (node, h) => [h.paragraph(h.attr(node, 'title') ?? ''), ...h.children()],
    Callout: (node, h) => [h.paragraph(`[${h.attr(node, 'title') ?? '提示'}]`), ...h.children()],
    // 讲解页的小演示（src/components/explain/）：演示本身 agent 看不见，页面要说的话都写在正文里
    DirSwap: (node, h) => h.paragraph('[演示] 装上新版本之后，链接与运行中的代码各指向哪个目录'),
    ReloadPicker: (node, h) => h.paragraph('[演示] 挑几个包升级，看谁的目录变了、谁被重新加载'),
    RemountRace: (node, h) => h.paragraph('[演示] 停用后马上启用与等旧实例卸载完再启用的时间线'),
  },
}
