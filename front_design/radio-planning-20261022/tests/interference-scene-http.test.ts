import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createHttpClient } from '../src/services/http-client';
import { createInterferenceSceneHttp } from '../src/services/interference-scene-http';
import type { InterferenceSceneSave } from '../src/types/interference-scene';
import { ApiError } from '../src/services/types';

const revision = 'resource-1111111111111111', hash = 'a'.repeat(64), time = '2026-10-23T08:00:00.000000Z';
const input = (): InterferenceSceneSave => ({
  sceneId: 'SC1', requestId: 'R1', taskId: 'T1', planId: 'P1', planVersion: 'V1', resourceRevision: revision,
  baseSceneVersionId: null, name: '干扰场景', note: '构造测试', interferenceIds: ['IF-2', 'IF-1'],
});
function receipt() {
  return { request_id: 'R1', operation: 'SAVE_INTERFERENCE_SCENE', status: 'SUCCEEDED', actor_id: 'integration-planner',
    task_id: 'T1', scene_id: 'SC1', base_scene_version_id: null, version_id: 'ISV-1', version_no: 1,
    plan_id: 'P1', plan_version: 'V1', resource_revision: revision, snapshot_hash: hash,
    data_origin: 'SYNTHETIC_INTEGRATION', changed: true, created_at: time };
}
function summary() {
  return { scene_id: 'SC1', task_id: 'T1', version_id: 'ISV-1', version_no: 1, name: '干扰场景', plan_id: 'P1',
    plan_version: 'V1', resource_revision: revision, source_count: 2, snapshot_hash: hash,
    data_origin: 'SYNTHETIC_INTEGRATION', saved_at: time };
}
function detail() {
  return { version: { ...summary(), schema_version: 1, note: '构造测试', previous_version_id: null,
    saved_by: 'integration-planner', resource_content_hash: hash, source: '非实测构造来源',
    interference_ids: ['IF-1', 'IF-2'], interference_sources: [
      { interference_id: 'IF-1', source_row: { interference_id: 'IF-1', tx_power_dbm: '', active: '' } },
      { interference_id: 'IF-2', source_row: { interference_id: 'IF-2', tx_power_dbm: '30' } },
    ], plan_snapshot: { task_id: 'T1', plan_id: 'P1', plan_version: 'V1', input_version: 'REV-1',
      condition_version: 'COND-1', resource_revision: revision, source: 'SR4',
      input_snapshot: { demands: [{ id: 'C1', requiredRateKbps: 64, mandatory: true }] },
      raw_snapshot: { solution_id: 'PL-1', summary: {}, terrain_fingerprint: null, detail: {
        nodes: [{ node_id: 'N1' }, { node_id: 'N2' }],
        devices: [{ device_id: 'D1', node_id: 'N1', status: null }, { device_id: 'D2', node_id: 'N2' }],
        links: [{ link_id: 'L1', node_a_id: 'N1', node_b_id: 'N2', device_a_id: 'D1', device_b_id: 'D2' }],
        routes: { routes: [{ demand_id: 'C1', primary: { node_path: ['N1', 'N2'], link_path: ['L1'] }, backup: null }] },
      } },
    } }, source_state: { state: 'CURRENT', reasons: [] as string[] } };
}
function service(value: unknown) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value);
  return { request, api: createInterferenceSceneHttp(request) };
}

function deferredService() {
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const request = vi.fn<AuthenticatedRequest>().mockImplementation(() => pending as never);
  return { request, resolve, api: createInterferenceSceneHttp(request) };
}

