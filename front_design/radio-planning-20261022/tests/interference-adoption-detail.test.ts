import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import Drawer from '../src/components/InterferenceAdoptionDetailDrawer.vue';
import { useAuthStore } from '../src/stores/auth';
import type { AdoptionDetail, RunDetail } from '../src/types/interference-workbench';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/AppDrawer.vue', () => ({
  default: defineComponent({
    props: ['visible', 'title'], emits: ['update:visible'],
    setup: (props, { slots, emit }) => () => props.visible ? h('aside', [
      h('h2', props.title),
      h('button', { 'aria-label': '关闭抽屉', onClick: () => emit('update:visible', false) }, '关闭'),
      slots.default?.(),
    ]) : null,
  }),
}));

let pinia: ReturnType<typeof createPinia>, app: App | undefined;
beforeAll(() => clientTemplate(Drawer, 'src/components/InterferenceAdoptionDetailDrawer.vue', 'interference-adoption-detail-render.ts'));
beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia);
  useAuthStore().accept({ id: 'unit-reader', username: 'unit-reader', name: 'UNIT_TEST',
    roleId: 'unit-role', roleName: 'UNIT_TEST', sessionId: 'unit-session', epoch: 'unit-epoch', revision: '1',
    permissions: ['situation.view', 'planning.view'] });
});
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); });
const hash = 'a'.repeat(64), stamp = '2026-10-24T00:00:00Z';

// Explicit service DTO fixtures; these tests are not real HTTP or browser evidence.
function adoption(id = 'AD-1', runId = 'RUN-1'): AdoptionDetail {
  return { adoption_id: id, task_id: 'TASK-1', run_id: runId, measure_id: 'MEASURE-1', adoption_version: 3,
    state: 'SUCCESS', source_hash: hash, source_state: { state: 'CURRENT', reasons: [] },
    planning_request_id: 'PLANNING-REQUEST-' + id, planning_job_id: 'JOB-' + id,
    planning_state: 'SUCCESS', planning_progress: 100, result_plan_id: 'CHILD-' + id, result_plan_state: 'SAVED',
    error: null, data_origin: 'SYNTHETIC_INTEGRATION', created_at: stamp, updated_at: stamp };
}
function analysis(runId = 'RUN-1', planId = 'PARENT-1'): RunDetail {
  return { run_id: runId, task_id: 'TASK-1', scene_id: 'SCENE-1', scene_version_id: 'SCENE-V1',
    plan_id: planId, plan_version: 'V7', resource_revision: 'RES-1', run_version: 1, state: 'SUCCESS',
    progress: 100, phase: '分析完成', cancel_requested: false, error: null, source_hash: hash,
    source_state: { state: 'CURRENT', reasons: [] }, data_origin: 'SYNTHETIC_INTEGRATION', started_at: stamp, updated_at: stamp,
    source: { schemaVersion: 1, sceneId: 'SCENE-1', taskId: 'TASK-1', versionId: 'SCENE-V1', versionNo: 1,
      name: 'UNIT_TEST', note: '', planId, planVersion: 'V7', resourceRevision: 'RES-1', sourceCount: 0,
      snapshotHash: hash, dataOrigin: 'SYNTHETIC_INTEGRATION', savedAt: stamp, previousVersionId: null,
      savedBy: 'unit-reader', resourceContentHash: hash, source: 'SR4', interferenceIds: [], interferenceSources: [],
      planSnapshot: { taskId: 'TASK-1', planId, planVersion: 'V7', inputVersion: 'INPUT-1', conditionVersion: 'COND-1',
        resourceRevision: 'RES-1', source: 'SR4', inputSnapshot: {}, rawSnapshot: {} } },
    result: { analysis_id: runId, affected_nodes: [], affected_links: [], affected_area: {},
      summary: { links: 0, jammers: 0, affected_nodes: 0, affected_links: 0, by_level: { SEVERE: 0, MODERATE: 0, MINOR: 0 } },
      measures: [{ measure_id: 'MEASURE-1', type: 'POWER_OPT', target_node_id: null, target_link_id: null,
        priority: 1, title: '持久化功率措施', detail: 'UNIT_TEST', risk: 'UNIT_TEST', available: true,
        unavailable_reasons: [], change_set: {}, preview_hash: hash, pre_eval: null, restores: false }],
      unresolved: [], measure_review: [], parameter_substitutions: [], notes: [] },
    result_hash: hash, adoptions: [], adoption_capabilities: {
      FREQ_ADJUST: { enabled: false, reasons: [] }, CHANNEL_SWITCH: { enabled: false, reasons: [] },
      POWER_OPT: { enabled: false, reasons: [] }, ROUTE_REBUILD: { enabled: false, reasons: [] }, NODE_REDEPLOY: { enabled: false, reasons: [] },
    } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick(); } }
