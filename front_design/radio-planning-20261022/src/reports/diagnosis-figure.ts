import { planStations } from '../services/planning-snapshot';
import type { DiagnosisRecord } from '../types/diagnosis';
import { propagationCoordinates } from '../services/diagnosis-propagation';
import { diagnosisOriginLabel } from '../services/diagnosis-presentation';

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]!));
// 这里只把已存在坐标映射到报告画布，不推算影响轮廓或诊断结果。
export function diagnosisFigureSvg(record: DiagnosisRecord): string {
  const nodes = planStations(record.network);
  const coordinates = [...nodes.map((n) => n.coordinate), ...record.result.regions.flatMap((r) => r.rings.flat())];
  const xs = coordinates.map((c) => c[0]); const ys = coordinates.map((c) => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const point = ([x,y]: number[]) => [90 + (x - minX) / Math.max(maxX-minX,0.01) * 690, 425 - (y - minY) / Math.max(maxY-minY,0.01) * 305];
  const positioned = new Map(nodes.map((n) => [n.id, point(n.coordinate)]));
  // 标签只做画布避让；节点坐标、链路与影响结果保持冻结快照原值。
  const occupied = [...positioned.values()].map(([x,y]) => ({ x:x-10, y:y-10, w:20, h:20 }));
  const labels: string[] = [];
  const label = (text: string, x: number, y: number, preferredY = -12) => {
    const width = text.length * 6.5;
    const offsets = [[10,preferredY],[10,24],[-width-10,-12],[-width-10,24],[10,-34],[10,46],[-width-10,-34],[-width-10,46],[10,-56],[10,68]];
    const candidates = offsets.map(([dx,dy]) => ({ x:Math.max(30,Math.min(860-width,x+dx)), y:Math.max(90,Math.min(438,y+dy-11)), w:width, h:15 }));
    const box = candidates.find((b) => occupied.every((a) => b.x+b.w+4<a.x || a.x+a.w+4<b.x || b.y+b.h+3<a.y || a.y+a.h+3<b.y)) ?? candidates[0];
    occupied.push(box);
    if (box !== candidates[0]) labels.push(`<line x1="${x}" y1="${y}" x2="${box.x+width/2}" y2="${box.y+8}" stroke="#8296a8" stroke-width="0.7"/>`);
    labels.push(`<text x="${box.x}" y="${box.y+11}" font-size="11" fill="#16314c">${escape(text)}</text>`);
  };
  const colors = { SEVERE:'#e97d87', MODERATE:'#eebc64', MINOR:'#72adca' };
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="900" height="530" viewBox="0 0 900 530">', '<rect width="900" height="530" fill="#f5f8fc"/>', `<text x="30" y="38" font-size="20" fill="#18304d">${escape(record.name)} · 影响示意</text>`, `<text x="30" y="66" font-size="12" fill="#526a80">${escape(record.network.id)} / ${escape(record.source.state)} · ${escape(diagnosisOriginLabel(record.dataOrigin))}</text>`];
  parts.push('<defs><marker id="propagation-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#167b92"/></marker></defs>');
  for (const region of record.result.regions) parts.push(`<path d="${region.rings.map((ring) => 'M'+ring.map((c) => point(c).join(',')).join('L')+'Z').join(' ')}" fill="${region.level ? colors[region.level] : '#bbc5d2'}" fill-opacity="0.35" fill-rule="evenodd" stroke="#b57170"/>`);
  for (const [index,link] of record.network.links.entries()) {
    const a = positioned.get(link.a), b = positioned.get(link.b); if (!a || !b) continue;
    const affected = record.result.links.some((l) => l.linkId === link.id);
    const x = (a[0]+b[0])/2, y = (a[1]+b[1])/2;
    parts.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${affected ? '#c6455f' : '#487da4'}" stroke-width="${affected ? 4 : 2}"/>`);
    label(link.id,x,y,index % 3 === 2 ? 27 : -16);
    if (record.faults.some((f) => f.objectType === 'LINK' && f.objectId === link.id)) parts.push(`<polygon points="${x},${y-11} ${x+11},${y} ${x},${y+11} ${x-11},${y}" fill="#f5f8fc" stroke="#9249b9" stroke-width="3"/>`);
  }
  for (const node of nodes) {
    const p = positioned.get(node.id)!;
    const affected = record.result.nodes.some((n) => n.nodeId === node.id);
    const injected = record.faults.some((f) => f.objectId === node.id || record.network.inputSnapshot.devices.some((d) => d.id === f.objectId && d.stationId === node.id));
    parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="${affected ? 8 : 5}" fill="${affected ? '#c6455f' : '#227c85'}"/>`);
    label(node.id,p[0],p[1]);
    if (injected) parts.push(`<circle cx="${p[0]}" cy="${p[1]}" r="14" fill="none" stroke="#9249b9" stroke-width="3"/>`);
  }
  // 按已冻结的步骤画方向，不从可见链路或备份路由补算。
  for (const path of record.result.propagationPaths ?? []) {
    const points=propagationCoordinates(path,record.network).map(point);
    points.slice(1).forEach((b,i) => { const a=points[i];if(a[0]!==b[0]||a[1]!==b[1])parts.push(`<line data-propagation="${escape(path.id)}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#167b92" stroke-width="2.5" stroke-dasharray="7 4" marker-end="url(#propagation-arrow)"/>`); });
  }
  parts.push(...labels);
  for (const [index,label] of ['红：严重','橙：一般','蓝：轻微','紫标：注入故障','红线：受影响链路','青箭头：传播'].entries()) parts.push(`<text x="${25+index*145}" y="477" font-size="12" fill="#38536f">${label}</text>`);
  parts.push('<text x="30" y="505" font-size="12" fill="#526a80">WGS84 坐标示意 · 不是实时底图 · 仅展示冻结结果</text>', '</svg>');
  return parts.join('');
}
export async function diagnosisFigurePng(record: DiagnosisRecord): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([diagnosisFigureSvg(record)], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve,reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('报告示意图加载失败')); image.src = url; });
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 1060;
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建报告画布');
    context.drawImage(image,0,0,canvas.width,canvas.height);
    const blob = await new Promise<Blob>((resolve,reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('报告图片生成失败')), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { URL.revokeObjectURL(url); }
}
