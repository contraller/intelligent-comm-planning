import { describe, expect, it } from 'vitest';
import { TestStorage } from './helpers/storage';
import { emptyDiagnosisWorkspace, readDiagnosis, writeDiagnosis } from '../src/services/diagnosis-storage';
import { createDiagnosisMock } from '../src/services/diagnosis-mock';
import { initialMeta } from '../src/services/resource-storage';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import resources from '../src/mocks/resources.json';
import type { ResourcesData } from '../src/types/domain';
import { interferenceFixture } from './helpers/interference';
import { networkDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { bindDiagnosisResult } from '../src/services/diagnosis-validation';
import { diagnosisDemoResult } from '../src/mocks/diagnosis-presets';

// 存储故障必须可辨认，不能清空坏记录并伪装初始成功。
describe('诊断存储与重置边界', () => {
  const setup = () => { const storage = new TestStorage(); const service = createDiagnosisMock(() => storage,() => ({resources:resources as ResourcesData,meta:initialMeta()})); return {storage,service}; };
  it('空工作区读取不写盘，合法空记录往返保留 revision', () => {
    const s = setup(); expect(readDiagnosis(s.storage)).toEqual(emptyDiagnosisWorkspace()); expect(s.storage.writes).toBe(0);
    const record = {...emptyDiagnosisWorkspace(),revision:'saved'}; writeDiagnosis(s.storage,record); expect(readDiagnosis(s.storage)).toEqual(record);
  });
  it.each(['{bad',JSON.stringify({...emptyDiagnosisWorkspace(),schemaVersion:99}),JSON.stringify({...emptyDiagnosisWorkspace(),scenarios:[{id:'broken'}]})])('损坏或不兼容记录保留，历史目录可用：%s', async (raw) => {
    const s = setup(); s.storage.entries.set(DIAGNOSIS_STORAGE_KEY,raw);
    const loaded = await s.service.loadDiagnosisWorkspace(); expect(loaded.workspace).toBeNull(); expect(loaded.error).toBeTruthy(); expect(loaded.legacy).toHaveLength(4); expect(s.storage.entries.get(DIAGNOSIS_STORAGE_KEY)).toBe(raw);
    expect((await s.service.getDiagnosisReport('DG-HW')).legacy).toBe(true);
  });
  it('读取拒绝明确失败，不回退到内存工作区', () => {
    const s = setup(); s.storage.failRead = true; expect(() => readDiagnosis(s.storage)).toThrow('无法读取诊断存储'); expect(s.storage.writes).toBe(0);
  });
  it('显式重置只改诊断键，写入失败保留坏记录', async () => {
    const s = setup(); s.storage.entries.set(DIAGNOSIS_STORAGE_KEY,'{bad'); s.storage.entries.set(PLANNING_STORAGE_KEY,'planning-marker'); s.storage.entries.set(RESOURCE_STORAGE_KEY,'resource-marker');
    s.storage.failWrite = true; await expect(s.service.resetDiagnosisWorkspace(null)).rejects.toMatchObject({code:'DIAGNOSIS_WRITE_FAILED'}); expect(s.storage.entries.get(DIAGNOSIS_STORAGE_KEY)).toBe('{bad');
    s.storage.failWrite = false; const restored = await s.service.resetDiagnosisWorkspace(null); expect(restored.workspace!.runs).toEqual([]);
    expect(s.storage.entries.get(PLANNING_STORAGE_KEY)).toBe('planning-marker'); expect(s.storage.entries.get(RESOURCE_STORAGE_KEY)).toBe('resource-marker'); expect(s.storage.writeHistory.every(key => key === DIAGNOSIS_STORAGE_KEY)).toBe(true);
  });
  it('正常记录重置需要匹配 revision', async () => {
    const s = setup(); writeDiagnosis(s.storage,{...emptyDiagnosisWorkspace(),revision:'newer'});
    await expect(s.service.resetDiagnosisWorkspace('older')).rejects.toMatchObject({code:'DIAGNOSIS_CONFLICT'}); expect(readDiagnosis(s.storage).revision).toBe('newer');
  });
});

// 沿真实保存、确认和诊断链路准备独立历史，测试不依赖当前规划库继续存在。
async function frozenDiagnosis(adopted: boolean) {
  const s = await interferenceFixture();
  let plan = s.plan;
  if (adopted) {
    const analysis = await s.submit(); s.advance();
    const version = await s.adopt(analysis.view.run.analysisId);
    plan = (await s.confirm(version.plan.id)).plan;
  }
  const preset = networkDiagnosisPresets(plan)[0];
  const saved = await s.diagnosis.saveDiagnosisScenario({ baseRevision: 'initial', requestId: 'detail-scenario', scenarioId: null,
    draft: { name: '冻结明细诊断', description: '', planId: plan.id, faults: structuredClone(preset.faults) } });
  const submitted = await s.diagnosis.submitDiagnosis({ baseRevision: saved.revision, requestId: 'detail-diagnosis',
    scenarioVersionId: saved.scenarios[0].versions[0].id, demo: 'normal' });
  s.advance();
  const workspace = await s.planning.loadPlanningWorkspace();
  await s.planning.resetPlanningWorkspace(workspace.workspace.revision);
  return { ...s, plan, runId: submitted.view.run.id };
}
describe('诊断补充明细随历史独立冻结', () => {
  it('旧诊断预设拒绝且不覆盖，现行结构的内置历史仍可查看', async () => {
    const s=await interferenceFixture(),preset=networkDiagnosisPresets(s.plan)[0];
    const saved=await s.diagnosis.saveDiagnosisScenario({baseRevision:'initial',requestId:'scene',scenarioId:null,draft:{name:'保存场景',description:'',planId:s.plan.id,faults:structuredClone(preset.faults)}});
    const task=await s.diagnosis.submitDiagnosis({baseRevision:saved.revision,requestId:'run',scenarioVersionId:saved.scenarios[0].versions[0].id,demo:'normal'});s.advance();
    const old=readDiagnosis(s.storage);old.presetVersion='diagnosis-demo-1';old.runs[0].presetVersion='diagnosis-demo-1';
    const bytes=JSON.stringify(old);s.storage.entries.set(DIAGNOSIS_STORAGE_KEY,bytes);const writes=s.storage.writes;
    await expect(s.diagnosis.getDiagnosisReport(task.view.run.id)).rejects.toMatchObject({code:'DIAGNOSIS_INCOMPATIBLE'});
    expect((await s.diagnosis.getDiagnosisReport('DG-HW')).dataOrigin).toBe('SAMPLE');
    expect(s.storage.writes).toBe(writes);expect(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)).toBe(bytes);
  });
  it.each([false, true])('上游重置后仍读取自身版本（采纳方案：%s）', async adopted => {
    const s = await frozenDiagnosis(adopted), bytes = s.storage.getItem(DIAGNOSIS_STORAGE_KEY), writes = s.storage.writes;
    const report = await s.diagnosis.getDiagnosisReport(s.runId);
    expect(report.network!.resultDetails).toEqual(s.plan.resultDetails);
    expect(report.network!.resultDetails).toBeDefined(); expect(report.source.state).toBe('HISTORICAL');
    expect(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
  });
  it.each([false, true])('旧诊断缺明细读取不回填也不写回（采纳方案：%s）', async adopted => {
    const s = await frozenDiagnosis(adopted), legacy = JSON.parse(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)!);
    for (const scenario of legacy.scenarios) for (const version of scenario.versions) delete version.network.resultDetails;
    for (const run of legacy.runs) delete run.scenario.network.resultDetails;
    const bytes = JSON.stringify(legacy); s.storage.entries.set(DIAGNOSIS_STORAGE_KEY, bytes);
    const writes = s.storage.writes;
    expect((await s.diagnosis.getDiagnosisReport(s.runId)).network).not.toHaveProperty('resultDetails');
    expect(readDiagnosis(s.storage).revision).toBe(legacy.revision);
    expect(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
  });
  it.each([false, true])('已有坏明细被拒绝且原记录保留（采纳方案：%s）', async adopted => {
    const s = await frozenDiagnosis(adopted), record = JSON.parse(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)!);
    for (const scenario of record.scenarios) for (const version of scenario.versions) version.network.resultDetails.assetVersion = 'unknown';
    for (const run of record.runs) run.scenario.network.resultDetails.assetVersion = 'unknown';
    const bytes = JSON.stringify(record); s.storage.entries.set(DIAGNOSIS_STORAGE_KEY, bytes);
    const writes = s.storage.writes;
    expect(() => readDiagnosis(s.storage)).toThrow('诊断记录损坏');
    expect(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)).toBe(bytes); expect(s.storage.writes).toBe(writes);
  });
});
