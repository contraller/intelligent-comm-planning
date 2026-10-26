import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { RuntimeParametersSnapshot } from '../src/types/runtime-parameters';

const http = vi.hoisted(() => ({ read: vi.fn(), apply: vi.fn() }));
vi.mock('../src/config/env', () => ({ env: { mode: 'http', apiBaseUrl: '/api/v1', sampleData: false } }));
vi.mock('../src/services', () => ({ previewService: {}, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/services/http', () => ({ collaborationHttp: { runtimeParameters: { getRuntimeParameters: http.read } }, applyHttpRuntimeParameters: http.apply }));
vi.mock('../src/components/RequestState.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceEditDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceImportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/IntegrationIdentitySwitcher.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/stores/device-configuration-acceptance', () => ({ useDeviceConfigurationAcceptanceStore: () => ({ busy: false, pending: null, visible: false, close: () => true, cancel: vi.fn() }) }));

import AppShell from '../src/layouts/AppShell.vue';
import { useAuthStore } from '../src/stores/auth';
import { useRuntimeParametersStore } from '../src/stores/runtime-parameters';
import { clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';

const Shell = { ...AppShell };
// 正常CI编译本树原模板；只读主源码装载的隔离harness显式指定同一输入文件。
beforeAll(() => clientTemplate(Shell, process.env.P05_SHELL_TEMPLATE_SOURCE ?? 'src/layouts/AppShell.vue', 'runtime-parameter-shell-render.ts'));
interface PendingRead { signal: AbortSignal; resolve: (value: unknown) => void; reject: (reason: Error) => void }
let pinia: ReturnType<typeof createPinia>, app: App | undefined;
const reads: PendingRead[] = [];
const snapshot = (revision = 'SYS-14', timeout = 20, epoch = 'runtime-epoch'): RuntimeParametersSnapshot => ({
  version: 'runtime-parameters-v1', epoch, revision, values: { 'PAR-01': 30, 'PAR-02': timeout },
});
const identity = () => ({ id: 'explicit-account', sessionId: 'session-one', username: 'operator', name: '隔离主体',
  roleId: 'role-system', roleName: '测试角色', epoch: 'session-generation', revision: '1', permissions: ['system.view'] as const });

beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {}); vi.stubGlobal('window', new EventTarget());
  reads.length = 0; http.read.mockReset(); http.apply.mockReset();
  http.read.mockImplementation((input: { signal: AbortSignal }) => new Promise((resolve, reject) => { reads.push({ signal: input.signal, resolve, reject }); }));
  pinia = createPinia(); setActivePinia(pinia); const auth = useAuthStore(); auth.accept({ ...identity(), permissions: [...identity().permissions] }); auth.currentPath = '/system';
});
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let index = 0; index < 12; index++) await nextTick(); }
async function mount() {
  const runtime = useRuntimeParametersStore(), auth = useAuthStore();
  // 默认spy透传真实实现；false会保留在结果中，不把拒绝伪装成应用成功。
  const report = vi.spyOn(runtime, 'reportApplied'), bind = vi.spyOn(runtime, 'bind'), unbind = vi.spyOn(runtime, 'unbind');
  const effects: { value: RuntimeParametersSnapshot | null; loading: boolean; error: unknown }[] = [];
  http.apply.mockImplementation((value: RuntimeParametersSnapshot | null) => { effects.push({ value, loading: runtime.loading, error: runtime.error }); });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/system', component: { render: () => h('section', { 'data-page': 'system' }, '实际Shell内系统页占位') } }] });
  await router.push('/system'); await router.isReady();
  const root = node('root'); app = renderer.createApp(Shell); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
  return { root, runtime, auth, report, bind, unbind, effects };
}
type Mounted = Awaited<ReturnType<typeof mount>>;
function applied(shell: Mounted, value: RuntimeParametersSnapshot) {
  expect(shell.runtime.loading).toBe(false); expect(shell.runtime.error).toBeNull(); expect(shell.runtime.snapshot).toEqual(value);
  expect(shell.runtime.applications).toEqual([{ consumer: 'http.request-timeout', epoch: value.epoch, revision: value.revision }]);
  expect(http.apply).toHaveBeenLastCalledWith(value);
  expect(shell.report).toHaveBeenLastCalledWith('http.request-timeout', value.epoch, value.revision);
  expect(shell.report.mock.results.at(-1)?.value).toBe(true);
  expect(shell.effects.filter(item => item.value !== null).every(item => !item.loading && !item.error)).toBe(true);
}

