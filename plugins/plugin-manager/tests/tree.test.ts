import { describe, expect, it } from 'vitest'
import { asTree } from '../src/tree.js'

describe('认一棵条目树', () => {
  it('是对象就认', () => {
    const tree = { store: {}, create: () => Promise.resolve('home:x'), remove: () => undefined, update: () => Promise.resolve() }
    expect(asTree(tree)).toBe(tree)
  })

  it('那一格根本不是对象时说的是「取不到树」', () => {
    for (const bad of [undefined, null, 'nope', 42]) {
      expect(() => asTree(bad)).toThrow(/cordis\.yml/)
    }
  })
})
