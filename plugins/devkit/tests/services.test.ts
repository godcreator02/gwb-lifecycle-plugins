import { describe, expect, it } from 'vitest'
import { serviceOwners, serviceSight } from '../src/services.js'

/** 造一截 fiber：store 里每条 impl 的 `fiber` 指回自己（＝本 fiber 提供的服务） */
function fiber(store: Record<string, string>, opts: { id?: string; name?: string; runtime?: string } = {}): Record<string, unknown> {
  const self: Record<string, unknown> = {
    entry: opts.id === undefined && opts.name === undefined ? undefined : { id: opts.id, options: { name: opts.name } },
    runtime: opts.runtime === undefined ? undefined : { name: opts.runtime, fibers: [] },
    parent: undefined,
  }
  self['store'] = Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { name: v, fiber: self }]))
  return self
}

/** 注入作用域那种 fiber：store 里有服务，但 impl.fiber 指向别人（＝它消费的，不是它提供的） */
function injectScope(store: Record<string, string>, owner: Record<string, unknown>): Record<string, unknown> {
  return {
    store: Object.fromEntries(Object.entries(store).map(([k, v]) => [k, { name: v, fiber: owner }])),
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

  it('注入作用域的 fiber 不算提供方——它 store 里的 impl 指着别人', () => {
    const shell = fiber({ gwbShell: 'gwbShell' }, { id: 'home:shell', name: '@godcreator/gwb-shell' })
    const baseui = fiber({}, { id: 'home:baseui', name: '@godcreator/gwb-baseui' })
    const scope = injectScope({ gwbShell: 'gwbShell' }, shell)
    const out = serviceOwners(
      ctxWith(fiber({}), [
        { name: '@godcreator/gwb-shell', fibers: [shell, injectScope({ gwbShell: 'gwbShell' }, shell)] },
        { name: '@godcreator/gwb-baseui', fibers: [baseui, scope] },
      ]),
    )
    expect(out).toEqual([{ service: 'gwbShell', entryId: 'home:shell', pkg: '@godcreator/gwb-shell' }])
  })

  it('没有挂载条目时退回件自报的名字', () => {
    const inner = fiber({ gwbThing: 'gwbThing' }, { runtime: 'gwb-thing' })
    expect(serviceOwners(ctxWith(fiber({}), [{ fibers: [inner] }]))).toEqual([{ service: 'gwbThing', pkg: 'gwb-thing' }])
  })

  it('同一个服务两个件都提供时两条都报', () => {
    const a = fiber({ gwbX: 'gwbX' }, { id: 'home:a', name: 'pkg-a' })
    const b = fiber({ gwbX: 'gwbX' }, { id: 'home:b', name: 'pkg-b' })
    const out = serviceOwners(ctxWith(fiber({}), [{ fibers: [a] }, { fibers: [b] }]))
    expect(out).toEqual([
      { service: 'gwbX', entryId: 'home:a', pkg: 'pkg-a' },
      { service: 'gwbX', entryId: 'home:b', pkg: 'pkg-b' },
    ])
  })

  it('saw 记下看见了多少：链几层、件几个、fiber 几条、服务表几张', () => {
    const root = fiber({ gwbKernel: 'gwbKernel' })
    const mine = fiber({}, { id: 'home:devkit', name: '@godcreator/gwb-devkit' })
    const shell = fiber({ gwbShell: 'gwbShell' }, { id: 'home:shell', name: '@godcreator/gwb-shell' })
    const { saw } = serviceSight(ctxWith(chain(mine, root), [{ fibers: [shell] }]))
    expect(saw).toEqual({ chainDepth: 2, runtimes: 1, fibers: 1, stores: 3 })
  })

  it('拿不到那些表时回空表——换了形状、或宿主不是 cordis，都不抛', () => {
    expect(serviceOwners(undefined)).toEqual([])
    expect(serviceOwners({})).toEqual([])
    expect(serviceOwners({ fiber: '不是对象', registry: { entries: '不是函数' } })).toEqual([])
    expect(serviceOwners({ fiber: { store: '不是对象' }, registry: { entries: () => [[0, { fibers: '不是数组' }]] } })).toEqual([])
    expect(serviceSight(undefined).saw).toEqual({ chainDepth: 0, runtimes: 0, fibers: 0, stores: 0 })
  })
})
