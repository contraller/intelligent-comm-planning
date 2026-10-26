import { useResourceReadStore } from '../src/stores/resource-read';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, defineComponent, h, nextTick, reactive, type App } from 'vue';
import { useSituationDiagnosis } from '../src/composables/useSituationDiagnosis';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { usePlanningStore } from '../src/stores/planning';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePreviewStore } from '../src/stores/preview';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { GIS_DIAGNOSIS_LEVELS } from '../src/services/gis-diagnosis-display';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import type { DiagnosisRecord } from '../src/types/diagnosis';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

// 内存宿主只替代 DOM；挂载真实 composable、Store、报告服务及响应式生命周期。
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
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(initialQuery: Record<string, unknown> = { diagnosisId: 'DG-HW' }) {
  const events = new EventTarget(), documentState = { hidden: false };
  vi.stubGlobal('window', events); vi.stubGlobal('document', documentState);
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore(), storage = new TestStorage(), raw = createMockService(() => storage);
  const report = vi.spyOn(previewService, 'getDiagnosisReport').mockImplementation(raw.getDiagnosisReport);
  const workspace = vi.spyOn(previewService, 'loadDiagnosisWorkspace'), run = vi.spyOn(previewService, 'getDiagnosisRun');
  const submit = vi.spyOn(previewService, 'submitDiagnosis');
  const query = reactive<{ value: Record<string, unknown> }>({ value: initialQuery });
  const gis = useGisWorkspaceStore(), preview = usePreviewStore(), planning = usePlanningStore(), task = useTaskInputStore(), diagnosis = useDiagnosisStore();
  let state!: ReturnType<typeof useSituationDiagnosis>;
  async function mount() {
    const Probe = defineComponent({ setup() {
      state = useSituationDiagnosis(() => query.value);
      return () => h('p', state.status.value);
    } });
    app = renderer.createApp(Probe); app.use(pinia!); app.mount(host()); await settle(); return state;
  }
  function dispatchStorage(key: string | null) {
    const event = new Event('storage'); Object.defineProperty(event, 'key', { value: key }); events.dispatchEvent(event);
  }
  return { auth, storage, raw, report, workspace, run, submit, query, gis, preview, planning, task, diagnosis,
    events, documentState, dispatchStorage, mount };
}
const firstNode = (record: DiagnosisRecord) => ({ objectType: 'NODE' as const, objectId: record.result.nodes[0].nodeId });

