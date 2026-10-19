import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// 原始 CSV 只读；生成物先到 tmp 核验，正式目录由审阅后的补丁新增。
const source = 'docs/数据接口样例/04_联调数据/synthetic/topology/topology_links_v1.csv';
const bytes = readFileSync(source);
const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
const rows = text.trimEnd().split(/\r?\n/).map(line => line.split(','));
const rawFields = ['link_id','node_a_id','node_b_id','device_a_id','device_b_id','device_class','freq_khz','bandwidth_khz','distance_m','path_loss_db','rx_power_dbm','link_margin_db','is_available','link_state','is_backup'];
if (JSON.stringify(rows.shift()) !== JSON.stringify(rawFields) || rows.length !== 500) throw Error('候选表头或行数不符');
const fields = ['id','nodeAId','nodeBId','deviceAId','deviceBId','deviceClass','freqKhz','bandwidthKhz','distanceM','pathLossDb','rxPowerDbm','linkMarginDb','isAvailable','linkState','isBackup'];
const numeric = new Set(['freqKhz','bandwidthKhz','distanceM','pathLossDb','rxPowerDbm','linkMarginDb']);
const boolean = new Set(['isAvailable','isBackup']);
const links = rows.map((cells, index) => {
  if (cells.length !== fields.length) throw Error(`第 ${index + 2} 行列数不符`);
  const data = Object.fromEntries(fields.map((field, column) => {
    const raw = cells[column];
    if (numeric.has(field)) { const value = raw === '' ? null : Number(raw); if (value !== null && !Number.isFinite(value)) throw Error('数值无效'); return [field, value]; }
    if (boolean.has(field)) { if (!['', 'true', 'false'].includes(raw)) throw Error('布尔值无效'); return [field, raw === '' ? null : raw === 'true']; }
    return [field, field === 'linkState' && raw === '' ? null : raw];
  }));
  const origin = { kind: 'SOURCE', file: source, row: index + 2 };
  return { ...data, assessmentState: 'REFERENCE', source: origin, reference: { data, source: origin } };
});
if (new Set(links.map(row => row.id)).size !== 500) throw Error('候选 ID 重复');
mkdirSync('tmp', { recursive: true });
const target = resolve('tmp/candidate-links.generated.json');
writeFileSync(target, '[\n' + links.map(row => '  ' + JSON.stringify(row)).join(',\n') + '\n]\n', 'utf8');
console.log(`已核验 ${links.length} 条候选；生成 ${target}`);
