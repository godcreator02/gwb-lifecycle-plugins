import { describe, expect, it } from 'vitest'
import { asTree } from '../src/tree.js'

/** loader 那棵树上我们用得着的四样 */
function fakeTree(missing?: string): Record<string, unknown> {
  const tree: Record<string, unknown> = {
    store: {},
    create: () => Promise.resolve('home:x'),
    remove: () => undefined,
    update: () => Promise.resolve(),
    resolve: () => undefined,
  }
  if (missing !== undefined) delete tree[missing]
  return tree
}

describe('认一棵条目树', () => {
  it('四样都在就认', () => {
    const tree = fakeTree()
    expect(asTree(tree)).toBe(tree)
  })

  it('少一样当场说清楚少的是哪个——比后面某一步莫名其妙失败好查', () => {
    for (const key of ['create', 'remove', 'update', 'resolve']) {
      expect(() => asTree(fakeTree(key)), key).toThrow(new RegExp(key))
    }
  })

  it('那一格根本不是对象时说的是「取不到树」,不是「少了某个方法」', () => {
    for (const bad of [undefined, null, 'nope', 42]) {
      expect(() => asTree(bad)).toThrow(/cordis\.yml/)
    }
  })
})
