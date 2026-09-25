import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installedPackageManifestFile, installedPackageRealpath, readHomeDependencies, readInstalledPackageManifest, readNpmrc, writeNpmrc } from '../src/home.js'

/** 读 home 的 `package.json`。这条真的读磁盘，所以在临时目录里跑 */

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-home-test-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('home 的 package.json', () => {
  it('读得出 dependencies', async () => {
    fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }), 'utf8')
    expect(await readHomeDependencies(home)).toEqual({ a: '1.0.0' })
  })

  it('清单不在、不是合法 JSON：抛错，报错里有清单路径', async () => {
    const file = path.join(home, 'package.json')
    await expect(readHomeDependencies(home)).rejects.toThrow(file)
    fs.writeFileSync(file, '{ not json', 'utf8')
    await expect(readHomeDependencies(home)).rejects.toThrow(`${file} 不是合法的 JSON`)
  })
})

describe('装在 home 里的包自己的 package.json', () => {
  function writeInstalledManifest(pkg: string, text: string): void {
    const dir = path.join(home, 'node_modules', ...pkg.split('/'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), text, 'utf8')
  }

  it('按包名（含 scope）从 node_modules 读出解析后的清单', async () => {
    writeInstalledManifest('@x/gwb-a', JSON.stringify({ name: '@x/gwb-a', peerDependencies: { '@godcreator/gwb-kernel-desktop': '^0.3.0' } }))
    expect(await readInstalledPackageManifest(home, '@x/gwb-a')).toEqual({ name: '@x/gwb-a', peerDependencies: { '@godcreator/gwb-kernel-desktop': '^0.3.0' } })
  })

  it('包不在 node_modules 里时是 undefined', async () => {
    expect(await readInstalledPackageManifest(home, '@x/not-installed')).toBeUndefined()
  })

  it('清单不是合法 JSON 时抛错，报错里有文件路径', async () => {
    writeInstalledManifest('broken', '{ not json')
    await expect(readInstalledPackageManifest(home, 'broken')).rejects.toThrow(installedPackageManifestFile(home, 'broken'))
  })
})

describe('装在 home 里的包的真实目录', () => {
  /** 照 pnpm 的布局：`node_modules/<包名>` 是指向 `.pnpm/<目录名>/node_modules/<包名>` 的目录链接 */
  function linkInstalled(pkg: string, dirName: string): string {
    const real = path.join(home, 'node_modules', '.pnpm', dirName, 'node_modules', ...pkg.split('/'))
    fs.mkdirSync(real, { recursive: true })
    const link = path.join(home, 'node_modules', ...pkg.split('/'))
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(real, link, 'junction')
    return real
  }

  it('node_modules/<包名> 是目录链接：回它指向的真实目录', async () => {
    const real = linkInstalled('@x/gwb-a', '@x+gwb-a@1.0.0_@x+gwb-b@1.0.0')
    expect(await installedPackageRealpath(home, '@x/gwb-a')).toBe(await fs.promises.realpath(real))
  })

  it('包不在 node_modules 里时是 undefined', async () => {
    expect(await installedPackageRealpath(home, '@x/not-installed')).toBeUndefined()
  })
})

describe('npmrc 的读写', () => {
  it('文件不在读成空文本；写完读回原样，目录里不留临时文件', async () => {
    const file = path.join(home, '.npmrc')
    expect(await readNpmrc(file)).toBe('')
    await writeNpmrc(file, '@j:registry=https://j.example/npm/\n')
    expect(await readNpmrc(file)).toBe('@j:registry=https://j.example/npm/\n')
    expect(fs.readdirSync(home)).toEqual(['.npmrc'])
  })

  it('路径在但读不了（是个目录）时抛错，报错里有路径', async () => {
    const dir = path.join(home, 'not-a-file')
    fs.mkdirSync(dir)
    await expect(readNpmrc(dir)).rejects.toThrow(dir)
  })
})
