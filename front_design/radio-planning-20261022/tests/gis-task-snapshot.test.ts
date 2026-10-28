import { describe, expect, it, vi } from 'vitest';
import { createGisTaskHttp } from '../src/services/gis-task-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import type { GisTaskSnapshotQuery } from '../src/types/gis-task';
import { httpFixture, response, taskDto } from './fixtures/planning-api';

// 独立合成的原始节点 DTO，只验证请求边界，不接触服务和数据库。
function nodeDto(id = 'N1') {
  return { node_id: id, node_name: `冻结节点${id}`, lon: 114, lat: 37, elevation_m: null,
    parent_node_id: [], echelon: '营', mobility: '固定', region: '', device_class: ['HF'],
    status: 'NORMAL', alert: null, origin: null, relay_capable: true, is_key: false, child_count: 0, device_count: 1 };
}
function snapshotDto() {
  return { task: taskDto(), resource_revision: 'r1', task_revision: 't1', snapshot_id: 'GIS-TASK-t1',
    source_changed: false, nodes: [nodeDto(), nodeDto('N2')], missing_node_ids: [] as string[], message: '' };
}
type Dto = ReturnType<typeof snapshotDto>;
const query: GisTaskSnapshotQuery = { context: 'planning', taskId: 'T1', revision: 't1' };
function direct(raw: unknown) {
  // 明确请求参数，避免 mock.calls 被推断成无参数元组。
  const request = vi.fn(async (_path: string, _init?: RequestInit) => raw);
  return { request, client: createGisTaskHttp(request as unknown as AuthenticatedRequest) };
}

