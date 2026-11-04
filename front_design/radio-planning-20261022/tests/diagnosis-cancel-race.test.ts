import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { diagnosisHistory } from '../src/mocks/diagnosis-history';
import DiagnosisProgressPanel from '../src/components/DiagnosisProgressPanel.vue';
import type { DiagnosisMutation, DiagnosisProgress, DiagnosisReadView, DiagnosisReceipt } from '../src/types/diagnosis';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
let pinia: ReturnType<typeof createPinia> | undefined, store: ReturnType<typeof useDiagnosisStore> | undefined, app: App<HostNode> | undefined;
afterEach(() => {
  app?.unmount(); app = undefined; store?.clearForSession(); store = undefined;
  if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks();
});

// 模拟服务在POST时先推进revision、回执后到达；与只延迟GET不同，旧实现会真实触发版本冲突。
async function fixture() {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const frozen = structuredClone(diagnosisHistory[0]), id = 'FR-cancel-race';
  let revision = 1, impactTaskId: string | null = null;
  const state: DiagnosisProgress = { id, state: 'RUNNING', progress: 55, phases: [{ name: '诊断', state: 'done' }], diagnosisReady: true, impactReady: false, error: null, source: { state: 'CURRENT', reasons: [] }, resultVersion: 'RV-race', dataOrigin: 'SAMPLE' };
  const detail = (): DiagnosisReadView => ({ ...structuredClone(state), run: {
    id, diagnoseTaskId: 'diagnose-race', impactTaskId, startedAt: 1, cancelledAt: state.state === 'CANCELLED' ? 2 : null,
    presetId: 'race', presetVersion: 'race-v1', scenario: { id: 'FSV-race', scenarioId: 'FS-race', version: 1, savedAt: '2026-11-04T00:00:00Z', name: frozen.name, description: frozen.description, planId: frozen.network.id, faults: frozen.faults, network: frozen.network },
  } });
  const receipt = (value: number): DiagnosisReceipt => ({ objectId: id, entityIds: [id], changed: true, revision: `SR5-${value}` });
  const receipts = new Map<string, { input: string; value: DiagnosisReceipt }>();
  const mutate = (input: DiagnosisMutation & { runId: string }, kind: 'impact' | 'cancel') => {
    const previous = receipts.get(input.requestId);
    if (previous) { expect(JSON.stringify(input)).toBe(previous.input); return structuredClone(previous.value); }
    if (input.baseRevision !== `SR5-${revision}`) throw new ApiError('诊断工作区已变化，请保留输入并重新读取', 1203, undefined, input.requestId, 409);
    if (kind === 'cancel' && state.state === 'SUCCESS') throw new ApiError('已完成的完整分析不能取消', 1203, undefined, input.requestId, 409);
    if (kind === 'impact') impactTaskId = 'impact-race';
    else state.state = 'CANCELLED';
    const value = receipt(++revision); receipts.set(input.requestId, { input: JSON.stringify(input), value }); return value;
  };
  vi.spyOn(previewService, 'loadDiagnosisContext').mockImplementation(async () => ({ revision: 'SR5-1', error: null, capabilities: { twoStep: true }, dataOrigin: 'SAMPLE', presets: [], legacy: [], sources: { plans: [], error: null }, symptoms: [], interferenceIds: [], latestRunId: null }));
  vi.spyOn(previewService, 'queryDiagnosisScenarios').mockResolvedValue({ items: [], total: 0, pageNum: 1, pageSize: 20 });
  vi.spyOn(previewService, 'queryDiagnosisHistory').mockResolvedValue({ items: [], total: 0, pageNum: 1, pageSize: 20 });
  const progress = vi.spyOn(previewService, 'getDiagnosisProgress').mockImplementation(async () => structuredClone(state));
  const readDetail = vi.spyOn(previewService, 'getDiagnosisDetail').mockImplementation(async () => detail());
  vi.spyOn(previewService, 'getDiagnosisStage').mockImplementation(async () => structuredClone(frozen.result));
  vi.spyOn(previewService, 'getDiagnosisReport').mockImplementation(async () => ({ ...structuredClone(frozen), id, legacy: false }));
  const impact = vi.spyOn(previewService, 'submitDiagnosisImpactReceipt').mockImplementation(async input => mutate(input, 'impact'));
  const cancel = vi.spyOn(previewService, 'cancelDiagnosisReceipt').mockImplementation(async input => mutate(input, 'cancel'));
  store = useDiagnosisStore(); await store.load(); store.runId = id; store.view = detail();
  return { store, auth, id, state, detail, mutate, impact, cancel, progress, readDetail, receipt, revision: () => revision };
}
async function confirm(s: Awaited<ReturnType<typeof fixture>>) {
  const pending = s.store.cancel(); expect(s.store.decision?.title).toBe('取消诊断'); s.store.answer('save'); await settle(); return { pending };
}

