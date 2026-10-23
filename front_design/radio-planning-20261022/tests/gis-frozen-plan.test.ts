import { describe, expect, it, vi } from 'vitest';
import { createGisFrozenPlanWorkspace, type GisFrozenPlanServices } from '../src/stores/gis-frozen-plan';
import type { GisLinkDetail, GisNetwork, GisPlanSurface } from '../src/types/gis-plan';

function network(id = 'P1'): GisNetwork {
  return { identity: { plan_id: id, task_id: 'T1', snapshot_id: `S-${id}`, input_version: 'I1', condition_version: 'C1', resource_revision: 'R1', state: 'SAVED', source_changed: true, data_origin: 'SYNTHETIC_INTEGRATION', source: 'SR4' },
    nodes: ['A', 'B'].map((id, i) => ({ id, name: id, coordinate: [114 + i / 10, 37], status: null, alert: null })),
    devices: [], links: [{ id: 'L1', a: 'A', b: 'B', device_a: 'EA', device_b: 'EB', device_class: 'HF', frequency_khz: null, backup: false, planned_state: null }],
    demands: [{ id: 'D1', source_id: 'A', target_id: 'B', source_device_id: null, target_device_id: null, service: null, mandatory: null, required_rate_kbps: null, min_reliability: null }], routes: [], paths_state: 'missing', paths_message: '未提供路径' };
}
function fixture() {
  const services: GisFrozenPlanServices = { queryPlans: vi.fn(async input => ({ items: [], total: 0, pageNum: input.pageNum, pageSize: input.pageSize })),
    plans: { getNetwork: vi.fn(async query => network(query.planId)),
      getSurface: vi.fn(async (_query, source) => ({ identity: source.identity, terrain: null, terrain_notice: '地形未知', coverage: null, coverage_notice: '覆盖未提供' })),
      getLink: vi.fn(async (_query, source): Promise<GisLinkDetail> => ({ identity: source.identity, link: source.links[0], endpoint_devices: [
        { id: 'EA', station_id: 'A', model_id: 'M', device_class: 'HF', frequency_khz: null, tx_power_dbm: null, antenna_height_m: null },
        { id: 'EB', station_id: 'B', model_id: 'M', device_class: 'HF', frequency_khz: null, tx_power_dbm: null, antenna_height_m: null },
      ], demand_ids: [], route_ids: [], observation: { state: 'missing', message: '未提供观测', samples: [] } })),
      getPaths: vi.fn(async (_query, source) => ({ identity: source.identity, demands: source.demands, routes: [], paths_state: 'missing' as const, paths_message: '未提供路径' })) } };
  return { services, model: createGisFrozenPlanWorkspace(services) };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
describe('冻结GIS页面工作区', () => {
  it('深链先读取真实方案版本，再打开同一任务方案', async () => {
    const { services } = fixture(); services.getPlan = vi.fn(async input => ({ id: input.planId, taskId: input.taskId, version: 'V7' }));
    const model = createGisFrozenPlanWorkspace(services);
    expect(await model.openIdentity({ taskId: 'T1', planId: 'P1' })).toBe(true);
    expect(services.getPlan).toHaveBeenCalledWith(expect.objectContaining({ context: 'gis', taskId: 'T1', planId: 'P1', signal: expect.any(AbortSignal) }));
    expect(model.planVersion.value).toBe('V7'); expect(model.network.value?.identity.plan_id).toBe('P1');
  });
  it('深链身份或版本错误不打开另一个网络，不伪造版本', async () => {
    const { services } = fixture(); services.getPlan = vi.fn(async () => ({ id: 'OTHER', taskId: 'T1', version: 'V1' }));
    const model = createGisFrozenPlanWorkspace(services);
    expect(await model.openIdentity({ taskId: 'T1', planId: 'P1' })).toBe(false);
    expect(services.plans.getNetwork).not.toHaveBeenCalled(); expect(model.error.value).toContain('不符'); expect(model.planVersion.value).toBe('');
  });
  it('关闭或切换后隔离深链元信息的晚响应', async () => {
    const { services } = fixture(), pending = deferred<{ id: string; taskId: string; version: string }>();
    services.getPlan = vi.fn(() => pending.promise); const model = createGisFrozenPlanWorkspace(services);
    const done = model.openIdentity({ taskId: 'T1', planId: 'P1' }); await model.openPlan({ id: 'P2', taskId: 'T1', version: 'V2' });
    pending.resolve({ id: 'P1', taskId: 'T1', version: 'V1' }); expect(await done).toBe(false);
    expect(model.network.value?.identity.plan_id).toBe('P2'); expect(model.planVersion.value).toBe('V2');
  });
  it('深链缺服务或服务失败有明确反馈，不补默认方案', async () => {
    const { services, model } = fixture(); expect(await model.openIdentity({ taskId: 'T1', planId: 'P1' })).toBe(false);
    expect(model.error.value).toContain('尚未接入'); services.getPlan = vi.fn(async () => { throw new Error('方案已归档或无权限'); });
    expect(await model.openIdentity({ taskId: 'T1', planId: 'P1' })).toBe(false); expect(model.error.value).toBe('方案已归档或无权限');
    expect(model.network.value).toBeNull(); expect(model.opening.value).toBe(false);
  });
  it('目录只在显式调用时读取，不自动选择网络', async () => {
    const { model, services } = fixture(); expect(services.queryPlans).not.toHaveBeenCalled();
    await model.queryPlans({ pageNum: 2, pageSize: 10, search: '历史' });
    expect(services.queryPlans).toHaveBeenCalledWith(expect.objectContaining({ context: 'gis', pageNum: 2, search: '历史', signal: expect.any(AbortSignal) }));
    expect(model.catalog.value?.total).toBe(0); expect(services.plans.getNetwork).not.toHaveBeenCalled();
  });
  it('指定任务方案打开，地形带同一快照和网络，未知值不改变', async () => {
    const { model, services } = fixture(); await model.openPlan({ id: 'P1', taskId: 'T1' });
    expect(services.plans.getNetwork).toHaveBeenCalledWith({ planId: 'P1', taskId: 'T1' }, expect.any(AbortSignal));
    expect(services.plans.getSurface).toHaveBeenCalledWith({ planId: 'P1', taskId: 'T1', snapshotId: 'S-P1' }, network(), expect.any(AbortSignal));
    expect(model.network.value?.nodes[0].status).toBeNull(); expect(model.surface.value?.terrain).toBeNull();
  });
  it('调用方改写选中行不会改变在途请求', async () => {
    const { model, services } = fixture(), pending = deferred<GisNetwork>(); vi.mocked(services.plans.getNetwork).mockReturnValueOnce(pending.promise);
    const row = { id: 'P1', taskId: 'T1' }, done = model.openPlan(row); row.id = 'OTHER'; row.taskId = 'OTHER'; pending.resolve(network()); await done;
    expect(model.network.value?.identity.plan_id).toBe('P1');
    expect(services.plans.getSurface).toHaveBeenCalledWith(expect.objectContaining({ planId: 'P1', taskId: 'T1' }), expect.anything(), expect.anything());
  });
  it('方案切换清空旧网络且隔离迟到响应', async () => {
    const { model, services } = fixture(), pending = deferred<GisNetwork>(); vi.mocked(services.plans.getNetwork).mockReturnValueOnce(pending.promise);
    const old = model.openPlan({ id: 'P1', taskId: 'T1' }); await model.openPlan({ id: 'P2', taskId: 'T1' }); pending.resolve(network()); await old;
    expect(model.network.value?.identity.plan_id).toBe('P2');
  });
  it('读取失败清空旧网络并显示原因，不回退当前资源', async () => {
    const { model, services } = fixture(); await model.openPlan({ id: 'P1', taskId: 'T1' });
    vi.mocked(services.plans.getNetwork).mockRejectedValueOnce(new Error('无权读取'));
    await model.openPlan({ id: 'P2', taskId: 'T1' }); expect(model.error.value).toBe('无权读取'); expect(model.network.value).toBeNull();
  });
  it('地形失败保留冻结点线，不拿当前DEM替代', async () => {
    const { model, services } = fixture(); vi.mocked(services.plans.getSurface).mockRejectedValueOnce(new Error('DEM不匹配'));
    await model.openPlan({ id: 'P1', taskId: 'T1' }); expect(model.network.value).not.toBeNull(); expect(model.surface.value).toBeNull(); expect(model.surfaceError.value).toBe('DEM不匹配');
  });
  it('链路和需求每一步调用同快照详情，保留无实测/无路径', async () => {
    const { model, services } = fixture(); await model.openPlan({ id: 'P1', taskId: 'T1' }); await model.selectLink('L1');
    expect(services.plans.getLink).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: 'S-P1', linkId: 'L1' }), network(), expect.any(AbortSignal));
    expect(model.detail.value?.observation.samples).toEqual([]); await model.selectDemand('D1');
    expect(model.detail.value).toBeNull(); expect(model.paths.value?.paths_state).toBe('missing');
  });
  it('无效对象不发请求，节点只选本快照', async () => {
    const { model, services } = fixture(); await model.openPlan({ id: 'P1', taskId: 'T1' }); await model.selectLink('NO'); model.selectNode('NO');
    expect(services.plans.getLink).not.toHaveBeenCalled(); expect(model.selectedNodeId.value).toBe(''); model.selectNode('A'); expect(model.selectedNodeId.value).toBe('A');
  });
  it('选择其他对象隔离旧详情', async () => {
    const { model, services } = fixture(); await model.openPlan({ id: 'P1', taskId: 'T1' }); const pending = deferred<Awaited<ReturnType<typeof services.plans.getLink>>>();
    vi.mocked(services.plans.getLink).mockReturnValueOnce(pending.promise); const old = model.selectLink('L1'); model.selectNode('A');
    pending.reject(new Error('旧详情错误')); await old; expect(model.detailError.value).toBe(''); expect(model.selectedNodeId.value).toBe('A');
  });
  it('卸载/会话变化清空目录与网络并停止在途读取', async () => {
    const { model, services } = fixture(), pending = deferred<GisNetwork>(); vi.mocked(services.plans.getNetwork).mockReturnValueOnce(pending.promise);
    const done = model.openPlan({ id: 'P1', taskId: 'T1' }); const signal = vi.mocked(services.plans.getNetwork).mock.calls[0][1]!; model.stop();
    expect(signal.aborted).toBe(true); pending.resolve(network()); await done; expect(model.network.value).toBeNull(); expect(model.catalog.value).toBeNull(); expect(model.opening.value).toBe(false);
  });
  it('网络关闭后迟到地形不能重新显示', async () => {
    const { model, services } = fixture(), pending = deferred<GisPlanSurface>(); vi.mocked(services.plans.getSurface).mockReturnValueOnce(pending.promise);
    const done = model.openPlan({ id: 'P1', taskId: 'T1' }); await Promise.resolve(); model.closeNetwork(); pending.resolve({ identity: network().identity, terrain: null, terrain_notice: 'unknown', coverage: null, coverage_notice: '覆盖未提供' }); await done;
    expect(model.surface.value).toBeNull(); expect(model.network.value).toBeNull();
  });
  it('目录失败保留上次结果并标记错误，旧列表迟到不覆盖新列表', async () => {
    const { model, services } = fixture(); await model.queryPlans({ pageNum: 1, pageSize: 10 });
    vi.mocked(services.queryPlans).mockRejectedValueOnce(new Error('目录失败')); await model.queryPlans({ pageNum: 2, pageSize: 10 });
    expect(model.catalog.value?.pageNum).toBe(1); expect(model.listError.value).toBe('目录失败');
    const pending = deferred<Awaited<ReturnType<typeof services.queryPlans>>>(); vi.mocked(services.queryPlans).mockReturnValueOnce(pending.promise);
    const old = model.queryPlans({ pageNum: 3, pageSize: 10 }); await model.queryPlans({ pageNum: 4, pageSize: 10 }); pending.resolve({ items: [], total: 0, pageNum: 3, pageSize: 10 }); await old;
    expect(model.catalog.value?.pageNum).toBe(4);
  });
});
