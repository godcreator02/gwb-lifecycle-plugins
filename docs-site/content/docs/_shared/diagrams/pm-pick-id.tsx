
/**
 * 选 id 的几个例子：上面的按钮切换例子，每个例子一步步做下去。左栏是条目树上现有的 id（插件管理选 id 只看它），
 * 中栏是磁盘上数据插件、设置插件记下的归属（删了条目也还在，插件管理不读），右栏是这一步做了什么、结果如何。
 * 结果是按 ids.ts 的规则手工算好写在这里的。
 */

import { useState } from 'react'
import { BORDER, FG, MONO, MUTED, Note, StepCaption } from './parts'
import { StepControls, useSteps } from './steps'

interface Row {
  id: string
  pkg: string
}

interface Action {
  what: string
  result: string
  rejected?: boolean
  tree: Row[]
  owners: Row[]
  caption: string
}

interface Example {
  tab: string
  tree: Row[]
  owners: Row[]
  intro: string
  actions: Action[]
}

const A = '@a/gwb-foo'
const B = '@b/foo'
const PY = '@godcreator/gwb-py-cli'

const EXAMPLES: Example[] = [
  {
    tab: '同一个包装两条',
    tree: [{ id: 'py-cli', pkg: PY }],
    owners: [{ id: 'py-cli', pkg: PY }],
    intro: '一个包可以有好几条条目，各是一个实例、各存各的数据。给同一个包再加一条条目。',
    actions: [
      { what: `add-entry ${PY}`, result: 'py-cli 被占，拿到 py-cli-2', tree: [{ id: 'py-cli', pkg: PY }, { id: 'py-cli-2', pkg: PY }], owners: [{ id: 'py-cli', pkg: PY }, { id: 'py-cli-2', pkg: PY }], caption: '默认 id py-cli 在条目树上已被占着，从 -2 起找第一个空着的号。' },
    ],
  },
  {
    tab: '不同源上的同名插件',
    tree: [],
    owners: [],
    intro: '两个不同的包去掉 scope 与 gwb- 前缀后都叫 foo。先装 A，再装 B，两个同时装着。',
    actions: [
      { what: `install ${A}`, result: '默认 id foo，拿到 foo', tree: [{ id: 'foo', pkg: A }], owners: [{ id: 'foo', pkg: A }], caption: '条目树上没有 foo，用默认 id。插件加载后，数据插件、设置插件记下 foo 属于 A。' },
      { what: `install ${B}`, result: 'foo 被占，拿到 foo-2', tree: [{ id: 'foo', pkg: A }, { id: 'foo-2', pkg: B }], owners: [{ id: 'foo', pkg: A }, { id: 'foo-2', pkg: B }], caption: '条目树上 foo 已被 A 占着，B 拿到 foo-2，两个插件各用各的数据与设置。' },
    ],
  },
  {
    tab: '卸载后，别的包同名',
    tree: [{ id: 'foo', pkg: A }],
    owners: [{ id: 'foo', pkg: A }],
    intro: 'A 装着、用的是 foo。卸载 A，再装 B。',
    actions: [
      { what: `uninstall ${A}`, result: '条目删了，归属还在', tree: [], owners: [{ id: 'foo', pkg: A }], caption: '卸载只删条目和包，数据与设置留在磁盘上，数据插件、设置插件的归属记录也留着。' },
      { what: `install ${B}`, result: '拿到 foo，加载时报错', rejected: true, tree: [{ id: 'foo', pkg: B }], owners: [{ id: 'foo', pkg: A }], caption: '插件管理只看条目树，foo 空着就给 B。B 加载时读到属于 A 的数据目录与设置分区，由数据插件与设置插件的归属检查报错，插件管理不管。' },
    ],
  },
]
function Rows({ x, title, rows, arrow }: { x: number; title: string; rows: Row[]; arrow: string }) {
  return (
    <g>
      <Note x={x} y={70} size={12} color={FG} weight={600}>
        {title}
      </Note>
      <rect x={x - 8} y={80} width={236} height={120} rx={8} fill="none" stroke={BORDER} />
      {rows.length === 0 && (
        <Note x={x} y={104} size={11.5} color={MUTED}>
          （空）
        </Note>
      )}
      {rows.map((row, index) => (
        <text key={`${row.id}-${row.pkg}`} x={x} y={104 + index * 24} fontSize={11} fill={FG} fontFamily={MONO}>
          {`${row.id} ${arrow} ${row.pkg}`}
        </text>
      ))}
    </g>
  )
}

export function PmPickId() {
  const [exampleIndex, setExampleIndex] = useState(0)
  const example = EXAMPLES[exampleIndex]!
  const count = example.actions.length + 1
  const state = useSteps(count, 3200)
  const step = Math.min(state.step, count - 1)
  const action = step === 0 ? undefined : example.actions[step - 1]
  const tree = action?.tree ?? example.tree
  const owners = action?.owners ?? example.owners

  const choose = (index: number) => {
    setExampleIndex(index)
    state.setStep(0)
  }

  const resultColor = action === undefined ? MUTED : action.rejected ? 'var(--diagram-b)' : 'var(--diagram-a)'

  return (
    <>
      <div className="diagram-controls" style={{ flexWrap: 'wrap', paddingTop: 8 }}>
        {EXAMPLES.map((one, index) => (
          <button key={one.tab} type="button" aria-pressed={index === exampleIndex} onClick={() => choose(index)}>
            {one.tab}
          </button>
        ))}
      </div>
      <svg viewBox="0 0 760 290" role="img" aria-label={`选 id 的例子：${example.tab}`}>
        <Note x={20} y={30} size={11.5} color={MUTED}>
          {`第 ${step} / ${count - 1} 步`}
        </Note>
        <Rows x={28} title="条目树上的 id" rows={tree} arrow="←" />
        <Rows x={278} title="磁盘上的归属（插件管理不读）" rows={owners} arrow="→" />

        <Note x={528} y={70} size={12} color={FG} weight={600}>
          这一步
        </Note>
        <rect x={520} y={80} width={226} height={120} rx={8} fill={action === undefined ? 'none' : action.rejected ? 'var(--diagram-b-soft)' : 'var(--diagram-a-soft)'} stroke={resultColor} strokeWidth={1.2} />
        {action === undefined ? (
          <Note x={532} y={104} size={11.5} color={MUTED}>
            点「下一步」开始
          </Note>
        ) : (
          <>
            <text x={532} y={104} fontSize={11} fill={FG} fontFamily={MONO}>
              {action.what}
            </text>
            <Note x={532} y={132} size={12.5} color={resultColor} weight={600}>
              {action.result}
            </Note>
          </>
        )}

        <StepCaption x={20} y={232} w={720} title={action === undefined ? example.tab : action.what} detail={action === undefined ? example.intro : action.caption} />
      </svg>
      <StepControls count={count} state={state} />
    </>
  )
}
