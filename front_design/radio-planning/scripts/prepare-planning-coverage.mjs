import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { renderCoveragePng } from './lib/coverage-png.mjs';

// 离线绘制固定教学色块：不读取设备功率、距离、地形，不计算业务覆盖率。
const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(resolve(root, 'src/mocks/planning-coverage-v2.json'), 'utf8'));
const output = resolve(root, 'public/maps/coverage');
const approved = ['balanced', 'economical', 'constrained'];
// 版本与输出均固定为 v2，历史 v1 图片不能作为本入口的写入目标。
if (catalog.version !== 'demo-v2') throw new Error('规划图片目录版本不匹配');

for (const id of approved) {
  const { coverage, patches } = catalog.assets[id];
  const { width, height, url } = coverage.raster_png;
  const target = resolve(output, `demo-v2-${id}.png`);
  if (dirname(target) !== output || url !== `/maps/coverage/demo-v2-${id}.png`) throw new Error('图片输出超出白名单');
  const png = renderCoveragePng({ coverage, patches });
  await mkdir(output, { recursive: true });
  await writeFile(target, png);
  console.log(`${id}: ${width} × ${height}, ${png.length} bytes`);
}
