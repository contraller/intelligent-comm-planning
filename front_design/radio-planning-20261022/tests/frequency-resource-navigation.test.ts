import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import FrequencyResourcePanel from '../src/components/FrequencyResourcePanel.vue';
import FrequencyResourceEditDrawer from '../src/components/FrequencyResourceEditDrawer.vue';
import { useFrequencyResourceStore } from '../src/stores/frequency-resource';
import { useResourceReadStore } from '../src/stores/resource-read';
import { previewService } from '../src/services';
import { collaborationHttp, httpService } from '../src/services/http';
import { ApiError } from '../src/services/types';
import type { FrequencyDisableReceipt, FrequencyDisableValidation, FrequencyResourcePage } from '../src/types/frequency-resource';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

// 挂载真实资源页、频点面板、store 和路由守卫，只替换无关展示与网络。
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible ? h('aside', slots.default?.()) : null }) };
});
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows'], setup: (props, { slots }) => () => h('div',
    (props.rows ?? []).map((row: Record<string, unknown>) => h('div', [slots.selected?.({ row }), slots.actions?.({ row })]))) }) };
});
vi.mock('../src/components/DecisionDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['request'], emits: ['answer'], setup: (props, { emit }) => () => props.request ? h('div', { role: 'dialog' }, [
    h('p', props.request.title), h('p', props.request.message),
    ...(['cancelLabel', 'discardLabel', 'saveLabel'] as const).filter(key => props.request[key]).map(key => h('button', {
      onClick: () => emit('answer', { cancelLabel: 'cancel', discardLabel: 'discard', saveLabel: 'save' }[key]),
    }, props.request[key])),
  ]) : null }) };
});
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerTree.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerEditDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerImportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerExportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SpectrumObservationImportDialog.vue', async () => {
  const { defineComponent } = await import('vue');
  return { default: defineComponent({ setup: (_props, { expose }) => {
    expose({ requestLeave: () => true, clearForSession: () => {} }); return () => null;
  } }) };
});
vi.mock('../src/components/ObservationStatusReferenceDrawer.vue', () => ({ default: { render: () => null } }));

const base = 'resource-1111111111111111', next = 'resource-2222222222222222';
const item = { freqId: 'FQ-0001', deviceClass: 'HF' as const, centerFreqKhz: 3000, bandwidthKhz: null,
  channelNo: null, isAvailable: true, occupiedBy: null, reuseMinDistanceM: null, adjacentGuardKhz: null, note: null };
const page: FrequencyResourcePage = { revision: base, baseRevision: base, contentHash: 'a'.repeat(64),
  dataOrigin: 'SYNTHETIC_INTEGRATION', source: '项目构造资源', page: 1, pageSize: 10, total: 1, items: [item] };
const validation: FrequencyDisableValidation = { ...page, selectedIds: [item.freqId], wouldDisable: [item.freqId], unchanged: [],
  impact: { resourceRevisionWillChange: true, historicalResourcesPreserved: true, savedPlansRequireRecompute: true, linkImpact: 'UNKNOWN' } };
