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
import * as diagnosisExport from '../src/reports/diagnosis-export';

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
  it('三路教学输出完整且输入受限，传播路径仅在影响阶段开放', async () => {
    const s=await setup(),task=await s.submit('three-way');
    s.advance(4700);const progress=await s.service.getDiagnosisProgress({id:task.view.run.id});
    expect(progress.phases[1].name).toContain('机器学习');
    const diagnosis=await s.service.getDiagnosisStage({id:task.view.run.id,stage:'diagnosis',resultVersion:progress.resultVersion});
    expect(diagnosis.fusionMode).toBe('THREE_WAY');expect(diagnosis).not.toHaveProperty('propagationPaths');
    expect(diagnosis.conclusions[0].branches.every(branch => branch.confidence!==null&&branch.contribution!==null&&branch.evidence.length>0)).toBe(true);
    await expect(s.service.getDiagnosisStage({id:task.view.run.id,stage:'impact',resultVersion:progress.resultVersion})).rejects.toMatchObject({code:'REPORT_NOT_READY'});
    s.advance();const report=await s.service.getDiagnosisReport(task.view.run.id);
    expect(report.result.propagationPaths![0].faultKey).toBe('DEVICE:DV-0027');
    expect(report.result.conclusions[0].confidence).toBe(0.895);
    await expect(s.submit('three-way',s.draft('balanced:software'))).rejects.toMatchObject({code:'NO_PRESET'});
  });
  it('来源支持性与当前归档元数据独立于冻结版本', async () => {
    const s=await setup(),saved=await s.save(),version=saved.scenarios[0].versions[0];
    expect((await s.service.loadDiagnosisSourceOptions()).plans[0]).toMatchObject({canCreate:true,unavailableReason:null});
    await s.service.archiveDiagnosisScenario({...await s.mutation(),scenarioId:version.scenarioId,archived:true});
    const detail=await s.service.getDiagnosisVersion({scenarioId:version.scenarioId,versionId:version.id});
    expect(detail.scenarioArchived).toBe(true);expect((await s.service.loadDiagnosisWorkspace()).workspace!.scenarios[0].versions[0]).not.toHaveProperty('scenarioArchived');
  });
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
  it.each(['xlsx','png'] as const)('%s 失败只反馈到影响下载，同一冻结报告重试不清除完整报告错误',async format=>{
    const s=await setup();await s.submit();s.advance();setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const download=vi.spyOn(diagnosisExport,'downloadDiagnosisFile').mockImplementation(()=>{}),store=useDiagnosisStore();await store.load();
    const id=store.record!.id,frozen=JSON.stringify(store.record),writes=s.storage.writes;
    vi.mocked(previewService.exportDiagnosisReport).mockRejectedValueOnce(new Error('完整报告生成失败'));
    await store.download('json');expect(store.exportError).toBe('完整报告生成失败');expect(store.impactExportError).toBe('');
    const impact=vi.mocked(previewService.exportDiagnosisImpact);impact.mockRejectedValueOnce(new Error('影响文件生成失败'));
    await store.download(format,'等级：严重');expect(store.impactExportError).toBe('影响文件生成失败');expect(store.exportError).toBe('完整报告生成失败');expect(download).not.toHaveBeenCalled();
    // 文件生成由服务负责；这里只验证原报告身份、筛选说明和下载响应的传递。
    const file={name:`影响.${format}`,mime:format==='png'?'image/png':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:new Uint8Array([1,2,3])};impact.mockResolvedValueOnce(file);
    await store.download(format,'等级：严重');expect(impact).toHaveBeenLastCalledWith(id,format,'等级：严重');expect(download).toHaveBeenCalledExactlyOnceWith(file);
    expect(store.impactExportError).toBe('');expect(store.exportError).toBe('完整报告生成失败');expect(store.exporting).toBe(false);
    await store.download('json');expect(store.exportError).toBe('');expect(download).toHaveBeenCalledTimes(2);expect(store.impactExportError).toBe('');
    expect(JSON.stringify(store.record)).toBe(frozen);expect(s.storage.writes).toBe(writes);store.stopPolling();
  });
  it('取消回执确认后详情失败只重查当前任务，不重复取消或清除冻结输入',async()=>{
    const s=await setup(),task=await s.submit();s.advance(1600);setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const store=useDiagnosisStore();await store.load();store.stopPolling();expect(store.view!.state).toBe('RUNNING');
    const frozen=JSON.stringify(store.view!.run.scenario),cancel=vi.mocked(previewService.cancelDiagnosisReceipt);
    cancel.mockRejectedValueOnce(new Error('取消服务暂不可用'));
    let pending=store.cancel();await vi.waitFor(()=>expect(store.decision).not.toBeNull());store.answer('save');await pending;
    expect(store.cancelAwaitingRefresh).toBe(false);expect(store.view!.state).toBe('RUNNING');expect(store.error).toBe('取消服务暂不可用');
    vi.mocked(previewService.getDiagnosisDetail).mockRejectedValueOnce(new Error('取消后读取失败'));
    pending=store.cancel();await vi.waitFor(()=>expect(store.decision).not.toBeNull());store.answer('save');await pending;
    expect(store.cancelAwaitingRefresh).toBe(true);expect(store.queryError).toContain('取消后读取失败');expect(store.error).toBe('');
    expect((await s.service.getDiagnosisRun(task.view.run.id)).state).toBe('CANCELLED');const writes=s.storage.writes;
    await store.cancel();expect(cancel).toHaveBeenCalledTimes(2);expect(store.decision).toBeNull();
    vi.mocked(previewService.getDiagnosisProgress).mockRejectedValueOnce(new Error('重查仍失败'));await store.query();
    expect(store.cancelAwaitingRefresh).toBe(true);expect(store.queryError).toContain('重查仍失败');
    await store.query();expect(store.view!.state).toBe('CANCELLED');expect(store.cancelAwaitingRefresh).toBe(false);expect(store.queryError).toBe('');
    expect(store.notice).toBe('取消状态已刷新');expect(cancel).toHaveBeenCalledTimes(2);expect(s.storage.writes).toBe(writes);expect(JSON.stringify(store.view!.run.scenario)).toBe(frozen);
  });
  it('目录失败分别保留查询条件，成功只清本目录错误，并支持两个目录同时恢复',async()=>{
    const s=await setup();await s.save();setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const store=useDiagnosisStore();await store.load();const scenes=JSON.stringify(store.workspace!.scenarios),writes=s.storage.writes;
    store.error='保留的场景操作错误';store.importError='保留的导入错误';store.exportError='保留的报告错误';
    const scenarios=vi.mocked(previewService.queryDiagnosisScenarios),history=vi.mocked(previewService.queryDiagnosisHistory);
    scenarios.mockRejectedValueOnce(new Error('场景目录中断'));history.mockRejectedValueOnce(new Error('运行目录中断'));
    await store.queryScenarios(2,true);await store.queryHistory(3);
    expect(store.scenarioQueryError).toBe('场景目录中断');expect(store.historyQueryError).toBe('运行目录中断');expect(JSON.stringify(store.workspace!.scenarios)).toBe(scenes);
    await store.queryScenarios(store.scenarioPage);expect(scenarios).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:2,archived:true}));
    expect(store.scenarioQueryError).toBe('');expect(store.historyQueryError).toBe('运行目录中断');expect(store.error).toBe('保留的场景操作错误');
    await store.queryHistory(store.historyPage);expect(history).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:3}));expect(store.historyQueryError).toBe('');
    // 同时重试不同目录，两份成功响应都应生效，不能相互抢占序号。
    store.scenarioQueryError='再次场景失败';store.historyQueryError='再次运行失败';
    let resolveScenes!: (value:Awaited<ReturnType<typeof s.service.queryDiagnosisScenarios>>)=>void,resolveHistory!: (value:Awaited<ReturnType<typeof s.service.queryDiagnosisHistory>>)=>void;
    scenarios.mockImplementationOnce(()=>new Promise(resolve=>{resolveScenes=resolve;}));history.mockImplementationOnce(()=>new Promise(resolve=>{resolveHistory=resolve;}));
    const first=store.queryScenarios(1,false),second=store.queryHistory(1);
    resolveHistory(await s.service.queryDiagnosisHistory({pageNum:1,pageSize:20}));await second;
    expect(store.historyQueryError).toBe('');expect(store.scenarioQueryError).toBe('再次场景失败');
    resolveScenes(await s.service.queryDiagnosisScenarios({pageNum:1,pageSize:20,archived:false}));await first;
    expect(store.scenarioQueryError).toBe('');expect(store.workspace!.scenarios).toHaveLength(1);expect(store.importError).toBe('保留的导入错误');expect(store.exportError).toBe('保留的报告错误');expect(s.storage.writes).toBe(writes);
    store.clearForSession();expect(store.scenarioQueryError).toBe('');expect(store.historyQueryError).toBe('');expect(store.impactExportError).toBe('');expect(store.cancelAwaitingRefresh).toBe(false);
  });
  it('空场景不发送诊断或保存请求，设置故障后恢复执行资格',async()=>{
    const s=await setup();setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const store=useDiagnosisStore();await store.load();await store.newScenario(s.plan.id);
    expect(store.canExecute).toBe(false);const writes=s.storage.writes;await store.submit();
    expect(previewService.submitDiagnosisReceipt).not.toHaveBeenCalled();expect(previewService.saveDiagnosisReceipt).not.toHaveBeenCalled();expect(s.storage.writes).toBe(writes);
    await store.applyPreset('balanced:hardware');expect(store.canExecute).toBe(true);
  });
  it.each(['size','read','service'] as const)('新文件 %s 预检失败即失去旧预览提交资格，重试成功只导入新文件',async failure=>{
    const s=await setup();setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const store=useDiagnosisStore();await store.load();const template=await s.service.getDiagnosisTemplate('csv',s.plan.id);
    const file=(name:string)=>new File([new Uint8Array(template.bytes).buffer],name,{type:template.mime});
    await store.previewImport(file('旧文件.csv'),s.plan.id);expect(store.importPreview!.issues).toEqual([]);
    const preview=vi.mocked(previewService.previewDiagnosisImport),writes=s.storage.writes;
    if(failure==='service')preview.mockRejectedValueOnce(new Error('新文件服务预检失败'));
    const next=failure==='size'?new File([new Uint8Array(5*1024*1024+1)],'新文件.csv'):file('新文件.csv');
    if(failure==='read')vi.spyOn(next,'arrayBuffer').mockRejectedValueOnce(new Error('新文件读取失败'));
    const checking=store.previewImport(next,s.plan.id);expect(store.importPreview).toBeNull();await checking;
    expect(store.importError).toBeTruthy();expect(store.importPreview).toBeNull();expect(await store.commitImport()).toBe(false);
    expect(previewService.importDiagnosisReceipt).not.toHaveBeenCalled();expect(s.storage.writes).toBe(writes);
    // 重新读取同一目标网络的新文件，只有本次有效预览能提交。
    await store.previewImport(file('重试文件.csv'),s.plan.id);expect(store.importPreview!.fileName).toBe('重试文件.csv');
    const drafts=JSON.parse(JSON.stringify(store.importPreview!.drafts));expect(await store.commitImport()).toBe(true);
    expect(vi.mocked(previewService.importDiagnosisReceipt).mock.calls[0][0].drafts).toEqual(drafts);
    expect((await s.service.loadDiagnosisWorkspace()).workspace!.scenarios).toHaveLength(drafts.length);
  });
  it('普通请求不带演示分支，能力关闭及换账号清理选择，Mock 缺省请求兼容旧幂等回执',async()=>{
    const s=await setup();setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const store=useDiagnosisStore();await store.load();expect(store.demoEnabled).toBe(true);store.demo='impact-failed';
    const context=await s.service.loadDiagnosisContext();vi.mocked(previewService.loadDiagnosisContext).mockResolvedValue({...context,capabilities:undefined});
    await store.reload();expect(store.demoEnabled).toBe(false);expect(store.demo).toBe('normal');
    await store.newScenario(s.plan.id);await store.applyPreset('balanced:hardware');await store.save();
    store.demo='diagnosis-failed';await store.submit();store.stopPolling();
    const submit=vi.mocked(previewService.submitDiagnosisReceipt);expect(submit.mock.calls.at(-1)![0]).not.toHaveProperty('demo');
    const submitted=await s.service.getDiagnosisRun(store.runId);expect(submitted.run.demo).toBe('normal');
    const request=submit.mock.calls.at(-1)![0];const retry=await s.service.submitDiagnosis({...request,demo:'normal'});expect(retry.view.run.id).toBe(store.runId);
    await store.reset();expect(store.decision).toBeNull();
    store.clearForSession();expect(store.demo).toBe('normal');expect(store.dataOrigin).toBe('UNKNOWN');expect(store.demoEnabled).toBe(false);
  });
  it('分页切换不解除归档保护，新建失败保留当前草稿与撤销历史', async () => {
    const s=await setup();setActivePinia(createPinia());authorizeStore();
    for(const [key,method] of Object.entries(s.service))vi.spyOn(previewService as any,key).mockImplementation(method as never);
    const store=useDiagnosisStore();await store.load();expect(store.record).toBeNull();
    await store.newScenario(s.plan.id);await store.applyPreset('balanced:hardware');await store.save();
    const id=store.scenarioId!;
    // 闭包确认通过实际 decision 回答，验证当前列表移除后状态仍独立存在。
    const archiving=store.archive(id,true);await vi.waitFor(() => expect(store.decision).not.toBeNull());store.answer('save');await archiving;
    expect(store.workspace!.scenarios).toHaveLength(0);expect(store.canEdit).toBe(false);expect(store.canExecute).toBe(false);
    await store.selectVersion({scenarioId:id,id:store.versionId});expect(store.canEdit).toBe(false);
    const before=JSON.stringify(store.draft),undo=JSON.stringify(store.undoStack);
    expect(await store.newScenario('missing')).toBe(false);expect(JSON.stringify(store.draft)).toBe(before);expect(JSON.stringify(store.undoStack)).toBe(undo);
  });
  it('撤销/重做保持完整草稿，保存失败仍保留可重试输入', async () => {
    const s = await setup(); setActivePinia(createPinia()); authorizeStore();
    for(const name of ['loadDiagnosisContext','loadDiagnosisSourceOptions','getDiagnosisSource','queryDiagnosisScenarios','queryDiagnosisHistory','getDiagnosisPreset','getDiagnosisVersion','saveDiagnosisReceipt'] as const)vi.spyOn(previewService,name).mockImplementation(s.service[name] as never);
    vi.spyOn(previewService,'loadDiagnosisSources').mockImplementation(s.service.loadDiagnosisSources);
    vi.spyOn(previewService,'getDiagnosisReport').mockImplementation(s.service.getDiagnosisReport);
    vi.spyOn(previewService,'saveDiagnosisScenario').mockImplementation(s.service.saveDiagnosisScenario);
    const store = useDiagnosisStore(); await store.load(); await store.newScenario(); await store.applyPreset('balanced:hardware');
    const draft = JSON.parse(JSON.stringify(store.draft)); store.applyFaults([], '修改'); store.undo(); expect(store.draft).toEqual(draft); store.redo(); expect(store.draft!.name).toBe('修改'); store.undo();
    s.storage.failWrite = true; expect(await store.save()).toBe(false); expect(store.draft).toEqual(draft); expect(store.dirty).toBe(true);
  });
  it('切换任务后迟到的查询不覆盖当前选择', async () => {
    const s = await setup(); const task = await s.submit(); setActivePinia(createPinia()); authorizeStore();
    const store = useDiagnosisStore(); let resolve!: (view:Awaited<ReturnType<typeof s.service.getDiagnosisProgress>>) => void;
    vi.spyOn(previewService,'getDiagnosisProgress').mockImplementation(() => new Promise(r => { resolve = r; }));
    store.runId = task.view.run.id; const query = store.query(); store.stopPolling(); store.runId = 'another';
    resolve(await s.service.getDiagnosisProgress({id:task.view.run.id})); await query; expect(store.view).toBeNull(); expect(store.runId).toBe('another');
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