describe('GIS任务冻结快照HTTP严格契约', () => {
  it('按保存revision请求唯一GET，解码原始节点DTO并保留冻结需求和端点', async () => {
    const raw = snapshotDto(); raw.source_changed = true; raw.message = '历史冻结资源';
    raw.task.input.demands[0]!.endpointMode = 'device';
    raw.task.input.demands[0]!.sourceDeviceId = 'E1'; raw.task.input.demands[0]!.targetDeviceId = 'E2';
    const f = httpFixture(() => response(raw)), signal = new AbortController().signal;
    const result = await createGisTaskHttp(f.request).getSnapshot(query, signal);
    expect(result).toMatchObject({ taskRevision: 't1', resourceRevision: 'r1', snapshotId: 'GIS-TASK-t1', sourceChanged: true,
      nodes: [{ kind: 'node', id: 'N1', coordinate: [114, 37] }, { kind: 'node', id: 'N2' }] });
    expect(result.task.input.demands).toEqual(raw.task.input.demands);
    const calls = f.calls.filter(call => !call.path.includes('/auth/'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/v1/task-inputs/T1/gis-snapshot?context=planning&revision=t1');
    expect(calls[0]!.init.method).toBe('GET'); expect(calls[0]!.init.body).toBeUndefined();
  });
  it('ID和revision按URL编码，不把输入拼入查询字符串', async () => {
    const raw = snapshotDto(); raw.task.task_id = 'T/one'; raw.task.revision = raw.task_revision = 'r+1'; raw.snapshot_id = 'GIS-TASK-r+1';
    const f = direct(raw); await f.client.getSnapshot({ ...query, taskId: 'T/one', revision: 'r+1' });
    expect(f.request).toHaveBeenCalledWith('/task-inputs/T%2Fone/gis-snapshot?context=planning&revision=r%2B1', { method: 'GET', signal: undefined });
  });
  it('部分缺节点只返回原序中存在的节点，缺失清单一次保留', async () => {
    const raw = snapshotDto(); raw.nodes = [nodeDto('N2')]; raw.missing_node_ids = ['N1'];
    const result = await direct(raw).client.getSnapshot(query);
    expect(result.nodes.map(node => node.id)).toEqual(['N2']); expect(result.missingNodeIds).toEqual(['N1']);
    raw.nodes = []; raw.missing_node_ids = ['N1', 'N2'];
    expect((await direct(raw).client.getSnapshot(query)).nodes).toEqual([]);
  });
  const invalidCases: [string, (raw: Dto) => void][] = [
    ['task_id', raw => { raw.task.task_id = 'OTHER'; }],
    ['task_revision', raw => { raw.task_revision = 'OTHER'; }],
    ['task.revision', raw => { raw.task.revision = 'OTHER'; }],
    ['resource_revision', raw => { raw.resource_revision = 'OTHER'; }],
    ['task.resource_revision', raw => { raw.task.resource_revision = ''; }],
    ['snapshot_id', raw => { raw.snapshot_id = 'GIS-TASK-OTHER'; }],
    ['重复节点', raw => { raw.nodes[1] = nodeDto(); }],
    ['多余节点', raw => { raw.nodes.push(nodeDto('N3')); }],
    ['节点逆序', raw => { raw.nodes.reverse(); }],
    ['未说明缺节点', raw => { raw.nodes.pop(); }],
    ['存在与缺失重叠', raw => { raw.missing_node_ids = ['N1']; }],
    ['重复缺失节点', raw => { raw.nodes = []; raw.missing_node_ids = ['N1', 'N1', 'N2']; }],
    ['缺失清单逆序', raw => { raw.nodes = []; raw.missing_node_ids = ['N2', 'N1']; }],
    ['未引用的缺失节点', raw => { raw.missing_node_ids = ['N3']; }],
    ['无限坐标', raw => { raw.nodes[0]!.lon = Infinity; }],
    ['非数坐标', raw => { raw.nodes[0]!.lat = NaN; }],
    ['坐标越界', raw => { raw.nodes[0]!.lat = 91; }],
    ['重复参与节点', raw => { raw.task.input.stationIds = ['N1', 'N1']; }],
    ['需求端点越界', raw => { raw.task.input.demands[0]!.targetId = 'N3'; }],
    ['缺少来源标记', raw => { Object.assign(raw, { source_changed: undefined }); }],
    ['来源标记非布尔', raw => { Object.assign(raw, { source_changed: 1 }); }],
    ['缺少消息', raw => { Object.assign(raw, { message: undefined }); }],
  ];
  it.each(invalidCases)('拒绝错误响应：%s', async (_name, change) => {
    const raw = snapshotDto(); change(raw);
    await expect(direct(raw).client.getSnapshot(query)).rejects.toThrow();
  });
  it.each([[1205, 409], [2001, 404], [2004, 404], [1104, 403]])('原样保留错误码%s，不转当前资源重试', async (code, status) => {
    const f = httpFixture(() => response(null, code, status));
    await expect(createGisTaskHttp(f.request).getSnapshot(query)).rejects.toMatchObject({ status, code: code === 1104 ? 'FORBIDDEN' : code });
    expect(f.calls.filter(call => !call.path.includes('/auth/'))).toHaveLength(1);
  });
  it('拒绝错误上下文及非法身份，已取消请求不发出读取', async () => {
    const f = direct(snapshotDto());
    await expect(f.client.getSnapshot({ ...query, context: 'gis' } as unknown as GisTaskSnapshotQuery)).rejects.toThrow();
    await expect(f.client.getSnapshot({ ...query, taskId: 'T 1' })).rejects.toThrow();
    await expect(f.client.getSnapshot({ ...query, revision: '' })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(f.client.getSnapshot(query, controller.signal)).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('请求期间改变查询对象不改变响应的原绑定，取消后的响应不接收', async () => {
    let complete!: (value: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const client = createGisTaskHttp(request as unknown as AuthenticatedRequest), mutable = { ...query };
    const pending = client.getSnapshot(mutable); mutable.taskId = 'OTHER'; complete(snapshotDto());
    expect((await pending).task.taskId).toBe('T1');
    const controller = new AbortController(), aborted = client.getSnapshot(query, controller.signal);
    controller.abort(); complete(snapshotDto());
    await expect(aborted).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });
});
