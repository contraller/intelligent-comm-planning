import { describe, expect, it } from 'vitest';
import { isModuleTab, moduleTabValues, resourceTabLabel, spectrumTabLabel } from '../src/config/module-tabs';
import { safeReturnPath } from '../src/config/permissions';

describe('频谱三页签与旧资源链接兼容', () => {
  it('频谱页只接纳三个频谱页签，资源旧值继续用于链接迁移', () => {
    expect(moduleTabValues.spectrum).toEqual(['frequencies', 'spectrum-config', 'spectrum-monitor']);
    expect(isModuleTab('spectrum', 'ledger')).toBe(false);
    expect(resourceTabLabel('ledger')).toBe('设备台账');
    for (const tab of moduleTabValues.spectrum) {
      expect(isModuleTab('resources', tab)).toBe(true);
      expect(isModuleTab('spectrum', tab)).toBe(true);
    }
  });
  it.each([
    ['frequencies', '规划频点'], ['spectrum-config', '频谱接口配置'], ['spectrum-monitor', '频谱观测'],
  ])('频谱页签 %s 映射到现有业务名称', (value, label) => expect(spectrumTabLabel(value)).toBe(label));
  it.each([undefined, null, '', 'ledger', 'unknown', ['frequencies'], ['spectrum-config', 'spectrum-monitor'], {}])
    ('非法或重复页签 %j 回到规划频点，不装配设备台账', value => expect(spectrumTabLabel(value)).toBe('规划频点'));
  it.each(['', '/embed'])('安全返回地址%s仍接纳旧深链和新频谱深链', prefix => {
    for (const tab of moduleTabValues.spectrum) {
      const legacy = `${prefix}/resources?tab=${tab}`;
      const canonical = `${prefix}/spectrum?tab=${tab}`;
      expect(safeReturnPath(legacy)).toBe(legacy);
      expect(safeReturnPath(canonical)).toBe(canonical);
    }
    expect(safeReturnPath(prefix + '/resources?tab=ledger')).toBe(prefix + '/resources?tab=ledger');
    expect(safeReturnPath(prefix + '/spectrum')).toBe(prefix + '/spectrum');
  });
  it.each([
    '/spectrum?tab=ledger', '/embed/spectrum?tab=ledger', '/spectrum?tab=frequencies&tab=spectrum-config',
    '/embed/spectrum?tab=spectrum-monitor&next=https://outside.invalid', '/spectrum?tab=unknown',
  ])('频谱安全返回拒绝未知/台账/混合目标 %s', value => expect(safeReturnPath(value)).toBeNull());
});
