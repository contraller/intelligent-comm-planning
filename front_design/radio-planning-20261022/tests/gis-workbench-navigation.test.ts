import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, type App } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { node, renderer } from './helpers/vue-client';

const calls = vi.hoisted(() => ({
  configuration: { leave: vi.fn(async () => true), clearForSession: vi.fn(), dirty: false, busy: false, pending: null },
  gis: { leave: vi.fn(async () => true), clearHistory: vi.fn(), start: vi.fn(), stop: vi.fn(), dirty: false, busy: false },
  editor: { clearSession: vi.fn() },
  auth: { registerLeave: vi.fn(() => vi.fn()), check: vi.fn(async () => true), bypassLeave: false, blocked: false },
  diagnosis: { allowDiscard: vi.fn(async () => false), dirty: true, locked: false, refreshSources: vi.fn(), load: vi.fn(),
    allowsGisTransfer: vi.fn((query: Record<string, unknown>) => query.faultEdit === '1'), clearGisTransfer: vi.fn(), stopPolling: vi.fn(), answer: vi.fn() },
}));
vi.mock('../src/stores/device-configuration', () => ({ useDeviceConfigurationStore: () => calls.configuration }));
vi.mock('../src/stores/gis-workspace', () => ({ useGisWorkspaceStore: () => calls.gis }));
vi.mock('../src/stores/resource-edit', () => ({ useResourceEditStore: () => calls.editor }));
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => calls.auth }));
vi.mock('../src/stores/diagnosis', () => ({ useDiagnosisStore: () => calls.diagnosis }));
import { useGisTaskLeaveGuard } from '../src/composables/useGisTaskLeaveGuard';
import { useDiagnosisLeaveGuard } from '../src/composables/useDiagnosisLeaveGuard';

let app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function mount(path: string, diagnosis = false) {
  vi.stubGlobal('window', new EventTarget());
  const page = { setup() {
    if (diagnosis) useDiagnosisLeaveGuard();
    else useGisTaskLeaveGuard({ fault: { active: () => false, dirty: () => false, busy: () => false, leave: async () => true, isReturnTarget: () => false } });
    return () => h('div');
  } };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path, component: page },
    ...['/planning', '/situation', '/gis-workbench'].filter(p => p !== path).map(path => ({ path, component: { render: () => h('div') } })),
  ] });
  await router.push(path); await router.isReady(); app = renderer.createApp({ render: () => h(RouterView) }); app.use(router); app.mount(node('root'));
  return router;
}
describe('GIS工作台新路由保留离页和诊断接力保护', () => {
  it.each(['/situation', '/gis-workbench'])('%s确认离页后才清理配置、资源及GIS草稿', async path => {
    const router = await mount(path); await router.push('/planning');
    expect(calls.configuration.leave).toHaveBeenCalledWith(true); expect(calls.gis.leave).toHaveBeenCalledWith(true);
    expect(calls.configuration.clearForSession).toHaveBeenCalledOnce(); expect(calls.editor.clearSession).toHaveBeenCalledOnce(); expect(calls.gis.clearHistory).toHaveBeenCalledOnce();
  });
  it('后续守卫拒绝导航时保留工作台现场', async () => {
    const router = await mount('/gis-workbench'); router.beforeEach(() => false); await router.push('/planning');
    expect(router.currentRoute.value.path).toBe('/gis-workbench'); expect(calls.editor.clearSession).not.toHaveBeenCalled(); expect(calls.gis.clearHistory).not.toHaveBeenCalled();
  });
  it.each(['/situation', '/gis-workbench'])('诊断到%s合法故障接力保留同一草稿，正常离开仍执行未保存保护', async target => {
    const router = await mount('/diagnosis', true); await router.push({ path: target, query: { faultEdit: '1' } });
    expect(router.currentRoute.value.path).toBe(target); expect(calls.diagnosis.allowDiscard).not.toHaveBeenCalled();
    await router.push('/diagnosis'); await router.push('/planning');
    expect(router.currentRoute.value.path).toBe('/diagnosis'); expect(calls.diagnosis.clearGisTransfer).toHaveBeenCalled(); expect(calls.diagnosis.allowDiscard).toHaveBeenCalledOnce();
  });
});
