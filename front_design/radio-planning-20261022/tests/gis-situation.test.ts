import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createGisSituation, gisExampleFrame, gisExampleMetadata, type GisSituationServices } from '../src/composables/useGisSituation';
import type { PlanningPlanSummary } from '../src/types/planning-api';
import type { TerrainBasemap } from '../src/services/terrain-basemap';
import type { GisNetwork, GisPlanSurface } from '../src/types/gis-plan';
import type { FrozenCoverageCache } from '../src/types/frozen-coverage';

function row(id = 'P1', state: PlanningPlanSummary['state'] = 'SAVED', savedAt = '2026-11-03T08:00:00+08:00'): PlanningPlanSummary {
  return { id, taskId: 'T1', name: `方案 ${id}`, version: 'V2', state, current: false, sourceChanged: false, savedAt };
}
function network(id = 'P1'): GisNetwork {
  const source = gisExampleFrame().network;
  return { ...source, identity: { ...source.identity, task_id: 'T1', plan_id: id, snapshot_id: `SNAP-${id}`, state: 'SAVED' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture() {
  const maps: TerrainBasemap[] = [];
  const terrain = vi.fn(async () => {
    const map: TerrainBasemap = { url: `blob:verified-${maps.length}`, extent: gisExampleFrame().terrain.bounds, source: '受控 DEM', dispose: vi.fn() };
    maps.push(map); return map;
  });
  const services: GisSituationServices = {
    queryPlans: vi.fn(async input => ({ items: [], total: 0, pageNum: input.pageNum, pageSize: input.pageSize })),
    plans: {
      getNetwork: vi.fn(async query => network(query.planId)),
      getSurface: vi.fn(async (_query, source): Promise<GisPlanSurface> => ({ identity: source.identity,
        terrain: gisExampleFrame().terrain, terrain_notice: '', coverage: null, coverage_notice: '未保存覆盖' })),
    },
    terrain,
  };
  return { services, model: createGisSituation(services), maps, terrain };
}

describe('GIS只读首页受控示例与整帧刷新', () => {
  it('空库首次进入立即有受控示例，不查询用户方案、不计算、不写入', () => {
    const { model, services, terrain } = fixture();
    expect(model.frame.value.example).toBe(true);
    expect(model.frame.value.label).toBe('默认态势');
    expect(model.frame.value.network.nodes).toHaveLength(140);
    expect(model.frame.value.network.links).toHaveLength(162);
    expect(model.frame.value.network.identity.state).toBe('REFERENCE');
    expect(model.frame.value.network.routes.length).toBeGreaterThan(0); expect(model.frame.value.interferences).toHaveLength(16);
    for (const boundary of ['构造示例', '算法预测', '非现场实测', '频率冲突', '未达标项']) expect(model.frame.value.notice).toContain(boundary);
    expect(services.queryPlans).not.toHaveBeenCalled(); expect(services.plans.getNetwork).not.toHaveBeenCalled(); expect(terrain).not.toHaveBeenCalled();
    model.stop();
  });
  it('示例几何与来源绑定本地真实DEM，部署PNG字节摘要匹配元数据', () => {
    const frame = gisExampleFrame();
    const meta = JSON.parse(readFileSync('public/maps/sr4-terrain.json', 'utf8'));
    expect(frame.terrain.sourceSha256).toBe(meta.source_sha256); expect(frame.terrain.bounds).toEqual(meta.extent);
    expect(createHash('sha256').update(readFileSync('public/maps/sr4-terrain.png')).digest('hex')).toBe(meta.image_sha256);
    const [west, south, east, north] = gisExampleMetadata.planningBounds;
    expect(frame.network.nodes.every(n => n.coordinate[0] >= west && n.coordinate[0] <= east && n.coordinate[1] >= south && n.coordinate[1] <= north)).toBe(true);
    expect(frame.network.nodes.every(n => n.status === null && n.alert === null)).toBe(true);
    expect(gisExampleMetadata.provenance.derivation).toContain('不冒充物理电台绑定');
  });
  it('示例DEM核验失败保留节点链路并给出原因，随后重试能显示地形', async () => {
    const { model, terrain } = fixture(), before = model.frame.value;
    terrain.mockRejectedValueOnce(new Error('地形图片校验失败'));
    await model.initialize(); expect(model.frame.value).toBe(before); expect(model.error.value).toContain('地形图片校验失败');
    await model.initialize(); expect(model.frame.value.basemap).not.toBeNull(); expect(model.error.value).toBe(''); model.stop();
  });
  it('刷新仅选择最新CONFIRMED，较新的SAVED不替换，地形验证完成前保留原帧', async () => {
    const { model, services, terrain, maps } = fixture(); await model.initialize(); const before = model.frame.value;
    vi.mocked(services.queryPlans).mockImplementation(async input => ({ items: [row('P1', 'SAVED', '2026-11-03T10:00:00+08:00'), row('P2', 'CONFIRMED', '2026-11-03T09:00:00+08:00')], total: 2, pageNum: input.pageNum, pageSize: input.pageSize }));
    const pending = deferred<TerrainBasemap>(); terrain.mockReturnValueOnce(pending.promise);
    const done = model.refreshLatest(); await vi.waitFor(() => expect(terrain).toHaveBeenCalledTimes(2));
    expect(model.frame.value).toBe(before); expect(model.busy.value).toBe(true);
    expect(services.queryPlans).toHaveBeenCalledOnce();
    expect(services.queryPlans).toHaveBeenCalledWith(expect.objectContaining({ context: 'gis', state: 'CONFIRMED' }));
    const verified = { ...maps[0], url: 'blob:new', dispose: vi.fn() }; pending.resolve(verified); await done;
    expect(model.frame.value.network.identity.plan_id).toBe('P2'); expect(model.frame.value.basemap).toBe(verified);
    expect(before.basemap?.dispose).toHaveBeenCalledOnce(); expect(model.notice.value).toContain('P2'); model.stop();
  });
  it('按服务的转正顺序刷新，旧保存方案最新转正时仍优先显示', async () => {
    const { model, services } = fixture();
    vi.mocked(services.queryPlans).mockResolvedValue({ items: [row('JUST-CONFIRMED', 'CONFIRMED', '2026-11-01T08:00:00+08:00'), row('LATER-SAVED', 'CONFIRMED', '2026-11-03T08:00:00+08:00')], total: 2, pageNum: 1, pageSize: 20 });
    await model.refreshLatest(); expect(model.frame.value.network.identity.plan_id).toBe('JUST-CONFIRMED'); model.stop();
  });
  it.each(['none', 'list-error', 'network-error', 'surface-error', 'missing-terrain', 'terrain-error', 'coverage-error'])('%s保留最后成功帧，绝不混入新网络或清空地图', async failure => {
    const { model, services, terrain } = fixture(); await model.initialize(); const before = model.frame.value;
    vi.mocked(services.queryPlans).mockResolvedValue({ items: [row('P1', 'CONFIRMED')], total: 1, pageNum: 1, pageSize: 20 });
    if (failure === 'none') vi.mocked(services.queryPlans).mockResolvedValue({ items: [], total: 0, pageNum: 1, pageSize: 20 });
    if (failure === 'list-error') vi.mocked(services.queryPlans).mockRejectedValue(new Error('目录不可用'));
    if (failure === 'network-error') vi.mocked(services.plans.getNetwork).mockRejectedValue(new Error('冻结来源不可用'));
    if (failure === 'surface-error') vi.mocked(services.plans.getSurface).mockRejectedValue(new Error('来源版本不匹配'));
    if (failure === 'missing-terrain') vi.mocked(services.plans.getSurface).mockResolvedValue({ identity: network().identity, terrain: null, terrain_notice: 'DEM未提供', coverage: null, coverage_notice: '未提供' });
    if (failure === 'terrain-error') terrain.mockRejectedValueOnce(new Error('DEM摘要不匹配'));
    if (failure === 'coverage-error') services.getCoverage = vi.fn(async () => { throw new Error('覆盖读取失败'); });
    await model.refreshLatest(); expect(model.frame.value).toBe(before); expect(before.basemap?.dispose).not.toHaveBeenCalled();
    expect(model.busy.value).toBe(false); expect(model.error.value || model.notice.value).toContain('当前态势已保留'); model.stop();
  });
  it('显式选择未达标参考方案保留标识，空覆盖不画大圆也不触发计算', async () => {
    const { model, services } = fixture(); await model.openPlan(row('P1', 'REFERENCE'));
    expect(model.frame.value.network.identity.plan_id).toBe('P1'); expect(model.frame.value.notice).toContain('未达标参考');
    expect(model.coverage.value).toBeNull(); expect(model.notice.value).toContain('未绘制推测覆盖'); expect(Object.keys(services.plans).sort()).toEqual(['getNetwork', 'getSurface']); model.stop();
  });
  it('首页干扰源仅采用打开网络的冻结同帧资料，旧版缺失提示原样保留', async () => {
    const { model, services } = fixture(), frozen = gisExampleFrame().interferences.slice(0, 1);
    vi.mocked(services.plans.getNetwork).mockResolvedValueOnce({ ...network('OLD'), interferences: frozen, interferences_notice: '' });
    await model.openPlan(row('OLD')); expect(model.frame.value.interferences).toEqual(frozen);
    vi.mocked(services.plans.getNetwork).mockResolvedValueOnce({ ...network('NO-SOURCES'), interferences: [], interferences_notice: '该旧方案未保留同版干扰源' });
    await model.openPlan(row('NO-SOURCES')); expect(model.frame.value.interferences).toEqual([]);
    expect(model.frame.value.notice).toContain('该旧方案未保留同版干扰源'); model.stop();
  });
  it('内置V6覆盖通过严格绑定校验，移动到有缓存的节点显示对应设备，缺源节点不画覆盖', async () => {
    const { model } = fixture(); await model.initialize();
    const cache = model.frame.value.coverage!;
    expect(cache.anchor.snapshot_id).toBe('SNP-GIS-EXAMPLE-1'); expect(cache.result?.solution_id).toBe('GIS-EXAMPLE-1');
    expect(cache.result?.devices).toHaveLength(4); expect(cache.anchor.engine_version).toBe('V01-6');
    expect(cache.result?.devices.every(device => device.computations.every(computation => computation.shape === 'CELLS'))).toBe(true);
    expect(model.coverage.value).toBeNull();
    const device = cache.result!.devices[0].device_id; model.previewDevices(['NO-COVERAGE', device]);
    expect(model.coverage.value?.deviceId).toBe(device); expect(model.coverage.value?.bandwidthSelection).toEqual({ selectionId: cache.bandwidth_selection_id, selectionHash: cache.bandwidth_selection_hash });
    model.previewDevices(['NO-COVERAGE']); expect(model.coverage.value).toBeNull(); expect(model.selectedDeviceId.value).toBe(''); model.stop();
  });
  it('新选择取消前一请求，旧网络晚到不能替换新帧', async () => {
    const { model, services } = fixture(), pending = deferred<GisNetwork>();
    vi.mocked(services.plans.getNetwork).mockReturnValueOnce(pending.promise);
    const old = model.openPlan(row('P1'));
    const signal = vi.mocked(services.plans.getNetwork).mock.calls[0][1]!;
    await model.openPlan(row('P2')); expect(signal.aborted).toBe(true);
    pending.resolve(network('P1')); await old; expect(model.frame.value.network.identity.plan_id).toBe('P2'); model.stop();
  });
  it('覆盖读取期间切换保留新方案，晚到地形URL释放', async () => {
    const { services, terrain, maps } = fixture(), pending = deferred<FrozenCoverageCache>();
    services.getCoverage = vi.fn(() => pending.promise);
    const model = createGisSituation(services), old = model.openPlan(row('P1'));
    await vi.waitFor(() => expect(services.getCoverage).toHaveBeenCalledOnce());
    services.getCoverage = undefined; await model.openPlan(row('P2'));
    pending.resolve({ state: 'MISS', result: null } as FrozenCoverageCache); await old;
    expect(model.frame.value.network.identity.plan_id).toBe('P2'); expect(terrain).toHaveBeenCalledTimes(2); expect(maps[0].dispose).toHaveBeenCalledOnce(); model.stop();
  });
  it('卸载取消目录和帧请求，晚到数据不能恢复并释放图片', async () => {
    const { model, services, maps } = fixture(); await model.initialize();
    const pending = deferred<GisNetwork>(); vi.mocked(services.plans.getNetwork).mockReturnValueOnce(pending.promise);
    const done = model.openPlan(row()); model.stop(); pending.resolve(network()); await done;
    expect(model.frame.value.example).toBe(true); expect(model.busy.value).toBe(false); expect(maps[0].dispose).toHaveBeenCalledOnce();
  });
});
