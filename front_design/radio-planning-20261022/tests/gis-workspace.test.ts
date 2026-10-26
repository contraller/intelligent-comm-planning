import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { initialResources } from '../src/mocks/resource-presets';
import { validateGisScene, matchesGisClassification, projectGisTree } from '../src/services/gis-workspace';
import type { GisClassification, GisResourceEditContext, GisResourceScene } from '../src/types/gis-workspace';
import type { ResourcesData } from '../src/types/domain';
import type { ResourceReadWorkspace } from '../src/types/resource-read';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useAuthStore } from '../src/stores/auth';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';

// 仅替换传输层；并发、版本与保存流程仍运行真实 Pinia Store。
vi.mock('../src/services', () => ({
  previewService: {
    loadGisResourceScene: vi.fn(), loadGisResourceEditContext: vi.fn(),
    loadResourceReadContext: vi.fn(), queryResourceMap: vi.fn(), saveResourceChanges: vi.fn(),
  },
  releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn(),
}));

const noClass: GisClassification = { mobility: '', role: '', relay: '' };
describe('GIS 分类与能力边界', () => {
  it('设备按型号频段归类，部署、角色与中继能力独立筛选', () => {
    const resources = initialResources();
    const hf = projectGisTree(resources, [], '', 'HF', false, 'devices', noClass);
    expect(hf.devices).toHaveLength(174);
    expect(hf.candidateRows.every(row => row.link.deviceClass === 'HF')).toBe(true);
    expect(new Set(hf.deviceIds).size).toBe(hf.devices.length);
    expect(hf.devices.every(d => resources.models.find(m => m.id === d.modelId)?.deviceClass === 'HF')).toBe(true);
    const counts = ['FIXED', 'VEHICLE', 'MANPACK'].map(mobility => projectGisTree(resources, [], '', 'HF', false, 'devices', { ...noClass, mobility: mobility as GisClassification['mobility'] }).devices.length);
    expect(counts).toEqual([32, 118, 24]);
    const relay = { ...resources.stations[0]!, mobility: 'VEHICLE' as const, role: 'TASK' as const, relayCapable: true };
    expect(matchesGisClassification(relay, { ...noClass, relay: 'YES' })).toBe(true);
    expect(matchesGisClassification(relay, { ...noClass, role: 'RELAY' })).toBe(false);
    expect(projectGisTree(resources, [], '', '全部', false, 'stations', noClass).stations).toHaveLength(132);
  });
  it('分页响应不能冒充完整 GIS 上下文', () => {
    // 两种来源都必须提供同一完整上下文及匹配版本。
    expect(() => validateGisScene({ revision: 'R1', items: [] } as never, 'R1')).toThrow('不完整');
    expect(() => validateGisScene({ revision: 'R2' } as never, 'R1')).toThrow('版本');
  });
});

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); vi.resetAllMocks(); });
afterEach(() => { disposePinia(pinia); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const resources = (): ResourcesData => ({ stations: [], devices: [], models: [], antennas: [], interferences: [], candidateLinks: [], source: 'unit-test', version: '1' });
const meta = (revision: string) => ({ revision, resourceEpoch: 'test', stationVersions: {}, deviceVersions: {}, savedAt: null, changedStationIds: [], changedDeviceIds: [] });
const situation = (revision: string) => ({ title: 'unit-test', snapshotId: revision, updatedAt: '', links: [], candidateLinks: [], regions: [], alerts: [], spectrum: [] });
function scene(revision = 'R1'): GisResourceScene {
  return { revision, resourceMeta: meta(revision), situation: situation(revision),
    map: { stations: [], devices: [], missingCount: 0 },
    network: { state: 'missing', title: '', message: '', snapshotId: revision, source: '', links: [], services: [], routes: [] },
    linkDetails: { state: 'missing', message: '', snapshotId: revision, source: '', records: [] } };
}
function baseline(revision = 'R1'): GisResourceEditContext {
  return { revision, resourceMeta: meta(revision), situation: situation(revision), baseRevision: revision,
    resources: resources(), validationSource: resources() };
}
function workspace(revision = 'R1'): ResourceReadWorkspace {
  return { revision, bounds: [113, 37, 115, 39], updatedAt: '', source: 'unit-test',
    stats: { nodes: 0, devices: 0, models: 0, interferences: 0, hf: 0, vuhf: 0,
      alerts: null, unknownAlerts: null, active: null, offShelf: null, unknownAvailability: null } };
}
function fixture(editing = false) {
  const auth = useAuthStore();
  auth.accept({ id: 'actor-1', sessionId: 'session-1', username: 'test', name: 'test', roleId: 'test', roleName: 'test',
    epoch: 'test', revision: '1', permissions: ['situation.view', 'planning.view', 'resources.edit', 'resources.workspace.edit'] });
  const read = useResourceReadStore(); read.context = 'gis'; read.workspace = workspace();
  const editor = useResourceEditStore(), gis = useGisWorkspaceStore();
  vi.mocked(previewService.loadGisResourceScene).mockImplementation(async input => scene(input.revision));
  vi.mocked(previewService.loadGisResourceEditContext).mockImplementation(async input => baseline(input.revision));
  if (editing) { editor.acceptGisContext(baseline()); editor.begin(); editor.acceptReceipt('R1', resources()); }
  return { gis, read, editor, auth };
}

describe('GIS scene 同源在途合并', () => {
  it('并发调用只发一次 scene，全部调用等到完整基线接纳后才结束', async () => {
    const { gis, editor } = fixture(true), pending = deferred<GisResourceScene>(), edit = deferred<GisResourceEditContext>();
    const load = vi.mocked(previewService.loadGisResourceScene).mockReturnValueOnce(pending.promise);
    const context = vi.mocked(previewService.loadGisResourceEditContext).mockReturnValueOnce(edit.promise);
    const one = gis.loadScene(), two = gis.loadScene();
    let completed = false; void two.then(() => { completed = true; });
    expect(load).toHaveBeenCalledTimes(1); expect(load.mock.calls[0]![0].signal?.aborted).toBe(false);
    pending.resolve(scene()); await vi.waitFor(() => expect(context).toHaveBeenCalledTimes(1));
    const three = gis.loadScene(); expect(load).toHaveBeenCalledTimes(1); expect(context).toHaveBeenCalledTimes(1);
    await nextTick(); expect(completed).toBe(false); expect(editor.baselinePending).toBe(true); expect(gis.sceneLoading).toBe(true);
    edit.resolve(baseline()); await Promise.all([one, two, three]);
    expect(completed).toBe(true); expect(editor.baselinePending).toBe(false); expect(gis.sceneLoading).toBe(false);
  });

  it('真实保存失败重试后，版本 watcher 与显式等待仅发一次 scene 和基线', async () => {
    const { gis, read, editor } = fixture(true);
    editor.acceptGisContext(baseline());
    gis.active = true;
    const write = vi.mocked(previewService.saveResourceChanges).mockRejectedValueOnce(new Error('save offline'))
      .mockResolvedValueOnce({ objectId: 'resources', revision: 'R2', readRevision: 'R2', changed: true, warnings: [], affectedIds: [] });
    expect(await gis.save()).toBe(false); expect(gis.saveState).toBe('failed'); expect(editor.error).toBe('save offline');
    expect(read.workspace?.revision).toBe('R1'); expect(previewService.loadGisResourceScene).not.toHaveBeenCalled();
    vi.mocked(previewService.loadResourceReadContext).mockResolvedValue(workspace('R2'));
    vi.mocked(previewService.queryResourceMap).mockResolvedValue({ revision: 'R2', bbox: workspace().bounds, zoom: 9, points: [], clusters: [], totalNodes: 0, totalInterferences: 0 });
    const edit = deferred<GisResourceEditContext>();
    const context = vi.mocked(previewService.loadGisResourceEditContext).mockReturnValueOnce(edit.promise);
    let completed = false; const save = gis.save().then(value => { completed = true; return value; });
    await vi.waitFor(() => { expect(editor.error).toBe(''); expect(context).toHaveBeenCalledTimes(1); });
    expect(vi.mocked(previewService.loadGisResourceScene)).toHaveBeenCalledTimes(1);
    expect(read.workspace?.revision).toBe('R2'); expect(editor.baselinePending).toBe(true); expect(completed).toBe(false);
    edit.resolve(baseline('R2')); expect(await save).toBe(true);
    expect(gis.saveState).toBe('succeeded'); expect(editor.baseRevision).toBe('R2'); expect(editor.baselinePending).toBe(false);
    expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[1]![0].requestId).toBe(write.mock.calls[0]![0].requestId);
    expect(write.mock.calls.every(([input]) => !Object.hasOwn(input, 'restoreFrom'))).toBe(true);
    expect(context).toHaveBeenCalledTimes(1); expect(vi.mocked(previewService.loadGisResourceScene)).toHaveBeenCalledTimes(1);
  });

  it('已结束的成功不作为缓存，显式读取和同版本刷新都重新请求', async () => {
    const { gis, read } = fixture();
    const load = vi.mocked(previewService.loadGisResourceScene);
    await gis.loadScene(); await gis.loadScene(); expect(load).toHaveBeenCalledTimes(2);
    read.refreshKey++; await gis.loadScene(); expect(load).toHaveBeenCalledTimes(3);
  });

  it('scene 失败保留错误与待更新基线，重试重新读取而非复用失败', async () => {
    const { gis, editor } = fixture(true);
    const load = vi.mocked(previewService.loadGisResourceScene).mockRejectedValueOnce(new Error('scene offline'));
    await Promise.all([gis.loadScene(), gis.loadScene()]);
    expect(load).toHaveBeenCalledTimes(1); expect(gis.sceneError).toBe('scene offline'); expect(editor.baselinePending).toBe(true);
    expect(previewService.loadGisResourceEditContext).not.toHaveBeenCalled();
    await gis.loadScene(); expect(load).toHaveBeenCalledTimes(2); expect(gis.sceneError).toBe(''); expect(editor.baselinePending).toBe(false);
  });

  it('完整基线失败不变成就绪，下次重试仍执行完整异步读取', async () => {
    const { gis, editor } = fixture(true);
    const context = vi.mocked(previewService.loadGisResourceEditContext).mockRejectedValueOnce(new Error('baseline offline'));
    await gis.loadScene(); expect(editor.baselinePending).toBe(true); expect(gis.sceneError).toBe('baseline offline');
    await gis.loadScene(); expect(context).toHaveBeenCalledTimes(2); expect(editor.baselinePending).toBe(false); expect(gis.sceneError).toBe('');
  });

  it.each(['identity', 'revision', 'context', 'refresh'] as const)('%s 来源变化取消旧读取，不把迟到结果写回', async source => {
    const { gis, read, auth } = fixture(), pending = deferred<GisResourceScene>();
    const load = vi.mocked(previewService.loadGisResourceScene).mockReturnValueOnce(pending.promise);
    const old = gis.loadScene(), signal = load.mock.calls[0]![0].signal;
    if (source === 'identity') auth.identity = { ...auth.identity!, id: 'actor-2' };
    if (source === 'revision') read.workspace = workspace('R2');
    if (source === 'context') read.context = 'planning';
    if (source === 'refresh') read.refreshKey++;
    expect(signal?.aborted).toBe(true);
    const latest = scene(source === 'revision' ? 'R2' : 'R1');
    load.mockResolvedValueOnce(latest); await gis.loadScene();
    pending.resolve({ ...scene(), situation: { ...situation('R1'), title: 'obsolete' } }); await old;
    expect(load).toHaveBeenCalledTimes(2); expect(gis.scene?.situation.title).toBe('unit-test'); expect(gis.sceneLoading).toBe(false); expect(gis.sceneError).toBe('');
  });

  it('来源 A→B→A 也不能复用已经取消的 A 请求', async () => {
    const { gis, auth } = fixture(), pending = deferred<GisResourceScene>();
    const load = vi.mocked(previewService.loadGisResourceScene).mockReturnValueOnce(pending.promise), old = gis.loadScene();
    const original = auth.identity!;
    auth.identity = { ...original, id: 'actor-2' }; auth.identity = original;
    await gis.loadScene(); expect(load).toHaveBeenCalledTimes(2);
    pending.resolve({ ...scene(), situation: { ...situation('R1'), title: 'obsolete' } }); await old;
    expect(gis.scene?.situation.title).toBe('unit-test');
  });

  it('失权立即取消共享读取，不继续请求或接纳迟到结果', async () => {
    const { gis, auth } = fixture(), pending = deferred<GisResourceScene>();
    const load = vi.mocked(previewService.loadGisResourceScene).mockReturnValueOnce(pending.promise), old = gis.loadScene();
    auth.accept({ ...auth.identity!, permissions: [] });
    expect(load.mock.calls[0]![0].signal?.aborted).toBe(true); expect(gis.sceneLoading).toBe(false);
    await gis.loadScene(); pending.resolve(scene()); await old;
    expect(load).toHaveBeenCalledTimes(1); expect(gis.scene).toBeNull(); expect(gis.sceneError).toBe('');
  });

  it.each([
    ['scene', 'viewport'], ['scene', 'filter'], ['scene', 'nodes'], ['scene', 'interferences'],
    ['baseline', 'viewport'], ['baseline', 'filter'], ['baseline', 'nodes'], ['baseline', 'interferences'],
  ] as const)('%s 在途变更展示态 %s 不取消全场景读取或悬空基线', async (phase, display) => {
    const { gis, read, editor } = fixture(true), pending = deferred<GisResourceScene>(), edit = deferred<GisResourceEditContext>();
    const load = vi.mocked(previewService.loadGisResourceScene).mockReturnValueOnce(pending.promise);
    const context = vi.mocked(previewService.loadGisResourceEditContext).mockReturnValueOnce(edit.promise);
    const accept = vi.spyOn(editor, 'acceptUnified'), one = gis.loadScene();
    if (phase === 'baseline') { pending.resolve(scene()); await vi.waitFor(() => expect(context).toHaveBeenCalledTimes(1)); }
    if (display === 'viewport') read.setViewport([113.5, 37.5, 114, 38], 12);
    if (display === 'filter') read.setMapFilter({ search: 'changed' });
    if (display === 'nodes') read.showNodes = false;
    if (display === 'interferences') read.showInterferences = false;
    const signal = load.mock.calls[0]![0].signal;
    expect(signal?.aborted).toBe(false); expect(gis.sceneLoading).toBe(true); expect(editor.baselinePending).toBe(true);
    const two = gis.loadScene(); expect(load).toHaveBeenCalledTimes(1);
    if (phase === 'scene') { pending.resolve(scene()); await vi.waitFor(() => expect(context).toHaveBeenCalledTimes(1)); }
    expect(context.mock.calls[0]![0].signal).toBe(signal); expect(context).toHaveBeenCalledTimes(1);
    edit.resolve(baseline()); await Promise.all([one, two]);
    expect(accept).toHaveBeenCalledTimes(1); expect(editor.baselinePending).toBe(false); expect(gis.sceneLoading).toBe(false);
    expect(load).toHaveBeenCalledTimes(1); expect(context).toHaveBeenCalledTimes(1); expect(gis.sceneError).toBe('');
  });

  it('已有脏输入时仅更新 scene，不读取或重置完整编辑基线', async () => {
    const { gis, editor } = fixture(true);
    editor.importFile = { name: 'pending.csv', bytes: new Uint8Array([1]) };
    await gis.loadScene(); expect(gis.scene?.revision).toBe('R1');
    expect(previewService.loadGisResourceEditContext).not.toHaveBeenCalled();
    expect(editor.baselinePending).toBe(true); expect(editor.importFile?.name).toBe('pending.csv');
  });

  it.each(['dirty', 'revision', 'context'] as const)('基线等待期间 %s 变化不覆盖新草稿或批准就绪', async change => {
    const { gis, editor } = fixture(true), edit = deferred<GisResourceEditContext>();
    vi.mocked(previewService.loadGisResourceEditContext).mockReturnValueOnce(edit.promise);
    const accept = vi.spyOn(editor, 'acceptUnified'), load = gis.loadScene();
    await vi.waitFor(() => expect(previewService.loadGisResourceEditContext).toHaveBeenCalledTimes(1));
    if (change === 'dirty') editor.importFile = { name: 'pending.csv', bytes: new Uint8Array([1]) };
    if (change === 'revision') editor.baseRevision = 'R2';
    if (change === 'context') editor.context = null;
    edit.resolve(baseline()); await load;
    expect(accept).not.toHaveBeenCalled(); expect(editor.baselinePending).toBe(true);
    if (change === 'dirty') expect(editor.importFile?.name).toBe('pending.csv');
  });

  it('离页取消共享请求，迟到失败不污染下一次显式读取', async () => {
    const { gis } = fixture(), pending = deferred<GisResourceScene>();
    const load = vi.mocked(previewService.loadGisResourceScene).mockReturnValueOnce(pending.promise), old = gis.loadScene();
    gis.stop(); expect(load.mock.calls[0]![0].signal?.aborted).toBe(true); expect(gis.sceneLoading).toBe(false);
    await gis.loadScene(); pending.resolve({ ...scene(), revision: 'wrong' }); await old;
    expect(gis.scene?.revision).toBe('R1'); expect(gis.sceneError).toBe('');
  });

  it('版本冲突保持冻结，不能把错误作为可复用成功结果', async () => {
    const { gis, read, editor } = fixture(true);
    vi.mocked(previewService.loadGisResourceScene).mockRejectedValueOnce(new ApiError('version changed', 'RESOURCE_VERSION_CHANGED'));
    await gis.loadScene(); expect(read.stale).toBe(true); expect(editor.baselinePending).toBe(true);
    await gis.loadScene(); expect(previewService.loadGisResourceScene).toHaveBeenCalledTimes(1);
  });
});