function receipt(requestId: string): FrequencyDisableReceipt {
  return { objectId: 'resource-frequency-disable', requestId, baseRevision: base, revision: next, readRevision: next,
    changed: true, selectedIds: [item.freqId], updated: [item.freqId], unchanged: [], affectedIds: [item.freqId],
    items: [{ ...item, isAvailable: false }], dataOrigin: 'SYNTHETIC_INTEGRATION', source: page.source, warnings: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeAll(async () => {
  for (const [component, path] of [[ResourcesView, 'src/views/ResourcesView.vue'],
    [FrequencyResourcePanel, 'src/components/FrequencyResourcePanel.vue'],
    [FrequencyResourceEditDrawer, 'src/components/FrequencyResourceEditDrawer.vue']] as const) {
    await clientTemplate(component, path, 'frequency-navigation-render.ts');
  }
});
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function flush() { for (let i = 0; i < 15; i++) await nextTick(); }
async function click(root: HostNode, label: string) {
  const button = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(button, label).toBeDefined();
  await (button!.props.onClick as (event: unknown) => unknown)({ stopPropagation() {}, preventDefault() {} }); await flush();
}
function unload() {
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
  window.dispatchEvent(event); return event.defaultPrevented;
}
async function fixture() {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: new TestStorage(), sessionStorage: new TestStorage() }));
  vi.stubGlobal('document', { activeElement: null }); vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {});
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore();
  // 模拟真实会话校验：身份对象和权限数组重建，账号及权限值均未变化。
  vi.mocked(previewService.getSession).mockImplementation(async () => ({ ...auth.identity!, permissions: [...auth.identity!.permissions] }));
  vi.spyOn(useResourceReadStore(), 'activate').mockResolvedValue(true);
  vi.spyOn(useResourceReadStore(), 'refresh').mockResolvedValue(true);
  const loadContext = vi.spyOn(httpService, 'loadResourceReadContext').mockResolvedValue({ revision: base } as Awaited<ReturnType<typeof httpService.loadResourceReadContext>>);
  const services = collaborationHttp.frequencies;
  const list = vi.spyOn(services, 'queryFrequencyResources').mockResolvedValue(page);
  const history = vi.spyOn(services, 'queryFrequencyOperations').mockResolvedValue({ page: 1, pageSize: 10, total: 0, items: [] });
  const preview = vi.spyOn(services, 'validateFrequencyDisable').mockResolvedValue(validation);
  const save = vi.spyOn(services, 'disableFrequencyResources').mockImplementation(async request => receipt(request.requestId));
  const operation = vi.spyOn(services, 'getFrequencyOperation').mockImplementation(async request => ({ operation: 'FREQUENCY_DISABLE',
    requestId: request.requestId, createdAt: '2026-10-28T00:00:00Z', receipt: receipt(request.requestId) }));
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/resources', component: ResourcesView }, { path: '/situation', component: { render: () => h('p', 'GIS目标页') } },
  ] });
  await router.push('/resources'); await router.isReady();
  const root = node('root'); app = renderer.createApp({ render: () => h(RouterView) });
  app.use(pinia); app.use(router); app.provide(ssrContextKey, {}); app.mount(root); await flush();
  await click(root, '规划频点');
  return { root, router, auth, loadContext, list, history, preview, save, operation, store: useFrequencyResourceStore() };
}

