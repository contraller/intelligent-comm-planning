// 台账与 GIS 共用频率含义；调用方决定读取已保存资源还是已应用草稿。
export type DeviceFrequencyMode = 'ALL' | 'MODEL' | 'DEVICE';
export type DeviceFrequencyPresence = 'ALL' | 'PRESENT' | 'MISSING';
export interface DeviceFrequencyInput {
  mode: DeviceFrequencyMode;
  presence: DeviceFrequencyPresence;
  min: string;
  max: string;
}
export interface DeviceFrequencyFilter {
  mode: DeviceFrequencyMode;
  presence: DeviceFrequencyPresence;
  minKhz: number | null;
  maxKhz: number | null;
}
export interface DeviceFrequencySource {
  workFreqKhz?: number | null;
  freqMinKhz?: number | null;
  freqMaxKhz?: number | null;
}
export const emptyDeviceFrequencyInput = (): DeviceFrequencyInput => ({ mode: 'ALL', presence: 'ALL', min: '', max: '' });
export const emptyDeviceFrequencyFilter = (): DeviceFrequencyFilter => ({ mode: 'ALL', presence: 'ALL', minKhz: null, maxKhz: null });

// 仅解析当前模式适用的字段；停用的旧输入不变成隐藏条件。
export function parseDeviceFrequency(input: DeviceFrequencyInput):
  { ok: true; value: DeviceFrequencyFilter } | { ok: false; error: string } {
  if (!['ALL', 'MODEL', 'DEVICE'].includes(input.mode)) return { ok: false, error: '请选择有效的频率筛选依据' };
  if (input.mode === 'ALL') return { ok: true, value: emptyDeviceFrequencyFilter() };
  const presence = input.mode === 'DEVICE' ? input.presence : 'ALL';
  if (!['ALL', 'PRESENT', 'MISSING'].includes(presence)) return { ok: false, error: '请选择有效的工作频点条件' };
  if (presence === 'MISSING') return { ok: true, value: { mode: 'DEVICE', presence, minKhz: null, maxKhz: null } };
  const bounds: (number | null)[] = [];
  for (const [label, raw] of [['下限', input.min], ['上限', input.max]]) {
    const text = raw.trim();
    if (!text) { bounds.push(null); continue; }
    // 接受十进制及科学计数法，拒绝非有限数、负数和隐式进制转换。
    const value = Number(text);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `频率${label}须为非负有限数（kHz）` };
    }
    bounds.push(value);
  }
  const [minKhz, maxKhz] = bounds;
  if (minKhz !== null && maxKhz !== null && minKhz > maxKhz) return { ok: false, error: '频率下限不能大于上限' };
  return { ok: true, value: { mode: input.mode, presence, minKhz, maxKhz } };
}
const validFrequency = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function matchesDeviceFrequency(source: DeviceFrequencySource, filter: DeviceFrequencyFilter) {
  if (filter.mode === 'ALL') return true;
  const hasRange = filter.minKhz !== null || filter.maxKhz !== null;
  const min = filter.minKhz ?? -Infinity, max = filter.maxKhz ?? Infinity;
  if (filter.mode === 'MODEL') {
    if (!hasRange) return true;
    // 型号能力只作区间交集，不代替设备当前配置。
    return validFrequency(source.freqMinKhz) && validFrequency(source.freqMaxKhz)
      && source.freqMinKhz <= source.freqMaxKhz && source.freqMinKhz <= max && source.freqMaxKhz >= min;
  }
  if (filter.presence === 'MISSING') return source.workFreqKhz == null;
  if (!hasRange && filter.presence === 'ALL') return true;
  return validFrequency(source.workFreqKhz) && source.workFreqKhz >= min && source.workFreqKhz <= max;
}
export function deviceFrequencySummary(filter: DeviceFrequencyFilter) {
  if (filter.mode === 'ALL') return '不限频率';
  if (filter.presence === 'MISSING') return '设备工作频点 · 频点为空';
  const name = filter.mode === 'MODEL' ? '型号支持频段' : '设备工作频点';
  const range = filter.minKhz === null && filter.maxKhz === null ? '不限范围'
    : filter.minKhz === null ? `≤ ${filter.maxKhz} kHz` : filter.maxKhz === null ? `≥ ${filter.minKhz} kHz`
      : `${filter.minKhz}–${filter.maxKhz} kHz`;
  return `${name} · ${filter.presence === 'PRESENT' ? '频点有值 · ' : ''}${range}`;
}