function services() {
  return { getAdoption: vi.fn(async (_input: { task_id: string; adoption_id: string }, _signal?: AbortSignal) => adoption()),
    getRun: vi.fn(async (_input: { task_id: string; run_id: string }, _signal?: AbortSignal) => analysis()),
    adoptMeasure: vi.fn(), cancelAdoption: vi.fn(), submitRun: vi.fn() };
}
async function mount(client = services(), visible = true, adoptionId = 'AD-1') {
  const state = reactive({ visible, taskId: 'TASK-1', adoptionId, services: client });
  const updates: boolean[] = [], root = node('root');
  app = renderer.createApp({ render: () => h(Drawer, { ...state, 'onUpdate:visible': value => {
    updates.push(value); state.visible = value;
  } }) });
  app.use(pinia); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
  return { root, state, client, updates };
}
function field(root: HostNode, label: string) {
  const dt = find(root, row => row.tag === 'dt' && textOf(row) === label);
  expect(dt, label).toBeDefined();
  return textOf(dt!.parent!.children[dt!.parent!.children.indexOf(dt!) + 1]!);
}
async function click(root: HostNode, label: string) {
  const target = find(root, row => row.tag === 'button' && row.props['aria-label'] === label);
  expect(target, label).toBeDefined(); expect(target!.props.disabled).not.toBe(true);
  await (target!.props.onClick as () => unknown)(); await settle();
}

