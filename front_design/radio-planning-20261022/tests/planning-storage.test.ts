import { savedRequest,taskMeta } from './helpers/tasks';
import { describe, expect, it } from 'vitest';
import resources from '../src/mocks/resources.json';
import { planningPresets } from '../src/mocks/planning-presets';
import { getPresetResultDetails } from '../src/services/planning-result-details-mock';
import { planningAdjustmentExamples } from '../src/mocks/planning-adjustments';
import { bindPlanningAdjustmentExample } from '../src/services/planning-adjustment';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { initialMeta } from '../src/services/resource-storage';
import { PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import type { ResourcesData } from '../src/types/domain';
import { TestStorage } from './helpers/storage';

function setup() {
  const storage = new TestStorage();
  let time = 1000;
  const service = createPlanningMock(
    () => storage,
    () => ({ resources: resources as ResourcesData, meta: {...initialMeta(),taskWorkspace:taskMeta(storage)} }),
    () => time,
  );
  const request = () => ({
    baseRevision: 'initial',
    requestId: 'request',
    taskId: null,
    parentPlanVersionId: null,
    input: structuredClone(planningPresets[0].input),
  });
  return {
    storage,
    service,
    request,
    advance: () => {
      time += 10000;
    },
  };
}
describe('规划存储边界', () => {
  // 模拟升级前已有作业，验证加载不回填且保存/确认继续冻结旧内容。
  it('旧v1候选缺省与新v2同存，原存储和确认配置不会被候选改写', async () => {
    const s = setup(), first = await s.service.submitPlanning(await savedRequest(s.storage, s.request()));
    const raw = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    raw.jobs[0].resultDetails = getPresetResultDetails('balanced', raw.jobs[0].input, 'planning-result-details-demo-1');
    const bytes = JSON.stringify(raw); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes); const writes = s.storage.writes;
    expect((await s.service.loadPlanningWorkspace()).workspace.jobs[0].resultDetails).not.toHaveProperty('candidateScreening');
    expect(s.storage.writes).toBe(writes); expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes); s.advance();
    const old = await s.service.savePlanVersion({ baseRevision: raw.revision, jobId: first.view.job.id, requestId: 'old-save', name: '旧版', note: '' });
    expect(old.plan.resultDetails).not.toHaveProperty('candidateScreening');
    const next = await s.service.submitPlanning(await savedRequest(s.storage, { ...s.request(), taskId: old.plan.taskId, baseRevision: old.workspace.revision, requestId: 'new' })); s.advance();
    const saved = await s.service.savePlanVersion({ baseRevision: next.workspace.revision, jobId: next.view.job.id, requestId: 'new-save', name: '新版', note: '' });
    const confirmed = await s.service.confirmPlanVersion({ baseRevision: saved.workspace.revision, planId: saved.plan.id, requestId: 'confirm' });
    expect(confirmed.plan.resultDetails?.candidateScreening).toEqual(next.view.job.resultDetails?.candidateScreening);
    expect(confirmed.plan.workflow!.confirmation!.configuration).not.toHaveProperty('candidateScreening');
    const compared = await s.service.comparePlanVersions([old.plan.id, saved.plan.id]);
    expect(compared[0].resultDetails).not.toHaveProperty('candidateScreening'); expect(compared[1].resultDetails?.candidateScreening?.candidates).toHaveLength(4);
  });
  it.each(['source-snapshot', 'result-preset', 'missing-identity', 'missing-adjustment', 'changed-config', 'flow-mismatch', 'fake-adoption'])(
    '已提供调整字段损坏必须拒绝，不回退任务原结果：%s', async kind => {
      const s = setup(), first = await s.service.submitPlanning(await savedRequest(s.storage, s.request())); s.advance();
      const parent = await s.service.savePlanVersion({ baseRevision: first.workspace.revision, jobId: first.view.job.id, requestId: 'parent', name: '父方案', note: '' });
      const submitted = await s.service.submitPlanning({ baseRevision: parent.workspace.revision, requestId: 'adjust', taskId: parent.plan.taskId,
        parentPlanVersionId: parent.plan.id, input: structuredClone(parent.plan.workflow!.input), adjustment: bindPlanningAdjustmentExample(planningAdjustmentExamples[1], parent.plan) });
      s.advance(); await s.service.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id, requestId: 'adjust-save', name: '调整方案', note: '' });
      const before = s.storage.getItem(PLANNING_STORAGE_KEY), writes = s.storage.writes;
      const loaded = await s.service.loadPlanningWorkspace();
      expect(loaded.workspace.plans[1].workflow!.resultPresetId).toBe('economical');
      expect(s.storage.writes).toBe(writes); expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(before);
      const record = JSON.parse(before!);
      if (kind === 'source-snapshot') record.jobs[1].adjustment.sourceSnapshotId = 'other';
      if (kind === 'result-preset') record.jobs[1].resultPresetId = 'balanced';
      if (kind === 'missing-identity') delete record.jobs[1].resultPresetId;
      if (kind === 'missing-adjustment') delete record.jobs[1].adjustment;
      if (kind === 'changed-config') record.jobs[1].adjustment.manualOverrides[0].antennaHeightM = 20;
      if (kind === 'flow-mismatch') delete record.plans[1].workflow.adjustment;
      if (kind === 'fake-adoption') { delete record.jobs[1].adjustment; record.jobs[1].interferenceOrigin = {}; }
      const bytes = JSON.stringify(record); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
      await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
      expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
    },
  );
  it.each([1, 2])('schema %s 旧格式或缺失依赖拒绝，不补齐', async schema => {
    const s=setup(),first=await s.service.submitPlanning(await savedRequest(s.storage,s.request()));s.advance();
    await s.service.savePlanVersion({baseRevision:first.workspace.revision,jobId:first.view.job.id,requestId:'parent',name:'保存方案',note:''});
    const record=JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);record.schemaVersion=schema;
    if(schema===1)delete record.interference;
    delete record.jobs[0].dependencies.interferenceVersion;
    const bytes=JSON.stringify(record);s.storage.entries.set(PLANNING_STORAGE_KEY,bytes);const writes=s.storage.writes;
    await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({code:schema===1?'PLANNING_INCOMPATIBLE':'PLANNING_CORRUPT'});
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
  });
  it('加载不写入；提交仅写规划键，新实例能恢复', async () => {
    const s = setup();
    await s.service.loadPlanningWorkspace();
    expect(s.storage.writes).toBe(0);
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    expect(s.storage.writeHistory).toEqual([RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY]);
    const loaded = await createMockService(() => s.storage).loadPlanningWorkspace();
    expect(loaded.workspace.jobs[0]).toEqual(a.view.job);
  });
  it.each(['submit', 'save', 'confirm', 'reset'])(
    '%s 写入失败保留完整原记录',
    async (operation) => {
      const s = setup();
      let a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
      s.advance();
      if (operation === 'confirm') {
        const saved = await s.service.savePlanVersion({
          baseRevision: a.workspace.revision,
          jobId: a.view.job.id,
          requestId: 'save',
          name: '方案',
          note: '',
        });
        a = { ...a, workspace: saved.workspace };
      }
      const before = s.storage.getItem(PLANNING_STORAGE_KEY);
      s.storage.failWriteKeys.add(PLANNING_STORAGE_KEY);
      const actions = {
        submit: async () =>
          s.service.submitPlanning(await savedRequest(s.storage,{
            ...s.request(),
            requestId: 'new',
            baseRevision: a.workspace.revision,
          })),
        save: () =>
          s.service.savePlanVersion({
            baseRevision: a.workspace.revision,
            jobId: a.view.job.id,
            requestId: 'save',
            name: '方案',
            note: '',
          }),
        confirm: () =>
          s.service.confirmPlanVersion({
            baseRevision: a.workspace.revision,
            planId: a.workspace.plans[0].id,
            requestId: 'confirm',
          }),
        reset: () => s.service.resetPlanningWorkspace(a.workspace.revision),
      };
      await expect(actions[operation as keyof typeof actions]()).rejects.toMatchObject({
        code: 'PLANNING_WRITE_FAILED',
      });
      expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(before);
    },
  );
  it.each(['invalid-json', 'version', 'references', 'dependencies', 'result', 'confirmation'])(
    '损坏记录明确拒绝且不覆盖：%s',
    async (kind) => {
      const s = setup();
      const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
      s.advance();
      await s.service.savePlanVersion({
        baseRevision: a.workspace.revision,
        jobId: a.view.job.id,
        requestId: 'save',
        name: '方案',
        note: '',
      });
      const record = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
      if (kind === 'version') record.presetVersion = 'unknown';
      if (kind === 'references') record.plans[0].jobId = 'missing';
      if (kind === 'dependencies') record.jobs[0].dependencies.deviceVersions = {};
      if (kind === 'result') record.plans[0].metrics.connectivityPercent = 99;
      if (kind === 'confirmation')
        record.currentConfirmedByTask[record.plans[0].taskId] = record.plans[0].id;
      const text = kind === 'invalid-json' ? 'broken' : JSON.stringify(record);
      s.storage.entries.set(PLANNING_STORAGE_KEY, text);
      await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({
        code: kind === 'version' ? 'PLANNING_INCOMPATIBLE' : 'PLANNING_CORRUPT',
      });
      expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(text);
    },
  );
  it('查询读取失败不伪装任务 FAILED，规划损坏不阻塞资源', async () => {
    const s = setup();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.storage.failReadKeys.add(PLANNING_STORAGE_KEY);
    await expect(s.service.getPlanningJob(a.view.job.id)).rejects.toMatchObject({
      code: 'PLANNING_READ_FAILED',
    });
    expect((await createMockService(() => s.storage).loadPreview()).resources.stations.length).toBe(
      132,
    );
    s.storage.failReadKeys.clear();
    expect((await s.service.getPlanningJob(a.view.job.id)).state).toBe('PENDING');
  });
  it('旧规划版本拒绝写入；两种重置只改各自专用键', async () => {
    const s = setup();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.advance();
    await expect(
      s.service.savePlanVersion({
        baseRevision: 'initial',
        jobId: a.view.job.id,
        requestId: 'save',
        name: '方案',
        note: '',
      }),
    ).rejects.toMatchObject({ code: 'PLANNING_CONFLICT' });
    const resourcesService = createMockService(() => s.storage);
    const planningText = s.storage.getItem(PLANNING_STORAGE_KEY);
    await resourcesService.resetResources(null);
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(planningText);
    const resourceText = s.storage.getItem(RESOURCE_STORAGE_KEY);
    await s.service.resetPlanningWorkspace(a.workspace.revision);
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resourceText);
    expect((await s.service.loadPlanningWorkspace()).workspace.jobs).toEqual([]);
  });
  it('显式重置可恢复损坏键，读取权限失败仍拒绝', async () => {
    const s = setup();
    s.storage.entries.set(PLANNING_STORAGE_KEY, 'bad');
    await s.service.resetPlanningWorkspace(null);
    s.storage.failReadKeys.add(PLANNING_STORAGE_KEY);
    await expect(s.service.resetPlanningWorkspace(null)).rejects.toMatchObject({
      code: 'PLANNING_READ_FAILED',
    });
  });
});

