import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../src/components/SpectrumMonitoringPanel.vue', import.meta.url), 'utf8');
describe('频谱展示装配契约审查', () => {
  it('nullable指标明确未知，实测与构造不混淆', () => { expect(source).toContain("value === null ? '未知'"); expect(source).toContain('构造资料，非实测'); expect(source).toContain('connectNulls: false'); });
  it('只读已存集/帧，宿主停止和会话清理可调用', () => { for (const key of ['createSpectrumObservationsStore', 'initialSelection', 'select-dataset', 'select-frame', 'requestLeave', 'visibilitychange']) expect(source).toContain(key); expect(source).not.toContain('useMonitoringStore'); expect(source).not.toContain('Mock'); });
  it('可选默认R仅用于空选择，已选集冻结R始终优先且不回写', () => {
    expect(source).toContain('resourceRevision?: string');
    const binding = source.match(/:resource-revision="([^"]+)"/)?.[1];
    expect(binding).toBe("s.selected?.resourceRevision ?? resourceRevision ?? ''");
    // 只独立执行本地组件中的纯绑定表达式，不当作Vue交互或浏览器证据。
    const resolve = new Function('s', 'resourceRevision', `return (${binding});`) as (state: { selected: { resourceRevision: string } | null }, revision?: string) => string;
    expect(resolve({ selected: null }, 'resource-current')).toBe('resource-current');
    expect(resolve({ selected: null })).toBe('');
    const selected = Object.freeze({ resourceRevision: 'resource-historical' });
    expect(resolve({ selected }, 'resource-current')).toBe('resource-historical');
    expect(resolve({ selected }, 'resource-current-next')).toBe('resource-historical');
    expect(selected.resourceRevision).toBe('resource-historical');
  });
  it('状态关联区分未核实与未关联，导出显式保留V2；宿主只收到冻结ref', () => {
    for (const text of ['deviceStatusRef?: ObservationDeviceStatusRefInput | null', 'select-status-ref', '未核实', "s.statusRefState === 'unbound'", 'includeDeviceStatusRef: true', ':device-status-ref="deviceStatusRef"']) expect(source).toContain(text);
    const dialog = readFileSync(new URL('../src/components/SpectrumObservationImportDialog.vue', import.meta.url), 'utf8');
    expect(dialog).toContain('linkStatus = ref(false)'); expect(dialog).toContain('关联已选冻结状态快照');
    expect(dialog).toContain("fileSource.value === 'preset'"); expect(dialog).toContain("fileSource.value = 'uploaded'");
  });
});
