import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('来源组件装配契约审查', () => {
  const source = readFileSync(new URL('../src/components/SpectrumConfigPanel.vue', import.meta.url), 'utf8');
  it('只依赖注入服务，移除旧Mock/重置操作', () => {
    expect(source).toContain('services: SpectrumSourceServices'); expect(source).not.toContain('useSpectrumStore');
    expect(source).not.toContain('Mock 检查'); expect(source).not.toContain('store.reset'); expect(source).toContain('离线校验');
  });
  it('保留宿主离开/会话生命周期与真实文件导出', () => {
    for (const value of ['requestLeave', 'clearForSession', 'dirty-change', 'busy-change', 'select-source', 'URL.createObjectURL', 'URL.revokeObjectURL']) expect(source).toContain(value);
    expect(source).toContain('discardLabel'); expect(source).toContain('saveLabel');
  });
});