describe('意见5：规划频点真实宿主离页与读取取消', () => {
  it('同值会话校验不重读、不误报失败，已有列表及选行可直接跳GIS', async () => {
    const f = await fixture(); f.store.select(item.freqId, true); await flush();
    expect(f.auth.hasUnsaved()).toBe(false); expect(unload()).toBe(false);
    await f.auth.check(); await flush();
    expect(f.list).toHaveBeenCalledOnce(); expect(f.loadContext).toHaveBeenCalledOnce();
    expect(f.store.selectedIds).toEqual([item.freqId]); expect(f.store.listFailed).toBe(false);
    await f.router.push('/situation');
    expect(f.router.currentRoute.value.path).toBe('/situation'); expect(textOf(f.root)).toContain('GIS目标页');
    expect(f.store.decision).toBeNull(); expect(f.save).not.toHaveBeenCalled();
  });

  it('上下文重读中可离页，取消不显示失败，也不继续查询列表', async () => {
    const f = await fixture(), held = deferred<Awaited<ReturnType<typeof httpService.loadResourceReadContext>>>();
    f.loadContext.mockReturnValueOnce(held.promise); const reading = f.store.refresh(); await flush();
    const signal = f.loadContext.mock.lastCall![0]!.signal!;
    expect(textOf(f.root)).toContain('正在读取规划频点，可切换页面');
    expect(textOf(f.root)).not.toContain('当前显示上次成功列表'); expect(unload()).toBe(false);
    await f.router.push('/situation'); expect(f.router.currentRoute.value.path).toBe('/situation'); expect(signal.aborted).toBe(true);
    held.resolve({ revision: next } as Awaited<ReturnType<typeof httpService.loadResourceReadContext>>); await reading;
    expect(f.list).toHaveBeenCalledOnce(); expect(f.store.revision).toBe(base); expect(f.store.error).toBe('');
    expect(f.store.listFailed).toBe(false); expect(f.store.phase).toBe('IDLE'); expect(f.store.pending).toBeNull();
  });

  it('列表查询中可离页，晚到旧页不能覆盖已有列表或误作停用失败', async () => {
    const f = await fixture(), held = deferred<FrequencyResourcePage>(); f.list.mockReturnValueOnce(held.promise);
    const reading = f.store.loadPage({ page: 2 }); await flush(); const signal = f.list.mock.lastCall![1]!;
    expect(f.store.canSelect).toBe(false); expect(f.store.listFailed).toBe(false);
    await f.router.push('/situation'); expect(signal.aborted).toBe(true);
    held.resolve({ ...page, page: 2 }); await reading;
    expect(f.router.currentRoute.value.path).toBe('/situation'); expect(f.store.page?.page).toBe(1);
    expect(f.store.canSelect).toBe(false); expect(f.store.listFailed).toBe(false); expect(f.store.error).toBe(''); expect(f.save).not.toHaveBeenCalled();
  });

  it('历史查询和回执只读查询均可取消离页，不产生未知写入', async () => {
    const f = await fixture(), heldHistory = deferred<Awaited<ReturnType<typeof collaborationHttp.frequencies.queryFrequencyOperations>>>(),
      heldOperation = deferred<Awaited<ReturnType<typeof collaborationHttp.frequencies.getFrequencyOperation>>>();
    f.history.mockReturnValueOnce(heldHistory.promise); f.operation.mockReturnValueOnce(heldOperation.promise);
    const history = f.store.loadHistory(), operation = f.store.inspectOperation('historical-request'); await flush();
    const historySignal = f.history.mock.lastCall![1]!, operationSignal = f.operation.mock.lastCall![1]!;
    await f.router.push('/situation'); expect(f.router.currentRoute.value.path).toBe('/situation');
    expect(historySignal.aborted).toBe(true); expect(operationSignal.aborted).toBe(true);
    heldHistory.reject(new ApiError('读取已中断', 'REQUEST_ABORTED')); heldOperation.reject(new ApiError('读取已中断', 'REQUEST_ABORTED'));
    await Promise.all([history, operation]);
    expect(f.store.operation).toBeNull(); expect(f.store.pending).toBeNull(); expect(f.store.phase).toBe('IDLE'); expect(f.store.error).toBe('');
  });

  it('停用预检只读，可直接离页且不执行停用', async () => {
    const f = await fixture(), held = deferred<FrequencyDisableValidation>(); f.preview.mockReturnValueOnce(held.promise);
    f.store.select(item.freqId, true); const checking = f.store.prepareDisable(); await flush();
    await f.router.push('/situation'); held.resolve(validation); await checking;
    expect(f.router.currentRoute.value.path).toBe('/situation'); expect(f.store.preview).toBeNull(); expect(f.store.decision).toBeNull();
    expect(f.store.pending).toBeNull(); expect(f.save).not.toHaveBeenCalled();
  });

  it('真实读取失败保留旧列表并禁写，但不阻止离页', async () => {
    const f = await fixture(); f.list.mockRejectedValueOnce(new ApiError('列表读取超时', 'REQUEST_TIMEOUT'));
    await f.store.loadPage({ page: 2 }); await flush();
    expect(textOf(f.root)).toContain('当前显示上次成功列表'); expect(f.store.canSelect).toBe(false); expect(f.store.page?.page).toBe(1);
    await f.router.push('/situation'); expect(f.router.currentRoute.value.path).toBe('/situation'); expect(f.store.pending).toBeNull();
  });

  it('未保存编辑可取消离页保留输入，再明确放弃后离页', async () => {
    const f = await fixture(); await click(f.root, '编辑');
    const note = all(f.root, n => n.props['aria-label'] === '构造频点备注')[0]!;
    (note.props['onUpdate:modelValue'] as (value: string) => void)('未保存草稿'); await flush();
    expect(f.auth.hasUnsaved()).toBe(true); expect(unload()).toBe(true);
    const leaving = f.router.push('/situation'); await flush(); expect(f.store.decision?.title).toBe('离开规划频点');
    await click(f.root, '继续编辑'); await leaving;
    expect(f.router.currentRoute.value.path).toBe('/resources'); expect(f.store.editorDirty).toBe(true);
    expect(all(f.root, n => n.props['aria-label'] === '构造频点备注')[0]!.value).toBe('未保存草稿');
    const retry = f.router.push('/situation'); await flush(); await click(f.root, '放弃草稿并离开'); await retry;
    expect(f.router.currentRoute.value.path).toBe('/situation'); expect(f.store.editor).toBeNull(); expect(f.save).not.toHaveBeenCalled();
  });

  it('未改动的编辑可直接离页，返回后可正常刷新列表', async () => {
    const f = await fixture(); await click(f.root, '编辑'); expect(f.store.editorDirty).toBe(false);
    await f.router.push('/situation'); expect(f.store.editor).toBeNull();
    await f.router.push('/resources'); await flush(); await click(f.root, '规划频点');
    expect(f.list).toHaveBeenCalledTimes(2); expect(f.store.canMaintain).toBe(true);
  });

  it('维护预检后取消离页保留草稿，并恢复可操作的维护确认', async () => {
    const f = await fixture();
    const checked = vi.spyOn(collaborationHttp.frequencies, 'validateFrequencyChanges').mockResolvedValue({
      revision: base, baseRevision: base, dataOrigin: page.dataOrigin, source: page.source,
      selectedIds: [item.freqId], wouldChange: [item.freqId], unchanged: [], impact: validation.impact,
      items: [{ kind: 'PATCH', freqId: item.freqId, before: item, after: { ...item, note: '未保存草稿' } }],
    });
    const save = vi.spyOn(collaborationHttp.frequencies, 'commitFrequencyChanges');
    await click(f.root, '编辑');
    const note = all(f.root, n => n.props['aria-label'] === '构造频点备注')[0]!;
    (note.props['onUpdate:modelValue'] as (value: string) => void)('未保存草稿'); await flush();
    const form = all(f.root, n => n.tag === 'form' && n.props.class === 'frequency-edit')[0]!;
    await (form.props.onSubmit as (event: unknown) => unknown)({ preventDefault() {} }); await flush();
    expect(checked).toHaveBeenCalledOnce(); expect(f.store.decision?.title).toBe('确认构造频点维护');
    const leaving = f.router.push('/situation'); await flush(); await click(f.root, '继续编辑'); await leaving;
    expect(f.router.currentRoute.value.path).toBe('/resources'); expect(f.store.changesPreview).not.toBeNull();
    expect(f.store.decision?.title).toBe('确认构造频点维护'); expect(f.store.editorDirty).toBe(true);
    await click(find(f.root, n => n.props.role === 'dialog')!, '取消');
    expect(f.store.changesPreview).toBeNull(); expect(f.store.editorDirty).toBe(true);
    expect(all(f.root, n => n.props['aria-label'] === '构造频点备注')[0]!.value).toBe('未保存草稿'); expect(save).not.toHaveBeenCalled();
  });

  it('保存已确认后的列表重读可取消离页，保留成功回执', async () => {
    const f = await fixture(), held = deferred<Awaited<ReturnType<typeof httpService.loadResourceReadContext>>>();
    f.store.select(item.freqId, true); await f.store.prepareDisable();
    f.loadContext.mockReturnValueOnce(held.promise); const saving = f.store.answer('save'); await flush();
    expect(f.store.phase).toBe('RESOLVED'); expect(f.store.pending).toBeNull(); expect(f.store.loading.context).toBe(true);
    const original = f.store.receipt!.requestId;
    await f.router.push('/situation'); held.reject(new ApiError('读取已中断', 'REQUEST_ABORTED')); await saving;
    expect(f.router.currentRoute.value.path).toBe('/situation'); expect(f.store.phase).toBe('RESOLVED');
    expect(f.store.pending).toBeNull(); expect(f.store.receipt?.requestId).toBe(original); expect(f.store.error).toBe('');
  });

  it('保存中保护离页；超时后的真实待核实写入也不能被普通查询清除', async () => {
    const f = await fixture(), held = deferred<FrequencyDisableReceipt>(); f.save.mockReturnValueOnce(held.promise);
    f.store.select(item.freqId, true); await f.store.prepareDisable(); const saving = f.store.answer('save'); await flush();
    await f.router.push('/situation'); expect(f.router.currentRoute.value.path).toBe('/resources'); expect(unload()).toBe(true);
    const original = f.store.pending!.requestId;
    held.reject(new ApiError('提交超时', 'REQUEST_TIMEOUT')); await saving;
    await f.router.push('/situation'); expect(f.router.currentRoute.value.path).toBe('/resources');
    expect(textOf(f.root)).toContain('请先核实频点原请求'); expect(f.store.pending?.requestId).toBe(original);
    f.store.stopReading(); expect(f.store.pending?.requestId).toBe(original); expect(f.store.phase).toBe('RESULT_UNKNOWN');
    await f.router.push('/situation'); expect(f.router.currentRoute.value.path).toBe('/resources'); expect(f.save).toHaveBeenCalledOnce();
    await f.store.inspectOperation(original); await f.router.push('/situation');
    expect(f.router.currentRoute.value.path).toBe('/situation'); expect(f.store.pending).toBeNull(); expect(f.store.receipt?.requestId).toBe(original);
  });
});
