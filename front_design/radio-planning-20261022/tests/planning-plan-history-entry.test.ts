import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import History from '../src/components/PlanningHistoryDrawer.vue';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { apiPlan, apiTask, input, storeFixture } from './fixtures/planning-api';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, renderer, node, find, textOf } from './helpers/vue-client';
import type { PlanningPlanSummary } from '../src/types/planning-api';

// 实际历史模板与状态逻辑；只替换对 DOM 有要求的抽屉和表格宿主。
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { h } = await import('vue'); return { default: { props: ['visible'], setup: (p: any, { slots }: any) => () => p.visible ? h('drawer', slots.default?.()) : null } };
});
vi.mock('../src/components/AppTable.vue', async () => {
  const { h } = await import('vue'); return { default: { props: ['rows'], setup: (p: any, { slots }: any) => () => h('table-probe', p.rows.map((row: any) => h('row-probe', [row.name, slots.actions?.({ row })]))) } };
});
await clientTemplate(History, 'src/components/PlanningHistoryDrawer.vue', 'saved-history-render.ts');
const summary: PlanningPlanSummary = { id: 'P-1', taskId: 'T1', name: '数据库保存方案', version: 'V1', state: 'SAVED', current: false, sourceChanged: false, savedAt: '2026-10-23T00:00:00Z' };
let app: App | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
async function mountHistory() {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const query = vi.spyOn(previewService, 'querySavedPlanningPlans').mockResolvedValue({ items: [summary], total: 11, pageNum: 1, pageSize: 10 });
  const legacy = vi.spyOn(previewService, 'queryPlanningReferenceSummaries');
  const props = reactive({ visible: true, disabled: false, initialTab: 'saved' as const });
  const open = vi.fn(); app = renderer.createApp({ render: () => h(History, { ...props, onOpenPlan: open }) });
  app.use(pinia); app.provide(ssrContextKey, {}); const root = node('root'); app.mount(root); await settle();
  return { props, query, legacy, open, root, auth };
}
describe('已保存方案历史目录', () => {
  it('只查已保存摘要，查询筛选和翻页由服务执行，打开传递完整归属', async () => {
    const s = await mountHistory(); expect(s.legacy).not.toHaveBeenCalled();
    expect(textOf(s.root)).toContain('已保存方案'); expect(textOf(s.root)).not.toContain('只读参考方案');
    await (find(s.root, n => n.tag === 'button' && textOf(n) === '打开方案')!.props.onClick as Function)();
    expect(s.open).toHaveBeenCalledWith(summary);
    (find(s.root, n => n.tag === 'select')!.props['onUpdate:modelValue'] as Function)('CONFIRMED');
    (find(s.root, n => n.tag === 'input')!.props['onUpdate:modelValue'] as Function)('数据库');
    s.query.mockResolvedValue({ items: [], total: 11, pageNum: 1, pageSize: 10 });
    await (find(s.root, n => n.tag === 'form')!.props.onSubmit as Function)({ preventDefault() {} }); await settle();
    expect(s.query).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'CONFIRMED', search: '数据库', pageNum: 1 }));
    s.query.mockResolvedValue({ items: [], total: 11, pageNum: 2, pageSize: 10 });
    await (find(s.root, n => n.tag === 'button' && textOf(n) === '下页')!.props.onClick as Function)(); await settle();
    expect(s.query).toHaveBeenLastCalledWith(expect.objectContaining({ pageNum: 2 }));
  });
  it('关闭窗口后迟到列表不覆盖上次成功页，错误明确显示', async () => {
    const s = await mountHistory();
    let resolve!: (value: any) => void;
    s.query.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const submit = (find(s.root, n => n.tag === 'form')!.props.onSubmit as Function)({ preventDefault() {} });
    await nextTick(); s.props.visible = false; await nextTick();
    resolve({ items: [{ ...summary, name: '迟到数据' }], total: 1, pageNum: 1, pageSize: 10 }); await submit; await settle();
    s.query.mockRejectedValueOnce(new Error('数据库读取失败')); s.props.visible = true; await settle();
    expect(textOf(s.root)).toContain('数据库读取失败'); expect(textOf(s.root)).not.toContain('迟到数据');
  });
});

