import { defineConfig } from 'vitest/config'

/** 配置都在插件包内：测试只收包内的 `tests/`，`src/` 里不放用例 */
export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    testTimeout: 20_000,
    fileParallelism: false,
  },
})