describe('持久化措施采纳只读详情', () => {
  it('按采纳原号读取，再用持久化run原号读取父方案与措施，只有查看权限也可用', async () => {
    const { root, client } = await mount();
    expect(client.getAdoption).toHaveBeenCalledExactlyOnceWith({ task_id: 'TASK-1', adoption_id: 'AD-1' }, expect.any(AbortSignal));
    expect(client.getRun).toHaveBeenCalledExactlyOnceWith({ task_id: 'TASK-1', run_id: 'RUN-1' }, expect.any(AbortSignal));
    expect(field(root, '规划请求号')).toBe('PLANNING-REQUEST-AD-1'); expect(field(root, '采纳请求号')).toBe('未提供');
    expect(field(root, '原分析编号')).toBe('RUN-1'); expect(field(root, '措施编号')).toBe('MEASURE-1');
    expect(field(root, '措施名称')).toBe('持久化功率措施'); expect(field(root, '父方案编号')).toBe('PARENT-1');
    expect(field(root, '父方案版本')).toBe('V7'); expect(field(root, '子规划作业编号')).toBe('JOB-AD-1');
    expect(field(root, '子方案编号')).toBe('CHILD-AD-1'); expect(field(root, '结论')).toBe('重算结果已保存 · SUCCESS');
    expect(field(root, '数据来源')).toBe('SYNTHETIC_INTEGRATION');
    expect(all(root, row => ['input', 'select', 'textarea'].includes(row.tag))).toHaveLength(0);
    for (const method of [client.adoptMeasure, client.cancelAdoption, client.submitRun]) expect(method).not.toHaveBeenCalled();
  });
  it('未打开或缺少编号不查询，显式打开后才读取', async () => {
    const { root, state, client } = await mount(services(), false, '');
    expect(client.getAdoption).not.toHaveBeenCalled(); state.visible = true; await settle();
    expect(textOf(root)).toContain('请选择采纳记录'); expect(client.getAdoption).not.toHaveBeenCalled();
    state.adoptionId = 'AD-1'; await settle(); expect(client.getAdoption).toHaveBeenCalledTimes(1);
  });
  it('空子job/子方案/进度/错误显示未提供，0进度保留，REFERENCE不变成正式结论', async () => {
    const client = services(), value = adoption();
    Object.assign(value, { planning_job_id: null, planning_state: null, planning_progress: 0,
      result_plan_id: null, result_plan_state: null, state: 'PENDING', error: null });
    client.getAdoption.mockResolvedValue(value); const { root } = await mount(client);
    for (const label of ['采纳请求号', '子规划作业编号', '子规划状态', '子方案编号', '子方案状态', '失败信息']) expect(field(root, label)).toBe('未提供');
    expect(field(root, '子规划进度')).toBe('0%'); expect(field(root, '结论')).toBe('等待重算 · PENDING');
    client.getAdoption.mockResolvedValue({ ...value, state: 'SUCCESS', result_plan_id: 'REF-1', result_plan_state: 'REFERENCE', planning_progress: null });
    await click(root, '重新读取采纳详情');
    expect(field(root, '子方案状态')).toBe('REFERENCE'); expect(field(root, '子规划进度')).toBe('未提供');
    expect(textOf(root)).not.toContain('当前方案'); expect(textOf(root)).not.toContain('已确认');
  });
  it('失败、取消和历史来源使用响应原值，不补成功或当前来源', async () => {
    const client = services(); client.getAdoption.mockResolvedValue({ ...adoption(), state: 'FAILED', error: '真实失败原因',
      source_state: { state: 'HISTORICAL', reasons: ['资源已变化'] } });
    const { root } = await mount(client);
    expect(field(root, '结论')).toBe('重算失败 · FAILED'); expect(field(root, '失败信息')).toBe('真实失败原因');
    expect(field(root, '来源状态')).toBe('HISTORICAL'); expect(field(root, '来源说明')).toBe('资源已变化');
    client.getAdoption.mockResolvedValue({ ...adoption(), state: 'CANCELLED' }); await click(root, '重新读取采纳详情');
    expect(field(root, '结论')).toBe('重算已取消 · CANCELLED');
  });
  it('采纳查询失败可原号重读，不发写请求或伪造详情', async () => {
    const client = services(); client.getAdoption.mockRejectedValueOnce(new Error('网络读取失败'));
    const { root } = await mount(client); expect(textOf(root)).toContain('采纳详情读取失败：网络读取失败');
    expect(client.getRun).not.toHaveBeenCalled(); expect(find(root, row => row.tag === 'dl')).toBeUndefined();
    await click(root, '重新读取采纳详情'); expect(client.getAdoption).toHaveBeenCalledTimes(2);
    expect(field(root, '采纳编号')).toBe('AD-1'); expect(textOf(root)).not.toContain('网络读取失败');
    expect(client.adoptMeasure).not.toHaveBeenCalled();
  });
  it('原分析查询失败仍保留独立采纳原号，父方案和措施名称不从当前现场补', async () => {
    const client = services(); client.getRun.mockRejectedValue(new Error('原分析不可读'));
    const { root } = await mount(client);
    expect(textOf(root)).toContain('原分析详情读取失败：原分析不可读'); expect(field(root, '规划请求号')).toBe('PLANNING-REQUEST-AD-1');
    expect(field(root, '原分析编号')).toBe('RUN-1'); expect(field(root, '父方案编号')).toBe('未提供');
    expect(field(root, '措施名称')).toBe('未提供'); expect(field(root, '子方案编号')).toBe('CHILD-AD-1');
  });
  it.each(['task_id', 'adoption_id'] as const)('拒绝采纳%s错归属，不继续读原分析', async key => {
    const client = services(); client.getAdoption.mockResolvedValue({ ...adoption(), [key]: 'WRONG' });
    const { root } = await mount(client); expect(textOf(root)).toContain('采纳详情与请求任务或编号不一致');
    expect(client.getRun).not.toHaveBeenCalled(); expect(find(root, row => row.tag === 'dl')).toBeUndefined();
  });
  it.each(['task_id', 'run_id', 'source_hash'] as const)('拒绝原分析%s不一致，不混合其他父方案', async key => {
    const client = services(); client.getRun.mockResolvedValue({ ...analysis('RUN-1', 'WRONG-PARENT'), [key]: 'WRONG' });
    const { root } = await mount(client); expect(textOf(root)).toContain('原分析的任务、编号或来源摘要与采纳记录不一致');
    expect(field(root, '父方案编号')).toBe('未提供'); expect(field(root, '措施名称')).toBe('未提供');
    expect(textOf(root)).not.toContain('WRONG-PARENT');
  });
  it('切换采纳对象中止旧读取，晚到旧采纳不覆盖新编号或触发旧原分析查询', async () => {
    const pending = deferred<AdoptionDetail>(), client = services(); client.getAdoption.mockReturnValueOnce(pending.promise);
    const { root, state } = await mount(client), signal = client.getAdoption.mock.calls[0]![1] as AbortSignal;
    client.getAdoption.mockResolvedValue(adoption('AD-2', 'RUN-2')); client.getRun.mockResolvedValue(analysis('RUN-2', 'PARENT-2'));
    state.adoptionId = 'AD-2'; await settle(); expect(signal.aborted).toBe(true);
    pending.resolve(adoption()); await settle();
    expect(field(root, '采纳编号')).toBe('AD-2'); expect(field(root, '父方案编号')).toBe('PARENT-2');
    expect(client.getRun).toHaveBeenCalledTimes(1); expect(client.getRun.mock.calls[0]![0].run_id).toBe('RUN-2');
  });
  it('切换任务会取消原分析读取，晚到旧父方案不混入新任务', async () => {
    const pending = deferred<RunDetail>(), client = services(); client.getRun.mockReturnValueOnce(pending.promise);
    const { root, state } = await mount(client), signal = client.getRun.mock.calls[0]![1] as AbortSignal;
    client.getAdoption.mockResolvedValue({ ...adoption('AD-2', 'RUN-2'), task_id: 'TASK-2' });
    client.getRun.mockResolvedValue({ ...analysis('RUN-2', 'PARENT-2'), task_id: 'TASK-2' });
    state.taskId = 'TASK-2'; state.adoptionId = 'AD-2'; await settle(); expect(signal.aborted).toBe(true);
    pending.resolve(analysis('RUN-1', 'OLD-PARENT')); await settle();
    expect(field(root, '任务编号')).toBe('TASK-2'); expect(field(root, '父方案编号')).toBe('PARENT-2'); expect(textOf(root)).not.toContain('OLD-PARENT');
  });
  it('关闭中止读取且发出关闭事件，重新打开同号要重新读取', async () => {
    const pending = deferred<AdoptionDetail>(), client = services(); client.getAdoption.mockReturnValueOnce(pending.promise);
    const { root, state, updates } = await mount(client), signal = client.getAdoption.mock.calls[0]![1] as AbortSignal;
    await click(root, '关闭抽屉'); expect(updates).toEqual([false]); expect(signal.aborted).toBe(true);
    pending.reject(new Error('关闭后的晚失败')); await settle(); expect(textOf(root)).toBe('');
    state.visible = true; await settle(); expect(client.getAdoption).toHaveBeenCalledTimes(2); expect(field(root, '采纳编号')).toBe('AD-1');
    expect(textOf(root)).not.toContain('关闭后的晚失败');
  });
  it('失去查看权限清除详情、中止原分析并禁止刷新，晚响应不能恢复内容', async () => {
    const pending = deferred<RunDetail>(), client = services(); client.getRun.mockReturnValueOnce(pending.promise);
    const { root } = await mount(client), signal = client.getRun.mock.calls[0]![1] as AbortSignal;
    const auth = useAuthStore(); auth.accept({ ...auth.identity!, permissions: ['planning.view'] }); await settle();
    expect(signal.aborted).toBe(true); pending.resolve(analysis()); await settle();
    expect(textOf(root)).toContain('需要 GIS 态势和网络规划查看权限'); expect(find(root, row => row.tag === 'dl')).toBeUndefined();
    expect(find(root, row => row.props['aria-label'] === '重新读取采纳详情')!.props.disabled).toBe(true);
  });
  it('同权限新身份会重新读取，旧身份晚响应不展示', async () => {
    const pending = deferred<AdoptionDetail>(), client = services(); client.getAdoption.mockReturnValueOnce(pending.promise);
    const { root } = await mount(client), signal = client.getAdoption.mock.calls[0]![1] as AbortSignal;
    const auth = useAuthStore(); auth.accept({ ...auth.identity!, id: 'reader-two', sessionId: 'session-two' }); await settle();
    expect(signal.aborted).toBe(true); pending.resolve({ ...adoption(), planning_request_id: 'OLD-REQUEST' }); await settle();
    expect(field(root, '规划请求号')).toBe('PLANNING-REQUEST-AD-1'); expect(textOf(root)).not.toContain('OLD-REQUEST');
  });
  it('卸载中止待处理读取，不因晚结果继续请求原分析', async () => {
    const pending = deferred<AdoptionDetail>(), client = services(); client.getAdoption.mockReturnValueOnce(pending.promise);
    await mount(client); const signal = client.getAdoption.mock.calls[0]![1] as AbortSignal;
    app!.unmount(); app = undefined; expect(signal.aborted).toBe(true); pending.resolve(adoption()); await settle();
    expect(client.getRun).not.toHaveBeenCalled();
  });
});
