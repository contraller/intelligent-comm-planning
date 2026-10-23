import { describe, expect, it, vi } from 'vitest';
import { createGisPlanHttp } from '../src/services/gis-plan-http';
import { readGisLinkDetail, readGisNetwork, readGisPaths, readGisPlanSurface } from '../src/services/gis-plan-validation';
import { createAuthHttp, type AuthenticatedRequest } from '../src/services/auth-http';
import { ApiError } from '../src/services/types';
import type { GisLinkDetail, GisNetwork, GisPaths } from '../src/types/gis-plan';

// 独立构造的冻结契约样本，不是算法实跑或真实观测。
const query = { planId: 'P1', taskId: 'T1', snapshotId: 'S1' };
function network(): GisNetwork {
  return {
    identity: { plan_id: 'P1', task_id: 'T1', snapshot_id: 'S1', input_version: 'I1', condition_version: 'C1',
      resource_revision: 'V1', state: 'SAVED', source_changed: true, data_origin: 'SYNTHETIC_INTEGRATION', source: 'SR4' },
    nodes: ['A', 'B', 'C'].map((id, index) => ({ id, name: '冻结节点' + id, coordinate: [113 + index, 37], status: null, alert: null })),
    devices: ['A', 'B', 'C'].map(id => ({ id: 'E' + id, station_id: id, model_id: 'M1', device_class: 'HF',
      frequency_khz: null, tx_power_dbm: null, antenna_height_m: null })),
    links: [['L1', 'A', 'B'], ['L2', 'B', 'C'], ['L3', 'A', 'C']].map(([id, a, b]) => ({
      id, a, b, device_a: 'E' + a, device_b: 'E' + b, device_class: 'HF', frequency_khz: null, backup: id !== 'L3', planned_state: null,
    })),
    demands: [{ id: 'D1', source_id: 'A', target_id: 'C', source_device_id: null, target_device_id: null,
      service: '数据', mandatory: true, required_rate_kbps: 64, min_reliability: 0.9 }],
    routes: [{ id: 'R1', demand_id: 'D1', node_ids: ['A', 'C'], link_ids: ['L3'], backup: false },
      { id: 'R2', demand_id: 'D1', node_ids: ['A', 'B', 'C'], link_ids: ['L1', 'L2'], backup: true }],
    paths_state: 'ready', paths_message: '',
  };
}
function detail(source = network()): GisLinkDetail {
  return { identity: structuredClone(source.identity), link: structuredClone(source.links[0]),
    endpoint_devices: [structuredClone(source.devices[0]), structuredClone(source.devices[1])], demand_ids: ['D1'], route_ids: ['R2'],
    observation: { state: 'missing', message: '未提供实测观测', samples: [] } };
}
function paths(source = network()): GisPaths {
  return { identity: structuredClone(source.identity), demands: structuredClone(source.demands), routes: structuredClone(source.routes),
    paths_state: source.paths_state, paths_message: source.paths_message };
}
function fixture(value: unknown) {
  const transport = vi.fn(async (_path: string, _init?: RequestInit) => value);
  const request: AuthenticatedRequest = async <T>(path: string, init?: RequestInit) => await transport(path, init) as T;
  return { api: createGisPlanHttp(request), transport };
}

