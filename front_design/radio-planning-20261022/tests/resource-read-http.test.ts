import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResourceReadHttp } from '../src/services/resource-read-http';
import type { ResourceMapQuery } from '../src/types/resource-read';

// 合成线协议样件用于检查边界，不读取或修改甲方来源文件。
const device = () => ({ device_id: 'D1', node_id: 'N1', model_id: 'M1', antenna_id: 'A1', node_name: '节点一', node_lon: 114, node_lat: 37, model_name: '短波设备', antenna_name: '天线一', device_class: 'HF', status: 'NORMAL' });
const node = () => ({ node_id: 'N1', node_name: '节点一', lon: 114, lat: 37, parent_node_id: '', echelon: '营', mobility: '固定', device_class: 'HF;VUHF', status: 'NORMAL', relay_capable: true, is_key: false, child_count: 0, device_count: 1 });
const workspace = () => ({ revision: 'v1', bounds: [113,36,115,38], updated_at: '2026-10-05T00:00:00Z', source: '资源接口', stats: { nodes: 1, devices: 1, models: 1, interferences: 0, hf: 1, vuhf: 0 } });
const response = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, message: code ? '版本或权限拒绝' : 'ok', data, request_id: 'R1' }), { status });
const query = { context: 'ledger' as const, revision: 'v1', pageNum: 1, pageSize: 10 };
const page = (items: unknown[]) => ({ revision: 'v1', page: 1, page_size: 10, total: items.length, items });
function service(data: unknown) {
  const fetcher = vi.fn<typeof fetch>(async () => response(data));
  return { fetcher, api: createResourceReadHttp({ baseUrl: () => '/api/v1', fetcher }) };
}
afterEach(() => vi.useRealTimers());
describe('资源 HTTP 传输和 DTO', () => {
  it('保留当前 DEM 元数据；缺失为未知，非法哈希和范围拒绝', async () => {
    const terrain = { source_sha256: 'a'.repeat(64), bbox: [113,36,115,38], source: '测试 DEM' };
    const read = (value: unknown) => service({ ...workspace(), terrain: value }).api.loadResourceReadContext({ context: 'planning' });
    expect((await read(terrain)).terrain).toEqual({ sourceSha256: terrain.source_sha256, bounds: terrain.bbox, source: terrain.source });
    expect((await read(null)).terrain).toBeNull();
    expect((await service(workspace()).api.loadResourceReadContext({ context: 'planning' })).terrain).toBeNull();
    for (const patch of [{ source_sha256: 'old' }, { bbox: [115,36,113,38] }, { source: '' }])
      await expect(read({ ...terrain, ...patch })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('同源 GET 发送分页筛选排序，不从当前页推算全库总数', async () => {
    const s = service({ ...page([device()]), page: 3, total: 21 });
    const result = await s.api.queryResourceDevices({ ...query, pageNum: 3, search: '短 波', deviceClass: 'HF', sort: 'status', order: 'desc', availability: 'UNKNOWN', alert: 'UNKNOWN' });
    expect(result).toMatchObject({ total: 21, pageNum: 3, pageSize: 10 });
    expect(result.items[0]).toMatchObject({ id: 'D1', stationId: 'N1', alert: null, origin: null, availability: null });
    const [url, init] = s.fetcher.mock.calls[0], params = new URL(String(url), 'http://local').searchParams;
    expect(Object.fromEntries(params)).toMatchObject({ context: 'ledger', revision: 'v1', page: '3', page_size: '10', search: '短 波', sort: 'status', order: 'desc', availability: 'UNKNOWN' });
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(init?.body).toBeUndefined();
  });
  it('上下文缺少补充统计保留未知，核心统计不一致拒绝', async () => {
    expect((await service(workspace()).api.loadResourceReadContext({ context: 'gis' })).stats.alerts).toBeNull();
    const dto = workspace(); dto.stats.devices = 2;
    await expect(service(dto).api.loadResourceReadContext({ context: 'gis' })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('新增分类和频段条件使用统一参数，响应忽略条件时拒绝而非在本页补筛', async () => {
    const s = service(page([{ ...device(), mobility: 'FIXED', node_role: 'RELAY', relay_capable: true, freq_min_khz: 1, freq_max_khz: 100 }]));
    const filter = { mobility: 'FIXED', nodeRole: 'RELAY', relayCapable: true, frequency: { mode: 'MODEL' as const, presence: 'ALL' as const, minKhz: 10, maxKhz: 20 } };
    expect((await s.api.queryResourceDevices({ ...query, ...filter })).items[0]).toMatchObject({ mobility: 'FIXED', nodeRole: 'RELAY', freqMinKhz: 1 });
    expect(Object.fromEntries(new URL(String(s.fetcher.mock.calls[0][0]), 'http://local').searchParams)).toMatchObject({ mobility: 'FIXED', node_role: 'RELAY', relay_capable: 'true', frequency_mode: 'MODEL', min_khz: '10', max_khz: '20' });
    await expect(service(page([device()])).api.queryResourceDevices({ ...query, ...filter })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('节点多值在边界拆分，根节点必须明确提供父级字段', async () => {
    const result = await service(page([node()])).api.queryResourceNodes({ ...query, context: 'gis', parentId: null });
    expect(result.items[0].classes).toEqual(['HF','VUHF']); expect(result.items[0].parentIds).toEqual([]);
    await expect(service(page([{ ...node(), parent_node_id: undefined }])).api.queryResourceNodes({ ...query, context: 'gis' })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it.each([{device_id:''},{node_id:null},{node_lon:181},{status:'BROKEN'},{device_class:'HF;VUHF'},{alert:'false'},{availability:'DELETED'},{origin:'OTHER'}])('关键字段或已提供枚举非法时拒绝 %j', async patch => {
    await expect(service(page([{ ...device(), ...patch }])).api.queryResourceDevices(query)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('拒绝重复 ID、分页回显错误及关联节点错误', async () => {
    for (const dto of [page([device(),device()]), { ...page([device()]), page:2 }, { ...page([device()]), total:12 }]) {
      await expect(service(dto).api.queryResourceDevices(query)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    await expect(service(page([device()])).api.queryResourceDevices({ ...query, nodeId: 'N2' })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('详情按同版 ID 读取型号与天线，错关联不能拼接成成功', async () => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input), 'http://local').pathname;
      if (path.endsWith('/nodes/N1')) return response({ revision: 'v1', item: node() });
      return response(path.endsWith('/devices/D1') ? { revision:'v1', item:device() } : { revision:'v1', items: path.endsWith('device-models') ? [{ model_id:'M1',model_name:'短波设备',device_class:'HF',freq_min_khz:1,freq_max_khz:100,tx_power_max_dbm:40,modulation:'AM;FM',work_mode:['simplex'] }] : [{antenna_id:'A1',antenna_name:'天线一'}] });
    });
    const api = createResourceReadHttp({ baseUrl: () => '/api/v1', fetcher });
    expect((await api.getResourceObject({ ...query, kind:'device',id:'D1' })).model?.modulation).toEqual(['AM','FM']);
    expect(fetcher.mock.calls).toHaveLength(4);
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('revision=v1'))).toBe(true);
    fetcher.mockImplementation(async () => response({ revision:'v1',item:device(),items:[{antenna_id:'wrong',antenna_name:'天线一'}] }));
    await expect(api.getResourceObject({ ...query, kind:'device',id:'D1' })).rejects.toMatchObject({ code:'INVALID_RESOURCE_RESPONSE' });
  });
  it.each([[1201,200,'RESOURCE_VERSION_CHANGED'],[1202,409,'RESOURCE_VERSION_CHANGED'],[1106,409,'SESSION_REPLACED'],[1102,200,'AUTH_EXPIRED'],[1103,200,'AUTH_DISABLED'],[1104,200,'FORBIDDEN'],[7,401,'AUTH_REQUIRED'],[7,403,'FORBIDDEN'],[7,404,'RESOURCE_NOT_FOUND']])('业务/传输错误映射并保留失败详情 %s/%s', async (code, status, expected) => {
    const s=service(null); s.fetcher.mockResolvedValue(response({ suggestions:['refresh'] },Number(code),Number(status)));
    await expect(s.api.queryResourceDevices(query)).rejects.toMatchObject({ code:expected,data:{suggestions:['refresh']},requestId:'R1',status });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('成功包络中的版本跳变也要求手动刷新', async () => {
    await expect(service({...page([]),revision:'v2'}).api.queryResourceDevices(query)).rejects.toMatchObject({code:'RESOURCE_VERSION_CHANGED'});
  });
  it('非法请求和跨域配置在网络发送前拒绝', async () => {
    const s=service(page([]));
    await expect(s.api.queryResourceDevices({...query,pageNum:0})).rejects.toThrow(); expect(s.fetcher).not.toHaveBeenCalled();
    const api=createResourceReadHttp({baseUrl:()=> 'https://foreign.test/api',origin:()=> 'https://local.test',fetcher:s.fetcher});
    await expect(api.loadResourceReadContext({context:'ledger'})).rejects.toThrow(); expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('超时覆盖响应体等待，取消可结束不响应 AbortSignal 的传输', async () => {
    vi.useFakeTimers();
    const fetcher=vi.fn<typeof fetch>(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}) as Response);
    const api=createResourceReadHttp({baseUrl:()=>'/api/v1',fetcher,timeoutMs:100});
    const task=api.queryResourceDevices(query), check=expect(task).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
    await vi.advanceTimersByTimeAsync(100); await check;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const controller=new AbortController(), canceled=api.queryResourceDevices({...query,signal:controller.signal});
    const canceledCheck=expect(canceled).rejects.toMatchObject({code:'REQUEST_ABORTED'}); controller.abort(); await canceledCheck;
  });
  it('网络/JSON 失败不返回 Mock 成功', async () => {
    const s=service(null);s.fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(s.api.queryResourceDevices(query)).rejects.toMatchObject({code:'NETWORK_ERROR'});
    s.fetcher.mockResolvedValueOnce(new Response('html'));
    await expect(s.api.queryResourceDevices(query)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
});
describe('服务端聚合地图契约',()=>{
  const q:ResourceMapQuery={context:'gis',revision:'v1',bbox:[113,36,115,38],zoom:10,showNodes:true,showInterferences:true};
  const frame=()=>({revision:'v1',bbox:q.bbox,zoom:10,points:[{kind:'interference',id:'I1',name:'干扰源',lon:114,lat:37,active:false}],clusters:[{kind:'node',cluster_id:'C1',lon:114,lat:37,count:200,bounds:[113.5,36.5,114.5,37.5],expansion_zoom:12}],total_nodes:200,total_interferences:1});
  it('聚合数量与展开级别直接来自服务，聚合成员按稳定 ID 分页',async()=>{
    const s=service(frame()), result=await s.api.queryResourceMap(q);
    expect(result.clusters[0]).toMatchObject({id:'C1',count:200,expansionZoom:12});
    expect(new URL(String(s.fetcher.mock.calls[0][0]),'http://local').searchParams.get('bbox')).toBe('113,36,115,38');
    const members=service(page([node()]));await members.api.queryResourceNodes({...query,context:'gis',clusterId:'C1'});
    expect(String(members.fetcher.mock.calls[0][0])).toContain('cluster_id=C1');
  });
  it.each(['total','bbox','outside','duplicate','zoom','hidden'] as const)('拒绝错误地图响应：%s',async kind=>{
    const d=frame(); if(kind==='total')d.total_nodes=201;if(kind==='bbox')d.bbox=[112,36,115,38];if(kind==='outside')d.points[0].lon=116;if(kind==='duplicate')d.points.push({...d.points[0]});if(kind==='zoom')d.clusters[0].expansion_zoom=9;
    await expect(service(d).api.queryResourceMap({...q,showNodes:kind!=='hidden'})).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
  });
});
