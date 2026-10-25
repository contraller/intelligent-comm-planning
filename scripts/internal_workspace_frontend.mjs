// 直接读取最新版源码，不生成生产包、不复制依赖或数千个地图瓦片。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontend = path.join(root, 'front_design', 'radio-planning-20261022');
const runtime = process.env.R4_RUNTIME_ROOT;
if (!runtime || !path.isAbsolute(runtime)) throw new Error('缺少显式隔离运行目录');
const require = createRequire(path.join(frontend, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
const profile = process.env.INTERNAL_WORKSPACE_PROFILE || 'r4';
const profiles = {
  r4: { host: '127.0.0.22', apiPort: 8122, port: 5322 },
  coverage: { host: '127.0.0.23', apiPort: 8123, port: 5323 },
  acceptance: { host: '127.0.0.24', apiPort: 8124, port: 5324 },
};
if (!Object.hasOwn(profiles, profile)) throw new Error('未知内部运行配置');
const { host, apiPort, port } = profiles[profile];
const target = `http://${host}:${apiPort}`;
// 验收只预打包已有开发依赖，避免每个新浏览器串行加载数千模块；不生成生产包。
const acceptanceDependencies = [
  // ExcelJS 的浏览器入口为 UMD；关闭自动发现时也须预编译为可导入模块。
  'vue', 'vue-router', 'pinia', 'papaparse', 'exceljs',
  'primevue/config', 'primevue/drawer', 'primevue/datatable', 'primevue/column',
  'primevue/dialog', 'primevue/tabs', 'primevue/tablist', 'primevue/tab',
  'primevue/tabpanels', 'primevue/tabpanel',
  'echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers',
];
const server = await createServer({
  root: frontend, configFile: false, mode: 'integration', base: '/',
  plugins: [vue()], publicDir: false, cacheDir: path.join(runtime, 'vite-cache'),
  // 静态数据由同一后端按需读取，地图JSON错误不得回落成HTML首页。
  server: { host, port, strictPort: true,
    proxy: Object.fromEntries(['/api/v1', '/health', '/maps', '/fonts'].map(key => [key, target])),
    watch: { ignored: ['**/public/**', '**/data/runtime/**'] } },
  optimizeDeps: { noDiscovery: true, include: profile === 'acceptance' ? acceptanceDependencies : ['papaparse'] },
});
await server.listen();
server.printUrls();
