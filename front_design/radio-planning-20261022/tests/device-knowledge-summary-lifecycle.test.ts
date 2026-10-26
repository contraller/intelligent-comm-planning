import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { useDeviceKnowledgeSummary } from '../src/composables/useDeviceKnowledgeSummary';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { createAccessService } from '../src/services/access';
import { useKnowledgeStore } from '../src/stores/knowledge';
import type { DeviceKnowledge } from '../src/types/knowledge';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

// 实际挂载 composable，内存宿主只代替 DOM，不替换生命周期与响应式更新。
interface Host { text: string; parent: Host | null; children: Host[] }
const host = (text = ''): Host => ({ text, parent: null, children: [] });
const renderer = createRenderer<Host, Host>({
  createElement: () => host(), createText: host, createComment: host,
  insert(child, parent) { child.parent = parent; parent.children.push(child); },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  setText(el, text) { el.text = text; }, setElementText(el, text) { el.text = text; },
  parentNode: el => el.parent, nextSibling: () => null, patchProp: () => {},
  insertStaticContent(text, parent) { const el = host(text); el.parent = parent; parent.children.push(el); return [el, el]; },
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); await nextTick(); }
let app: App<Host> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); });
async function fixture(preload = true) {
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore(), storage = new TestStorage(), raw = createMockService(() => storage);
  const load = vi.spyOn(previewService, 'loadKnowledgeMetadata').mockImplementation(raw.loadKnowledgeMetadata);
  for (const name of ['searchKnowledgeSummaries', 'getKnowledgeGraph', 'getKnowledgeEntity'] as const)
    vi.spyOn(previewService, name).mockImplementation(raw[name] as never);
  const query = vi.spyOn(previewService, 'getDeviceKnowledge').mockImplementation(raw.getDeviceKnowledge);
  const store = useKnowledgeStore(); if (preload) await store.ensureMetadata();
  const device = reactive({ id: 'DV-ONE', modelId: 'DM-0001', name: '原设备', power: 10 });
  let state!: ReturnType<typeof useDeviceKnowledgeSummary>;
  async function mount() {
    const Probe = defineComponent({ setup() {
      state = useDeviceKnowledgeSummary(() => device);
      return () => h('p', `${device.name} ${state.status.value}`);
    } });
    app = renderer.createApp(Probe); app.use(pinia!); app.mount(host()); await settle(); return state;
  }
  return { auth, storage, raw, load, query, store, device, mount };
}

