import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [vue()],
    base: './',
    server: {
      proxy: {
        '/api/v1': env.VITE_BACKEND_PROXY_TARGET || 'http://127.0.0.1:8001',
      },
    },
    // 保留已有产物，遵守项目禁止物理删除文件的约定。
    build: { emptyOutDir: false, chunkSizeWarningLimit: 1500 },
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  };
});
