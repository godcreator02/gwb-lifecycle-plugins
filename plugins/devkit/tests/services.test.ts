import { describe, expect, it } from 'vitest'
import { serviceOwners } from '../src/services.js'

/** 造一条 cordis 的 `Impl`：服务名 + 提供者那条挂载条目 */
function impl(service: string, entry?: { id?: string; name?: string }): Record<string, unknown> {
  return {
    name: service,
    fiber: { entry: entry === undefined ? {} : { id: entry.id, options: { name: entry.name } } },
  }
}

describe('devkit.services：问运行时要服务表', () => {
  it('从 reflect.store 里把服务 → 提供者捞出来，按包名排', () => {
    const out = serviceOwners({
      store: {
        gwbKernel: impl('gwbKernel'),
        gwbShell: impl('gwbShell', { id: 'home:shell', name: '@godcreator/gwb-shell' }),
        gwbData: impl('gwbData', { id: 'home:data', name: '@godcreator/gwb-data' }),
      },
    })
    expect(out).toEqual([
      { service: 'gwbKernel' },
      { service: 'gwbData', entryId: 'home:data', pkg: '@godcreator/gwb-data' },
      { service: 'gwbShell', entryId: 'home:shell', pkg: '@godcreator/gwb-shell' },
    ])
  })

  it('内核自己挂的服务没有挂载条目——照样报服务名，不编造 pkg', () => {
    expect(serviceOwners({ store: { gwbKernel: impl('gwbKernel') } })).toEqual([{ service: 'gwbKernel' }])
  })

  it('条目形状认不出时退回 key 当服务名，其余不写', () => {
    expect(serviceOwners({ store: { gwbThing: {} } })).toEqual([{ service: 'gwbThing' }])
    expect(serviceOwners({ store: { gwbThing: { name: 'gwbThing', fiber: '不是对象' } } })).toEqual([
      { service: 'gwbThing' },
    ])
  })

  it('拿不到那张表时回空表——换了内部形状、或宿主不是 cordis，都不抛', () => {
    expect(serviceOwners(undefined)).toEqual([])
    expect(serviceOwners({})).toEqual([])
    expect(serviceOwners({ store: '不是对象' })).toEqual([])
    expect(serviceOwners([])).toEqual([])
  })
})
