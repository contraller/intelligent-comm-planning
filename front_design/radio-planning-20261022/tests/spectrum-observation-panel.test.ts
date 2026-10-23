import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../src/components/SpectrumMonitoringPanel.vue', import.meta.url), 'utf8');
describe('频谱展示装配契约审查', () => {
  it('nullable指标明确未知，实测与构造不混淆', () => { expect(source).toContain("value === null ? '未知'"); expect(source).toContain('构造资料，非实测'); expect(source).toContain('connectNulls: false'); });
  it('只读已存集/帧，宿主停止和会话清理可调用', () => { for (const key of ['createSpectrumObservationsStore', 'initialSelection', 'select-dataset', 'select-frame', 'requestLeave', 'visibilitychange']) expect(source).toContain(key); expect(source).not.toContain('useMonitoringStore'); expect(source).not.toContain('Mock'); });
});
