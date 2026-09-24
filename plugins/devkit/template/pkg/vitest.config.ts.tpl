import { defineConfig } from 'vitest/config'

/**
 * 配置都在插件包内：测试只收包内的 `tests/`，`src/` 里不放用例。
 *
 * 「slow」标签：**真的启动子进程的用例一律打上它**（运行 `pnpm build` / `pnpm pack` 这类）。
 * 日常 `pnpm test` 带着 `--tags-filter=!slow`，跳过它们；`pnpm test:all` 全部运行。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    testTimeout: 20_000,
    fileParallelism: false,
    tags: [
      {
        name: 'slow',
        description: '真的启动子进程的用例',
        timeout: 300_000,
      },
    ],
  },
})
