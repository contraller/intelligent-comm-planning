import { describe, expect, it, vi } from 'vitest';
import { allPermissions, permissions } from '../src/config/permissions';
import { collaborationHttp, httpService } from '../src/services/http';
import { createAuthHttp } from '../src/services/auth-http';
import { createPlanningHttp } from '../src/services/planning-http';
import { createTaskHttp } from '../src/services/task-http';
import { createGisPlanHttp } from '../src/services/gis-plan-http';
import { createInterferenceSceneHttp } from '../src/services/interference-scene-http';
import { createFrequencyResourceHttp } from '../src/services/frequency-resource-http';
import { createDeviceConfigurationHttp } from '../src/services/device-configuration-http';
import { createObservationHttp } from '../src/services/observation-http';

describe('总集成独立工厂入口', () => {
  it('频点停用保留专项权限及只读前置条件', () => {
    expect(allPermissions).toContain('resources.frequency.disable');
    expect(permissions.find(p => p.code === 'resources.frequency.disable')?.requires).toEqual(['resources.view']);
  });

  it('共享已认证实例不冒充旧页面已接通', () => {
    expect(Object.isFrozen(collaborationHttp)).toBe(true);
    expect(typeof collaborationHttp.gisPlans.getNetwork).toBe('function');
    expect(typeof collaborationHttp.interferenceScenes.saveScene).toBe('function');
    expect(typeof collaborationHttp.frequencies.disableFrequencyResources).toBe('function');
    expect(typeof collaborationHttp.deviceConfigurations.submitRequest).toBe('function');
    expect(typeof collaborationHttp.observations.getObservationFrame).toBe('function');
  });

  it('未改造的旧配置页面入口仍拒绝，不返回虚构成功', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(httpService.getDeviceConfigurationProgress({ context: 'ledger', requestId: 'not-a-real-request' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
});

const liveUrl = process.env.COLLABORATION_URL;
const reopenPlanId = process.env.COLLABORATION_REOPEN_PLAN_ID;
describe.skipIf(!liveUrl)('INT-A 独立库真实 HTTP', () => {
  it.skipIf(!!reopenPlanId)('真实 SR4 后读取冻结网络和场景，再验证配置受理与频点版本变更', async () => {
    const base = new URL(liveUrl!);
    if (base.hostname !== '127.0.0.18' || !['5318', '8118'].includes(base.port)
      || process.env.COLLABORATION_ISOLATED !== '1') throw new Error('只允许显式 INT-A 隔离服务');
    let cookie = '';
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(new URL(input instanceof Request ? input.url : String(input), base), { ...init, headers });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    };
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher, timeoutMs: 30000 });
    const request = auth.authenticatedRequest;
    const planning = createPlanningHttp(request, () => '/api/v1');
    const tasks = createTaskHttp(request);
    const gis = createGisPlanHttp(request);
    const scenes = createInterferenceSceneHttp(request);
    const frequencies = createFrequencyResourceHttp(request);
    const configurations = createDeviceConfigurationHttp(request);
    const observations = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request });
    const source = await request<{ revision: string }>('/resource/context');
    const revision = source.revision;
    const catalog = await planning.loadPlanningCatalog({ context: 'planning' });
    const input = structuredClone(catalog.presets[0]!.defaults);
    const taskId = 'integration-' + crypto.randomUUID();
    input.name = '总集成构造验证-' + taskId.slice(-8);
    input.description = '非生产、非实测；真实算法 HTTP 联调，保留全部记录。';
    const task = await tasks.saveTaskInput({ context: 'planning', taskId, revision: null,
      resourceRevision: revision, input, requestId: crypto.randomUUID() });
    let job = await planning.submitPlanningTask({ context: 'planning', taskId, revision: task.revision,
      inputVersion: task.inputVersion, conditionVersion: task.conditionVersion, resourceRevision: revision,
      parentPlanId: null, requestId: crypto.randomUUID() });
    const started = Date.now();
    while (['PENDING', 'RUNNING'].includes(job.state) && Date.now() - started < 300000) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await planning.getPlanningTask({ context: 'planning', taskId, jobId: job.id });
    }
    expect(job.state, job.error ?? '算法未完成').toBe('SUCCESS');
    expect(job.outcome?.code, '不放宽构造预设硬约束').toBe(0);
    const saved = await planning.savePlanningPlan({ context: 'planning', taskId, jobId: job.id,
      revision: task.revision, name: input.name, note: input.description, requestId: crypto.randomUUID() });
    const plan = await planning.confirmPlanningPlan({ context: 'planning', taskId, planId: saved.id,
      revision: saved.revision, requestId: crypto.randomUUID() });
    const query = { planId: plan.id, taskId };
    const network = await gis.getNetwork(query);
    expect(network.nodes.length).toBe(job.result!.nodes.length);
    expect(network.links.length).toBe(job.result!.links.length);
    const snapshotId = network.identity.snapshot_id;
    const link = await gis.getLink({ ...query, snapshotId, linkId: network.links[0]!.id }, network);
    expect(link.observation.state).toBe('missing');
    const paths = await gis.getPaths({ ...query, snapshotId }, network);
    expect(paths.routes.length).toBeGreaterThan(0);
    await expect(gis.getNetwork({ ...query, snapshotId: 'wrong-snapshot' })).rejects.toMatchObject({ code: 1203, status: 409 });
    const sceneRequest = { sceneId: 'scene-' + crypto.randomUUID(), requestId: crypto.randomUUID(),
      taskId, planId: plan.id, planVersion: plan.version, resourceRevision: revision,
      baseSceneVersionId: null, name: '构造干扰场景', note: '非实测；只验证保存，不宣称完成分析', interferenceIds: [] };
    const scene = await scenes.saveScene(sceneRequest);
    expect(await scenes.saveScene(sceneRequest)).toEqual(scene);
    const detail = await scenes.getScene({ taskId, sceneId: sceneRequest.sceneId, versionId: scene.versionId });
    expect(detail.version.planId).toBe(plan.id);
    const editor = await auth.switchIntegrationIdentity('integration-editor');
    expect(editor.permissions).toContain('resources.frequency.disable');
    const context = await configurations.loadContext({ context: 'ledger', revision, device_id: 'DV-0001' });
    const configurationRequest = { context: 'ledger' as const, schema_version: 'device-configuration-a1' as const,
      base_revision: revision, device_id: 'DV-0001', model_id: context.model.model_id,
      request_id: 'configuration-' + crypto.randomUUID(),
      values: { tx_power_dbm: context.model.tx_power_max_dbm, work_freq_khz: context.model.freq_min_khz } };
    const accepted = await configurations.submitRequest(configurationRequest);
    expect(accepted.dispatch_status).toBe('NOT_DISPATCHED');
    expect(accepted.device_execution_status).toBe('UNKNOWN');
    expect(accepted.applied_values).toBeNull();
    expect(await configurations.submitRequest(configurationRequest)).toEqual(accepted);
    expect(await configurations.getRequest({ context: 'ledger', request_id: configurationRequest.request_id })).toEqual(accepted);
    const empty = await observations.loadObservationContext();
    expect(empty.datasetCount).toBe(0);
    expect(empty.selected).toBeNull();
    const pool = await frequencies.loadFrequencyResources({ context: 'ledger', revision });
    const frequencyId = pool.items.find(row => row.isAvailable)!.freqId;
    const preview = await frequencies.validateFrequencyDisable({ context: 'ledger', revision, ids: [frequencyId] });
    expect(preview.wouldDisable).toEqual([frequencyId]);
    const disable = { context: 'ledger' as const, baseRevision: revision,
      requestId: crypto.randomUUID(), ids: [frequencyId] };
    const changed = await frequencies.disableFrequencyResources(disable);
    expect(changed.changed).toBe(true);
    expect(await frequencies.disableFrequencyResources(disable)).toEqual(changed);
    await expect(frequencies.loadFrequencyResources({ context: 'ledger', revision })).rejects.toMatchObject({ code: 1205, status: 409 });
    expect((await gis.getNetwork(query)).identity.source_changed).toBe(true);
    const history = await scenes.getScene({ taskId, sceneId: sceneRequest.sceneId, versionId: scene.versionId });
    expect(history.version).toEqual(detail.version);
    console.info('COLLABORATION_RESULT', JSON.stringify({ taskId, jobId: job.id, planId: plan.id,
      nodes: network.nodes.length, links: network.links.length, routes: paths.routes.length,
      sceneId: scene.sceneId, versionId: scene.versionId, configurationId: accepted.configuration_id,
      fromRevision: revision, toRevision: changed.revision, frequencyId }));
  }, 420000);

  it.skipIf(!reopenPlanId)('重启后回读原任务和模块冻结结果，不重新运行算法', async () => {
    const base = new URL(liveUrl!);
    if (base.hostname !== '127.0.0.18' || !['5318', '8118'].includes(base.port)
      || process.env.COLLABORATION_ISOLATED !== '1') throw new Error('只允许显式 INT-A 隔离服务');
    let cookie = '';
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('Cookie', cookie);
      const response = await fetch(new URL(input instanceof Request ? input.url : String(input), base), { ...init, headers });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    };
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher, timeoutMs: 30000 });
    const taskId = process.env.COLLABORATION_REOPEN_TASK_ID!;
    const jobId = process.env.COLLABORATION_REOPEN_JOB_ID!;
    const sceneId = process.env.COLLABORATION_REOPEN_SCENE_ID!;
    const requestId = process.env.COLLABORATION_REOPEN_CONFIGURATION_REQUEST_ID!;
    if (![taskId, jobId, sceneId, requestId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('缺少本轮回读标识');
    const request = auth.authenticatedRequest;
    const planning = createPlanningHttp(request, () => '/api/v1');
    const job = await planning.getPlanningTask({ context: 'planning', taskId, jobId });
    expect(job.state).toBe('SUCCESS');
    expect(job.result?.links.length).toBeGreaterThan(0);
    const gis = await createGisPlanHttp(request).getNetwork({ taskId, planId: reopenPlanId! });
    expect(gis.identity.source_changed).toBe(true);
    const scene = await createInterferenceSceneHttp(request).getScene({ taskId, sceneId });
    expect(scene.version.planId).toBe(reopenPlanId);
    await auth.switchIntegrationIdentity('integration-editor');
    const receipt = await createDeviceConfigurationHttp(request).getRequest({ context: 'ledger', request_id: requestId });
    expect(receipt.dispatch_status).toBe('NOT_DISPATCHED');
    expect(receipt.online).toBeNull();
    console.info('COLLABORATION_REOPEN_RESULT', JSON.stringify({ taskId, jobId, planId: reopenPlanId,
      nodes: gis.nodes.length, links: gis.links.length, sceneVersion: scene.version.versionId,
      configurationId: receipt.configuration_id, sourceChanged: gis.identity.source_changed }));
  }, 60000);
});