describe('诊断影响提交与取消串行', () => {
  it('impact已推进服务版本而回执延迟时，取消等待回执并使用新revision', async () => {
    const s = await fixture(), gate = deferred<void>();
    s.impact.mockImplementationOnce(async input => { const value = s.mutate(input, 'impact'); await gate.promise; return value; });
    const querying = s.store.query(); await vi.waitFor(() => expect(s.impact).toHaveBeenCalledOnce());
    expect(s.revision()).toBe(2); expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.store.locked).toBe(true); expect(s.store.busy).toBe(false);
    const cancelling = await confirm(s); expect(s.store.busy).toBe(true); expect(s.cancel).not.toHaveBeenCalled();
    gate.resolve(); await Promise.all([querying, cancelling.pending]);
    expect(s.cancel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseRevision: 'SR5-2', runId: s.id }));
    expect(s.cancel.mock.calls[0][0].requestId).not.toBe(s.impact.mock.calls[0][0].requestId);
    expect(s.store.workspace!.revision).toBe('SR5-3'); expect(s.store.view!.state).toBe('CANCELLED'); expect(s.store.cancelAwaitingRefresh).toBe(false); expect(s.store.busy).toBe(false);
    expect(s.readDetail).toHaveBeenCalledTimes(1); // 取消不等待impact之后的只读详情。
    await s.store.cancel(); expect(s.cancel).toHaveBeenCalledTimes(1);
  });

  it('进度GET尚在途时提出取消，确认弹框期间也不会新发impact', async () => {
    const s = await fixture(), gate = deferred<DiagnosisProgress>(); s.progress.mockImplementationOnce(() => gate.promise);
    const querying = s.store.query(), cancelling = s.store.cancel();
    expect(s.store.decision).not.toBeNull(); gate.resolve(structuredClone(s.state)); await querying;
    expect(s.impact).not.toHaveBeenCalled(); expect(s.cancel).not.toHaveBeenCalled();
    s.store.answer('save'); await cancelling;
    expect(s.cancel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseRevision: 'SR5-1' })); expect(s.store.view!.state).toBe('CANCELLED');
  });

  it('取消先发且回执未回时，轮询与重复点击均不产生新的写操作', async () => {
    const s = await fixture(), gate = deferred<void>();
    s.cancel.mockImplementationOnce(async input => { const value = s.mutate(input, 'cancel'); await gate.promise; return value; });
    const cancelling = await confirm(s); expect(s.cancel).toHaveBeenCalledOnce();
    await s.store.query(); await s.store.cancel(); expect(s.impact).not.toHaveBeenCalled(); expect(s.cancel).toHaveBeenCalledOnce(); expect(s.store.decision).toBeNull();
    gate.resolve(); await cancelling.pending; expect(s.store.view!.state).toBe('CANCELLED');
  });

  it('放弃首次取消后解除意图与busy，下一轮可正常提交impact', async () => {
    const s = await fixture(), cancelling = s.store.cancel(); expect(s.store.busy).toBe(true);
    s.store.answer('cancel'); await cancelling; expect(s.store.busy).toBe(false);
    await s.store.query(); expect(s.impact).toHaveBeenCalledOnce(); expect(s.cancel).not.toHaveBeenCalled(); expect(s.store.locked).toBe(false);
  });

  it('自然完成返回409时保留真实错误，后续只读回查显示完成而非取消', async () => {
    const s = await fixture(), gate = deferred<void>();
    s.impact.mockImplementationOnce(async input => { const value = s.mutate(input, 'impact'); await gate.promise; return value; });
    const querying = s.store.query(); await vi.waitFor(() => expect(s.impact).toHaveBeenCalledOnce());
    const cancelling = await confirm(s); s.state.state = 'SUCCESS'; s.state.impactReady = true; s.state.progress = 100; gate.resolve();
    await Promise.all([querying, cancelling.pending]);
    expect(s.store.error).toBe('已完成的完整分析不能取消'); expect(s.store.cancelAwaitingRefresh).toBe(false); expect(s.store.notice).not.toContain('取消已完成'); expect(s.store.workspace!.revision).toBe('SR5-2');
    await s.store.query(); expect(s.store.view!.state).toBe('SUCCESS'); expect(s.store.record!.id).toBe(s.id); expect(s.impact).toHaveBeenCalledOnce(); expect(s.cancel).toHaveBeenCalledOnce();
  });

  it('确认弹框期间自然完成，仅补回只读报告，不发送取消', async () => {
    const s = await fixture(), gate = deferred<DiagnosisProgress>(); s.progress.mockImplementationOnce(() => gate.promise);
    const querying = s.store.query(), cancelling = s.store.cancel();
    s.state.state = 'SUCCESS'; s.state.impactReady = true; s.state.progress = 100; gate.resolve(structuredClone(s.state)); await querying;
    expect(s.store.view!.state).toBe('SUCCESS'); expect(s.store.record).toBeNull();
    s.store.answer('save'); await cancelling; await vi.waitFor(() => expect(s.store.record?.id).toBe(s.id));
    expect(s.cancel).not.toHaveBeenCalled(); expect(s.impact).not.toHaveBeenCalled(); expect(s.store.notice).toContain('任务已结束'); expect(s.store.cancelAwaitingRefresh).toBe(false);
  });

  it('工作区冲突409不冒充取消成功，已确认取消意图继续阻止新impact', async () => {
    const s = await fixture(); s.cancel.mockRejectedValueOnce(new ApiError('诊断工作区已变化，请保留输入并重新读取', 1203, undefined, 'request-conflict', 409));
    await (await confirm(s)).pending;
    expect(s.store.error).toContain('工作区已变化'); expect(s.store.cancelAwaitingRefresh).toBe(false); expect(s.store.workspace!.revision).toBe('SR5-1');
    await s.store.query(); expect(s.impact).not.toHaveBeenCalled(); expect(s.store.view!.state).toBe('RUNNING');
  });

  it('impact回执丢失后保留原号和原参数，核实前不发送取消', async () => {
    const s = await fixture();
    s.impact.mockImplementationOnce(async input => { s.mutate(input, 'impact'); throw new Error('影响回执读取超时'); });
    await s.store.query(); const first = structuredClone(s.impact.mock.calls[0][0]);
    expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.store.queryError).toContain('影响回执读取超时');
    await (await confirm(s)).pending;
    expect(s.cancel).not.toHaveBeenCalled(); expect(s.store.error).toContain('提交尚未确认');
    // 进度已带impactTaskId也必须原号核实回执，不能只猜测新revision。
    await s.store.query(); expect(s.impact).toHaveBeenNthCalledWith(2, first); expect(s.revision()).toBe(2); expect(s.store.workspace!.revision).toBe('SR5-2');
    await (await confirm(s)).pending; expect(s.cancel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseRevision: 'SR5-2' })); expect(s.store.view!.state).toBe('CANCELLED');
  });

  it('impact明确409拒绝仍展示冲突并释放工作区读取资格，不盲目重发或取消', async () => {
    const s = await fixture(), gate = deferred<void>();
    s.impact.mockImplementationOnce(async () => { await gate.promise; throw new ApiError('诊断工作区已变化，请保留输入并重新读取', 1203, undefined, 'impact-conflict', 409); });
    const querying = s.store.query(); await vi.waitFor(() => expect(s.impact).toHaveBeenCalledOnce()); const cancelling = await confirm(s);
    gate.resolve(); await Promise.all([querying, cancelling.pending]);
    expect(s.store.queryError).toContain('工作区已变化'); expect(s.store.error).toContain('工作区已变化'); expect(s.store.locked).toBe(false); expect(s.cancel).not.toHaveBeenCalled(); expect(s.impact).toHaveBeenCalledOnce();
    await s.store.query(); expect(s.impact).toHaveBeenCalledOnce(); expect(s.store.workspace!.revision).toBe('SR5-1');
  });

  it('impact在途取消后换号，旧回执与旧finally不覆盖新会话状态', async () => {
    const s = await fixture(), gate = deferred<void>();
    s.impact.mockImplementationOnce(async input => { const value = s.mutate(input, 'impact'); await gate.promise; return value; });
    const querying = s.store.query(); await vi.waitFor(() => expect(s.impact).toHaveBeenCalledOnce()); const cancelling = await confirm(s);
    s.auth.accept({ ...s.auth.identity!, sessionId: 'new-session' }); s.store.clearForSession();
    s.store.workspace = { revision: 'SR5-70', scenarios: [], runs: [] }; s.store.runId = 'FR-new'; s.store.busy = true;
    gate.resolve(); await Promise.all([querying, cancelling.pending]);
    expect(s.cancel).not.toHaveBeenCalled(); expect(s.store.workspace.revision).toBe('SR5-70'); expect(s.store.runId).toBe('FR-new'); expect(s.store.busy).toBe(true); expect(s.store.view).toBeNull(); expect(s.store.error).toBe('');
  });

  it('等待impact期间权限撤销，不把旧回执用于继续取消', async () => {
    const s = await fixture(), gate = deferred<void>();
    s.impact.mockImplementationOnce(async input => { const value = s.mutate(input, 'impact'); await gate.promise; return value; });
    const querying = s.store.query(); await vi.waitFor(() => expect(s.impact).toHaveBeenCalledOnce()); const cancelling = await confirm(s);
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'diagnosis.execute') }); gate.resolve();
    await Promise.all([querying, cancelling.pending]); expect(s.cancel).not.toHaveBeenCalled(); expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.store.cancelAwaitingRefresh).toBe(false);
  });

  it('取消回执确认后详情读取失败，仅重查状态而不再次取消', async () => {
    const s = await fixture(); s.readDetail.mockRejectedValueOnce(new Error('详情暂不可读'));
    await (await confirm(s)).pending; expect(s.store.cancelAwaitingRefresh).toBe(true); expect(s.store.queryError).toContain('详情暂不可读');
    await s.store.cancel(); expect(s.cancel).toHaveBeenCalledOnce(); await s.store.query();
    expect(s.store.view!.state).toBe('CANCELLED'); expect(s.store.cancelAwaitingRefresh).toBe(false); expect(s.impact).not.toHaveBeenCalled(); expect(s.cancel).toHaveBeenCalledOnce();
  });

  it('回执任务身份不匹配时不接纳revision、不继续取消', async () => {
    const s = await fixture(); s.impact.mockResolvedValueOnce({ ...s.receipt(2), objectId: 'FR-other', entityIds: ['FR-other'] });
    await s.store.query(); await (await confirm(s)).pending;
    expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.cancel).not.toHaveBeenCalled(); expect(s.store.cancelAwaitingRefresh).toBe(false);
  });
});

await clientTemplate(DiagnosisProgressPanel, 'src/components/DiagnosisProgressPanel.vue', 'diagnosis-cancel-progress-render.ts');
describe('取消处理中进度面板', () => {
  it('等待期间显示处理状态并禁用按钮，成功回执后仍区分状态待刷新', async () => {
    const s = await fixture(), root = node('root');
    app = renderer.createApp({ render: () => h(DiagnosisProgressPanel, { view: s.store.view!, queryError: s.store.queryError, busy: s.store.busy, cancelAwaitingRefresh: s.store.cancelAwaitingRefresh }) }); app.use(pinia!); app.provide(ssrContextKey, {}); app.mount(root);
    s.store.busy = true; await nextTick();
    const button = find(root, n => n.tag === 'button' && textOf(n) === '取消处理中…')!;
    expect(button.props.disabled).toBe(true); expect(button.props['aria-busy']).toBe(true); expect(textOf(root)).not.toContain('取消已完成');
    s.store.cancelAwaitingRefresh = true; await nextTick(); expect(textOf(root)).toContain('取消已完成，状态待刷新'); expect(textOf(root)).toContain('上次读取值');
  });
});
