import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export default defineConfig(({ command }) => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const localPython = path.join(root, '.venv', 'Scripts', 'python.exe')
  const ports = command === 'serve' ? JSON.parse(execFileSync(
    process.env.IRODORI_WORKBENCH_PYTHON || (existsSync(localPython) ? localPython : 'python'),
    [path.join(root, 'scripts', 'config_cli.py')], { encoding: 'utf8', env: process.env },
  )) as { port: number; dev_port: number } : { port: 8999, dev_port: 5173 }
  return {
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: ports.dev_port,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${ports.port}`,
        changeOrigin: true,
      },
    },
  },
  }
})
