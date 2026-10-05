import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoProjectRegistryAuth, homeRegistryTokens, registryEnvironment, registryTokens, withRegistryAuthFile } from '../src/registry-auth.js'

const dirs: string[] = []
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-auth-test-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir) } })
const key = '//registry.example/npm/:_authToken'

describe('home registry credentials', () => {
  it('rejects project-level auth before spawning pnpm instead of silently accepting its higher priority', () => {
    const dir = fixture()
    fs.writeFileSync(path.join(dir, '.npmrc'), `${key}=project-secret`)
    expect(() => assertNoProjectRegistryAuth(dir)).toThrow('会覆盖 home 凭据')
    fs.writeFileSync(path.join(dir, '.npmrc'), '@example:registry=https://registry.example/npm/')
    expect(() => assertNoProjectRegistryAuth(dir)).not.toThrow()
  })
  it('missing home and cleared slot are anonymous without reading another home or legacy settings', () => {
    const dir = fixture()
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ '*': { 'npm-auth': { type: 'secret', value: JSON.stringify({ [key]: 'old-token' }) } } }))
    expect(homeRegistryTokens(dir)).toEqual({})
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ version: 1, sections: { '*': { 'npm-auth': {} } } }))
    expect(homeRegistryTokens(dir)).toEqual({})
  })
  it('reads only the selected home and rejects malformed data without echoing it', () => {
    const one = fixture(), two = fixture()
    fs.writeFileSync(path.join(one, 'credentials.json'), JSON.stringify({ version: 1, sections: { '*': { 'npm-auth': { value: JSON.stringify({ [key]: 'home-one' }) } } } }))
    expect(homeRegistryTokens(one)).toEqual({ [key]: 'home-one' })
    expect(homeRegistryTokens(two)).toEqual({})
    fs.writeFileSync(path.join(two, 'credentials.json'), 'secret-malformed-json')
    expect(() => homeRegistryTokens(two)).toThrow('credentials.json 无法读取')
  })
  it('rejects arbitrary npm options and line injection without including credential values', () => {
    expect(() => registryTokens(JSON.stringify({ registry: 'secret-token' }))).toThrow('npm-auth 每项')
    expect(() => registryTokens(JSON.stringify({ [key]: 'secret-token\nregistry=bad' }))).toThrow('npm-auth 每项')
    expect(() => registryTokens('secret-malformed')).toThrow('JSON 对象')
  })
  it('clears inherited auth while retaining unrelated process settings', () => {
    expect(registryEnvironment({ PATH: 'bin', NPM_TOKEN: 'x', NODE_AUTH_TOKEN: 'y', npm_config_userconfig: 'old', pnpm_config_registry: 'https://public/', GWB_REGISTRY_AUTH_0: 'old', npm_config_auto_install_peers: 'false' })).toEqual({ PATH: 'bin', pnpm_config_registry: 'https://public/', npm_config_auto_install_peers: 'false' })
  })
  it('temporary auth file contains references only, overrides machine auth and cleans up after success', async () => {
    let authFile = ''
    const result = await withRegistryAuthFile({ [key]: 'fixture-secret' }, { '@example:registry': 'https://registry.example/npm/', [key]: '(protected)' }, { NPM_CONFIG_USERCONFIG: 'machine', NPM_TOKEN: 'machine-secret' }, async ({ env }) => {
      authFile = env.NPM_CONFIG_USERCONFIG!
      const text = fs.readFileSync(authFile, 'utf8')
      expect(text).toContain(`${key}=\${GWB_REGISTRY_AUTH_0}`)
      expect(text).not.toContain('fixture-secret')
      expect(env.NPM_TOKEN).toBeUndefined()
      expect(env.GWB_REGISTRY_AUTH_0).toBe('fixture-secret')
      return { error: 'provider echoed fixture-secret' }
    })
    expect(result.error).toBe('provider echoed [credential]')
    expect(fs.existsSync(authFile)).toBe(false)
  })
  it('redacts a thrown error and removes the temporary config on failure', async () => {
    let authFile = ''
    await expect(withRegistryAuthFile({ [key]: 'fixture-secret' }, {}, {}, async ({ env }) => {
      authFile = env.NPM_CONFIG_USERCONFIG!
      throw new Error('provider echoed fixture-secret')
    })).rejects.toThrow('provider echoed [credential]')
    expect(fs.existsSync(authFile)).toBe(false)
  })
})
