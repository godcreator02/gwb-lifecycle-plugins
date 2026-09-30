'use client'

/**
 * 谁会被重新加载：读者给四个包各挑「不点名 / 升级 / 按原版本重装」，当场看到每个包升级前后的真实目录名、
 * 归进回执的哪一组、重新加载的先后，以及这组选择对应的那条命令。判断只用页面正文写的规则：
 * 目录变了的都重新加载；目录名里带着 peer 的版本；先后按这批包之间的 peer 排，被依赖的先、同一层按包名；插件管理自己与 peer 了它的包排到回执之后。
 */
import { useState, type CSSProperties } from 'react'

type PackageId = 'baseui' | 'clock' | 'notes' | 'pm' | 'shell'
type Action = 'keep' | 'upgrade' | 'reinstall'

interface DemoPackage {
  id: PackageId
  label: string
  initial: string
  color: string
  name: string
  installed: string
  latest?: string
  peers: PackageId[]
  isPluginManager?: boolean
}

/** 按包名排：同一层里的先后按包名 */
const PACKAGES: DemoPackage[] = [
  { id: 'baseui', label: '基础界面', initial: '界', color: '#f59e0b', name: 'gwb-baseui', installed: '0.9.0', peers: ['pm'] },
  { id: 'clock', label: '时钟', initial: '时', color: '#0ea5e9', name: 'gwb-clock', installed: '0.2.0', latest: '0.2.1', peers: [] },
  { id: 'notes', label: '笔记', initial: '笔', color: '#e84393', name: 'gwb-notes', installed: '0.3.0', peers: ['shell'] },
  { id: 'pm', label: '插件管理', initial: '管', color: '#7c3aed', name: 'gwb-plugin-manager', installed: '0.14.1', latest: '0.14.2', peers: [], isPluginManager: true },
  { id: 'shell', label: '外壳', initial: '壳', color: '#16a34a', name: 'gwb-shell', installed: '0.14.0', latest: '0.14.1', peers: [] },
]
const byId = (id: PackageId): DemoPackage => PACKAGES.find((pkg) => pkg.id === id)!

type Versions = Record<PackageId, string>
const INSTALLED = Object.fromEntries(PACKAGES.map((pkg) => [pkg.id, pkg.installed])) as Versions

function versionsAfter(actions: Record<PackageId, Action>): Versions {
  return Object.fromEntries(PACKAGES.map((pkg) => [pkg.id, actions[pkg.id] === 'upgrade' && pkg.latest !== undefined ? pkg.latest : pkg.installed])) as Versions
}

/** pnpm 存放包的目录名（省去范围与 .pnpm 前缀）：自己的版本，后面接每个 peer 的版本 */
function segmentsOf(pkg: DemoPackage, after: Versions): { text: string; changed: boolean }[] {
  return [
    { text: `${pkg.name}@${after[pkg.id]}`, changed: after[pkg.id] !== INSTALLED[pkg.id] },
    ...pkg.peers.map((peer) => ({ text: `_${byId(peer).name}@${after[peer]}`, changed: after[peer] !== INSTALLED[peer] })),
  ]
}

/** 只看这批包之间的 peer：被依赖的先，前面的都排完后同时可以重新加载的算一层，同一层按包名 */
function inPeerOrder(batch: readonly DemoPackage[]): DemoPackage[] {
  const ordered: DemoPackage[] = []
  let rest = [...batch]
  while (rest.length > 0) {
    const layer = rest.filter((pkg) => pkg.peers.every((peer) => !rest.some((other) => other.id === peer)))
    ordered.push(...layer.sort((a, b) => a.name.localeCompare(b.name)))
    rest = rest.filter((pkg) => !layer.includes(pkg))
  }
  return ordered
}

type Verdict = 'reload' | 'same' | 'dependent' | 'none'
const VERDICT_TEXT: Record<Verdict, string> = {
  reload: 'updated · 目录变了，重新加载',
  same: 'updated · 目录没变，不动',
  dependent: 'dependents · 没点名，目录跟着变了，重新加载',
  none: '没点名，目录没变',
}

/** 三种参数只能给一种：全是升级就是 only；有按原版本重装的，整条写成 specs（specs 也能写新版本号） */
function Command({ actions, after }: { actions: Record<PackageId, Action>; after: Versions }) {
  const named = PACKAGES.filter((pkg) => actions[pkg.id] !== 'keep')
  if (named.length === 0) return <span className="rp-prompt">（给一个包点名）</span>
  const onlyUpgrades = named.every((pkg) => actions[pkg.id] === 'upgrade')
  return (
    <span key={named.map((pkg) => `${pkg.id}${actions[pkg.id]}`).join()}>
      {'{'}
      <span className="rp-key">"{onlyUpgrades ? 'only' : 'specs'}"</span>:{onlyUpgrades ? '[' : '{'}
      {named.map((pkg, index) => (
        <span key={pkg.id}>
          {index > 0 && ','}
          <span className="rp-str">"{pkg.name}"</span>
          {!onlyUpgrades && (
            <>
              :<span className="rp-str">"{after[pkg.id]}"</span>
            </>
          )}
        </span>
      ))}
      {onlyUpgrades ? ']' : '}'}
      {'}'}
    </span>
  )
}

