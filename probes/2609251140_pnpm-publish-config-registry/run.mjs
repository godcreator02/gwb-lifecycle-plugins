// 探针：pnpm publish 认不认包清单里的 publishConfig.registry，它和 .npmrc 的范围行、命令行 --registry 谁优先；
// pnpm view 不带 --registry 时是不是按 .npmrc 的范围行去问。
// 起两个本机假源 A、B，只记下收到的请求、publish 一律回 403（什么都不会真的发出去）；
// 用一份临时 userconfig 把 @gwbprobe 的范围行指向 B，包清单的 publishConfig.registry 指向 A，看请求落在哪个源上。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const PKG = '@gwbprobe/probe-pkg'

function fakeRegistry(label, latest) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    req.resume()
    req.on('end', () => {
      if (req.method === 'PUT') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `probe registry ${label} refuses every publish` }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      const dist = { tarball: `http://127.0.0.1/${label}.tgz`, shasum: '0'.repeat(40) }
      res.end(JSON.stringify({ name: PKG, 'dist-tags': { latest }, versions: { [latest]: { name: PKG, version: latest, dist } }, time: { [latest]: '2026-01-01T00:00:00.000Z' } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${String(server.address().port)}/`
      resolve({ label, url, hits, server })
    })
  })
}

function runPnpm(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd, env, shell: true })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => resolve({ code, out }))
  })
}

const a = await fakeRegistry('A', '1.0.0')
const b = await fakeRegistry('B', '2.0.0')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-probe-publishconfig-'))
const userconfig = path.join(work, '.npmrc')
const hostOf = (url) => url.replace(/^http:/, '')
fs.writeFileSync(
  userconfig,
  [`@gwbprobe:registry=${b.url}`, `${hostOf(a.url)}:_authToken=probe-a`, `${hostOf(b.url)}:_authToken=probe-b`, ''].join('\n'),
)
const unscopedUserconfig = path.join(work, 'unscoped.npmrc')
fs.writeFileSync(unscopedUserconfig, [`registry=${b.url}`, `${hostOf(a.url)}:_authToken=probe-a`, `${hostOf(b.url)}:_authToken=probe-b`, ''].join('\n'))
const env = { ...process.env, NPM_CONFIG_USERCONFIG: userconfig }
for (const key of Object.keys(env)) if (/^npm_config_(?!userconfig$)/i.test(key)) delete env[key]

function writePackage(dir, publishConfig) {
  fs.mkdirSync(dir, { recursive: true })
  const manifest = { name: PKG, version: '0.0.1', files: ['index.js'] }
  if (publishConfig !== undefined) manifest.publishConfig = publishConfig
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(dir, 'index.js'), 'export {}\n')
}

const cases = [
  { name: '1 publishConfig.registry=A，范围行=B，命令行不带 --registry', publishConfig: { registry: a.url }, args: ['publish', '--no-git-checks', '--tag', 'latest'] },
  { name: '2 不写 publishConfig，范围行=B，命令行不带 --registry', publishConfig: undefined, args: ['publish', '--no-git-checks', '--tag', 'latest'] },
  { name: '3 publishConfig.registry=A，范围行=B，命令行 --registry B', publishConfig: { registry: a.url }, args: ['publish', '--no-git-checks', '--tag', 'latest', '--registry', b.url] },
  { name: '4 不写 publishConfig，范围行=B，命令行 --registry A', publishConfig: undefined, args: ['publish', '--no-git-checks', '--tag', 'latest', '--registry', a.url] },
  { name: '5 pnpm view 不带 --registry（范围行=B）', view: true, args: ['view', PKG, 'dist-tags.latest'] },
  { name: '6 pnpm view --registry A（范围行=B）', view: true, args: ['view', PKG, 'dist-tags.latest', '--registry', a.url] },
  { name: '7 pnpm view --@gwbprobe:registry=A（范围行=B）', view: true, args: ['view', PKG, 'dist-tags.latest', `--@gwbprobe:registry=${a.url}`] },
  { name: '8 pnpm view --config.@gwbprobe:registry=A（范围行=B）', view: true, args: ['view', PKG, 'dist-tags.latest', `--config.@gwbprobe:registry=${a.url}`] },
  { name: '9 pnpm view，环境变量 npm_config_@gwbprobe:registry=A（范围行=B）', view: true, args: ['view', PKG, 'dist-tags.latest'], extraEnv: { 'npm_config_@gwbprobe:registry': a.url } },
  { name: '10 pnpm view，环境变量 pnpm_config_@gwbprobe:registry=A（范围行=B）', view: true, args: ['view', PKG, 'dist-tags.latest'], extraEnv: { 'pnpm_config_@gwbprobe:registry': a.url } },
  { name: '11 pnpm view <包>@0.0.1 version（范围行=B，B 上只有 2.0.0）', view: true, args: ['view', `${PKG}@0.0.1`, 'version'] },
  { name: '12 不带范围的包名：pnpm view --registry A（userconfig 里 registry=B）', view: true, args: ['view', 'probe-unscoped', 'dist-tags.latest', '--registry', a.url], extraEnv: { NPM_CONFIG_USERCONFIG: unscopedUserconfig } },
  { name: '13 不带范围的包名：pnpm view 不带 --registry（userconfig 里 registry=B）', view: true, args: ['view', 'probe-unscoped', 'dist-tags.latest'], extraEnv: { NPM_CONFIG_USERCONFIG: unscopedUserconfig } },
]

console.log(`pnpm ${(await runPnpm(['--version'], work, env)).out.trim()}；A=${a.url} B=${b.url}`)
for (const [index, one] of cases.entries()) {
  a.hits.length = 0
  b.hits.length = 0
  const dir = path.join(work, `case-${String(index + 1)}`)
  if (one.view === true) fs.mkdirSync(dir, { recursive: true })
  else writePackage(dir, one.publishConfig)
  const result = await runPnpm(one.args, dir, { ...env, ...one.extraEnv })
  console.log(`\n== ${one.name}`)
  console.log(`命令：pnpm ${one.args.join(' ')}；退出码 ${String(result.code)}`)
  console.log(`A 收到：${a.hits.length === 0 ? '无' : a.hits.join(' | ')}`)
  console.log(`B 收到：${b.hits.length === 0 ? '无' : b.hits.join(' | ')}`)
  console.log(`输出最后几行：\n${result.out.trim().split(/\r?\n/).slice(-4).join('\n')}`)
}

a.server.close()
b.server.close()
fs.rmSync(work, { recursive: true, force: true })
