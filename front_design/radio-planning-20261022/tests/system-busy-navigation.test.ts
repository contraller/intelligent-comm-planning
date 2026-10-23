import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { allPermissions } from '../src/config/permissions';

const service = vi.hoisted(() => ({
  loadSystemOptions: vi.fn(), queryAccountSummaries: vi.fn(),
  queryParameterSummaries: vi.fn(), resetSystemParameters: vi.fn(), getSession: vi.fn(),
}));
vi.mock('../src/services', () => ({ previewService: service }));
vi.mock('../src/config/env', () => ({ env: { mode: 'http' } }));
vi.mock('../src/components/AppDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppTable.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/RequestState.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SystemAccountDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SystemRoleDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SystemParameterDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SystemPasswordDrawer.vue', () => ({ default: { render: () => null } }));

import SystemView from '../src/views/SystemView.vue';
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

const identity = () => ({
  id: 'ACC-busy-navigation', sessionId: 'SID-busy-navigation', username: 'operator',
  name: '维护人员', roleId: 'ROLE-maintainer', roleName: '维护角色', epoch: 'test-epoch',
  revision: '1', permissions: [...allPermissions],
});
const catalog = (revision = 'SYS-1') => ({ revision, roles: [], permissions: [] });
const page = () => ({ items: [], total: 0, pageNum: 1, pageSize: 20, revision: 'SYS-1' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
let pinia: ReturnType<typeof createPinia>;
let app: App | undefined;

beforeAll(async () => {
  await clientTemplate(SystemView, 'src/views/SystemView.vue', 'system-busy-navigation-render.ts');
});
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument);
  vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('window', new EventTarget());
  vi.resetAllMocks();
  pinia = createPinia(); setActivePinia(pinia);
  useAuthStore().accept(identity());
  service.getSession.mockResolvedValue(identity());
  service.loadSystemOptions.mockResolvedValue(catalog());
  service.queryAccountSummaries.mockResolvedValue(page());
  service.queryParameterSummaries.mockResolvedValue(page());
});
afterEach(() => {
  app?.unmount(); app = undefined;
  disposePinia(pinia); vi.unstubAllGlobals();
});

async function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/system', component: SystemView }] });
  await router.push('/system'); await router.isReady();
  const root = node('root');
  app = renderer.createApp({ render: () => h(RouterView) });
  app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root); await settle();
  return root;
}
function sidebarButtons(root: HostNode) {
  const sidebar = find(root, item => item.tag === 'div' && item.props.class === 'side-list');
  expect(sidebar).toBeDefined();
  return all(sidebar!, item => item.tag === 'button');
}
function parameterTab(root: HostNode) {
  const button = sidebarButtons(root).find(item => textOf(item) === '参数配置');
  expect(button).toBeDefined(); return button!;
}

describe('系统侧栏真实写入导航状态', () => {
  it('恢复参数请求及成功后的重载期间全部禁用，收尾后可切换参数页', async () => {
    const root = await mount(), store = useSystemStore();
    const write = deferred<{ revision: string; objectId: string; changed: boolean; operationId: string }>();
    const reload = deferred<ReturnType<typeof catalog>>();
    service.resetSystemParameters.mockReturnValueOnce(write.promise);
    service.loadSystemOptions.mockReturnValueOnce(reload.promise);
    const resetting = store.reset('system'); await settle();
    expect(store.decision?.title).toBe('恢复参数默认值');
    store.answer('save'); await settle();
    expect(service.resetSystemParameters).toHaveBeenCalledTimes(1);
    expect(store.busy).toBe(true);
    expect(sidebarButtons(root)).toHaveLength(4);
    for (const button of sidebarButtons(root)) expect(button.props.disabled).toBe(true);
    // 原store保护仍有效，模板同时向用户提供原生disabled状态。
    await store.changeTab('parameters');
    expect(store.tab).toBe('accounts');
    expect(service.queryParameterSummaries).not.toHaveBeenCalled();

    write.resolve({ revision: 'SYS-2', objectId: 'parameters', changed: true, operationId: 'OP-reset' });
    await settle();
    expect(store.loading).toBe(true); expect(store.busy).toBe(true);
    for (const button of sidebarButtons(root)) expect(button.props.disabled).toBe(true);
    reload.resolve(catalog('SYS-2')); await resetting; await settle();
    expect(store.busy).toBe(false); expect(store.loading).toBe(false);
    for (const button of sidebarButtons(root)) expect(button.props.disabled).toBe(false);
    await (parameterTab(root).props.onClick as () => Promise<void>)(); await settle();
    expect(store.tab).toBe('parameters');
    expect(service.queryParameterSummaries).toHaveBeenCalledTimes(1);
    expect(parameterTab(root).props.class).toContain('active');
  });

  it('首次目录冷加载不禁用侧栏，切换取消旧读取并加载目标页', async () => {
    const cold = deferred<ReturnType<typeof catalog>>();
    service.loadSystemOptions.mockReturnValueOnce(cold.promise);
    const root = await mount(), store = useSystemStore();
    const oldSignal = service.loadSystemOptions.mock.calls[0][0].signal as AbortSignal;
    expect(store.catalog).toBeNull(); expect(store.loading).toBe(true); expect(store.busy).toBe(false);
    for (const button of sidebarButtons(root)) expect(button.props.disabled).toBe(false);
    await (parameterTab(root).props.onClick as () => Promise<void>)(); await settle();
    expect(oldSignal.aborted).toBe(true);
    expect(store.tab).toBe('parameters'); expect(store.loading).toBe(false);
    expect(service.loadSystemOptions).toHaveBeenCalledTimes(2);
    expect(service.queryParameterSummaries).toHaveBeenCalledTimes(1);
    cold.resolve(catalog('SYS-stale')); await settle();
    expect(store.catalog?.revision).toBe('SYS-1'); expect(store.tab).toBe('parameters');
    expect(parameterTab(root).props.disabled).toBe(false);
  });
});
