import { defineConfig } from 'vitest/config'

/**
 * 一仓一包一插件：测试只认仓根的 `tests/`，`src/` 里不放用例。
 *
 * 「slow」标签：**凡真起子进程的用例必打标**（`pnpm build` / `pnpm pack` 那种）。
 * 日常 `pnpm test` 想跳过它们就加 `--tags-filter=!slow`。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    testTimeout: 20_000,
    fileParallelism: false,
    tags: [
      {
        name: 'slow',
        description: '真起子进程的用例',
        timeout: 300_000,
      },
    ],
  },
})
