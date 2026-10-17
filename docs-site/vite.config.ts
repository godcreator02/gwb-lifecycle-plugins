import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { godDocsite } from '@godcreator/god-docsite/vite'
import * as collections from './source.config.ts'

export default defineConfig({
  plugins: [fumadocsMdx(), tailwindcss(), godDocsite({ collections }), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  // 构建时预渲染经 vite preview 发请求：写死 IPv4，免得 localhost 双栈连接在构建进程忙时超时、预渲染报空错误
  preview: { host: '127.0.0.1' },
})
