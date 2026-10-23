import { describe, expect, it, vi } from 'vitest';
import { createResourceReadHttp } from '../src/services/resource-read-http';

// 请求桩只验证协议；不代替真实状态导入和浏览器验收。
const revision = 'resource-' + 'a'.repeat(16), snapshot = 'status-test';
const query = { context: 'ledger' as const, revision, pageNum: 1, pageSize: 5,
  statusMode: 'observed' as const, observationSnapshotId: snapshot };
const item = { device_id: 'D1', node_id: 'N1', model_id: 'M1', antenna_id: 'A1',
  node_name: '节点', node_lon: 114, node_lat: 37, model_name: '型号', antenna_name: '天线',
  device_class: 'HF', status: null as string | null, alert: null as boolean | null, observed_at: null as string | null };
const metadata = { snapshot_id: snapshot, snapshot_revision: 'device-status-' + 'b'.repeat(64),
  resource_revision: revision, data_origin: 'SYNTHETIC_INTEGRATION', source_label: '构造联调状态' };
const data = () => ({ revision, page: 1, page_size: 5, total: 1, items: [{ ...item }],
  status_mode: 'observed', observation_snapshot_id: snapshot, observation: { ...metadata } });
function service(value: unknown) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 0, message: 'ok', data: value })));
  return { fetcher, api: createResourceReadHttp({ baseUrl: () => '/api/v1', fetcher }) };
}

describe('冻结设备状态的只读投影', () => {
  it('原快照号发送到后端，缺报明确保留未知', async () => {
    const { api, fetcher } = service(data());
    const result = await api.queryResourceDevices(query);
    expect(Object.fromEntries(new URL(String(fetcher.mock.calls[0]![0]), 'http://local').searchParams))
      .toMatchObject({ status_mode: 'observed', observation_snapshot_id: snapshot });
    expect(result.items[0]).toMatchObject({ status: null, alert: null,
      statusDisplay: { mode: 'observed', status: null, alert: null, retained: false } });
    expect(result.items[0]!.statusDisplay!.observedAt).toBeUndefined();
  });
  it('已报告的状态和采集时间保持原值', async () => {
    const value = data();
    value.items = [{ ...item, status: 'FAULT', alert: true, observed_at: '2026-10-23T00:00:00Z' }];
    const result = await service(value).api.queryResourceDevices({ ...query, status: 'FAULT', alert: 'YES' });
    expect(result.items[0]!.statusDisplay).toMatchObject({ status: 'FAULT', alert: true, observedAt: '2026-10-23T00:00:00Z' });
  });
  it.each([
    { snapshot_id: 'other' }, { resource_revision: 'other' }, { snapshot_revision: 'old' },
    { data_origin: 'LIVE' }, { source_label: '' },
  ])('错误来源绑定不得显示成功 %j', async patch => {
    const value = data(); Object.assign(value.observation, patch);
    await expect(service(value).api.queryResourceDevices(query)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('基线请求不得夹带观测快照，节点不得猜测设备聚合状态', async () => {
    const { api, fetcher } = service(data());
    await expect(api.queryResourceDevices({ ...query, statusMode: 'baseline' })).rejects.toThrow();
    await expect(api.queryResourceNodes(query)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('地图频率和上下架筛选发送服务端，不再静默丢弃', async () => {
    const value = { revision, bbox: [113, 36, 115, 38], zoom: 9, points: [], clusters: [], total_nodes: 0, total_interferences: 0 };
    const { api, fetcher } = service(value);
    await api.queryResourceMap({ context: 'gis', revision, bbox: [113, 36, 115, 38], zoom: 9,
      showNodes: true, showInterferences: false, availability: 'ACTIVE',
      frequency: { mode: 'DEVICE', presence: 'MISSING', minKhz: null, maxKhz: null } });
    expect(Object.fromEntries(new URL(String(fetcher.mock.calls[0]![0]), 'http://local').searchParams))
      .toMatchObject({ availability: 'ACTIVE', frequency_mode: 'DEVICE', frequency_presence: 'MISSING' });
  });
});
