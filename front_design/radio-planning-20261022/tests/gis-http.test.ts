import { describe, expect, it, vi } from 'vitest';
import { createGisHttp } from '../src/services/gis-http';
import { decodeGisDirectory, decodeGisScene } from '../src/services/gis-http-validation';
import { httpFixture, response } from './fixtures/planning-api';

// 独立线协议样件用于验证解码和关联拒绝，不当作真实联调结果。
function dto() {
  return { revision: 'r1', context: 'gis', dataOrigin: 'SYNTHETIC_INTEGRATION', source: '构造资源，非实测', updatedAt: '2026-10-23T00:00:00Z',
    nodes: [{ node_id: 'N1', node_name: '节点一', lon: 114, lat: 37, parent_node_id: '', echelon: '营', mobility: '固定', device_class: 'HF', status: 'NORMAL', alert: false, origin: 'SOURCE', relay_capable: true, is_key: false, child_count: 0, device_count: 1 }],
    models: [{ model_id: 'M1', model_name: '短波设备', device_class: 'HF', freq_min_khz: 2000, freq_max_khz: 30000, tx_power_max_dbm: 40, modulation: 'AM', work_mode: 'simplex' }],
    devices: [{ device_id: 'D1', node_id: 'N1', model_id: 'M1', antenna_id: 'A1', node_name: '节点一', node_lon: 114, node_lat: 37, model_name: '短波设备', antenna_name: '天线一', device_class: 'HF', status: 'NORMAL', alert: false, availability: 'ACTIVE', origin: 'SOURCE' }],
    interferences: [], snapshotId: 'GIS-RES-r1', networkState: 'missing', networkMessage: '未关联规划网络' };
}
describe('GIS 只读 HTTP', () => {
  it('目录和场景经认证入口发送同版请求并传递取消信号', async () => {
    const fixture = httpFixture(() => response(dto())), api = createGisHttp(fixture.request);
    const controller = new AbortController(), input = { context: 'gis' as const, revision: 'r1', signal: controller.signal };
    const directory = await api.loadGisResourceDirectory(input), scene = await api.loadGisResourceScene(input);
    expect(directory.resources.devices[0]).toMatchObject({ id: 'D1', stationId: 'N1' });
    expect(scene.network).toMatchObject({ state: 'missing', links: [], routes: [] });
    expect(scene.map.devices[0]).toMatchObject({ id: 'D1', coordinate: [114, 37] });
    const calls = fixture.calls.filter(row => row.path.includes('/resource/gis-'));
    expect(calls).toHaveLength(2);
    expect(calls.every(row => row.path.endsWith('?context=gis&revision=r1') && row.init.body === undefined)).toBe(true);
  });
  it('取消、非法上下文不发请求', async () => {
    const request = vi.fn(), api = createGisHttp(request), controller = new AbortController();controller.abort();
    await expect(api.loadGisResourceScene({ context: 'gis', revision: 'r1', signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    // 故意越过编译期约束，核验运行时仍拒绝非 GIS 调用。
    await expect(api.loadGisResourceDirectory({ context: 'planning', revision: 'r1' } as never)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_QUERY' });
    expect(request).not.toHaveBeenCalled();
  });
  it('错版拒绝且缺失网络不补造为成功', () => {
    expect(() => decodeGisScene(dto(), 'r2')).toThrow();
    expect(decodeGisScene(dto(), 'r1').linkDetails.state).toBe('missing');
    expect(() => decodeGisScene({ ...dto(), networkState: 'ready' }, 'r1')).toThrow();
  });
  it.each(['duplicate', 'parent', 'model', 'station', 'origin', 'coordinate'] as const)('拒绝坏关联：%s', kind => {
    const value = dto();
    if (kind === 'duplicate') value.nodes.push({ ...value.nodes[0] });
    if (kind === 'parent') value.nodes[0].parent_node_id = 'absent';
    if (kind === 'model') value.devices[0].model_id = 'absent';
    if (kind === 'station') value.devices[0].node_id = 'absent';
    if (kind === 'origin') value.nodes[0].origin = 'MANUAL';
    if (kind === 'coordinate') value.devices[0].node_lon = 115;
    expect(() => decodeGisScene(value, 'r1')).toThrow();
    if (kind !== 'coordinate') expect(() => decodeGisDirectory(value, 'r1')).toThrow();
  });
});