describe('实际AppShell与真实runtime store的应用时序', () => {
  it('首次refresh真实pending阶段不报成功，settle后才应用并报告PAR02=20', async () => {
    const shell = await mount(); expect(textOf(shell.root)).toContain('无线网络智能规划系统');
    expect(find(shell.root, item => item.props['data-page'] === 'system')).toBeDefined();
    expect(shell.bind).toHaveBeenCalledTimes(1); expect(reads).toHaveLength(1); expect(shell.runtime.loading).toBe(true);
    expect(shell.runtime.snapshot).toBeNull(); expect(shell.runtime.applications).toEqual([]); expect(shell.report).not.toHaveBeenCalled();
    expect(shell.effects.every(item => item.value === null)).toBe(true);
    const value = snapshot(); reads[0]!.resolve(value); await settle(); applied(shell, value);
    expect(shell.report.mock.results.every(result => result.value === true)).toBe(true);
  });
  it('同标签新版本refresh期间不新增应用成功，结束后替换为新版本', async () => {
    const shell = await mount(), previous = snapshot('SYS-13', 15); reads[0]!.resolve(previous); await settle(); applied(shell, previous);
    const reports = shell.report.mock.calls.length, effects = shell.effects.filter(item => item.value !== null).length;
    const refreshing = shell.runtime.refresh(); await settle(); expect(shell.runtime.loading).toBe(true);
    expect(shell.report).toHaveBeenCalledTimes(reports); expect(shell.effects.filter(item => item.value !== null)).toHaveLength(effects);
    const next = snapshot(); reads.at(-1)!.resolve(next); await refreshing; await settle(); applied(shell, next);
    expect(shell.bind).toHaveBeenCalledTimes(1); expect(shell.report.mock.results.every(result => result.value === true)).toBe(true);
  });
  it.each(['network', 'invalid-snapshot'])('%s失败清除应用标记，页脚实际重试可恢复，不卸载页面', async failure => {
    const shell = await mount(); reads[0]!.resolve(snapshot('SYS-13', 15)); await settle();
    const refreshing = shell.runtime.refresh(), rejected = expect(refreshing).rejects.toBeInstanceOf(Error);
    if (failure === 'network') reads.at(-1)!.reject(new Error('isolated-unavailable'));
    else reads.at(-1)!.resolve({ ...snapshot(), values: { 'PAR-02': 20 } });
    await rejected; await settle();
    expect(shell.runtime.snapshot).toBeNull(); expect(shell.runtime.applications).toEqual([]); expect(http.apply).toHaveBeenLastCalledWith(null);
    expect(textOf(shell.root)).toContain('运行参数未就绪'); expect(find(shell.root, item => item.props['data-page'] === 'system')).toBeDefined();
    const button = find(shell.root, item => item.props['aria-label'] === '重新读取运行参数')!;
    expect(button).toBeDefined(); expect(button.props.disabled).toBe(false);
    const retry = (button.props.onClick as () => Promise<unknown>)(); await settle(); expect(shell.runtime.loading).toBe(true);
    const value = snapshot(); reads.at(-1)!.resolve(value); await retry; await settle(); applied(shell, value);
    expect(textOf(shell.root)).not.toContain('运行参数未就绪');
  });
  it('换身份取消旧请求，迟到旧快照不应用，新身份settle后才报告', async () => {
    const shell = await mount(); reads[0]!.resolve(snapshot('SYS-13', 15)); await settle();
    const oldRefresh = shell.runtime.refresh(); await settle(); const old = reads.at(-1)!;
    shell.auth.accept({ ...identity(), id: 'other-account', sessionId: 'session-two', permissions: [...identity().permissions] }); await settle();
    const latest = reads.at(-1)!; expect(latest).not.toBe(old); expect(old.signal.aborted).toBe(true);
    expect(shell.runtime.snapshot).toBeNull(); expect(shell.runtime.applications).toEqual([]); expect(http.apply).toHaveBeenLastCalledWith(null);
    for (const request of reads.slice(1, -1)) request.resolve(snapshot('SYS-99', 100, 'old-account-epoch'));
    await oldRefresh; await settle(); expect(shell.runtime.snapshot).toBeNull();
    expect(shell.effects.some(item => item.value?.epoch === 'old-account-epoch')).toBe(false);
    const next = snapshot('SYS-14', 20, 'other-account-epoch'); latest.resolve(next); await settle(); applied(shell, next);
    expect(shell.bind).toHaveBeenCalledTimes(1);
  });
  it('退出期间晚响应不恢复配置或应用标记，也不发匿名runtime请求', async () => {
    const shell = await mount(), active = reads[0]!; shell.auth.accept(null); await settle();
    expect(active.signal.aborted).toBe(true); expect(reads).toHaveLength(1); expect(shell.runtime.snapshot).toBeNull();
    active.resolve(snapshot()); await settle();
    expect(shell.runtime.applications).toEqual([]); expect(shell.report).not.toHaveBeenCalled(); expect(http.apply).toHaveBeenLastCalledWith(null);
    expect(shell.effects.every(item => item.value === null)).toBe(true);
  });
  it('卸载解绑并取消读取，迟到响应不能应用；同Pinia重挂允许单次新绑定', async () => {
    const first = await mount(), old = reads[0]!; app!.unmount(); app = undefined; await settle();
    expect(first.unbind).toHaveBeenCalledTimes(1); expect(old.signal.aborted).toBe(true); expect(http.apply).toHaveBeenLastCalledWith(null);
    old.resolve(snapshot('SYS-99', 100)); await settle(); expect(first.runtime.snapshot).toBeNull(); expect(first.runtime.applications).toEqual([]);
    first.report.mockRestore(); first.bind.mockRestore(); first.unbind.mockRestore();
    const second = await mount(); expect(second.bind).toHaveBeenCalledTimes(1); expect(second.runtime.loading).toBe(true);
    const value = snapshot(); reads.at(-1)!.resolve(value); await settle(); applied(second, value);
  });
});