describe('GIS 诊断报告读取与显示归属', () => {
  it('同报告来源刷新保留冻结传播步骤及引用，不写入诊断工作区',async()=>{
    const s=await fixture(),record=await s.raw.getDiagnosisReport('DG-HW');
    const node=record.network.inputSnapshot.stations[0],device=record.network.inputSnapshot.devices.find(d=>d.stationId===node.id)!;
    record.faults=[{objectType:'DEVICE',objectId:device.id,faultType:'HW_FAILURE',symptomIds:[],occurTime:null,interferenceId:null}];
    record.result.propagationPaths=[{id:'frozen-path',faultKey:`DEVICE:${device.id}`,level:'SEVERE',reason:'冻结教学传播',steps:[{objectType:'DEVICE',objectId:device.id,reason:'设备异常'},{objectType:'NODE',objectId:node.id,reason:'所属节点受影响'}]}];
    s.report.mockResolvedValue(record);const state=await s.mount(),paths=state.display.value!.paths,before=JSON.stringify(paths),writes=s.storage.writes;
    const refreshed=structuredClone(record);refreshed.source={state:'UNKNOWN',reasons:['上游暂不可核实']};s.report.mockResolvedValue(refreshed);
    s.events.dispatchEvent(new Event('focus'));await settle();expect(state.display.value!.paths).toBe(paths);expect(JSON.stringify(paths)).toBe(before);
    expect(state.impact.value.paths).toEqual(paths);expect(s.storage.writes).toBe(writes);expect(s.submit).not.toHaveBeenCalled();
  });
  it.each(['resource', 'analysis', 'monitoring'] as const)('普通 %s 入口不读取诊断服务，也不改变模式或草稿', async mode => {
    const s = await fixture({}); s.gis.mapMode = mode;
    s.diagnosis.draft = { name: '未保存诊断输入', description: '', planId: '独立规划', faults: [] };
    const before = JSON.stringify(s.diagnosis.$state), state = await s.mount();
    expect(state.status.value).toBe('idle'); expect(state.display.value).toBeNull(); expect(s.gis.mapMode).toBe(mode);
    expect(state.open()).toBe(false); s.events.dispatchEvent(new Event('focus')); await settle();
    expect(s.report).not.toHaveBeenCalled(); expect(s.workspace).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled();
    expect(JSON.stringify(s.diagnosis.$state)).toBe(before);
  });
  it('明确历史 ID 只调用完整报告，保持存储与诊断页选择、输入不变', async () => {
    const s = await fixture(), legacy = await s.raw.getDiagnosisReport('DG-LINK');
    s.diagnosis.record = legacy; s.diagnosis.runId = '原诊断选择'; s.diagnosis.error = '原编辑反馈';
    s.diagnosis.draft = { name: '保留诊断输入', description: '', planId: legacy.network.id, faults: [] };
    const before = JSON.stringify(s.diagnosis.$state), entries = [...s.storage.entries], writes = s.storage.writes;
    const state = await s.mount();
    expect(s.gis.mapMode).toBe('diagnosis'); expect(state.status.value).toBe('ready');
    expect(s.report).toHaveBeenCalledExactlyOnceWith('DG-HW'); expect(state.display.value?.record.completedAt).toBeNull();
    expect(state.display.value?.record.result.summary).toBeNull(); expect(s.workspace).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled(); expect(s.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(s.diagnosis.$state)).toBe(before); expect([...s.storage.entries]).toEqual(entries); expect(s.storage.writes).toBe(writes);
  });
  it.each([
    { diagnosisId: '' }, { diagnosisId: null }, { diagnosisId: ['DG-HW'] },
    { diagnosisId: ['DG-HW', 'DG-HW'] }, { diagnosisId: 'DG-HW', stationId: 'ND-0007' },
    { diagnosisId: 'DG-HW', taskId: 'TASK-1' }, { diagnosisId: 'x'.repeat(121) }, { diagnosisId: 'DG-\u0000HW' },
  ])('无效明确目标 %j 保留诊断错误上下文，不调用服务', async query => {
    const s = await fixture(query), state = await s.mount();
    expect(state.target.value.present).toBe(true); expect(state.status.value).toBe('invalid');
    expect(s.gis.mapMode).toBe('diagnosis'); expect(state.error.value).not.toBe(''); expect(state.display.value).toBeNull();
    await state.actions.value.retry(); expect(s.report).not.toHaveBeenCalled();
  });
  it.each(['situation.view', 'diagnosis.view'] as const)('缺少 %s 不读，重新获权后重新读取当前目标', async permission => {
    const s = await fixture(), identity = s.auth.identity!;
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(value => value !== permission) });
    const state = await s.mount(); expect(state.status.value).toBe('forbidden'); expect(s.report).not.toHaveBeenCalled();
    s.auth.accept(identity); await settle(); expect(state.status.value).toBe('ready'); expect(s.report).toHaveBeenCalledExactlyOnceWith('DG-HW');
  });
  it('报告未就绪与错误身份均显示错误；显式重试不污染其他 Store', async () => {
    const s = await fixture(); s.report.mockRejectedValueOnce(new Error('完整报告未就绪'));
    // 编辑错误来自当前任务 Store，共享规划版本仍由读取缓存提供。
    s.preview.error = '资源原错误'; s.task.error = '规划原错误'; s.diagnosis.error = '诊断原错误';
    const state = await s.mount(); expect(state.status.value).toBe('error'); expect(state.error.value).toBe('完整报告未就绪');
    const other = await s.raw.getDiagnosisReport('DG-LINK'); s.report.mockResolvedValueOnce(other);
    await state.actions.value.retry(); expect(state.status.value).toBe('error'); expect(state.display.value).toBeNull();
    expect(state.error.value).not.toBe(''); await state.actions.value.retry(); expect(state.status.value).toBe('ready');
    expect([s.preview.error, s.task.error, s.diagnosis.error]).toEqual(['资源原错误', '规划原错误', '诊断原错误']);
  });
  it.each(['target', 'mode', 'session', 'session-id', 'identity', 'permission', 'unmount'] as const)(
    '%s 变化同步清旧数据，迟到成功／失败不能覆盖当前归属', async change => {
      const s = await fixture(), oldRecord = await s.raw.getDiagnosisReport('DG-HW');
      const state = await s.mount(), oldActions = state.actions.value;
      oldActions.select(firstNode(oldRecord), 'impact'); expect(state.selection.value).not.toBeNull();
      const late = deferred<DiagnosisRecord>(); s.report.mockReturnValueOnce(late.promise);
      const pending = state.actions.value.retry(); await settle();
      if (change === 'target') s.query.value = { diagnosisId: 'DG-LINK' };
      if (change === 'mode') s.gis.mapMode = 'analysis';
      if (change === 'session') s.auth.generation++;
      if (change === 'session-id') s.auth.identity!.sessionId += '-next';
      if (change === 'identity') s.auth.identity!.id += '-next';
      if (change === 'permission') s.auth.identity!.permissions = s.auth.identity!.permissions.filter(value => value !== 'diagnosis.view');
      if (change === 'unmount') { app!.unmount(); app = undefined; }
      expect(state.display.value).toBeNull(); expect(state.selection.value).toBeNull(); expect(state.focus.value).toBeNull();
      await settle(); const current = state.display.value, currentStatus = state.status.value;
      oldActions.select(firstNode(oldRecord)); oldActions.setLevel('SEVERE', false); await oldActions.retry();
      late.resolve(oldRecord); await pending; await settle();
      expect(state.display.value).toBe(current); expect(state.status.value).toBe(currentStatus); expect(state.selection.value).toBeNull();
      expect(state.levels.value).toEqual(GIS_DIAGNOSIS_LEVELS); expect(state.error.value).not.toBe('迟到失败');
      if (change === 'unmount') return;
      if (change === 'permission') authorizeStore();
      state.open(); await settle();
      const failure = deferred<DiagnosisRecord>(); s.report.mockReturnValueOnce(failure.promise);
      const pendingFailure = state.actions.value.retry(); await settle();
      s.query.value = { diagnosisId: 'DG-CONFIG' }; await settle(); const latest = state.display.value;
      failure.reject(new Error('迟到失败')); await pendingFailure; await settle();
      expect(state.status.value).toBe('ready'); expect(state.error.value).toBe(''); expect(state.display.value).toBe(latest);
    });
  it('同轮换目标再返回相同 ID 也拒绝旧响应，只读取最终目标', async () => {
    const s = await fixture(), late = deferred<DiagnosisRecord>(); s.report.mockReturnValueOnce(late.promise);
    const state = await s.mount(); s.query.value = { diagnosisId: 'DG-LINK' }; s.query.value = { diagnosisId: 'DG-HW' }; await settle();
    expect(s.report.mock.calls.map(args => args[0])).toEqual(['DG-HW', 'DG-HW']); expect(state.status.value).toBe('ready');
    const current = state.display.value; late.reject(new Error('已失效读取')); await settle();
    expect(state.display.value).toBe(current); expect(state.error.value).toBe('');
  });
  it('返回资源后不被窗口或迟到响应抢回，显式恢复才重读', async () => {
    const s = await fixture(), state = await s.mount(), late = deferred<DiagnosisRecord>();
    s.report.mockReturnValueOnce(late.promise); const pending = state.actions.value.retry(); await settle();
    state.leave(); expect(s.gis.mapMode).toBe('resource'); s.events.dispatchEvent(new Event('focus'));
    late.resolve(await s.raw.getDiagnosisReport('DG-HW')); await pending; await settle();
    expect(s.gis.mapMode).toBe('resource'); expect(state.display.value).toBeNull(); expect(s.report).toHaveBeenCalledTimes(2);
    state.open(); await settle(); expect(s.gis.mapMode).toBe('diagnosis'); expect(state.status.value).toBe('ready'); expect(s.report).toHaveBeenCalledTimes(3);
  });
  it('去掉明确参数回资源；卸载诊断后普通入口不继承空诊断模式', async () => {
    const s = await fixture(), first = await s.mount(); s.query.value = {}; await settle();
    expect(s.gis.mapMode).toBe('resource'); expect(first.display.value).toBeNull();
    s.query.value = { diagnosisId: 'DG-HW' }; await settle(); expect(first.status.value).toBe('ready');
    app!.unmount(); app = undefined; expect(s.gis.mapMode).toBe('resource');
    s.query.value = {}; const before = s.report.mock.calls.length, second = await s.mount();
    expect(second.status.value).toBe('idle'); expect(s.gis.mapMode).toBe('resource'); expect(s.report).toHaveBeenCalledTimes(before);
  });
  it('卸载时保留用户已切换的其他模式，迟到错误与旧回调不可复显', async () => {
    const s = await fixture(), state = await s.mount(), late = deferred<DiagnosisRecord>();
    const oldActions = state.actions.value; s.report.mockReturnValueOnce(late.promise); const pending = oldActions.retry(); await settle();
    s.gis.mapMode = 'monitoring'; app!.unmount(); app = undefined;
    late.reject(new Error('卸载后的错误')); await pending; await oldActions.retry();
    expect(s.gis.mapMode).toBe('monitoring'); expect(state.display.value).toBeNull(); expect(state.error.value).toBe(''); expect(state.open()).toBe(false);
  });
});