async function store() {
  const s = await storeFixture(); pinia = s.pinia;
  const planning = usePlanningApiStore(pinia); planning.selectedPlan = apiPlan('OLD');
  return { ...s, planning };
}
describe('历史方案打开的现场保护', () => {
  it('跨任务打开前读取详情，成功后显示同一冻结结果并刷新版本列表', async () => {
    const s = await store(), plan = { ...apiPlan(), taskId: 'T2' };
    vi.mocked(previewService.getPlanningPlan).mockResolvedValue(plan);
    vi.mocked(previewService.getTaskInput).mockResolvedValue({ ...apiTask(), taskId: 'T2' });
    expect(await s.planning.openHistoricalPlan('T2', plan.id)).toBe(true);
    expect(s.task.taskId).toBe('T2'); expect(s.planning.selectedPlan?.result.snapshotId).toBe(plan.result.snapshotId);
    expect(s.planning.step).toBe(2); expect(s.planning.job).toBeNull();
  });
  it('未保存输入选择取消时保留任务和旧结果', async () => {
    const s = await store(); s.task.updateInput({ ...input(), name: '保留草稿' });
    const opening = s.planning.openHistoricalPlan('T1', 'P-1');
    await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); s.task.answer('cancel');
    expect(await opening).toBe(false); expect(s.task.draft!.name).toBe('保留草稿'); expect(s.planning.selectedPlan?.id).toBe('OLD');
  });
  it('详情失败和错误归属均不请求切换任务', async () => {
    const s = await store(), before = vi.mocked(previewService.getTaskInput).mock.calls.length;
    vi.mocked(previewService.getPlanningPlan).mockRejectedValueOnce(new ApiError('方案不存在', 2001));
    expect(await s.planning.openHistoricalPlan('T2', 'MISSING')).toBe(false);
    vi.mocked(previewService.getPlanningPlan).mockResolvedValueOnce({ ...apiPlan(), taskId: 'T9' });
    expect(await s.planning.openHistoricalPlan('T2', 'P-1')).toBe(false);
    expect(s.task.taskId).toBe('T1'); expect(s.planning.selectedPlan?.id).toBe('OLD');
    expect(vi.mocked(previewService.getTaskInput).mock.calls).toHaveLength(before);
  });
  it('方案详情迟到且已取消时不切换现场', async () => {
    const s = await store(), controller = new AbortController(); let resolve!: (value: any) => void;
    vi.mocked(previewService.getPlanningPlan).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const opening = s.planning.openHistoricalPlan('T2', 'P-1', controller.signal);
    controller.abort(); resolve({ ...apiPlan(), taskId: 'T2' });
    expect(await opening).toBe(false); expect(s.planning.selectedPlan?.id).toBe('OLD'); expect(s.task.taskId).toBe('T1');
  });
  it('任务读取阶段关闭窗口，也不能接受迟到任务', async () => {
    const s = await store(), controller = new AbortController(); let resolve!: (value: any) => void;
    vi.mocked(previewService.getPlanningPlan).mockResolvedValueOnce({ ...apiPlan(), taskId: 'T2' });
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const opening = s.planning.openHistoricalPlan('T2', 'P-1', controller.signal);
    await vi.waitFor(() => expect(resolve).toBeDefined()); controller.abort(); resolve({ ...apiTask(), taskId: 'T2' });
    expect(await opening).toBe(false); expect(s.task.taskId).toBe('T1'); expect(s.planning.selectedPlan?.id).toBe('OLD');
  });
  it('身份变化后返回的详情不能应用', async () => {
    const s = await store(); let resolve!: (value: any) => void;
    vi.mocked(previewService.getPlanningPlan).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const opening = s.planning.openHistoricalPlan('T2', 'P-1'); s.auth.accept(null); resolve({ ...apiPlan(), taskId: 'T2' });
    expect(await opening).toBe(false); expect(s.task.taskId).toBe('T1'); expect(s.planning.selectedPlan?.id).toBe('OLD');
  });
});
