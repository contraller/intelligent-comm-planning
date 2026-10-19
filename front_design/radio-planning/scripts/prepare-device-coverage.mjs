import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { renderCoveragePng } from './lib/coverage-png.mjs';

// 本脚本仅写四张 v2 设备图，不覆盖既有 v1 设备图或规划图片。
const root = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(await readFile(resolve(root, 'src/mocks/device-coverage-v2.json'), 'utf8'));
const output = resolve(root, 'public/maps/coverage');
if (catalog.version !== 'device-v2') throw new Error('设备图片目录版本不匹配');
for (const id of ['DV-0001', 'DV-0009', 'DV-0033', 'DV-0043']) {
  const sample = catalog.samples.find(row => row.deviceId === id);
  const name = `device-v2-${id}.png`, target = resolve(output, name);
  if (!sample || dirname(target) !== output || sample.coverage.raster_png.url !== `/maps/coverage/${name}`) throw new Error('设备图片超出输出白名单');
  const png = renderCoveragePng(sample);
  await mkdir(output, { recursive: true });
  await writeFile(target, png);
  console.log(`${id}: ${png.length} bytes`);
}
