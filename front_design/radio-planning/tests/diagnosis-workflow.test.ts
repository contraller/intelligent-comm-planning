import { savedRequest,taskMeta } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createPlanningMock } from '../src/services/planning-mock';
import { createDiagnosisMock } from '../src/services/diagnosis-mock';
import { initialMeta } from '../src/services/resource-storage';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import resources from '../src/mocks/resources.json';
import type { ResourcesData } from '../src/types/domain';
import type { DiagnosisDraft, DiagnosisDemo, DiagnosisRunView } from '../src/types/diagnosis';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import { previewService } from '../src/services';
import { useDiagnosisStore } from '../src/stores/diagnosis';

// 通过真实规划服务准备确认版本，诊断测试不绕过上游资格检查。
async function setup(networkId = 'balanced', confirmed = true) {
  const storage = new TestStorage(); let time = Date.parse('2026-10-03T00:00:00Z');
  const current = {resources:structuredClone(resources) as ResourcesData,meta:initialMeta()};
  const planning = createPlanningMock(() => storage,() => ({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}}),() => time);
  const submitted = await planning.submitPlanning(await savedRequest(storage,{baseRevision:'initial',requestId:'plan-submit',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets.find(p => p.id === networkId)!.input)}));
  time += 10000;
  const saved = await planning.savePlanVersion({baseRevision:submitted.workspace.revision,requestId:'plan-save',jobId:submitted.view.job.id,name:'诊断网络',note:''});
  const plan = confirmed ? (await planning.confirmPlanVersion({baseRevision:saved.workspace.revision,requestId:'plan-confirm',planId:saved.plan.id})).plan : saved.plan;
  const service = createDiagnosisMock(() => storage,() => ({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}}),() => time);
  const mutation = async () => ({baseRevision:(await service.loadDiagnosisWorkspace()).workspace!.revision,requestId:crypto.randomUUID()});
  const draft = (presetId = `${networkId}:hardware`): DiagnosisDraft => ({name:'诊断场景',description:'冻结快照测试',planId:plan.id,faults:structuredClone(diagnosisPresets.find(p => p.id === presetId)!.faults)});
  const save = async (input = draft(), scenarioId: string | null = null) => service.saveDiagnosisScenario({...await mutation(),scenarioId,draft:input});
  const submit = async (demo: DiagnosisDemo = 'normal', input = draft()) => { const saved = await save(input); return service.submitDiagnosis({...await mutation(),scenarioVersionId:saved.scenarios.at(-1)!.versions.at(-1)!.id,demo}); };
  return {service,planning,plan,storage,current,mutation,draft,save,submit,advance:(ms = 10000) => { time += ms; }};
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('诊断场景与冻结任务', () => {
  it('只列出当前有效确认方案，SAVED 和资源失效版本不可进入新诊断', async () => {
    const unconfirmed = await setup('balanced',false);
    expect((await unconfirmed.service.loadDiagnosisSources()).plans).toEqual([]);
    await expect(unconfirmed.save()).rejects.toMatchObject({code:'NETWORK_NOT_ELIGIBLE'});
    const s = await setup();
    expect((await s.service.loadDiagnosisSources()).plans.map(p => p.id)).toEqual([s.plan.id]);
    s.current.meta.stationVersions['ND-0003'] = 'changed';
    await expect(s.save()).rejects.toMatchObject({code:'NETWORK_NOT_ELIGIBLE'});
  });
  it.each(diagnosisPresets.map(p => [p.id,p.networkPresetId] as const))('%s 按对应网络完成并保留分路、引用和报告身份', async (id,networkId) => {
    const s = await setup(networkId); const task = await s.submit('normal',s.draft(id));
    expect(task.view.state).toBe('PENDING');
    expect(new Set([task.view.run.id,task.view.run.diagnoseTaskId,task.view.run.impactTaskId,task.view.run.scenario.id,s.plan.id]).size).toBe(5);
    s.advance(); const result = await s.service.getDiagnosisRun(task.view.run.id);
    expect(result.state).toBe('SUCCESS'); expect(result.report!.network.id).toBe(s.plan.id);
    expect(result.report!.result.conclusions.every(c => c.branches.find(b => b.source === 'ML')?.confidence === null)).toBe(true);
    const summary = result.report!.result.summary!;
    expect(summary.affectedNodeCount).toBe(result.report!.result.nodes.length);
    expect(summary.affectedLinkCount).toBe(result.report!.result.links.length);
  });
  it('合法但未匹配的场景可保存，不允许回用最近结果', async () => {
    const s = await setup(); const draft = s.draft(); draft.faults[0].symptomIds = [];
    const saved = await s.save(draft);
    await expect(s.service.submitDiagnosis({...await s.mutation(),scenarioVersionId:saved.scenarios[0].versions[0].id,demo:'normal'})).rejects.toMatchObject({code:'NO_PRESET'});
    expect((await s.service.loadDiagnosisWorkspace()).workspace!.runs).toHaveLength(0);
  });
  it('编辑新增版本、归档保留引用，旧任务输入不被改写', async () => {
    const s = await setup(); const task = await s.submit(); const original = structuredClone(task.view.run.scenario);
    const edited = s.draft(); edited.name = '第二版本';
    const changed = await s.save(edited,original.scenarioId);
    expect(changed.scenarios[0].versions).toHaveLength(2);
    await s.service.archiveDiagnosisScenario({...await s.mutation(),scenarioId:original.scenarioId,archived:true});
    s.advance(); const record = await s.service.getDiagnosisReport(task.view.run.id);
    expect(record.name).toBe(original.name); expect(record.faults).toEqual(original.faults);
    await expect(s.service.submitDiagnosis({...await s.mutation(),scenarioVersionId:original.id,demo:'normal'})).rejects.toMatchObject({code:'SCENARIO_NOT_FOUND'});
  });
  it('提交幂等，保存或提交失败不留下半条记录', async () => {
    const s = await setup(); const saved = await s.save();
    const req = {...await s.mutation(),scenarioVersionId:saved.scenarios[0].versions[0].id,demo:'normal' as const};
    const first = await s.service.submitDiagnosis(req); const second = await s.service.submitDiagnosis(req);
    expect(second.view.run.id).toBe(first.view.run.id); expect(second.workspace.runs).toHaveLength(1);
    await expect(s.service.submitDiagnosis({...req,demo:'low-confidence'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    const raw = s.storage.entries.get(DIAGNOSIS_STORAGE_KEY);
    s.storage.failWrite = true;
    await expect(s.save()).rejects.toMatchObject({code:'DIAGNOSIS_WRITE_FAILED'});
    expect(s.storage.entries.get(DIAGNOSIS_STORAGE_KEY)).toBe(raw);
  });
  it('运行期间相关资源变化并重置规划，仍按冻结输入完成；新任务被阻止', async () => {
    const s = await setup(); const task = await s.submit(); const frozen = structuredClone(task.view.run);
    s.current.meta.stationVersions['ND-0003'] = 'revision-next';
    const planning = await s.planning.loadPlanningWorkspace(); await s.planning.resetPlanningWorkspace(planning.workspace.revision);
    s.advance(); const record = await s.service.getDiagnosisReport(task.view.run.id);
    expect(record.network).toEqual(frozen.scenario.network); expect(record.result).toEqual(frozen.result);
    expect(record.source.state).toBe('HISTORICAL'); expect(record.source.reasons).toContain('源规划已重置或缺失');
    await expect(s.save()).rejects.toMatchObject({code:'NETWORK_NOT_ELIGIBLE'});
  });
  it('无关资源变化不影响当前状态；源存储读取失败不使任务失败', async () => {
    const s = await setup(); const task = await s.submit(); s.current.meta.stationVersions['ND-0050'] = 'other';
    expect((await s.service.getDiagnosisRun(task.view.run.id)).source.state).toBe('CURRENT');
    s.storage.failReadKeys.add(PLANNING_STORAGE_KEY); s.advance();
    const result = await s.service.getDiagnosisRun(task.view.run.id);
    expect(result.state).toBe('SUCCESS'); expect(result.source.state).toBe('UNKNOWN');
    expect((await s.service.loadDiagnosisSources()).error).toBeTruthy();
  });
  it('低置信度与分路缺失照常保存，不把缺失分支变为零分', async () => {
    const s = await setup(); const task = await s.submit('low-confidence'); s.advance();
    const result = (await s.service.getDiagnosisReport(task.view.run.id)).result;
    expect(result.conclusions[0].needManualReview).toBe(true); expect(result.conclusions[0].confidence).toBe(0.52);
    expect(result.conclusions[0].candidates).toHaveLength(2); expect(result.conclusions[0].branches[2].confidence).toBeNull();
  });
  it.each(['diagnosis-failed','impact-failed'] as const)('%s 不产生完整成功报告', async (demo) => {
    const s = await setup(); const task = await s.submit(demo); s.advance(); const result = await s.service.getDiagnosisRun(task.view.run.id);
    expect(result.state).toBe('FAILED'); expect(result.diagnosisReady).toBe(demo === 'impact-failed'); expect(result.impactReady).toBe(false);
    await expect(s.service.getDiagnosisReport(task.view.run.id)).rejects.toMatchObject({code:'REPORT_NOT_READY'});
  });
  it('取消失败保留运行状态，取消成功刷新后仍为 CANCELLED', async () => {
    const s = await setup(); const task = await s.submit(); s.advance(1600);
    const request = {...await s.mutation(),runId:task.view.run.id}; s.storage.failWrite = true;
    await expect(s.service.cancelDiagnosisRun(request)).rejects.toMatchObject({code:'DIAGNOSIS_WRITE_FAILED'});
    expect((await s.service.getDiagnosisRun(task.view.run.id)).state).toBe('RUNNING');
    s.storage.failWrite = false; await s.service.cancelDiagnosisRun(request); s.advance();
    expect((await s.service.getDiagnosisRun(task.view.run.id)).state).toBe('CANCELLED');
  });
  it('导入整批校验和幂等，不覆盖同名场景', async () => {
    const s = await setup(); const first = s.draft(), bad = s.draft(); bad.faults[0].objectId = '不存在';
    await expect(s.service.commitDiagnosisImport({...await s.mutation(),drafts:[first,bad]})).rejects.toMatchObject({code:3003});
    expect((await s.service.loadDiagnosisWorkspace()).workspace!.scenarios).toHaveLength(0);
    const req = {...await s.mutation(),drafts:[first,first]};
    const saved = await s.service.commitDiagnosisImport(req);
    expect(saved.scenarios).toHaveLength(2); expect((await s.service.commitDiagnosisImport(req)).scenarios).toHaveLength(2);
  });
});

describe('诊断 store 的草稿与异步隔离', () => {
  it('撤销/重做保持完整草稿，保存失败仍保留可重试输入', async () => {
    const s = await setup(); setActivePinia(createPinia()); authorizeStore();
    vi.spyOn(previewService,'loadDiagnosisWorkspace').mockImplementation(s.service.loadDiagnosisWorkspace);
    vi.spyOn(previewService,'loadDiagnosisSources').mockImplementation(s.service.loadDiagnosisSources);
    vi.spyOn(previewService,'getDiagnosisReport').mockImplementation(s.service.getDiagnosisReport);
    vi.spyOn(previewService,'saveDiagnosisScenario').mockImplementation(s.service.saveDiagnosisScenario);
    const store = useDiagnosisStore(); await store.load(); await store.newScenario(); store.applyPreset('balanced:hardware');
    const draft = JSON.parse(JSON.stringify(store.draft)); store.applyFaults([], '修改'); store.undo(); expect(store.draft).toEqual(draft); store.redo(); expect(store.draft!.name).toBe('修改'); store.undo();
    s.storage.failWrite = true; expect(await store.save()).toBe(false); expect(store.draft).toEqual(draft); expect(store.dirty).toBe(true);
  });
  it('切换任务后迟到的查询不覆盖当前选择', async () => {
    const s = await setup(); const task = await s.submit(); setActivePinia(createPinia()); authorizeStore();
    const store = useDiagnosisStore(); let resolve!: (view:DiagnosisRunView) => void;
    vi.spyOn(previewService,'getDiagnosisRun').mockImplementation(() => new Promise(r => { resolve = r; }));
    store.runId = task.view.run.id; const query = store.query(); store.stopPolling(); store.runId = 'another';
    resolve(task.view); await query; expect(store.view).toBeNull(); expect(store.runId).toBe('another');
  });
});

describe('本批上游资源对诊断影响',()=>{
  it.each(['interference','availability'])('%s 变更阻止新诊断，已提交任务仍用冻结网络完成',async kind=>{
    const s=await setup(),task=await s.submit(),frozen=structuredClone(task.view.run);
    if(kind==='interference')s.current.meta.interferenceVersion='changed-interference';
    else {const device=s.current.resources.devices.find(d=>s.plan.inputSnapshot.devices.some(p=>p.id===d.id))!;device.availability='OFF_SHELF';s.current.meta.deviceVersions[device.id]='changed-device';s.current.meta.stationVersions[device.stationId]='changed-station';}
    expect((await s.service.loadDiagnosisSources()).plans).toEqual([]);
    await expect(s.save()).rejects.toMatchObject({code:'NETWORK_NOT_ELIGIBLE'});
    s.advance();const report=await s.service.getDiagnosisReport(task.view.run.id);
    expect(report.network).toEqual(frozen.scenario.network);expect(report.result).toEqual(frozen.result);expect(report.source.state).toBe('HISTORICAL');
  });
});
