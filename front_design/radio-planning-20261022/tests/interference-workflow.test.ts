import { describe, expect, it } from 'vitest';
import { interferenceFixture } from './helpers/interference';
import { PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { createInterferenceMock } from '../src/services/interference-mock';
import { interferenceVariants } from '../src/mocks/interference-presets';

describe('干扰分析与采纳流程', () => {
  it('提交冻结输入、区分身份、刷新恢复，地图无需触发计算', async () => {
    const s = await interferenceFixture(), request = await s.request(), first = await s.service.submitInterferenceAnalysis(request);
    expect(first.view.state).toBe('PENDING');
    expect(first.view.measurePreviews).toEqual([]);
    expect(new Set([first.view.run.analysisId, first.view.run.jobId, s.plan.id, s.plan.snapshotId]).size).toBe(4);
    expect((await s.service.submitInterferenceAnalysis(request)).view.run.analysisId).toBe(first.view.run.analysisId);
    await expect(s.service.submitInterferenceAnalysis({...request,scenarioId:'failed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    s.advance(1700); expect(await s.service.getInterferenceAnalysis(first.view.run.analysisId)).toMatchObject({state:'RUNNING',measurePreviews:[]});
    const restored = createInterferenceMock(() => s.storage, s.resource.read, () => Date.parse('2026-10-06T00:00:00Z'));
    const before = s.storage.writes, next = await restored.getInterferenceAnalysis(first.view.run.analysisId);
    expect(next.state).toBe('SUCCESS'); expect(next.run).toEqual(first.view.run); expect(s.storage.writes).toBe(before);
    expect(next.measurePreviews).toHaveLength(next.result!.measures.length);
    expect(next.measurePreviews!.every(row=>row.result && !row.unavailableReason && !('snapshotId' in row.result))).toBe(true);
    expect(JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!).interference.runs[0]).not.toHaveProperty('measurePreviews');
  });
  it('服务预览独立于预设和旧记录，后续查询及采纳保持完整快照一致',async()=>{
    const s=await interferenceFixture(),run=await s.submit();s.advance();
    const before=s.storage.getItem(PLANNING_STORAGE_KEY),writes=s.storage.writes;
    const view=await s.service.getInterferenceAnalysis(run.view.run.analysisId);
    const preview=view.measurePreviews!.find(row=>row.measureId==='FREQ_ADJUST')!.result!;
    const expected=structuredClone(preview);
    preview.configuration.devices[0].frequencyKhz=12345;
    preview.inputSnapshot.stations[0].coordinate=[0,0];preview.notes.push('外部改动');
    const restored=(await s.service.loadInterferenceWorkspace()).views[0];
    expect(restored.measurePreviews!.find(row=>row.measureId==='FREQ_ADJUST')!.result).toEqual(expected);
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(before);expect(s.storage.writes).toBe(writes);
    const adopted=await s.adopt(run.view.run.analysisId);
    for(const field of ['inputSnapshot','links','regions','metrics','notes','resultDetails'] as const)expect(adopted.plan[field]).toEqual(expected[field]);
    for(const field of ['configuration','checks','deploymentCost','costUnit'] as const)expect(adopted.plan.workflow![field]).toEqual(expected[field]);
  });
  it('采纳单项一次写入方案与回执，原资源、输入和当前确认指针不变', async () => {
    const s = await interferenceFixture(), run = await s.submit(); s.advance();
    const resourceBytes = s.storage.getItem(RESOURCE_STORAGE_KEY), before = s.storage.writes;
    const adopted = await s.adopt(run.view.run.analysisId);
    expect(s.storage.writes - before).toBe(1);
    expect(s.storage.writeHistory.at(-1)).toBe(PLANNING_STORAGE_KEY);
    expect(adopted.plan).toMatchObject({state:'SAVED',jobId:null,taskId:s.plan.taskId,inputSnapshot:s.plan.inputSnapshot});
    expect(adopted.plan.workflow!.input).toEqual(s.plan.workflow!.input);
    expect(adopted.workspace.currentConfirmedByTask[s.plan.taskId]).toBe(s.plan.id);
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resourceBytes);
    expect(adopted.plan.workflow!.confirmation).toBeNull();
    const confirmed = await s.confirm(adopted.plan.id);
    expect(confirmed.workspace.currentConfirmedByTask[s.plan.taskId]).toBe(adopted.plan.id);
    expect(confirmed.workspace.plans.find(row => row.id === s.plan.id)!.state).toBe('CONFIRMED');
  });
  it('同分析同措施换请求标识仍返回原版本；不同措施各自派生，不能复用标识', async () => {
    const s = await interferenceFixture(), run = await s.submit(); s.advance();
    const first = await s.adopt(run.view.run.analysisId,'FREQ_ADJUST','first');
    const repeated = await s.adopt(run.view.run.analysisId,'FREQ_ADJUST','repeat');
    expect(repeated.changed).toBe(false); expect(repeated.plan.id).toBe(first.plan.id); expect(repeated.workspace.plans).toHaveLength(2);
    await expect(s.adopt(run.view.run.analysisId,'POWER_OPT','repeat')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    const other = await s.adopt(run.view.run.analysisId,'POWER_OPT');
    expect(other.plan.id).not.toBe(first.plan.id); expect(other.plan.workflow!.parentPlanVersionId).toBe(s.plan.id);
    expect(other.plan.workflow!.configuration.devices.find(row=>row.deviceId==='DV-0002')!.frequencyKhz).toBe(8000);
    await s.confirm(first.plan.id);
    expect((await s.adopt(run.view.run.analysisId,'FREQ_ADJUST','first')).plan.id).toBe(first.plan.id);
    await expect(s.adopt(run.view.run.analysisId,'NODE_REDEPLOY')).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  });
  it('仅干扰变化可重分析，增强参数必须精确匹配且不隐式保存资源', async () => {
    const s = await interferenceFixture();
    await s.resource.commit({baseRevision:s.resource.read().meta.revision,stations:[],devices:[],interferences:[{id:'IF-0008',txPowerDbm:47.9}]});
    expect((await s.service.loadInterferenceSources()).plans.find(row=>row.plan.id===s.plan.id)).toMatchObject({eligible:true,interferenceOnly:true,plan:{sourceChanged:true}});
    expect((await s.service.loadInterferenceWorkspace()).workspace.plans.find(row=>row.id===s.plan.id)!.sourceChanged).toBe(true);
    await expect(s.submit()).rejects.toMatchObject({code:'NO_PRESET'});
    const run = await s.submit('enhanced'); s.advance();
    expect((await s.adopt(run.view.run.analysisId)).plan.workflow!.dependencies.interferenceVersion).toBe(s.resource.read().meta.interferenceVersion);
    await s.resource.commit({baseRevision:s.resource.read().meta.revision,stations:[{id:'ND-0001',name:'相关站点已改'}],devices:[]});
    await expect(s.submit('enhanced')).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  });
  it('运行中源变化保留冻结结果且禁止新采纳；资源无法读取显示未知', async () => {
    const s = await interferenceFixture(), run = await s.submit(); s.advance();
    await s.resource.commit({baseRevision:s.resource.read().meta.revision,stations:[],devices:[],interferences:[{id:'IF-0008',txPowerDbm:47.9}]});
    const view = await s.service.getInterferenceAnalysis(run.view.run.analysisId);
    expect(view.state).toBe('SUCCESS'); expect(view.source.state).toBe('HISTORICAL'); expect(view.run).toEqual(run.view.run);
    expect(view.measurePreviews!.some(row=>row.result)).toBe(true);
    await expect(s.adopt(run.view.run.analysisId)).rejects.toMatchObject({code:'SOURCE_CHANGED'});
    s.storage.failReadKeys.add(RESOURCE_STORAGE_KEY);
    const unknown=await s.service.getInterferenceAnalysis(run.view.run.analysisId);
    expect(unknown.source.state).toBe('UNKNOWN');expect(unknown.measurePreviews).toEqual(view.measurePreviews);
    expect((await s.service.loadInterferenceWorkspace()).views).toHaveLength(1);
  });
  it.each(['unaffected','unavailable','failed'] as const)('%s 不伪造可采纳措施', async scenario => {
    const s = await interferenceFixture(), run = await s.submit(scenario); s.advance();
    const view = await s.service.getInterferenceAnalysis(run.view.run.analysisId);
    expect(view.state).toBe(scenario==='failed'?'FAILED':'SUCCESS');
    expect(view.run.measureResultDetails).toEqual([]);
    if(scenario==='unaffected')expect(view.result!.impact.summary.affectedNodeCount).toBe(0);
    if(scenario!=='failed')expect(view.result!.measures.every(row=>row.unavailableReason&&row.variantId===null)).toBe(true);
    expect(view.measurePreviews!.every(row=>row.result===null&&!!row.unavailableReason)).toBe(true);
    if(scenario==='failed')expect(view.measurePreviews).toEqual([]);
    await expect(s.adopt(run.view.run.analysisId)).rejects.toMatchObject({code:scenario==='failed'?'NO_RESULT':'MEASURE_UNAVAILABLE'});
  });
  it('取消失败保留运行，成功取消刷新后不会产生结果', async () => {
    const s = await interferenceFixture(), run = await s.submit(); s.advance(1600);
    const request={baseRevision:run.workspace.revision,analysisId:run.view.run.analysisId};
    s.storage.failWrite=true; await expect(s.service.cancelInterferenceAnalysis(request)).rejects.toMatchObject({code:'PLANNING_WRITE_FAILED'});
    s.storage.failWrite=false; expect((await s.service.getInterferenceAnalysis(request.analysisId)).state).toBe('RUNNING');
    await s.service.cancelInterferenceAnalysis(request);s.advance();
    expect((await s.service.getInterferenceAnalysis(request.analysisId))).toMatchObject({state:'CANCELLED',result:null,measurePreviews:[]});
  });
});

describe('措施补充明细冻结', () => {
  it.each(interferenceVariants.map(variant => [variant.id, variant.networkPresetId, variant.type] as const))(
    '%s 提交、预览、采纳、确认和重试读取同一独立版本', async (_id, presetId, measureId) => {
      const s = await interferenceFixture(presetId), submitted = await s.submit();
      const entry = submitted.view.run.measureResultDetails!.find(row => row.measureId === measureId)!;
      expect(entry.resultDetails).toBeDefined();
      const expected = structuredClone(entry.resultDetails);
      s.advance();
      const viewed = await s.service.getInterferenceAnalysis(submitted.view.run.analysisId);
      const preview = viewed.measurePreviews!.find(row => row.measureId === measureId)!.result!;
      expect(preview.resultDetails).toEqual(expected);
      // 返回副本被外部改动不能污染 Run 或后续采纳。
      preview.resultDetails!.assetVersion = 'caller-changed';
      const adopted = await s.adopt(submitted.view.run.analysisId, measureId, 'first-details');
      expect(adopted.plan.resultDetails).toEqual(expected);
      const confirmed = await s.confirm(adopted.plan.id);
      expect(confirmed.plan.resultDetails).toEqual(expected);
      const repeat = await s.adopt(submitted.view.run.analysisId, measureId, 'first-details');
      expect(repeat.plan.resultDetails).toEqual(expected); expect(repeat.plan.id).toBe(adopted.plan.id);
    },
  );
  it('新分析可基于无明细旧父方案，仅措施后结果具有新明细', async () => {
    const s = await interferenceFixture();
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    for (const job of legacy.jobs) delete job.resultDetails;
    for (const plan of legacy.plans) delete plan.resultDetails;
    s.storage.entries.set(PLANNING_STORAGE_KEY, JSON.stringify(legacy));
    const submitted = await s.submit();
    expect(submitted.view.run.network).not.toHaveProperty('resultDetails');
    expect(submitted.view.run.measureResultDetails).toHaveLength(5);
    s.advance();
    const adopted = await s.adopt(submitted.view.run.analysisId);
    expect(adopted.plan.resultDetails).toBeDefined();
    expect(adopted.workspace.plans.find(plan => plan.id === s.plan.id)).not.toHaveProperty('resultDetails');
  });
  it('无明细旧 Run 恢复后仍完整预览并可采纳，明细持续缺省', async () => {
    const s = await interferenceFixture(), submitted = await s.submit();
    const legacy = JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!);
    delete legacy.interference.runs[0].measureResultDetails;
    const bytes = JSON.stringify(legacy); s.storage.entries.set(PLANNING_STORAGE_KEY, bytes);
    const writes = s.storage.writes; s.advance();
    const view = await s.service.getInterferenceAnalysis(submitted.view.run.analysisId);
    expect(view.measurePreviews).toHaveLength(5);
    expect(view.measurePreviews!.every(row => row.result && !('resultDetails' in row.result))).toBe(true);
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
    const adopted = await s.adopt(submitted.view.run.analysisId);
    expect(adopted.plan).not.toHaveProperty('resultDetails');
    expect((await s.confirm(adopted.plan.id)).plan).not.toHaveProperty('resultDetails');
  });
});