describe('规划干扰依赖边界',()=>{
  it('缺少或非法干扰版本均拒绝，不补造 initial',async()=>{
    const s=setup();await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    const record=JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    expect(record.jobs[0].dependencies.interferenceVersion).toBe('initial');
    delete record.jobs[0].dependencies.interferenceVersion;
    const legacy=JSON.stringify(record);s.storage.entries.set(PLANNING_STORAGE_KEY,legacy);
    await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({code:'PLANNING_CORRUPT'});expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(legacy);
    record.jobs[0].dependencies.interferenceVersion=12;
    s.storage.entries.set(PLANNING_STORAGE_KEY,JSON.stringify(record));
    await expect(s.service.loadPlanningWorkspace()).rejects.toBeDefined();
  });
});

describe('规划补充明细冻结与旧存储兼容', () => {
  it('缺明细旧 Job 从存储恢复、完成、保存、确认均不回填，新任务可共存', async () => {
    const s = setup();
    const submitted = await s.service.submitPlanning(await savedRequest(s.storage, s.request()));
    // 构造升级前的持久化字节，再通过实际服务完成后续流程。
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    delete legacy.jobs[0].resultDetails;
    const bytes = JSON.stringify(legacy); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    const writes = s.storage.writes;
    const loaded = await s.service.loadPlanningWorkspace();
    expect(loaded.workspace.revision).toBe(legacy.revision);
    expect(loaded.workspace.jobs[0]).not.toHaveProperty('resultDetails');
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
    s.advance();
    expect((await s.service.getPlanningJob(submitted.view.job.id)).result).not.toHaveProperty('resultDetails');
    const saved = await s.service.savePlanVersion({ baseRevision: legacy.revision, jobId: submitted.view.job.id,
      requestId: 'legacy-save', name: '历史方案', note: '' });
    expect(saved.plan).not.toHaveProperty('resultDetails');
    const confirmed = await s.service.confirmPlanVersion({ baseRevision: saved.workspace.revision,
      planId: saved.plan.id, requestId: 'legacy-confirm' });
    expect(confirmed.plan).not.toHaveProperty('resultDetails');
    const next = await s.service.submitPlanning(await savedRequest(s.storage, { ...s.request(),
      requestId: 'new-submit', baseRevision: confirmed.workspace.revision }));
    expect(next.view.job.resultDetails).toBeDefined();
    const mixedBytes = s.storage.getItem(PLANNING_STORAGE_KEY), mixedWrites = s.storage.writes;
    const mixed = await s.service.loadPlanningWorkspace();
    expect(mixed.workspace.jobs[0]).not.toHaveProperty('resultDetails');
    expect(mixed.workspace.jobs[1].resultDetails).toEqual(next.view.job.resultDetails);
    expect(mixed.workspace.plans[0]).not.toHaveProperty('resultDetails');
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(mixedBytes); expect(s.storage.writes).toBe(mixedWrites);
  });
  it.each(['null', 'unknown-asset', 'value', 'job-plan', 'plan-missing'] as const)('拒绝已提供但被改写的明细：%s', async kind => {
    const s = setup(), submitted = await s.service.submitPlanning(await savedRequest(s.storage, s.request()));
    s.advance();
    await s.service.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id,
      requestId: 'save-details', name: '冻结明细', note: '' });
    const record = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    if (kind === 'null') record.jobs[0].resultDetails = null;
    if (kind === 'unknown-asset') record.jobs[0].resultDetails.assetVersion = 'unknown';
    if (kind === 'value') record.jobs[0].resultDetails.deviceParameters[0].tiltDeg = 0;
    if (kind === 'job-plan') record.plans[0].resultDetails.deviceParameters[0].tiltEffective = true;
    if (kind === 'plan-missing') delete record.plans[0].resultDetails;
    const bytes = JSON.stringify(record); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    const writes = s.storage.writes;
    await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
  });
});
