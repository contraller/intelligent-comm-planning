import { describe, expect, it } from 'vitest';
import { initialResources } from '../src/mocks/resource-presets';
import type { DeviceHistory, DeviceHistorySummary } from '../src/types/device-maintenance';
import { configurationStatusLabel, formatMaintenanceTime, formatMaintenanceValue, isDeviceBaseline, maintenanceChangeRows, maintenanceFieldLabel, maintenanceSnapshotRows } from '../src/services/device-maintenance-display';

// 只验证已留存资料的展示和源数据不变，不替业务服务补历史。
describe('设备追溯展示转换', () => {
  it('统一为北京时间，跨日和零点正确，未知日期保留原文', () => {
    expect(formatMaintenanceTime('2026-10-21T13:52:55.659Z')).toBe('2026-10-21 21:52:55');
    expect(formatMaintenanceTime('2026-10-21T16:00:00Z')).toBe('2026-10-22 00:00:00');
    expect(formatMaintenanceTime('2026-10-20T08:00:00+08:00')).toBe('2026-10-20 08:00:00');
    expect(formatMaintenanceTime('旧资料日期未知')).toBe('旧资料日期未知');
    expect(formatMaintenanceValue('installedAt', '旧资料日期未知')).toBe('旧资料日期未知');
    expect(formatMaintenanceTime('')).toBe('未提供');
  });

  it('已知字段、枚举和单位可读，零值与 false 不作为缺失', () => {
    expect(maintenanceFieldLabel('currentWorkMode')).toBe('当前工作模式');
    expect(formatMaintenanceValue('currentWorkMode', 'MOCK_HOPPING')).toBe('教学跳频');
    expect(formatMaintenanceValue('txPowerDbm', 0)).toBe('0 dBm');
    expect(formatMaintenanceValue('workFreqKhz', 6000)).toBe('6000 kHz');
    expect(formatMaintenanceValue('azimuthDeg', 0)).toBe('0°');
    expect(formatMaintenanceValue('alert', false)).toBe('无告警');
    expect(formatMaintenanceValue('availability', 'OFF_SHELF')).toBe('已下架');
    expect(configurationStatusLabel('SUCCEEDED')).toBe('成功');
  });

  it('缺失和未知资料不补业务含义，关联编号不猜名称', () => {
    expect(formatMaintenanceValue('currentWorkMode', null)).toBe('未提供');
    expect(formatMaintenanceValue('currentWorkMode', undefined)).toBe('未提供');
    expect(formatMaintenanceValue('currentWorkMode', '')).toBe('空字符串');
    expect(formatMaintenanceValue('currentWorkMode', 'NEW_MODE')).toBe('NEW_MODE');
    expect(formatMaintenanceValue('modelId', 'DM-0042')).toBe('DM-0042');
    expect(maintenanceFieldLabel('customField')).toBe('customField');
    expect(formatMaintenanceValue('customField', { note: '原文' })).toContain('原文');
    expect(maintenanceFieldLabel('constructor')).toBe('constructor');
    expect(formatMaintenanceValue('currentWorkMode', '__proto__')).toBe('__proto__');
    expect(configurationStatusLabel('constructor')).toBe('constructor');
  });

  it('端口按身份对齐，重排后仍只列实际变动的参数', () => {
    const before = initialResources().devices.find(device => device.id === 'DV-0001')!.ports!;
    const after = structuredClone(before).reverse();
    after.find(port => port.number === 'BUS-1')!.rateKbps = 128;
    const rows = maintenanceChangeRows([{ field: 'ports', before, after }]);
    expect(rows.find(row => row.label === '端口 BUS-1 · 速率')).toMatchObject({ before: '64 kbps', after: '128 kbps' });
    expect(rows.filter(row => row.label.includes('RF-1'))).toEqual([]);
    expect(rows.find(row => row.label === '端口排列')).toMatchObject({ before: 'RF-1、BUS-1', after: 'BUS-1、RF-1' });
  });

  it('端口原状态未知时不造前值，缺少端口与空清单保持各自展示', () => {
    const port = initialResources().devices.find(device => device.id === 'DV-0001')!.ports![0]!;
    const rows = maintenanceChangeRows([{ field: 'ports', before: null, after: [port] }]);
    expect(rows.find(row => row.label === '端口 RF-1 · 速率')).toMatchObject({ before: '未提供', after: '9.6 kbps' });
    expect(rows.every(row => !row.label.includes('新增'))).toBe(true);
    expect(maintenanceChangeRows([{ field: 'ports', before: null, after: [] }])[0]).toMatchObject({ before: '未提供', after: '无端口记录' });
  });

  it('基线依据正文或既有摘要来源，不按未知操作人或 initial 版本猜测', () => {
    expect(isDeviceBaseline({ source: '首次留存的变更前快照' } as DeviceHistorySummary)).toBe(true);
    expect(isDeviceBaseline({ source: '资源维护', actor: null, revision: 'initial' } as DeviceHistorySummary)).toBe(false);
    expect(isDeviceBaseline({ before: null, source: '其他来源' } as DeviceHistory)).toBe(true);
    expect(isDeviceBaseline({ before: initialResources().devices[0], source: '首次留存的变更前快照' } as DeviceHistory)).toBe(false);
  });

  it('留存状态只展示已有值，转换不修改历史或端口', () => {
    const device = initialResources().devices.find(item => item.id === 'DV-0001')!;
    const bytes = JSON.stringify(device), snapshot = maintenanceSnapshotRows(device);
    expect(snapshot.find(row => row.label === '设备编号')?.value).toBe('DV-0001');
    expect(snapshot.find(row => row.label === '端口 RF-1 · 端口类型')?.value).toBe('射频端口');
    expect(snapshot.every(row => !Object.hasOwn(row, 'before'))).toBe(true);
    expect(JSON.stringify(device)).toBe(bytes);
  });
});
