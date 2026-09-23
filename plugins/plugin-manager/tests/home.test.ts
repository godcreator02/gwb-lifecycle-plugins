import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readHomeDependencies, readInstalledManifest, readPeerManifest } from '../src/home.js'

/**
 * 读 home 那几份清单。**这几条是真去碰盘的**，所以在临时目录里搭一份 pnpm 的布局来跑：
 * `readPeerManifest` 要越过的正是那层软链——虚拟仓的形状猜错，peer 的种类就一律认不出，
 * 共享包会被当件跳过，而这一步没有任何现象。
 */

let home: string

/** 一份清单落盘，目录顺手建出来 */
function writeManifest(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value), 'utf8')
}

/**
 * 照 pnpm 的样子摆一个包：真身躺在 `.pnpm/<key>/node_modules/<包名>`，
 * `<home>/node_modules/<包名>` 是一条指过去的软链，peer 跟真身并排躺在同一层 node_modules 里
 */
function installLikePnpm(pkg: string, key: string, manifest: unknown, peers: Record<string, unknown> = {}): void {
  const face = path.join(home, 'node_modules', '.pnpm', key, 'node_modules')
  writeManifest(path.join(face, ...pkg.split('/'), 'package.json'), manifest)
  for (const [peer, value] of Object.entries(peers)) {
    writeManifest(path.join(face, ...peer.split('/'), 'package.json'), value)
  }
  const link = path.join(home, 'node_modules', ...pkg.split('/'))
  fs.mkdirSync(path.dirname(link), { recursive: true })
  // junction 而不是 symlink：Windows 上建目录软链要特权，junction 不用
  fs.symlinkSync(path.join(face, ...pkg.split('/')), link, 'junction')
}

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
    writeManifest(path.join(home, 'package.json'), { dependencies: { a: '1.0.0' } })
    expect(await readHomeDependencies(home)).toEqual({ a: '1.0.0' })
  })
})

describe('home 里装着的包自己那份清单', () => {
  it('读得出；没装回 undefined', async () => {
    installLikePnpm('@scope/thing', 'thing@1.0.0', { name: '@scope/thing', version: '1.0.0' })
    expect(await readInstalledManifest(home, '@scope/thing')).toMatchObject({ version: '1.0.0' })
    expect(await readInstalledManifest(home, '@scope/absent')).toBeUndefined()
  })
})

describe('一条 peer 的清单', () => {
  it('从虚拟仓里读——那层软链要先解开，peer 跟包并排躺在同一层 node_modules', async () => {
    installLikePnpm('@scope/owner', 'owner@1.0.0', { name: '@scope/owner' }, {
      '@scope/lib': { name: '@scope/lib', gwb: { shared: {} } },
      bare: { name: 'bare' },
    })
    expect(await readPeerManifest(home, '@scope/owner', '@scope/lib')).toMatchObject({ gwb: { shared: {} } })
    expect(await readPeerManifest(home, '@scope/owner', 'bare')).toMatchObject({ name: 'bare' })
  })

  it('虚拟仓里没有就退到 home 顶层——已经是直接依赖的 peer 在那儿', async () => {
    installLikePnpm('@scope/owner', 'owner@1.0.0', { name: '@scope/owner' })
    writeManifest(path.join(home, 'node_modules', '@scope', 'lib', 'package.json'), { name: '@scope/lib' })
    expect(await readPeerManifest(home, '@scope/owner', '@scope/lib')).toMatchObject({ name: '@scope/lib' })
  })

  it('两处都没有（optional 的 peer pnpm 不补）回 undefined，不抛', async () => {
    installLikePnpm('@scope/owner', 'owner@1.0.0', { name: '@scope/owner' })
    expect(await readPeerManifest(home, '@scope/owner', '@scope/nope')).toBeUndefined()
  })

  it('包根本没装、软链解不开也不抛', async () => {
    expect(await readPeerManifest(home, '@scope/ghost', '@scope/lib')).toBeUndefined()
  })

  it('不是软链的平铺布局照样读得到（包与 peer 并排在 node_modules 里）', async () => {
    writeManifest(path.join(home, 'node_modules', 'owner', 'package.json'), { name: 'owner' })
    writeManifest(path.join(home, 'node_modules', 'lib', 'package.json'), { name: 'lib' })
    expect(await readPeerManifest(home, 'owner', 'lib')).toMatchObject({ name: 'lib' })
  })
})