describe('设备型号知识摘要生命周期', () => {
  // 保留真实权限包装和身份订阅，覆盖旧测试直接调用 Mock 时漏掉的反馈循环。
  it.each([true, false])('工作区预加载=%s，同身份校验不循环查询，真实失权仍清空摘要', async preload => {
    const s = await fixture(preload);
    let identity = JSON.parse(JSON.stringify(s.auth.identity!)) as NonNullable<typeof s.auth.identity>;
    let sessionReads = 0;
    vi.spyOn(s.raw, 'getSession').mockImplementation(async () => {
      // 缺陷回归时停止制造新对象，让测试失败而不是占满微任务队列。
      return ++sessionReads <= 20 ? structuredClone(identity) : identity;
    });
    const guarded = createAccessService(() => s.raw, null);
    s.query.mockImplementation(guarded.getDeviceKnowledge);
    s.load.mockImplementation(guarded.loadKnowledgeMetadata).mockClear();
    for (const name of ['searchKnowledgeSummaries', 'getKnowledgeGraph', 'getKnowledgeEntity'] as const)
      vi.mocked(previewService[name]).mockImplementation(guarded[name] as never);
    const before = [...s.storage.entries], generation = s.auth.generation;
    const state = await s.mount(); await settle();
    expect(state.status.value).toBe('ready');
    expect(s.query).toHaveBeenCalledTimes(1);
    expect(s.load).toHaveBeenCalledTimes(preload ? 0 : 1);
    expect(sessionReads).toBeLessThan(20);
    const summary = state.summary.value;
    for (let i = 0; i < 3; i++) await guarded.getSession();
    await settle();
    expect(s.auth.generation).toBe(generation);
    expect(s.query).toHaveBeenCalledTimes(1); expect(state.summary.value).toBe(summary);
    identity = { ...identity, permissions: identity.permissions.filter(p => p !== 'knowledge.view') };
    await guarded.getSession(); await settle();
    expect(state.summary.value).toBeNull(); expect(state.status.value).toBe('forbidden');
    await state.retry(); expect(s.query).toHaveBeenCalledTimes(1);
    expect([...s.storage.entries]).toEqual(before);
  });
  it('通过服务读当前发布版且省略 query，不写入存储或根据设备参数重算知识', async () => {
    const s = await fixture(), before = [...s.storage.entries], state = await s.mount();
    expect(state.status.value).toBe('ready');
    expect(s.query).toHaveBeenCalledExactlyOnceWith({ modelId: 'DM-0001', versionId: s.store.current!.id });
    expect(state.summary.value?.components.map(row => row.entityId)).toContain('KGE-POWER');
    const summary = state.summary.value;
    s.device.power = 50; s.store.query = '其他检索'; s.store.historyVersionId = 'KGV-SEED-1';
    await settle();
    expect(state.summary.value).toBe(summary); expect(s.query).toHaveBeenCalledTimes(1);
    expect([...s.storage.entries]).toEqual(before);
  });
  it('首次无工作区只加载一次，读入后查询摘要', async () => {
    const s = await fixture(false), state = await s.mount();
    await settle();
    expect(s.load).toHaveBeenCalledTimes(1); expect(s.query).toHaveBeenCalledTimes(1);
    expect(state.status.value).toBe('ready');
  });
  it('已有工作区加载时挂载与重试共用 loadFlight，完成后只读一次摘要', async () => {
    const s = await fixture(false), late = deferred<Awaited<ReturnType<typeof s.raw.loadKnowledgeMetadata>>>();
    const loaded = await s.raw.loadKnowledgeMetadata(); s.load.mockReturnValueOnce(late.promise);
    const loading = s.store.ensureMetadata(), state = await s.mount(), retry = state.retry();
    expect(state.status.value).toBe('loading'); expect(s.load).toHaveBeenCalledTimes(1);
    late.resolve(loaded); await Promise.all([loading, retry]); await settle();
    expect(state.status.value).toBe('ready'); expect(s.load).toHaveBeenCalledTimes(1); expect(s.query).toHaveBeenCalledTimes(1);
  });
  it.each(['permission', 'unmount'])('首次工作区未返回时 %s，完成后不发摘要请求', async change => {
    const s = await fixture(false), late = deferred<Awaited<ReturnType<typeof s.raw.loadKnowledgeMetadata>>>();
    const loaded = await s.raw.loadKnowledgeMetadata(); s.load.mockReturnValueOnce(late.promise);
    const state = await s.mount();
    if (change === 'permission') s.auth.identity!.permissions = s.auth.identity!.permissions.filter(p => p !== 'knowledge.view');
    else { app!.unmount(); app = undefined; }
    late.resolve(loaded); await settle();
    expect(state.summary.value).toBeNull(); expect(s.query).not.toHaveBeenCalled(); expect(s.load).toHaveBeenCalledTimes(1);
  });
  it('工作区存在但没有可读发布版时，显式重试重新加载', async () => {
    const s = await fixture(); s.store.workspace!.currentVersionId = '缺失的发布版';
    const state = await s.mount(); expect(state.status.value).toBe('workspace-error');
    await state.retry(); await settle();
    expect(state.status.value).toBe('ready'); expect(s.load).toHaveBeenCalledTimes(2); expect(s.query).toHaveBeenCalledTimes(1);
  });
  it('没有权限不加载、不查询；重获权限后读取', async () => {
    const s = await fixture(false), identity = s.auth.identity!;
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(p => p !== 'knowledge.view') });
    const state = await s.mount();
    expect(state.status.value).toBe('forbidden'); expect(s.load).not.toHaveBeenCalled(); expect(s.query).not.toHaveBeenCalled();
    s.auth.accept(identity); await settle();
    expect(state.status.value).toBe('ready'); expect(s.load).toHaveBeenCalledTimes(1);
  });
  it('工作区加载失败不循环，显式重试恢复且摘要不重复请求', async () => {
    const s = await fixture(false); s.load.mockRejectedValueOnce(new Error('工作区暂时不可用'));
    const state = await s.mount(); await settle();
    expect(state.status.value).toBe('workspace-error'); expect(state.error.value).toBe('工作区暂时不可用');
    expect(s.load).toHaveBeenCalledTimes(1); expect(s.query).not.toHaveBeenCalled();
    await state.retry(); await settle();
    expect(state.status.value).toBe('ready'); expect(s.load).toHaveBeenCalledTimes(2); expect(s.query).toHaveBeenCalledTimes(1);
  });
  it('已有工作区错误保留到重试，不自动覆盖未保存的知识输入', async () => {
    const s = await fixture();
    s.store.draft = { summary: '未保存输入', baseVersionId: s.store.current!.id, entities: [], relations: [] };
    s.store.loadError = '请重试知识读取'; s.load.mockClear();
    const draft = s.store.draft, state = await s.mount();
    expect(state.status.value).toBe('workspace-error'); expect(s.load).not.toHaveBeenCalled();
    await state.retry(); await settle();
    expect(s.store.draft).toBe(draft); expect(s.store.draft.summary).toBe('未保存输入');
    expect(state.status.value).toBe('ready');
  });
  it('摘要失败只影响摘要，重试不重载正常工作区', async () => {
    const s = await fixture(); s.query.mockRejectedValueOnce(new Error('摘要服务不可用'));
    s.store.error = '独立编辑反馈'; const state = await s.mount();
    expect(state.status.value).toBe('error'); expect(state.summary.value).toBeNull();
    expect(state.error.value).toBe('摘要服务不可用'); expect(s.store.loadError).toBe('');
    expect(s.store.error).toBe('独立编辑反馈'); expect(s.device.name).toBe('原设备');
    await state.retry();
    expect(state.status.value).toBe('ready'); expect(s.load).toHaveBeenCalledTimes(1);
  });
  it('错误型号／版本的成功响应进入摘要错误态', async () => {
    const s = await fixture(); s.query.mockResolvedValueOnce({ modelId: 'DM-0002', versionId: s.store.current!.id, items: [] });
    const state = await s.mount();
    expect(state.status.value).toBe('error'); expect(state.summary.value).toBeNull(); expect(state.error.value).not.toBe('');
    await state.retry(); expect(state.status.value).toBe('ready');
  });
  it('无知识是正常成功，不等同请求失败', async () => {
    const s = await fixture(); s.device.modelId = 'DM-0016'; const state = await s.mount();
    expect(state.status.value).toBe('ready'); expect(state.error.value).toBe('');
    expect(state.summary.value).toMatchObject({ roots: [], components: [], interfaces: [], functions: [] });
  });
  it.each(['device', 'model', 'version', 'permission', 'session', 'workspace-error'] as const)(
    '%s 变化同步清旧值，迟到成功和迟到失败都不能覆盖新归属', async change => {
      const s = await fixture(), old = deferred<DeviceKnowledge>();
      const oldData = await s.raw.getDeviceKnowledge({ modelId: s.device.modelId, versionId: s.store.current!.id });
      const state = await s.mount(); expect(state.status.value).toBe('ready');
      s.query.mockReturnValueOnce(old.promise); const retry = state.retry(); await settle();
      if (change === 'device') s.device.id = 'DV-TWO';
      if (change === 'model') s.device.modelId = 'DM-0002';
      if (change === 'version') {const v=await s.raw.getKnowledgeVersion({id:'KGV-SEED-1'});s.store.workspace!.versions=[v];s.store.workspace!.currentVersionId=v.id;}
      if (change === 'permission') s.auth.identity!.permissions = s.auth.identity!.permissions.filter(p => p !== 'knowledge.view');
      if (change === 'session') s.auth.generation++;
      if (change === 'workspace-error') s.store.loadError = '工作区已失效';
      expect(state.summary.value).toBeNull(); await settle();
      const current = state.summary.value, currentStatus = state.status.value, currentError = state.error.value;
      old.resolve(oldData); await retry; await settle();
      expect(state.summary.value).toBe(current); expect(state.status.value).toBe(currentStatus); expect(state.error.value).toBe(currentError);
      // 恢复可读后再挂起一次，单独验证旧失败不覆盖新成功。
      s.store.loadError = ''; if (change === 'permission') authorizeStore(); await settle();
      const lateFailure = deferred<DeviceKnowledge>(); s.query.mockReturnValueOnce(lateFailure.promise);
      const second = state.retry(); await settle(); s.device.id += '-new'; await settle();
      expect(state.status.value).toBe('ready'); const latest = state.summary.value;
      lateFailure.reject(new Error('旧设备失败')); await second;
      expect(state.status.value).toBe('ready'); expect(state.error.value).toBe(''); expect(state.summary.value).toBe(latest);
    });
  it('同一轮离开再返回相同设备也拒绝旧回调，不向中间设备发请求', async () => {
    const s = await fixture(), late = deferred<DeviceKnowledge>();
    s.query.mockReturnValueOnce(late.promise); const state = await s.mount();
    s.device.id = 'DV-TWO'; s.device.id = 'DV-ONE'; await settle();
    expect(s.query).toHaveBeenCalledTimes(2); expect(state.status.value).toBe('ready');
    const current = state.summary.value; late.reject(new Error('第一次请求失败')); await settle();
    expect(state.summary.value).toBe(current); expect(state.error.value).toBe('');
  });
  it.each(['success', 'failure'])('卸载后迟到 %s 不复显，重试也不再请求', async outcome => {
    const s = await fixture(), late = deferred<DeviceKnowledge>(); s.query.mockReturnValueOnce(late.promise);
    const data = await s.raw.getDeviceKnowledge({ modelId: 'DM-0001', versionId: s.store.current!.id });
    const state = await s.mount(); app!.unmount(); app = undefined;
    if (outcome === 'success') late.resolve(data); else late.reject(new Error('卸载后失败'));
    await settle(); await state.retry();
    expect(state.summary.value).toBeNull(); expect(state.error.value).toBe(''); expect(s.query).toHaveBeenCalledTimes(1);
  });
});
