import { describe, expect, it } from 'vitest';
import { interferenceFixture } from './helpers/interference';
import { PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { readPlanning } from '../src/services/planning-storage';
import { planningPresets } from '../src/mocks/planning-presets';

describe('规划 v2 内嵌分析存储', () => {
  it('旧 v1 拒绝，读取和提交都不迁移写回', async () => {
    const s=await interferenceFixture(),record=JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    record.schemaVersion=1;delete record.interference;
    const bytes=JSON.stringify(record);s.storage.entries.set(PLANNING_STORAGE_KEY,bytes);const count=s.storage.writes;
    expect(()=>readPlanning(s.storage,planningPresets)).toThrow('版本不兼容');
    await expect(s.submit()).rejects.toBeDefined();
    expect(s.storage.writes).toBe(count);expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
  });
  it.each(['submit','adopt','repeat-receipt'] as const)('%s 写入失败时原字节不变、没有半条方案', async operation => {
    const s=await interferenceFixture();let analysisId='';
    if(operation!=='submit'){const run=await s.submit();analysisId=run.view.run.analysisId;s.advance();}
    if(operation==='repeat-receipt')await s.adopt(analysisId);
    const request=await s.request(), bytes=s.storage.getItem(PLANNING_STORAGE_KEY), resources=s.storage.getItem(RESOURCE_STORAGE_KEY);
    s.storage.failWriteKeys.add(PLANNING_STORAGE_KEY);
    await expect(operation==='submit'?s.service.submitInterferenceAnalysis(request):s.service.adoptInterferenceMeasure({
      baseRevision:JSON.parse(bytes!).revision,analysisId,measureId:'FREQ_ADJUST',requestId:'failed-write',
    })).rejects.toMatchObject({code:'PLANNING_WRITE_FAILED'});
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resources);
  });
  it.each(['result','source','parent','receipt','configuration','coordinate','confirmation'] as const)('损坏 %s 明确拒绝并保留原记录', async field => {
    const s=await interferenceFixture(),run=await s.submit();s.advance();const adopted=await s.adopt(run.view.run.analysisId,'NODE_REDEPLOY');
    const record=JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    const plan=record.plans.find((p:{id:string})=>p.id===adopted.plan.id);
    if(field==='result')record.interference.runs[0].result.impact.summary.affectedNodeCount=999;
    if(field==='source')record.interference.runs[0].sources[0].txPowerDbm=999;
    if(field==='parent')record.interference.runs[0].network.snapshotId='foreign';
    if(field==='receipt')record.interference.receipts[0].planId='missing';
    if(field==='configuration')plan.workflow.configuration.devices[0].frequencyKhz=99999;
    if(field==='coordinate')plan.workflow.configuration.deployment[2].plannedCoordinate=[190,100];
    if(field==='confirmation')record.currentConfirmedByTask[plan.taskId]=plan.id;
    const bytes=JSON.stringify(record);s.storage.entries.set(PLANNING_STORAGE_KEY,bytes);
    await expect(s.service.loadInterferenceWorkspace()).rejects.toMatchObject({code:'PLANNING_CORRUPT'});
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
  });
  it('版本冲突拒绝采纳；资源重置保留分析，规划重置清空分析但保留任务库', async () => {
    const s=await interferenceFixture(),run=await s.submit();s.advance();
    await expect(s.service.adoptInterferenceMeasure({baseRevision:'initial',requestId:'old',analysisId:run.view.run.analysisId,measureId:'FREQ_ADJUST'})).rejects.toMatchObject({code:'PLANNING_CONFLICT'});
    const bytes=s.storage.getItem(PLANNING_STORAGE_KEY);s.resource.reset(s.resource.read().meta.revision);
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);
    expect((await s.service.getInterferenceAnalysis(run.view.run.analysisId)).source.state).toBe('HISTORICAL');
    const resourceBytes=s.storage.getItem(RESOURCE_STORAGE_KEY);
    await s.planning.resetPlanningWorkspace(run.workspace.revision);
    expect((await s.service.loadInterferenceWorkspace()).workspace.interference).toEqual({runs:[],receipts:[]});
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resourceBytes);expect(s.resource.read().meta.taskWorkspace!.tasks).toHaveLength(1);
  });
});

describe('分析明细的持久化一致性', () => {
  it.each(['null', 'missing', 'extra', 'duplicate', 'wrong-measure', 'wrong-variant', 'asset', 'adopted-missing', 'legacy-run-new-plan'] as const)(
    '明确拒绝损坏的 %s，保留原字节与 revision', async kind => {
      const s = await interferenceFixture(), submitted = await s.submit(); s.advance();
      const adopted = await s.adopt(submitted.view.run.analysisId);
      const record = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
      const run = record.interference.runs[0], rows = run.measureResultDetails;
      const plan = record.plans.find((row: { id: string }) => row.id === adopted.plan.id);
      if (kind === 'null') run.measureResultDetails = null;
      if (kind === 'missing') rows.pop();
      if (kind === 'extra') rows.push({ ...rows[0], measureId: 'UNKNOWN' });
      if (kind === 'duplicate') rows[1] = structuredClone(rows[0]);
      if (kind === 'wrong-measure') rows[0].measureId = 'UNKNOWN';
      if (kind === 'wrong-variant') rows[0].resultDetails = structuredClone(rows[1].resultDetails);
      if (kind === 'asset') rows[0].resultDetails.assetVersion = 'missing-version';
      if (kind === 'adopted-missing') delete plan.resultDetails;
      if (kind === 'legacy-run-new-plan') delete run.measureResultDetails;
      const bytes = JSON.stringify(record); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
      const writes = s.storage.writes;
      await expect(s.service.loadInterferenceWorkspace()).rejects.toMatchObject({ code: 'PLANNING_CORRUPT' });
      expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
    },
  );
});