describe('P03 场景不可变版本 HTTP 适配器', () => {
  it('保存路径和字段精确转换，仅排序源集合，不修改调用方输入', async () => {
    const s = service(receipt()), request = input();
    expect((await s.api.saveScene(request)).versionId).toBe('ISV-1');
    expect(s.request.mock.calls[0][0]).toBe('/interference/scenes/SC1');
    expect(s.request.mock.calls[0][1]!.method).toBe('PUT');
    expect(JSON.parse(s.request.mock.calls[0][1]!.body as string)).toEqual({ request_id: 'R1', task_id: 'T1', plan_id: 'P1',
      plan_version: 'V1', resource_revision: revision, base_scene_version_id: null, name: request.name,
      note: request.note, interference_ids: ['IF-1', 'IF-2'] });
    expect(request.interferenceIds).toEqual(['IF-2', 'IF-1']);
    expect(s.request).toHaveBeenCalledTimes(1);
  });

  it('指定历史版本并保留来源、空串、未知状态和地形', async () => {
    const dto = detail(), s = service(dto);
    dto.source_state = { state: 'HISTORICAL', reasons: ['当前确认方案已切换'] };
    const result = await s.api.getScene({ taskId: 'T1', sceneId: 'SC1', versionId: 'ISV-1' });
    expect(s.request.mock.calls[0][0]).toBe('/interference/scenes/SC1?task_id=T1&version_id=ISV-1');
    expect(result.sourceState.state).toBe('HISTORICAL');
    expect(result.version.interferenceSources[0].sourceRow.active).toBe('');
    expect(result.version.planSnapshot.rawSnapshot.terrain_fingerprint).toBeNull();
    expect(result.version.planSnapshot.rawSnapshot).toEqual(dto.version.plan_snapshot.raw_snapshot);
    dto.version.plan_snapshot.raw_snapshot.detail.devices[0].node_id = 'changed';
    expect(result.version.planSnapshot.rawSnapshot).not.toEqual(dto.version.plan_snapshot.raw_snapshot);
  });

  it('单路径段安全编码，不把名称或源 ID 放入 URL 路径', async () => {
    const dto = receipt(); dto.scene_id = '场景:#?%'; dto.request_id = '请求:#?%';
    const s = service(dto);
    await s.api.saveScene({ ...input(), sceneId: dto.scene_id, requestId: dto.request_id });
    expect(s.request.mock.calls[0][0]).toBe('/interference/scenes/' + encodeURIComponent(dto.scene_id));
    await s.api.getSceneReceipt({ taskId: 'T1', sceneId: dto.scene_id, requestId: dto.request_id });
    const path = String(s.request.mock.calls[1][0]);
    expect(path).toContain('/scene-operations/' + encodeURIComponent(dto.request_id));
    expect(new URL(path, 'http://local').searchParams.get('scene_id')).toBe(dto.scene_id);
  });

  it('场景目录与版本历史分页分别验证归属和版本顺序', async () => {
    const s = service({ items: [summary()], total: 1, page: 1, page_size: 20 });
    expect((await s.api.listScenes({ taskId: 'T1', search: '%_' })).items[0].sourceCount).toBe(2);
    expect(new URL(String(s.request.mock.calls[0][0]), 'http://local').searchParams.get('search')).toBe('%_');
    const history = { items: [{ ...summary(), version_id: 'ISV-2', version_no: 2 }, summary()], total: 2, page: 1, page_size: 20 };
    s.request.mockResolvedValue(history);
    expect((await s.api.listSceneVersions({ taskId: 'T1', sceneId: 'SC1' })).items.map(i => i.versionNo)).toEqual([2, 1]);
    expect(s.request.mock.calls[1][0]).toBe('/interference/scenes/SC1/versions?task_id=T1&page=1&page_size=20');
    s.request.mockResolvedValue({ items: [], total: 1, page: 9, page_size: 20 });
    expect((await s.api.listScenes({ taskId: 'T1', page: 9 })).items).toEqual([]);
  });

  it('无变化回执必须保持基础版本，新增版本必须不同于基础版本', async () => {
    const dto = { ...receipt(), base_scene_version_id: 'ISV-1', changed: false };
    expect((await service(dto).api.saveScene({ ...input(), baseSceneVersionId: 'ISV-1' })).changed).toBe(false);
    for (const patch of [{ version_id: 'ISV-2' }, { base_scene_version_id: null }, { changed: true }]) {
      await expect(service({ ...dto, ...patch }).api.saveScene({ ...input(), baseSceneVersionId: 'ISV-1' }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    const next = { ...dto, changed: true, version_id: 'ISV-2', version_no: 2 };
    expect((await service(next).api.saveScene({ ...input(), baseSceneVersionId: 'ISV-1' })).versionNo).toBe(2);
  });

  it('写请求超时后由调用方显式查询回执，不自动重试或计算', async () => {
    const s = service(receipt());
    s.request.mockRejectedValueOnce(new ApiError('超时', 'REQUEST_TIMEOUT'));
    await expect(s.api.saveScene(input())).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(s.request).toHaveBeenCalledTimes(1);
    expect((await s.api.getSceneReceipt({ taskId: 'T1', sceneId: 'SC1', requestId: 'R1' })).status).toBe('SUCCEEDED');
    expect(s.request).toHaveBeenCalledTimes(2);
    expect(s.request.mock.calls[1][1]).toBeUndefined();
    expect(String(s.request.mock.calls[1][0])).toContain('/scene-operations/R1?');
  });

  it('保存等待期间改写调用方输入和源数组，仍核验发起时的请求', async () => {
    const s = deferredService(), request = input();
    const pending = s.api.saveScene(request);
    request.sceneId = 'SC2'; request.taskId = 'T2'; request.requestId = 'R2'; request.planId = 'P2';
    request.planVersion = 'V2'; request.resourceRevision = 'other'; request.baseSceneVersionId = 'other';
    request.interferenceIds.splice(0, request.interferenceIds.length, 'IF-new');
    s.resolve(receipt());
    await expect(pending).resolves.toMatchObject({ sceneId: 'SC1', taskId: 'T1', requestId: 'R1', planId: 'P1' });
    expect(s.request.mock.calls[0][0]).toBe('/interference/scenes/SC1');
    expect(JSON.parse(s.request.mock.calls[0][1]!.body as string)).toMatchObject({
      task_id: 'T1', request_id: 'R1', plan_id: 'P1', interference_ids: ['IF-1', 'IF-2'],
    });
  });

  it('详情等待期间改写任务、场景及指定版本，仍接受原版本响应', async () => {
    const s = deferredService(), query = { taskId: 'T1', sceneId: 'SC1', versionId: 'ISV-1' };
    const pending = s.api.getScene(query);
    query.taskId = 'T2'; query.sceneId = 'SC2'; query.versionId = 'ISV-2';
    s.resolve(detail());
    await expect(pending).resolves.toMatchObject({ version: { taskId: 'T1', sceneId: 'SC1', versionId: 'ISV-1' } });
    expect(s.request.mock.calls[0][0]).toBe('/interference/scenes/SC1?task_id=T1&version_id=ISV-1');
  });

  it('回执查询等待期间改写输入，不改变已发请求的响应归属', async () => {
    const s = deferredService(), query = { taskId: 'T1', sceneId: 'SC1', requestId: 'R1' };
    const pending = s.api.getSceneReceipt(query);
    query.taskId = 'T2'; query.sceneId = 'SC2'; query.requestId = 'R2';
    s.resolve(receipt());
    await expect(pending).resolves.toMatchObject({ taskId: 'T1', sceneId: 'SC1', requestId: 'R1' });
    expect(s.request.mock.calls[0][0]).toBe('/interference/scene-operations/R1?task_id=T1&scene_id=SC1');
  });

  it('不能通过改写等待中的输入，让另一任务的回执通过校验', async () => {
    const s = deferredService(), request = input();
    const pending = s.api.saveScene(request);
    request.taskId = 'T2'; request.sceneId = 'SC2'; request.requestId = 'R2';
    s.resolve({ ...receipt(), task_id: 'T2', scene_id: 'SC2', request_id: 'R2' });
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    { taskId: 'other' }, { planId: 'other' }, { planVersion: 'V2' }, { resourceRevision: 'other' },
    { requestId: 'other' }, { sceneId: 'other' },
  ])('拒绝错配成功回执 %j', async patch => {
    await expect(service(receipt()).api.saveScene({ ...input(), ...patch })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    { actor_id: null }, { changed: 'true' }, { operation: 'ANALYZE' }, { status: 'RUNNING' }, { version_no: true },
    { snapshot_hash: 'bad' }, { created_at: 'yesterday' }, { extra: 'hidden' },
  ])('拒绝畸形成功回执 %j', async patch => {
    await expect(service({ ...receipt(), ...patch }).api.saveScene(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('在发出保存前拒绝额外字段、缺失值、重复源及非法路径身份', async () => {
    const s = service(receipt());
    for (const patch of [{ sceneId: 'a/b' }, { requestId: 'a\\b' }, { name: ' x' }, { note: null },
      { interferenceIds: ['IF-1', 'IF-1'] }, { interferenceIds: [true] }, { actorId: 'admin' },
      { baseSceneVersionId: undefined }, { planVersion: 'V0' }, { sceneId: '' }, { name: 'x'.repeat(61) }]) {
      await expect(s.api.saveScene({ ...input(), ...patch } as InterferenceSceneSave)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(s.request).not.toHaveBeenCalled();
  });

  it('查询参数在发送前拒绝错误数字、额外字段和缺少身份', async () => {
    const s = service(null);
    for (const patch of [{ page: '1' }, { page: 0 }, { pageSize: 101 }, { pageSize: NaN }, { taskId: '' }, { ids: [] }]) {
      await expect(s.api.listScenes({ taskId: 'T1', ...patch } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    await expect(s.api.listSceneVersions({ taskId: 'T1', sceneId: 'SC1', search: 'x' } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(s.api.getScene({ taskId: 'T1', sceneId: 'SC1', versionId: '' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).not.toHaveBeenCalled();
  });

  it('拒绝版本身份、干扰源选择、完整拓扑、来源状态的不一致', async () => {
    const mutations: ((dto: ReturnType<typeof detail>) => void)[] = [
      dto => { dto.version.task_id = 'other'; }, dto => { dto.version.version_id = 'other'; },
      dto => { dto.version.source_count = 0; }, dto => { dto.version.interference_ids.reverse(); },
      dto => { dto.version.interference_sources[0].source_row.interference_id = 'other'; },
      dto => { dto.version.plan_snapshot.resource_revision = 'other'; },
      dto => { dto.version.plan_snapshot.raw_snapshot.detail.links[0].device_a_id = 'missing'; },
      dto => { dto.version.plan_snapshot.raw_snapshot.detail.routes.routes[0].primary.link_path[0] = 'missing'; },
      dto => { dto.source_state.reasons = ['invalid-current-reason']; },
      dto => { dto.version.plan_snapshot.raw_snapshot = {} as never; },
    ];
    for (const mutate of mutations) {
      const dto = detail(); mutate(dto);
      await expect(service(dto).api.getScene({ taskId: 'T1', sceneId: 'SC1', versionId: 'ISV-1' }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('拒绝分页计数错配、任务错配和重复版本', async () => {
    const good = { items: [summary()], total: 1, page: 1, page_size: 20 };
    for (const patch of [{ total: 0 }, { total: -1 }, { page: 2 }, { page_size: 10 }, { total: '1' },
      { items: [{ ...summary(), task_id: 'other' }] }, { items: [summary(), summary()], total: 2 }]) {
      await expect(service({ ...good, ...patch }).api.listScenes({ taskId: 'T1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it.each([[1001, 'VALIDATION_ERROR'], [2001, 'NOT_FOUND'], [1203, 'VERSION_CONFLICT'],
    [1205, 'RESOURCE_VERSION_CHANGED'], [1206, 'REQUEST_CONFLICT']])('映射错误 %s 并保留追踪和 HTTP 状态', async (code, expected) => {
    const s = service(null);
    s.request.mockRejectedValue(new ApiError('明确失败', Number(code), null, 'trace', 409));
    await expect(s.api.saveScene(input())).rejects.toMatchObject({ code: expected, requestId: 'trace', status: 409 });
    expect(s.request).toHaveBeenCalledTimes(1);
  });

  it.each([1101, 1104, 1105, 1106, 5001, 5002, 5003])('保留身份/存储错误 %s，不掩盖失败', async code => {
    const s = service(null), error = new ApiError('拒绝', code, null, 'trace', 503);
    s.request.mockRejectedValue(error);
    await expect(s.api.listScenes({ taskId: 'T1' })).rejects.toBe(error);
  });

  it('复用公共包络校验，畸形包络和业务失败不能被当作成功', async () => {
    for (const payload of [{ data: receipt() }, { code: 0, message: 'ok' }, { code: 1206, message: '冲突', data: null }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const api = createInterferenceSceneHttp(createHttpClient('/api/v1', fetcher));
      await expect(api.saveScene(input())).rejects.toBeInstanceOf(ApiError);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
