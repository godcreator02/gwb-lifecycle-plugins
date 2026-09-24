/**
 * 示意图：`<Diagram name="…" title="…">文字说明</Diagram>`。
 *
 * 人看到的是 `name` 对应的那张 SVG（静态图或分步动画），agent 读生成的 markdown 看到的是 title 与子元素里的
 * 文字说明（docfirst.config.mjs 里 Diagram 的规则只保留这两样）。所以说明文字要能单独读懂：图画的是什么、
 * 谁连着谁，文字里都要有。图不在 docfirst 的检查范围里。
 * 这套组件复制自内核仓文档站，两个站各有一份。
 */
import type { ReactNode } from 'react'
import { DkAuditDeps } from './diagrams/dk-audit-deps'
import { DkCdp } from './diagrams/dk-cdp'
import { DkDevLoop } from './diagrams/dk-dev-loop'
import { DkHomeNew } from './diagrams/dk-home-new'
import { DkRelease } from './diagrams/dk-release'
import { DkScaffold } from './diagrams/dk-scaffold'
import { PmBusy } from './diagrams/pm-busy'
import { PmCommands } from './diagrams/pm-commands'
import { PmHomeContents } from './diagrams/pm-home-contents'
import { PmInstall } from './diagrams/pm-install'
import { PmList } from './diagrams/pm-list'
import { PmPickId } from './diagrams/pm-pick-id'
import { PmPnpmLookup } from './diagrams/pm-pnpm-lookup'
import { PmRemount } from './diagrams/pm-remount'
import { PmRequires } from './diagrams/pm-requires'
import { PmSources } from './diagrams/pm-sources'
import { PmTestedKernel } from './diagrams/pm-tested-kernel'
import { PmUninstall } from './diagrams/pm-uninstall'
import { PmUpgrade } from './diagrams/pm-upgrade'
import { PmUpgradeGap } from './diagrams/pm-upgrade-gap'
import { RkPluginGuard } from './diagrams/rk-plugin-guard'
import { RkSelfReportGuard } from './diagrams/rk-self-report-guard'
import { SeamMap } from './diagrams/seam-map'
import { SeamRepoShape } from './diagrams/seam-repo-shape'
import { SeamServiceTable } from './diagrams/seam-service-table'
import { SeamVersionFields } from './diagrams/seam-version-fields'

const drawings: Record<string, () => ReactNode> = {
  'seam-map': () => <SeamMap />,
  'pm-list': () => <PmList />,
  'pm-busy': () => <PmBusy />,
  'pm-commands': () => <PmCommands />,
  'pm-install': () => <PmInstall />,
  'pm-home-contents': () => <PmHomeContents />,
  'pm-uninstall': () => <PmUninstall />,
  'pm-remount': () => <PmRemount />,
  'pm-upgrade': () => <PmUpgrade />,
  'pm-upgrade-gap': () => <PmUpgradeGap />,
  'pm-pick-id': () => <PmPickId />,
  'pm-pnpm-lookup': () => <PmPnpmLookup />,
  'pm-sources': () => <PmSources />,
  'pm-requires': () => <PmRequires />,
  'pm-tested-kernel': () => <PmTestedKernel />,
  'dk-scaffold': () => <DkScaffold />,
  'dk-dev-loop': () => <DkDevLoop />,
  'dk-home-new': () => <DkHomeNew />,
  'dk-release': () => <DkRelease />,
  'dk-audit-deps': () => <DkAuditDeps />,
  'dk-cdp': () => <DkCdp />,
  'rk-self-report-guard': () => <RkSelfReportGuard />,
  'rk-plugin-guard': () => <RkPluginGuard />,
  'seam-version-fields': () => <SeamVersionFields />,
  'seam-repo-shape': () => <SeamRepoShape />,
  'seam-service-table': () => <SeamServiceTable />,
}

export function Diagram({ name, title, children }: { name: string; title?: string; children?: ReactNode }) {
  const draw = drawings[name]
  if (draw === undefined) throw new Error(`没有叫「${name}」的图：src/components/diagram.tsx 的 drawings 表里没有登记`)
  return (
    <figure className="diagram">
      {title !== undefined && <figcaption className="diagram-title">{title}</figcaption>}
      <div className="diagram-canvas">{draw()}</div>
      {children !== undefined && <div className="diagram-text">{children}</div>}
    </figure>
  )
}
