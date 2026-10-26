import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia, disposePinia } from 'pinia';
import { useAuthStore } from '../src/stores/auth';
import { routePermissions } from '../src/config/permissions';

describe('知识图谱入口可达性', () => {
  it('切换按钮有文字且快捷入口仍受知识权限保护', () => {
    const source = readFileSync('src/components/IntegrationIdentitySwitcher.vue', 'utf8');
    expect(source).toContain("'切换中' : '切换'");
    expect(source).toContain('v-if="auth.can(\'knowledge.view\')" to="/knowledge"');
  });
  it('主导航保持图谱入口，窄屏允许完整换行', () => {
    const source = readFileSync('src/layouts/AppShell.vue', 'utf8');
    expect(source).toContain("path: '/knowledge'");expect(source).toContain('navigation.filter((n) => auth.can(routePermissions[n.path]))');
    expect(source).toContain('flex: 1 0 100%');expect(source).toContain('flex-wrap: wrap');
    expect(routePermissions['/knowledge']).toBe('knowledge.view');
  });
  it('无权限身份不会因可见性修复获得图谱读取权', () => {
    const pinia = createPinia();setActivePinia(pinia);
    try { const auth = useAuthStore();expect(auth.can('knowledge.view')).toBe(false); }
    finally { disposePinia(pinia); }
  });
});
