import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPnpmConfig } from './pnpm-config.js'
import { isRecord } from './vocab.js'

/** Shared so the publishing plugin and package manager use the same home-owned registry identity. */
export const REGISTRY_AUTH_KEY = 'npm-auth'

export function registryTokens(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === '') return {}
  let parsed: unknown
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : undefined } catch { throw new Error('npm-auth 必须是 JSON 对象；凭据原文未输出') }
  if (!isRecord(parsed)) throw new Error('npm-auth 必须是 JSON 对象')
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^\/\/[^\s=]+\/:_authToken$/.test(key) || typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) {
      throw new Error('npm-auth 每项要是 //主机/路径/:_authToken 对应的非空单行字符串')
    }
    tokens[key] = value
  }
  return tokens
}

/** Only the selected home is read; a missing or cleared slot never falls back to machine credentials. */
export function homeRegistryTokens(homeDir: string): Record<string, string> {
  let doc: unknown
  try { doc = JSON.parse(fs.readFileSync(path.join(homeDir, 'credentials.json'), 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('当前 home 的 credentials.json 无法读取；未使用机器凭据替补')
  }
  if (!isRecord(doc) || doc.version !== 1 || !isRecord(doc.sections)) throw new Error('当前 home 的 credentials.json 格式不正确')
  const shared = doc.sections['*']
  const slot = isRecord(shared) ? shared[REGISTRY_AUTH_KEY] : undefined
  return registryTokens(isRecord(slot) ? slot.value : undefined)
}

export function registryEnvironment(base: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([key]) =>
    !/^(?:npm_token|node_auth_token|gwb_registry_auth_.*)$/i.test(key)
    && !/^(?:npm|pnpm)_config_.*(?:auth|token|password|username|userconfig)/i.test(key),
  ))
}

export interface RegistryAuthContext {
  env: NodeJS.ProcessEnv
  redact<T>(value: T): T
}

/** Project auth has higher priority than pnpm's user auth file; let the skill migrate it explicitly. */
export function assertNoProjectRegistryAuth(cwd: string): void {
  const userDir = fs.realpathSync.native(os.homedir()).toLowerCase()
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    // pnpm's user auth file is already replaced. It is not a project file when walking its descendants.
    if (fs.realpathSync.native(dir).toLowerCase() === userDir && dir !== path.resolve(cwd)) break
    const file = path.join(dir, '.npmrc')
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8')
      if (/^\s*[^#;\r\n=]*(?:_authToken|_auth|_password|username|certfile|keyfile)\s*=/im.test(text)
        || /^\s*(?:registry|@[^\s:]+:registry)\s*=\s*https?:\/\/[^\s/]+@/im.test(text)) {
        throw new Error(`工程 ${dir} 的 .npmrc 含认证配置，会覆盖 home 凭据；请按 gwb-plugin-manager 说明书迁入 npm-auth 后移除这些认证项，保留源路由。`)
      }
    }
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || path.dirname(dir) === dir) break
  }
}

/** pnpm 12's auth-file override isolates authentication while retaining non-secret registry routes. */
export async function withHomeRegistryAuth<T>(pnpm: string, homeDir: string, run: (context: RegistryAuthContext) => Promise<T>, base: NodeJS.ProcessEnv = process.env, cwd: string = homeDir): Promise<T> {
  assertNoProjectRegistryAuth(cwd)
  const config = await readPnpmConfig(pnpm, homeDir)
  if (!config.ok) throw new Error('无法读取 pnpm 源配置；未启动安装或发布')
  return withRegistryAuthFile(homeRegistryTokens(homeDir), config.data, base, run)
}

export async function withRegistryAuthFile<T>(tokens: Record<string, string>, config: Record<string, unknown>, base: NodeJS.ProcessEnv, run: (context: RegistryAuthContext) => Promise<T>): Promise<T> {
  const env = registryEnvironment(base)
  const lines = Object.entries(config)
    .filter(([key, value]) => /^(?:registry|@[a-z0-9._-]+:registry)$/.test(key) && typeof value === 'string' && !/[\r\n]/.test(value))
    .map(([key, value]) => {
      const url = new URL(String(value))
      if (url.username !== '' || url.password !== '') throw new Error('源地址不能内嵌账号密码；请按说明书配置 home 的 npm-auth')
      return `${key}=${String(value)}`
    })
  const secrets = Object.values(tokens)
  for (const [index, [key, value]] of Object.entries(tokens).entries()) {
    const variable = `GWB_REGISTRY_AUTH_${index}`
    env[variable] = value
    lines.push(`${key}=\${${variable}}`)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwb-registry-auth-'))
  const file = path.join(dir, '.npmrc')
  env.NPM_CONFIG_USERCONFIG = file
  const redact = <R>(value: R): R => {
    const text = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? secrets.reduce((line, secret) => line.split(secret).join('[credential]'), item) : item)
    return text === undefined ? value : JSON.parse(text) as R
  }
  try {
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' })
    return redact(await run({ env, redact }))
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : 'pnpm 操作失败'))
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    fs.rmdirSync(dir)
  }
}
