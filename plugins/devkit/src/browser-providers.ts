import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { exportTarget } from './artifact-check.js'
import { isRecord, packageManifestOf } from './vocab.js'

export interface BrowserProvidersIo {
  readText(file: string): string | undefined
  importModule(url: string): Promise<unknown>
  realpath?(directory: string): string
}

export interface BrowserProviders {
  declared: boolean
  imports: Record<string, string>
  problems: string[]
}

/** 只读自身与明确 peer 的代码出口，不扫描 home，不求值插件主入口。 */
export async function collectBrowserImports(pkgDir: string, manifest: Record<string, unknown>, io: BrowserProvidersIo): Promise<BrowserProviders> {
  const providers = [{ directory: pkgDir, manifest }]
  const peers = isRecord(manifest.peerDependencies) ? Object.keys(manifest.peerDependencies) : []
  for (const name of peers) {
    const directory = path.join(pkgDir, 'node_modules', ...name.split('/'))
    const peer = packageManifestOf(io.readText(path.join(directory, 'package.json')))
    if (peer !== undefined) providers.push({ directory, manifest: peer })
  }
  const result: BrowserProviders = { declared: false, imports: {}, problems: [] }
  for (const provider of providers) {
    const entry = exportTarget(provider.manifest, './browser-imports')
    if (entry === undefined) continue
    result.declared = true
    try {
      const directory = io.realpath?.(provider.directory) ?? provider.directory
      const moduleFile = path.resolve(directory, entry)
      if (!inside(directory, moduleFile) || io.readText(moduleFile) === undefined) throw new Error(`代码出口不在包内或文件不存在：${moduleFile}`)
      requireDistributed(provider.manifest, directory, moduleFile)
      const module = await io.importModule(pathToFileURL(moduleFile).href)
      if (!isRecord(module) || typeof module.browserImports !== 'function') throw new Error('代码出口缺少 browserImports()')
      const mapping: unknown = module.browserImports()
      if (!isRecord(mapping) || typeof mapping.then === 'function') throw new Error('browserImports() 必须同步返回名字到 URL 的对象')
      for (const [name, url] of Object.entries(mapping)) {
        if (!name || /[\s:\\?#]/.test(name) || name.startsWith('.') || name.startsWith('/') || name.endsWith('/')) throw new Error(`不是精确模块名：${name}`)
        if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'file:' || !/\.m?js$/.test(new URL(url).pathname)) throw new Error(`${name} 不是本地模块文件 URL`)
        const target = fileURLToPath(url)
        if (!inside(directory, target)) throw new Error(`${name} 的目标不在提供方包内：${url}`)
        if (io.readText(target) === undefined) throw new Error(`${name} 的目标文件不在：${target}`)
        requireDistributed(provider.manifest, directory, target)
        const previous = Object.hasOwn(result.imports, name) ? result.imports[name] : undefined
        if (previous !== undefined && previous !== url) throw new Error(`${name} 的提供方冲突：${previous} 与 ${url}`)
        Object.defineProperty(result.imports, name, { value: url, enumerable: true, configurable: true })
      }
    } catch (error) {
      result.problems.push(`${String(provider.manifest.name ?? provider.directory)} 的 browser-imports：${String(error)}`)
    }
  }
  return result
}

function requireDistributed(manifest: Record<string, unknown>, directory: string, file: string): void {
  const files = Array.isArray(manifest.files) ? manifest.files : []
  if (!files.some(item => typeof item === 'string' && !/[*?!]/.test(item) &&
    (path.resolve(directory, item) === file || inside(path.resolve(directory, item), file)))) {
    throw new Error(`browser-imports 的文件未被 files 白名单包含：${file}`)
  }
}

function inside(directory: string, file: string): boolean {
  const relative = path.relative(directory, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