describe('GIS 同报告来源刷新与定位事件', () => {
  it('仅来源变化保留筛选、选择、数组与定位；刷新期间明确核实中', async () => {
    const s = await fixture(), state = await s.mount();
    state.actions.value.select(firstNode(state.display.value!.record), 'impact'); state.actions.value.setLevel('SEVERE', false);
    const oldDisplay = state.display.value, oldFocus = state.focus.value, oldSelection = state.selection.value, context = state.contextKey.value;
    const next = await s.raw.getDiagnosisReport('DG-HW'); next.source = { state: 'UNKNOWN', reasons: ['上游暂时无法核实'] };
    const late = deferred<DiagnosisRecord>(); s.report.mockReturnValueOnce(late.promise);
    const refreshing = state.actions.value.retry(); await settle();
    expect(state.refreshing.value).toBe(true); expect(state.status.value).toBe('ready'); expect(state.display.value).toBe(oldDisplay);
    late.resolve(next); await refreshing;
    expect(state.refreshing.value).toBe(false); expect(state.display.value).toBe(oldDisplay);
    expect(state.display.value!.record.source).toEqual(next.source); expect(state.selection.value).toBe(oldSelection);
    expect(state.focus.value).toBe(oldFocus); expect(state.contextKey.value).toBe(context); expect(state.levels.value).not.toContain('SEVERE');
  });
  it.each(['network', 'result'] as const)('同 ID 的 %s 内容变化作为新上下文，原回调与定位全部失效', async field => {
    const s = await fixture(), state = await s.mount(), oldActions = state.actions.value;
    oldActions.select(firstNode(state.display.value!.record)); oldActions.setLevel('SEVERE', false);
    const previous = state.contextKey.value, next = await s.raw.getDiagnosisReport('DG-HW');
    if (field === 'network') next.network.inputSnapshot.stations[0].coordinate[0] += 0.001;
    else next.result.nodes[0].reason += '补充影响原因';
    s.report.mockResolvedValueOnce(next); await state.actions.value.retry();
    expect(state.status.value).toBe('ready'); expect(state.contextKey.value).not.toBe(previous);
    expect(state.selection.value).toBeNull(); expect(state.focus.value).toBeNull(); expect(state.levels.value).toEqual(GIS_DIAGNOSIS_LEVELS);
    oldActions.select(firstNode(next)); expect(state.selection.value).toBeNull();
  });
  it.each(['failure', 'invalid'] as const)('来源重读 %s 清除可用画面，不保留旧成功冒充新成功', async failure => {
    const s = await fixture(), state = await s.mount(); state.actions.value.select(firstNode(state.display.value!.record));
    if (failure === 'failure') s.report.mockRejectedValueOnce(new Error('报告读取失败'));
    else { const next = await s.raw.getDiagnosisReport('DG-HW'); next.result.nodes[0].nodeId = '不在快照'; s.report.mockResolvedValueOnce(next); }
    await state.actions.value.retry();
    expect(state.status.value).toBe('error'); expect(state.display.value).toBeNull(); expect(state.selection.value).toBeNull(); expect(state.focus.value).toBeNull();
    expect(state.error.value).not.toBe(''); expect(state.refreshing.value).toBe(false);
  });
  it('等级筛选只读现有结果、清理隐藏影响行；null 历史影响保持可见', async () => {
    const s = await fixture(), record = await s.raw.getDiagnosisReport('DG-HW');
    record.result.nodes[0].level = 'SEVERE'; s.report.mockResolvedValueOnce(record);
    const state = await s.mount(), target = firstNode(record), actions = state.actions.value;
    actions.select(target, 'impact'); expect(state.selection.value).not.toBeNull();
    actions.setLevel('SEVERE', false); expect(state.impact.value.nodes).toEqual([]); expect(state.selection.value).toBeNull();
    actions.select(target, 'impact'); expect(state.selection.value).toBeNull();
    actions.select(target); expect(state.selection.value?.origin).toBe('object');
    actions.setLevel('MODERATE', false); actions.setLevel('MINOR', false);
    expect(state.impact.value.links.length).toBeGreaterThan(0); expect(state.impact.value.regions.length).toBeGreaterThan(0);
    expect(state.display.value?.record.result.summary).toBeNull(); expect(s.report).toHaveBeenCalledTimes(1);
  });
  it('同一对象再选可再次定位，设备与链路来自冻结网络，错误类型 ID 不给位置', async () => {
    const s = await fixture(), state = await s.mount(), record = state.display.value!.record, target = firstNode(record);
    state.actions.value.select(target); const first = state.focus.value!.serial;
    state.actions.value.select(target); expect(state.focus.value!.serial).toBeGreaterThan(first);
    const device = state.display.value!.devices[0], station = state.display.value!.stations.find(row => row.id === device.stationId)!;
    state.actions.value.select({ objectType: 'DEVICE', objectId: device.id }); expect(state.focus.value!.coordinates).toEqual([station.coordinate]);
    const link = state.display.value!.links[0]; state.actions.value.select({ objectType: 'LINK', objectId: link.id });
    expect(state.focus.value!.coordinates).toHaveLength(2); const current = state.focus.value;
    state.actions.value.select({ objectType: 'NODE', objectId: device.id }); expect(state.focus.value).toBe(current);
    state.actions.value.select(target, 'fault'); expect(state.focus.value).toBe(current); expect(s.report).toHaveBeenCalledTimes(1);
  });
  it('窗口及已知存储事件合并重读；未知键、隐藏页面和非诊断模式不读', async () => {
    const s = await fixture(), state = await s.mount();
    s.events.dispatchEvent(new Event('focus')); s.events.dispatchEvent(new Event('focus'));
    s.dispatchStorage(RESOURCE_STORAGE_KEY); s.dispatchStorage(PLANNING_STORAGE_KEY); s.dispatchStorage(DIAGNOSIS_STORAGE_KEY); await settle();
    expect(s.report).toHaveBeenCalledTimes(2);
    s.dispatchStorage('与诊断无关'); await settle(); expect(s.report).toHaveBeenCalledTimes(2);
    s.documentState.hidden = true; s.events.dispatchEvent(new Event('focus')); s.dispatchStorage(null); await settle(); expect(s.report).toHaveBeenCalledTimes(2);
    s.documentState.hidden = false; s.dispatchStorage(null); await settle(); expect(s.report).toHaveBeenCalledTimes(3);
    state.leave(); s.dispatchStorage(DIAGNOSIS_STORAGE_KEY); await settle(); expect(s.report).toHaveBeenCalledTimes(3);
  });
  it('同标签页资源／规划版本变化重新读取来源，不订阅编辑草稿字段', async () => {
    const s = await fixture(); const read=useResourceReadStore();read.workspace=await s.raw.loadResourceReadContext({context:'gis'});
    s.planning.workspace = (await s.raw.loadPlanningWorkspace()).workspace;
    const state = await s.mount(); expect(s.report).toHaveBeenCalledTimes(1);
    read.workspace!.revision = '资源新版本'; await settle(); expect(s.report).toHaveBeenCalledTimes(2);
    s.planning.workspace!.revision = '规划新版本'; await settle(); expect(s.report).toHaveBeenCalledTimes(3);
    s.task.error = '无关错误'; s.diagnosis.runId = '诊断页独立选择'; await settle(); expect(s.report).toHaveBeenCalledTimes(3);
    expect(state.status.value).toBe('ready');
  });
  it('卸载释放窗口监听，已排队的事件函数也不能发请求', async () => {
    const s = await fixture(), add = vi.spyOn(s.events, 'addEventListener'), remove = vi.spyOn(s.events, 'removeEventListener');
    const state = await s.mount(), actions = state.actions.value;
    const installed = add.mock.calls.filter(args => ['focus', 'storage'].includes(args[0])); expect(installed).toHaveLength(2);
    app!.unmount(); app = undefined;
    for (const [name, callback] of installed) {
      expect(remove).toHaveBeenCalledWith(name, callback);
      if (typeof callback === 'function') callback(new Event(name));
    }
    s.events.dispatchEvent(new Event('focus')); s.dispatchStorage(RESOURCE_STORAGE_KEY); await actions.retry(); await settle();
    expect(s.report).toHaveBeenCalledTimes(1); expect(state.display.value).toBeNull();
  });
});
