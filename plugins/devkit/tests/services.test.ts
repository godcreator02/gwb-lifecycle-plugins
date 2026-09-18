import { describe, expect, it } from 'vitest'
import { serviceOwners } from '../src/services.js'

/** 造一截 fiber 链：每层一张服务表，可选挂载条目与件的自报名 */
function fiber(store: Record<string, string>, opts: { id?: string; name?: string; runtime?: string } = {}): Record<string, unknown> {
  return {
    store: Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { name: v }])),
    entry: opts.id === undefined && opts.name === undefined ? undefined : { id: opts.id, options: { name: opts.name } },
    runtime: opts.runtime === undefined ? undefined : { name: opts.runtime, fibers: [] },
    parent: undefined,
  }
}

function chain(...fibers: Record<string, unknown>[]): Record<string, unknown> {
  for (let i = 0; i < fibers.length - 1; i++) (fibers[i] as { parent: unknown })['parent'] = { fiber: fibers[i + 1] }
  return fibers[0]!
}

function ctxWith(fiberChain: Record<string, unknown>, runtimes: Record<string, unknown>[] = []): Record<string, unknown> {
  return { fiber: fiberChain, registry: { entries: () => runtimes.map((r, i) => [i, r]) } }
}

describe('devkit.services：问运行时要服务表', () => {
  it('沿自己的 fiber 链往上：捞到根上挂的服务（没有条目、没有包名）', () => {
    const root = fiber({ gwbKernel: 'gwbKernel' })
    const mine = fiber({}, { id: 'home:devkit', name: '@godcreator/gwb-devkit' })
    expect(serviceOwners(ctxWith(chain(mine, root)))).toEqual([{ service: 'gwbKernel' }])
  })

  it('registry 里每个件的 fiber：带条目名与包名', () => {
    const shell = fiber({ gwbShell: 'gwbShell' }, { id: 'home:shell', name: '@godcreator/gwb-shell' })
    const data = fiber({ gwbData: 'gwbData' }, { id: 'home:data', name: '@godcreator/gwb-data' })
    const out = serviceOwners(ctxWith(fiber({}), [{ name: '@godcreator/gwb-shell', fibers: [shell] }, { name: '@godcreator/gwb-data', fibers: [data] }]))
    expect(out).toEqual([
      { service: 'gwbData', entryId: 'home:data', pkg: '@godcreator/gwb-data' },
      { service: 'gwbShell', entryId: 'home:shell', pkg: '@godcreator/gwb-shell' },
    ])
  })

  it('没有挂载条目时退回件自报的名字', () => {
    const inner = fiber({ gwbThing: 'gwbThing' }, { runtime: 'gwb-thing' })
    expect(serviceOwners(ctxWith(fiber({}), [{ fibers: [inner] }]))).toEqual([{ service: 'gwbThing', pkg: 'gwb-thing' }])
  })

  it('同一个服务两张表都出现时只报一条，两条链上的都报', () => {
    const a = fiber({ gwbX: 'gwbX' }, { id: 'home:a', name: 'pkg-a' })
    const b = fiber({ gwbX: 'gwbX' }, { id: 'home:b', name: 'pkg-b' })
    const out = serviceOwners(ctxWith(fiber({}), [{ fibers: [a] }, { fibers: [b] }]))
    expect(out).toEqual([
      { service: 'gwbX', entryId: 'home:a', pkg: 'pkg-a' },
      { service: 'gwbX', entryId: 'home:b', pkg: 'pkg-b' },
    ])
  })

  it('拿不到那些表时回空表——换了形状、或宿主不是 cordis，都不抛', () => {
    expect(serviceOwners(undefined)).toEqual([])
    expect(serviceOwners({})).toEqual([])
    expect(serviceOwners({ fiber: '不是对象', registry: { entries: '不是函数' } })).toEqual([])
    expect(serviceOwners({ fiber: { store: '不是对象' }, registry: { entries: () => [[0, { fibers: '不是数组' }]] } })).toEqual([])
  })
})
