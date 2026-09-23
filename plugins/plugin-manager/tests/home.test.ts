import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHomeDependencies } from '../src/home.js'

/** 读 home 的 `package.json`。这条真的读磁盘，所以在临时目录里跑 */

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-home-test-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('home 的 package.json', () => {
  it('读得出 dependencies；清单不在、坏了都当空表', async () => {
    expect(await readHomeDependencies(home)).toEqual({})
    fs.writeFileSync(path.join(home, 'package.json'), '{ not json', 'utf8')
    expect(await readHomeDependencies(home)).toEqual({})
    fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }), 'utf8')
    expect(await readHomeDependencies(home)).toEqual({ a: '1.0.0' })
  })
})
