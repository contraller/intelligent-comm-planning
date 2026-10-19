import { describe, expect, it } from 'vitest';
import { initialResources } from '../src/mocks/resource-presets';
import { emptyLedgerFrequencyFilter, emptyLedgerFrequencyInput, ledgerFrequencySummary, matchesLedgerAlert, matchesLedgerFrequency, parseLedgerFrequency } from '../src/services/resource-ledger-filter';
import type { LedgerFrequencyInput } from '../src/services/resource-ledger-filter';

function parsed(patch: Partial<LedgerFrequencyInput>) {
  const result = parseLedgerFrequency({ ...emptyLedgerFrequencyInput(), ...patch });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
describe('资源台账频率条件解析', () => {
  it('默认不限频率；停用输入不成为隐藏条件，返回独立对象', () => {
    const input = emptyLedgerFrequencyInput(); input.min = 'bad';
    expect(parseLedgerFrequency(input)).toEqual({ ok: true, value: emptyLedgerFrequencyFilter() });
    expect(emptyLedgerFrequencyInput().min).toBe('');
    expect(parsed({ mode: 'MODEL', presence: 'MISSING', min: ' 3e3 ', max: '6000.5' }))
      .toEqual({ mode: 'MODEL', presence: 'ALL', minKhz: 3000, maxKhz: 6000.5 });
    expect(parsed({ mode: 'DEVICE', presence: 'MISSING', min: 'bad', max: '-5' }))
      .toEqual({ mode: 'DEVICE', presence: 'MISSING', minKhz: null, maxKhz: null });
  });
  it('空上下限、单端范围、等值频点与零下限都保留明确含义', () => {
    expect(parsed({ mode: 'DEVICE' })).toMatchObject({ minKhz: null, maxKhz: null });
    expect(parsed({ mode: 'MODEL', min: '0' })).toMatchObject({ minKhz: 0, maxKhz: null });
    expect(parsed({ mode: 'MODEL', max: '1.5' })).toMatchObject({ minKhz: null, maxKhz: 1.5 });
    expect(parsed({ mode: 'DEVICE', min: '6000', max: '6000' })).toMatchObject({ minKhz: 6000, maxKhz: 6000 });
  });
  it.each(['-1', 'NaN', 'Infinity', '1e999', '6000kHz', '0x100', '.', '1,000'])('拒绝非法下限 %s', min => {
    const result = parseLedgerFrequency({ ...emptyLedgerFrequencyInput(), mode: 'MODEL', min });
    expect(result).toEqual({ ok: false, error: '频率下限须为非负有限数（kHz）' });
  });
  it('上限和倒置范围分别说明错误，不偷偷交换边界', () => {
    expect(parseLedgerFrequency({ mode: 'DEVICE', presence: 'ALL', min: '6', max: 'bad' }))
      .toEqual({ ok: false, error: '频率上限须为非负有限数（kHz）' });
    expect(parseLedgerFrequency({ mode: 'MODEL', presence: 'ALL', min: '6001', max: '6000' }))
      .toEqual({ ok: false, error: '频率下限不能大于上限' });
  });
  it('摘要只显示已应用模式适用字段，明确单位及有值状态', () => {
    expect(ledgerFrequencySummary(parsed({}))).toBe('不限频率');
    expect(ledgerFrequencySummary(parsed({ mode: 'MODEL', min: '6000' }))).toBe('型号支持频段 · ≥ 6000 kHz');
    expect(ledgerFrequencySummary(parsed({ mode: 'MODEL', max: '6000' }))).toBe('型号支持频段 · ≤ 6000 kHz');
    expect(ledgerFrequencySummary(parsed({ mode: 'DEVICE', presence: 'PRESENT' }))).toBe('设备工作频点 · 频点有值 · 不限范围');
    expect(ledgerFrequencySummary(parsed({ mode: 'DEVICE', presence: 'MISSING' }))).toBe('设备工作频点 · 频点为空');
  });
});

describe('资源台账频率与告警匹配', () => {
  const source = { freqMinKhz: 3000, freqMaxKhz: 30000, workFreqKhz: 6000 };
  it('型号按交集匹配，配置频点只按自身值；两种口径不互相补值', () => {
    const model = parsed({ mode: 'MODEL', min: '1000', max: '4000' }), point = parsed({ mode: 'DEVICE', min: '1000', max: '4000' });
    expect(matchesLedgerFrequency(source, model)).toBe(true);
    expect(matchesLedgerFrequency(source, point)).toBe(false);
    expect(matchesLedgerFrequency({ ...source, workFreqKhz: null }, model)).toBe(true);
    expect(matchesLedgerFrequency({ ...source, workFreqKhz: null }, point)).toBe(false);
  });
  it('区间交集与频点均包含边界，等值范围与无交集正确区分', () => {
    for (const value of [3000, 30000]) expect(matchesLedgerFrequency(source, parsed({ mode: 'MODEL', min: String(value), max: String(value) }))).toBe(true);
    expect(matchesLedgerFrequency(source, parsed({ mode: 'MODEL', min: '30000.1' }))).toBe(false);
    expect(matchesLedgerFrequency(source, parsed({ mode: 'MODEL', max: '2999.9' }))).toBe(false);
    expect(matchesLedgerFrequency(source, parsed({ mode: 'DEVICE', min: '6000', max: '6000' }))).toBe(true);
    expect(matchesLedgerFrequency(source, parsed({ mode: 'DEVICE', min: '6000.1' }))).toBe(false);
  });
  it('空频点不等于零；不限、有值、为空及范围各自独立', () => {
    const all = parsed({ mode: 'DEVICE' }), has = parsed({ mode: 'DEVICE', presence: 'PRESENT' }), missing = parsed({ mode: 'DEVICE', presence: 'MISSING' });
    for (const workFreqKhz of [null, undefined]) {
      expect(matchesLedgerFrequency({ workFreqKhz }, all)).toBe(true);
      expect(matchesLedgerFrequency({ workFreqKhz }, has)).toBe(false);
      expect(matchesLedgerFrequency({ workFreqKhz }, missing)).toBe(true);
      expect(matchesLedgerFrequency({ workFreqKhz }, parsed({ mode: 'DEVICE', min: '0', max: '0' }))).toBe(false);
    }
    expect(matchesLedgerFrequency({ workFreqKhz: 0 }, missing)).toBe(false);
    expect(matchesLedgerFrequency({ workFreqKhz: 0 }, has)).toBe(true);
  });
  it('缺失或非法型号范围不能冒充有交集，非有限频点不当作正常数值', () => {
    const filter = parsed({ mode: 'MODEL', min: '6000' });
    for (const value of [{}, { freqMinKhz: 30000, freqMaxKhz: 3000 }, { freqMinKhz: 0, freqMaxKhz: Infinity }]) {
      expect(matchesLedgerFrequency(value, filter)).toBe(false);
    }
    expect(matchesLedgerFrequency({ workFreqKhz: NaN }, parsed({ mode: 'DEVICE', presence: 'PRESENT' }))).toBe(false);
  });
  it('告警独立于运行状态，正常且有告警可与频率条件共同命中', () => {
    const device = { ...source, status: 'NORMAL', alert: true };
    expect(matchesLedgerAlert(device, 'ALL')).toBe(true); expect(matchesLedgerAlert(device, 'YES')).toBe(true);
    expect(matchesLedgerAlert(device, 'NO')).toBe(false);
    expect(device.status === 'NORMAL' && matchesLedgerAlert(device, 'YES')
      && matchesLedgerFrequency(device, parsed({ mode: 'DEVICE', min: '6000' }))).toBe(true);
  });
  // 观测缺省不能被“无告警”收纳，已有布尔值断言保持原样。
  it('观测告警空值只匹配未提供及全部条件', () => {
    expect(matchesLedgerAlert({ alert: null }, 'UNKNOWN')).toBe(true);
    expect(matchesLedgerAlert({ alert: null }, 'ALL')).toBe(true);
    expect(matchesLedgerAlert({ alert: null }, 'YES')).toBe(false);
    expect(matchesLedgerAlert({ alert: null }, 'NO')).toBe(false);
    expect(matchesLedgerAlert({ alert: false }, 'UNKNOWN')).toBe(false);
  });
  it('初始 414 台配置频点全部为空，检索不修改源数据或从型号填充值', () => {
    const resources = initialResources(), before = JSON.stringify(resources), has = parsed({ mode: 'DEVICE', presence: 'PRESENT' });
    const missing = parsed({ mode: 'DEVICE', presence: 'MISSING' });
    expect(resources.devices.filter(row => matchesLedgerFrequency(row, has))).toHaveLength(0);
    expect(resources.devices.filter(row => matchesLedgerFrequency(row, missing))).toHaveLength(414);
    const input = { ...emptyLedgerFrequencyInput(), mode: 'MODEL' as const, min: ' 6000 ' }, snapshot = JSON.stringify(input);
    parseLedgerFrequency(input); expect(JSON.stringify(input)).toBe(snapshot); expect(JSON.stringify(resources)).toBe(before);
  });
});

