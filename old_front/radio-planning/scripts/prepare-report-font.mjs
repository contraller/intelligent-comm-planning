import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 固定官方字体提交；已存在不同文件时停止，不覆盖用户资产。
const commit = '165c01b46ea533872e002e0785ff17e44f6d97d8';
const base = `https://raw.githubusercontent.com/notofonts/noto-cjk/${commit}/`;
const folder = new URL('../public/fonts/', import.meta.url);
await mkdir(folder, { recursive: true });
async function preserve(name, bytes) {
  const target = new URL(name, folder);
  try {
    const existing = await readFile(target);
    if (!existing.equals(Buffer.from(bytes))) throw new Error(`已有文件内容不同，请人工核对：${fileURLToPath(target)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(target, bytes, { flag: 'wx' });
  }
}
const rows = [];
for (const [name, path] of [['NotoSansCJKsc-Regular.otf', 'Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'], ['OFL-NotoSansCJK.txt', 'LICENSE']]) {
  const url = base + path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (name.endsWith('.otf') && bytes.subarray(0,4).toString() !== 'OTTO') throw new Error('不是有效 OpenType 字体');
  if (name.endsWith('.txt') && !bytes.toString('utf8').includes('SIL OPEN FONT LICENSE')) throw new Error('未找到预期字体许可证');
  await preserve(name, bytes);
  rows.push({ name, url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
}
await preserve('ATTRIBUTION.md', Buffer.from(`# 诊断报告字体来源\n\nNoto Sans CJK SC Regular，仅供本地 PDF 中文报告使用；不修改应用全局字体。\n\n固定提交：\`${commit}\`。许可：SIL Open Font License 1.1，原文见 OFL-NotoSansCJK.txt。\n\n${rows.map((r) => `- [${r.name}](${r.url})：${r.size} 字节；SHA-256 \`${r.sha256}\`。`).join('\n')}\n`, 'utf8'));
console.log(JSON.stringify(rows));