export function ReloadPicker() {
  const [actions, setActions] = useState<Record<PackageId, Action>>({ baseui: 'keep', clock: 'keep', notes: 'keep', pm: 'keep', shell: 'upgrade' })
  const after = versionsAfter(actions)
  const verdictOf = (pkg: DemoPackage): Verdict => {
    const changed = segmentsOf(pkg, after).some((segment) => segment.changed)
    if (actions[pkg.id] !== 'keep') return changed ? 'reload' : 'same'
    return changed ? 'dependent' : 'none'
  }
  const queue = inPeerOrder(PACKAGES.filter((pkg) => verdictOf(pkg) === 'reload' || verdictOf(pkg) === 'dependent'))
  const waitsForPluginManager = new Set<PackageId>()
  for (const pkg of queue) {
    if (pkg.isPluginManager || pkg.peers.some((peer) => waitsForPluginManager.has(peer))) waitsForPluginManager.add(pkg.id)
  }
  const inCommand = queue.filter((pkg) => !waitsForPluginManager.has(pkg.id))
  const afterReceipt = queue.filter((pkg) => waitsForPluginManager.has(pkg.id))
  const anyNamed = PACKAGES.some((pkg) => actions[pkg.id] !== 'keep')
  const trainKey = queue.map((pkg) => pkg.id).join()

  return (
    <figure className="rp not-prose">
      <div className="rp-title">挑几个包，看谁要重新加载</div>
      <div className="rp-term">
        <span className="rp-prompt">$ plugin-manager.update </span>
        <Command actions={actions} after={after} />
      </div>

      <div className="rp-rows">
        {PACKAGES.map((pkg) => {
          const verdict = verdictOf(pkg)
          return (
            <div key={pkg.id} className="rp-row" data-hot={verdict === 'reload' || verdict === 'dependent' ? '' : undefined} style={{ '--pkg': pkg.color } as CSSProperties}>
              <div className="rp-avatar" aria-hidden>
                {pkg.initial}
              </div>
              <div>
                <div className="rp-top">
                  <div>
                    <span className="rp-name">{pkg.label}</span>
                    <span className="rp-ver">
                      {pkg.installed}
                      {after[pkg.id] !== pkg.installed && <b> → {after[pkg.id]}</b>}
                      {pkg.peers.length > 0 && <> · peer 写了{pkg.peers.map((peer) => byId(peer).label).join('、')}</>}
                    </span>
                  </div>
                  <div className="rp-switch" role="group" aria-label={`${pkg.label}这次怎么装`}>
                    {(['keep', 'upgrade', 'reinstall'] as const).map((action) => (
                      <button
                        key={action}
                        type="button"
                        aria-pressed={actions[pkg.id] === action}
                        disabled={action === 'upgrade' && pkg.latest === undefined}
                        onClick={() => setActions({ ...actions, [pkg.id]: action })}
                      >
                        {action === 'keep' ? '不点名' : action === 'upgrade' ? (pkg.latest === undefined ? '已是最新' : `升到 ${pkg.latest}`) : '原版本重装'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rp-bottom">
                  <span className="rp-tag">
                    .pnpm/
                    {segmentsOf(pkg, after).map((segment, index) => (
                      <span key={`${index}-${segment.text}`} className={segment.changed ? 'rp-seg rp-mark' : 'rp-seg'}>
                        {segment.text}
                      </span>
                    ))}
                  </span>
                  <span key={verdict} className="rp-sticker" data-kind={verdict}>
                    {VERDICT_TEXT[verdict]}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="rp-train">
        <div className="rp-train-title">重新加载的先后：两组合在一起按 peer 排，被依赖的先、同一层按包名；插件管理与 peer 了它的包在回执之后</div>
        <div className="rp-cars">
          {!anyNamed ? (
            <span style={{ color: '#8f8ab5', fontSize: 14 }}>还没点名，没有要重新加载的包。</span>
          ) : queue.length === 0 ? (
            <span style={{ color: '#8f8ab5', fontSize: 14 }}>点了名的包目录都没变：一条条目都不重新加载。</span>
          ) : (
            <>
              {inCommand.map((pkg, index) => (
                <span key={`${pkg.id}-${trainKey}`} style={{ display: 'contents' }}>
                  {index > 0 && <span className="rp-link" aria-hidden />}
                  <span className="rp-car" style={{ '--pkg': pkg.color, animationDelay: `${index * 0.08}s` } as CSSProperties}>
                    {pkg.label}
                    <small>第 {index + 1} 个</small>
                  </span>
                </span>
              ))}
              {afterReceipt.length > 0 && (
                <>
                  <span key={`receipt-${trainKey}`} className="rp-sticker" data-kind="same" style={{ margin: '0 6px' }}>
                    ✉ 回执发出
                  </span>
                  {afterReceipt.map((pkg, index) => (
                    <span key={`${pkg.id}-${trainKey}`} style={{ display: 'contents' }}>
                      {index > 0 && <span className="rp-link" aria-hidden />}
                      <span
                        className="rp-car"
                        data-later=""
                        style={{ '--pkg': pkg.color, animationDelay: `${(inCommand.length + index) * 0.08 + 0.15}s` } as CSSProperties}
                      >
                        {pkg.label}
                        <small>回执之后第 {index + 1} 个</small>
                      </span>
                    </span>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </figure>
  )
}
