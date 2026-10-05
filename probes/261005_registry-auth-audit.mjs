import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { withHomeRegistryAuth, locatePnpm } from '../plugins/plugin-manager/dist/index.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-audit-'))
const registryCalls = []
const checks = []
const server = http.createServer((request, response) => {
  registryCalls.push(request.headers.authorization ?? 'none')
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    name: '@fixture/probe', 'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: '@fixture/probe', version: '1.0.0', dist: { tarball: 'http://127.0.0.1/no-download' } } },
  }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const registry = `http://127.0.0.1:${port}/`
const key = `//127.0.0.1:${port}/:_authToken`
const pnpm = await locatePnpm()
assert.equal(pnpm.ok, true)
const initiatingHome = path.join(root, 'home')
const project = path.join(root, 'project')
const workspace = path.join(root, 'workspace')
const child = path.join(workspace, 'packages', 'child')
for (const directory of [initiatingHome, project, child]) fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(initiatingHome, '.npmrc'), `@fixture:registry=${registry}\n`)
fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
const global = path.join(root, 'global.npmrc')
fs.writeFileSync(global, `${key}=global-fixture\n`)
const base = { ...process.env, NPM_CONFIG_GLOBALCONFIG: global, NPM_TOKEN: 'environment-fixture', NODE_AUTH_TOKEN: 'node-fixture' }
const secret = (tokens) => fs.writeFileSync(path.join(initiatingHome, 'credentials.json'), JSON.stringify({ version: 1, sections: { '*': { 'npm-auth': { value: JSON.stringify(tokens) } } } }))
async function run(cwd) {
  return withHomeRegistryAuth(pnpm.file, initiatingHome, async ({ env }) => {
    const result = await promisify(execFile)(pnpm.file, ['view', '@fixture/probe', 'version', '--registry', registry], { cwd, env, timeout: 15_000 })
    return { version: result.stdout.trim() }
  }, base, cwd)
}
try {
  secret({ [key]: 'home-fixture' })
  fs.writeFileSync(path.join(project, '.npmrc'), `${key}=project-fixture\n`)
  await assert.rejects(run(project), /工程.*认证配置/)
  assert.equal(registryCalls.length, 0)
  checks.push('project auth rejected before any registry request')
  fs.unlinkSync(path.join(project, '.npmrc'))

  fs.writeFileSync(path.join(workspace, '.npmrc'), `${key}=workspace-fixture\n`)
  await assert.rejects(run(child), /工程.*认证配置/)
  assert.equal(registryCalls.length, 0)
  checks.push('ancestor workspace auth rejected before any request')
  fs.unlinkSync(path.join(workspace, '.npmrc'))

  const homeResult = await run(project)
  assert.equal(homeResult.version, '1.0.0')
  assert.deepEqual(registryCalls.splice(0), ['Bearer home-fixture'])
  checks.push('home token wins without project auth; machine/env ignored')

  secret({})
  const anonymous = await run(project)
  assert.equal(anonymous.version, '1.0.0')
  assert.deepEqual(registryCalls.splice(0), ['none'])
  checks.push('missing home token stays anonymous despite global config/env tokens')

  fs.writeFileSync(path.join(project, '.npmrc'), `@fixture:registry=http://fixture:password@127.0.0.1:${port}/\n`)
  await assert.rejects(run(project), /工程.*认证配置/)
  assert.equal(registryCalls.length, 0)
  checks.push('project registry URL credentials rejected before any request')
  fs.unlinkSync(path.join(project, '.npmrc'))

  fs.writeFileSync(path.join(initiatingHome, '.npmrc'), `@fixture:registry=http://fixture:password@127.0.0.1:${port}/\n`)
  await assert.rejects(run(project), /源地址不能内嵌账号密码/)
  assert.equal(registryCalls.length, 0)
  checks.push('initiating home route rejects embedded credentials')
  console.log(JSON.stringify({ checks, count: checks.length, realHomesTouched: false, syntheticSecretsOnly: true }))
} finally {
  server.close()
  const resolved = fs.realpathSync(root)
  assert.ok(resolved.toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase() + path.sep))
  fs.rmSync(resolved, { recursive: true, force: true })
}
