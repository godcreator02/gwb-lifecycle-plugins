import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { PUBLISH_WORKFLOW, type GithubReleaseGateway, type GithubRepo } from './release.js'

const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'
const CREDENTIAL_TIMEOUT_MS = 30_000
const RUN_POLL_MS = 5_000
/** release 公开到 Actions 建出运行之间、本机与 GitHub 的时钟差：早于 `since` 这么多的运行也算这一次的 */
const RUN_CLOCK_SKEW_MS = 60_000

/**
 * git 凭据管理器里 github.com 的那份凭据，就是推送用的同一份。不弹登录窗口：没有就直接报错。
 * 只在这个进程里用，不写盘、不进日志
 */
export function githubTokenFromGit(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'fill'], {
      env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`git credential fill ${String(CREDENTIAL_TIMEOUT_MS / 1000)} 秒没返回`))
    }, CREDENTIAL_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`启动 git credential fill 没成:${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const password = /^password=(.+)$/m.exec(stdout)?.[1]?.trim()
      if (code === 0 && password !== undefined && password !== '') {
        resolve(password)
        return
      }
      reject(new Error(`git 凭据管理器里没有 github.com 的凭据(git credential fill 退出码 ${String(code)}${stderr.trim() === '' ? '' : `:${stderr.trim()}`}):先在这台机器上用 git 推一次 GitHub 上的仓,登录一次`))
    })
    child.stdin.end('protocol=https\nhost=github.com\n\n')
  })
}

interface WorkflowRun {
  html_url: string
  status: string
  conclusion: string | null
  created_at: string
}

/** 经 GitHub REST API 实现 `GithubReleaseGateway`。`token` 第一次发请求时才取，取一次 */
export function githubGateway(token: () => Promise<string>): GithubReleaseGateway {
  let cachedToken: string | undefined
  const call = async (url: string, init: { method?: string; body?: string | Blob; contentType?: string } = {}): Promise<Response> => {
    cachedToken ??= await token()
    return fetch(url, {
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: {
        Authorization: `Bearer ${cachedToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gwb-devkit',
        ...(init.contentType === undefined ? {} : { 'Content-Type': init.contentType }),
      },
    })
  }
  const json = async <T>(url: string, init?: Parameters<typeof call>[1]): Promise<T> => {
    const response = await call(url, init)
    if (!response.ok) throw new Error(`GitHub ${init?.method ?? 'GET'} ${url} 返回 ${String(response.status)}:${(await response.text()).slice(0, 400)}`)
    return (await response.json()) as T
  }
  const repoPath = (repo: GithubRepo): string => `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`

  return {
    async hasCommit(repo, sha) {
      const response = await call(`${API}/repos/${repoPath(repo)}/commits/${sha}`)
      if (response.ok) return true
      // 不存在的提交号 GitHub 回 404 或 422
      if (response.status === 404 || response.status === 422) return false
      throw new Error(`GitHub 查提交 ${sha} 返回 ${String(response.status)}:${(await response.text()).slice(0, 400)}`)
    },

    async createRelease(input) {
      const releases = `${API}/repos/${repoPath(input.repo)}/releases`
      const draft = await json<{ id: number }>(releases, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ tag_name: input.tag, target_commitish: input.sha, name: input.title, body: input.body, draft: true }),
      })
      for (const asset of input.assets) {
        await json(`${UPLOADS}/repos/${repoPath(input.repo)}/releases/${String(draft.id)}/assets?name=${encodeURIComponent(asset.name)}`, {
          method: 'POST',
          contentType: 'application/gzip',
          body: await fs.openAsBlob(asset.file),
        })
      }
      const published = await json<{ html_url: string }>(`${releases}/${String(draft.id)}`, {
        method: 'PATCH',
        contentType: 'application/json',
        body: JSON.stringify({ draft: false }),
      })
      return { url: published.html_url }
    },

    async waitPublishRun(input) {
      const workflow = PUBLISH_WORKFLOW.split('/').pop()!
      const runsUrl = `${API}/repos/${repoPath(input.repo)}/actions/workflows/${workflow}/runs?event=release&head_sha=${input.sha}&per_page=20`
      const deadline = Date.now() + input.timeoutMs
      let url: string | undefined
      for (;;) {
        const { workflow_runs: runs } = await json<{ workflow_runs: WorkflowRun[] }>(runsUrl)
        const run = runs
          .filter((one) => Date.parse(one.created_at) >= input.since - RUN_CLOCK_SKEW_MS)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
        if (run !== undefined) {
          url = run.html_url
          if (run.status === 'completed') return { finished: true, success: run.conclusion === 'success', url }
        }
        if (Date.now() >= deadline) return url === undefined ? { finished: false } : { finished: false, url }
        await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS))
      }
    },
  }
}