describe('GIS 冻结方案读取适配器', () => {
  it('冻结地形按精确快照读取，缺失必须有明确原因', async () => {
    const row = { identity: network().identity, terrain: null, terrain_notice: '历史DEM未提供', coverage: null, coverage_notice: '覆盖未提供' };
    const { api, transport } = fixture(row);
    expect(await api.getSurface(query, network())).toEqual(row);
    expect(transport.mock.calls[0][0]).toBe('/gis/plans/P1/surface?context=gis&task_id=T1&snapshot_id=S1');
    expect(() => readGisPlanSurface({ ...row, terrain_notice: '' }, query, network())).toThrowError(ApiError);
    expect(() => readGisPlanSurface({ ...row, identity: { ...row.identity, resource_revision: 'OTHER' } }, query, network())).toThrowError(ApiError);
  });
  it('已核验地形保留来源/哈希/范围，不接受损坏元数据', () => {
    const row = { identity: network().identity, terrain: { sourceSha256: 'a'.repeat(64), bounds: [113, 36, 115, 38], source: '冻结DEM' }, terrain_notice: '', coverage: null, coverage_notice: '覆盖未提供' };
    expect(readGisPlanSurface(row, query, network()).terrain).toEqual(row.terrain);
    expect(() => readGisPlanSurface({ ...row, terrain: { ...row.terrain, bounds: [115, 36, 113, 38] } }, query, network())).toThrowError(ApiError);
    expect(() => readGisPlanSurface({ ...row, terrain: { ...row.terrain, sourceSha256: 'bad' } }, query, network())).toThrowError(ApiError);
  });
  it('覆盖仅解码冻结结果，缺少覆盖必须有原因且不表示零覆盖', () => {
    const row = { identity: network().identity, terrain: null, terrain_notice: '未提供地形', coverage: { contour: { type: 'FeatureCollection', features: [] }, raster_png: null }, coverage_notice: '' };
    expect(readGisPlanSurface(row, query, network()).coverage).toEqual({ contour: row.coverage.contour, rasterPng: null });
    expect(() => readGisPlanSurface({ ...row, coverage: null }, query, network())).toThrowError(ApiError);
    expect(() => readGisPlanSurface({ ...row, coverage: { contour: null, raster_png: null } }, query, network())).toThrowError(ApiError);
  });
  it('携带方案、任务、上下文和可选快照，只发送 GET 并传递取消信号', async () => {
    const { api, transport } = fixture(network()), controller = new AbortController();
    const result = await api.getNetwork(query, controller.signal);
    expect(result).toEqual(network());
    expect(transport).toHaveBeenCalledExactlyOnceWith('/gis/plans/P1/network?context=gis&task_id=T1&snapshot_id=S1', { method: 'GET', signal: controller.signal });
    expect(result.nodes[0].status).toBeNull(); expect(result.devices[0].frequency_khz).toBeNull();
    await api.getNetwork({ planId: 'P1', taskId: 'T1' });
    expect(transport.mock.calls[1][0]).toBe('/gis/plans/P1/network?context=gis&task_id=T1');
  });
  it('读取指定链路并保留观测缺失', async () => {
    const { api, transport } = fixture(detail());
    const result = await api.getLink({ ...query, linkId: 'L1' }, network());
    expect(transport.mock.calls[0][0]).toBe('/gis/plans/P1/links/L1?context=gis&task_id=T1&snapshot_id=S1');
    expect(result.observation).toEqual({ state: 'missing', message: '未提供实测观测', samples: [] });
  });
  it('读取所有或指定需求的主备路径', async () => {
    const { api, transport } = fixture(paths());
    expect((await api.getPaths(query, network())).routes).toHaveLength(2);
    await api.getPaths({ ...query, demandId: 'D1' }, network());
    expect(transport.mock.calls[1][0]).toBe('/gis/plans/P1/paths?context=gis&task_id=T1&snapshot_id=S1&demand_id=D1');
  });
  it.each(['SAVED', 'REFERENCE', 'CONFIRMED'] as const)('历史方案 %s 不因资源变化被替换', state => {
    const source = network(); source.identity.state = state;
    expect(readGisNetwork(source, query).identity).toEqual(source.identity);
  });
  it('未提供路径资料不伪装成已计算零路径', () => {
    const source = network(); source.routes = []; source.paths_state = 'missing'; source.paths_message = '路径未提供';
    expect(readGisNetwork(source, query).paths_state).toBe('missing');
    expect(readGisPaths(paths(source), query, source).routes).toEqual([]);
  });
  it('解码独立复制数组，不改变页面传入的冻结网络', () => {
    const source = network(), result = readGisNetwork(source, query);
    result.nodes[0].coordinate[0] = 100;
    expect(source.nodes[0].coordinate[0]).toBe(113);
  });
  it.each<[string, (row: GisNetwork) => void]>([
    ['错误任务', row => { row.identity.task_id = 'T2'; }],
    ['错误方案', row => { row.identity.plan_id = 'P2'; }],
    ['错误快照', row => { row.identity.snapshot_id = 'S2'; }],
    ['未知来源', row => { (row.identity as unknown as { source: string }).source = 'MOCK'; }],
    ['重复节点', row => { row.nodes.push(structuredClone(row.nodes[0])); }],
    ['重复设备', row => { row.devices.push(structuredClone(row.devices[0])); }],
    ['重复链路', row => { row.links.push(structuredClone(row.links[0])); }],
    ['重复需求', row => { row.demands.push(structuredClone(row.demands[0])); }],
    ['重复路径', row => { row.routes.push(structuredClone(row.routes[0])); }],
    ['设备归属错误', row => { row.devices[0].station_id = 'X'; }],
    ['链路设备错误', row => { row.links[0].device_a = 'EB'; }],
    ['链路频段错误', row => { row.links[0].device_class = 'VUHF'; }],
    ['链路自环', row => { row.links[0].b = 'A'; }],
    ['需求设备错归属', row => { row.demands[0].source_device_id = 'EB'; }],
    ['路径需求不存在', row => { row.routes[0].demand_id = 'X'; }],
    ['路径链路不存在', row => { row.routes[0].link_ids = ['X']; }],
    ['路径节点错序', row => { row.routes[1].node_ids = ['A', 'C', 'B']; }],
    ['同类主备重复', row => { row.routes[1].backup = false; }],
    ['路径长度错误', row => { row.routes[0].node_ids = ['A']; }],
    ['经度越界', row => { row.nodes[0].coordinate[0] = 181; }],
    ['非有限数值', row => { row.devices[0].tx_power_dbm = NaN; }],
    ['未分配频点不能为0', row => { row.links[0].frequency_khz = 0; }],
    ['挂高不能为负', row => { row.devices[0].antenna_height_m = -1; }],
    ['可靠性越界', row => { row.demands[0].min_reliability = 1.1; }],
    ['未知指标不能缺字段', row => { delete (row.devices[0] as Partial<GisNetwork['devices'][0]>).tx_power_dbm; }],
    ['缺失路径须有说明', row => { row.routes = []; row.paths_state = 'missing'; }],
    ['空路径不能为ready', row => { row.routes = []; }],
  ])('拒绝损坏冻结网络：%s', (_label, mutate) => {
    const source = network(); mutate(source);
    expect(() => readGisNetwork(source, query)).toThrowError(expect.objectContaining({ code: 'INVALID_GIS_PLAN_RESPONSE' }));
  });
  it.each<[string, (row: GisLinkDetail) => void]>([
    ['链路替换', row => { row.link.id = 'L2'; }],
    ['参数篡改', row => { row.link.frequency_khz = 3000; }],
    ['端点设备调换', row => { row.endpoint_devices.reverse(); }],
    ['假观测样本', row => { (row.observation.samples as unknown[]).push({ snr: 20 }); }],
    ['观测无说明', row => { row.observation.message = ''; }],
    ['路径关联缺失', row => { row.route_ids = []; }],
    ['需求关联重复', row => { row.demand_ids = ['D1', 'D1']; }],
    ['冻结资源版本变更', row => { row.identity.resource_revision = 'V2'; }],
  ])('拒绝混入其他快照的详情：%s', (_label, mutate) => {
    const value = detail(); mutate(value);
    expect(() => readGisLinkDetail(value, { ...query, linkId: 'L1' }, network())).toThrowError(ApiError);
  });
  it('只允许方案状态和来源变化标记更新，不允许静态参数变化', () => {
    const value = detail(); value.identity.state = 'CONFIRMED'; value.identity.source_changed = false;
    expect(readGisLinkDetail(value, { ...query, linkId: 'L1' }, network()).identity.state).toBe('CONFIRMED');
  });
  it('不接受额外路径、缺失需求或改变主备标识', () => {
    const value = paths(); value.routes[0].backup = true;
    expect(() => readGisPaths(value, query, network())).toThrowError(ApiError);
    expect(() => readGisPaths(paths(), { ...query, demandId: 'X' }, network())).toThrowError(ApiError);
  });
  it.each([
    { planId: '', taskId: 'T1' }, { planId: 'P1', taskId: ' T1' },
    { ...query, snapshotId: '' }, { ...query, extra: 'unexpected' },
  ])('非法查询在发出网络请求前失败 %j', async invalidQuery => {
    const { api, transport } = fixture(network());
    await expect(api.getNetwork(invalidQuery)).rejects.toMatchObject({ code: 'INVALID_GIS_PLAN_QUERY' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('详情和路径查询不能遗漏快照', async () => {
    const { api, transport } = fixture(detail());
    await expect(api.getLink({ ...query, snapshotId: '', linkId: 'L1' }, network())).rejects.toMatchObject({ code: 'INVALID_GIS_PLAN_QUERY' });
    await expect(api.getPaths({ ...query, snapshotId: '' }, network())).rejects.toMatchObject({ code: 'INVALID_GIS_PLAN_QUERY' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('响应校验绑定发起时的查询，不跟随外部对象改写', async () => {
    const selected = { ...query };
    const { api } = fixture(network());
    const pending = api.getNetwork(selected);
    selected.taskId = 'other'; selected.snapshotId = 'other';
    expect((await pending).identity.task_id).toBe('T1');
  });
  it('详情读取期间冻结参考网络，页面编辑不能篡改预期响应', async () => {
    const source = network(), selected = { ...query, linkId: 'L1' };
    const { api } = fixture(detail());
    const pending = api.getLink(selected, source);
    source.links[0].frequency_khz = 9999; selected.linkId = 'L2';
    expect((await pending).link.id).toBe('L1');
  });
  it('错误参考网络在请求前拒绝', async () => {
    const { api, transport } = fixture(detail()), source = network();
    source.identity.snapshot_id = 'other';
    await expect(api.getLink({ ...query, linkId: 'L1' }, source)).rejects.toMatchObject({ code: 'INVALID_GIS_PLAN_RESPONSE' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('GIS 复用共享会话 HTTP 边界', () => {
  const envelope = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, message: code ? '请求拒绝' : 'ok', data }),
    { status, headers: { 'Content-Type': 'application/json' } });
  function http(handler: (init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => 'http://local', fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/auth/session')) return envelope({ session_id: 'SS1', account_id: 'U1', username: 'planner', display_name: '联调规划员',
        role_id: 'RP', role_name: '联调角色', permissions: ['situation.view'], identity_revision: 'A1', session_generation: 'G1', integration_mode: true });
      return handler(init);
    } });
    return { api: createGisPlanHttp(client.authenticatedRequest), calls };
  }
  it('经共享会话校验并传递绑定标识，不直接裸 fetch', async () => {
    const { api, calls } = http(() => envelope(network()));
    expect((await api.getNetwork(query)).identity.snapshot_id).toBe('S1');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('/api/v1/gis/plans/P1/network?context=gis&task_id=T1&snapshot_id=S1');
    expect(new Headers(calls[1].init.headers).get('X-Session-Id')).toBe('SS1');
    expect(calls[1].init.credentials).toBe('same-origin');
  });
  it.each([[1203, 409, 1203], [2001, 404, 2001], [1104, 403, 'FORBIDDEN'], [5002, 503, 5002]] as const)(
    '保留业务错误 %s，不退回演示网络', async (code, status, expected) => {
      const { api, calls } = http(() => envelope(null, code, status));
      await expect(api.getNetwork(query)).rejects.toMatchObject({ code: expected, status });
      expect(calls).toHaveLength(2);
    },
  );
  it('取消中断读取，不将错误重试为成功', async () => {
    const { api, calls } = http(init => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const controller = new AbortController(), pending = api.getNetwork(query, controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(calls).toHaveLength(2);
  });
});
