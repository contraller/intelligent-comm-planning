import { useMonitoringStore } from '../src/stores/monitoring';
import { monitoringFixture, settleMonitoring } from './helpers/monitoring';
import type { MonitoringFrameResult } from '../src/types/monitoring';
import { createWorkbenchFixture, deferred, enterWorkbenchStore } from './helpers/interference-workbench';
import { createInterferenceWorkbenchHttp } from '../src/services/interference-workbench-http';
import { savedRequest,taskMeta } from './helpers/tasks';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceReadStore } from '../src/stores/resource-read';
import { usePlanningStore } from '../src/stores/planning';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useTaskInputStore } from '../src/stores/task-input';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { createAccessService } from '../src/services/access';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { ApiError } from '../src/services/types';
import { previewService } from '../src/services';
import { useSpectrumStore } from '../src/stores/spectrum';
import type { SpectrumWorkspace } from '../src/types/spectrum';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { planningPresets } from '../src/mocks/planning-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import type { PreviewData } from '../src/types/domain';
let pinia:ReturnType<typeof createPinia>;
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();if(pinia)disposePinia(pinia);});
async function start(username='resource'){
  pinia=createPinia();setActivePinia(pinia);const s=authFixture();s.bind();await s.login(username);const auth=useAuthStore();await auth.check();return {...s,auth};
}
// 资源管理会话测试使用当前台账维护上下文，不借用 GIS 草稿 Store。
async function ledgerEditor(){
  await useResourceReadStore().activate('ledger');return useResourceLedgerEditStore();
}
describe('会话切换与草稿保护',()=>{
  it('旧账号迟到的加载失败不污染新账号规划状态',async()=>{
    const s=await start('planner'),store=usePlanningStore();let reject!:(e:Error)=>void;vi.spyOn(previewService,'loadPlanningWorkspace').mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
    const old=store.load();store.clearForSession();await s.service.logout();await s.login('viewer');await s.auth.check();await store.load();const revision=store.workspace!.revision;
    reject(new ApiError('旧请求失效','SESSION_CHANGED'));await old;expect(store.workspace!.revision).toBe(revision);expect(store.loadError).toBe('');expect(store.loading).toBe(false);
  });
  it('仅有执行权限可运行已保存诊断场景，不能编辑或暗中保存新场景',async()=>{
    vi.useFakeTimers();const s=await start('planner');
    const planning=await s.service.loadPlanningWorkspace(),job=await s.service.submitPlanning(await savedRequest(s.storage,{baseRevision:planning.workspace.revision,requestId:'p-submit',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)}));
    vi.advanceTimersByTime(10000);const saved=await s.service.savePlanVersion({baseRevision:job.workspace.revision,requestId:'p-save',jobId:job.view.job.id,name:'执行权限测试',note:''});
    const confirmed=await s.service.confirmPlanVersion({baseRevision:saved.workspace.revision,requestId:'p-confirm',planId:saved.plan.id});
    const loaded=await s.service.loadDiagnosisWorkspace(),scenarios=await s.service.saveDiagnosisScenario({baseRevision:loaded.workspace!.revision,requestId:'scenario',scenarioId:null,draft:{name:'已保存场景',description:'',planId:confirmed.plan.id,faults:structuredClone(diagnosisPresets.find(p=>p.id==='balanced:hardware')!.faults)}});
    const system=readSystem(s.storage);system.roles.push({id:'EXECUTE-ONLY',name:'仅执行诊断',description:'测试',permissions:['diagnosis.view','diagnosis.execute']});system.accounts.find(a=>a.id==='SYS-PLANNER')!.roleId='EXECUTE-ONLY';writeSystem(s.storage,system);await s.auth.check();
    const store=useDiagnosisStore();await store.load();await store.selectVersion(scenarios.scenarios[0].versions[0]);expect(store.canEdit).toBe(false);expect(store.canExecute).toBe(true);await store.submit();expect(store.runId).toBeTruthy();expect(store.view?.state).toBe('PENDING');store.stopPolling();
  });
  it('退出取消和会话写失败均保留资源输入，成功后才统一清内存',async()=>{
    const s=await start(),preview=usePreviewStore(),editor=await ledgerEditor();await preview.load();await editor.openForm('DV-0001');editor.form!.fields.antennaHeightM='18';
    s.auth.registerLeave(()=>editor.leave(true),()=>editor.dirty);s.auth.registerCleaner(editor.clearForSession);s.auth.registerCleaner(preview.clearForSession);
    let leave=s.auth.leaveSession();await vi.waitFor(()=>expect(editor.decision).not.toBeNull());editor.answer('cancel');expect(await leave).toBe(false);expect(editor.dirty).toBe(true);
    s.sessions.failWrite=true;leave=s.auth.leaveSession();await vi.waitFor(()=>expect(editor.decision).not.toBeNull());editor.answer('discard');expect(await leave).toBe(false);expect(editor.form!.fields.antennaHeightM).toBe('18');expect(editor.dirty).toBe(true);
    s.sessions.failWrite=false;leave=s.auth.leaveSession();await vi.waitFor(()=>expect(editor.decision).not.toBeNull());editor.answer('discard');expect(await leave).toBe(true);expect(editor.form).toBeNull();expect(preview.data).toBeNull();
  });
  it('停用冻结草稿并禁止保存，明确丢弃前输入不变',async()=>{
    const s=await start(),preview=usePreviewStore(),editor=await ledgerEditor();await preview.load();await editor.openForm('DV-0001');editor.form!.fields.antennaHeightM='19';s.auth.currentPath='/resources';
    const w=readSystem(s.storage);w.accounts.find(a=>a.id==='SYS-RESOURCE')!.enabled=false;writeSystem(s.storage,w);await s.auth.check();expect(s.auth.blocked).toBe(true);expect(await editor.save()).toBe(false);expect(editor.form!.fields.antennaHeightM).toBe('19');
    s.auth.registerCleaner(editor.clearForSession);expect(await s.auth.discardRestricted()).toBe(true);expect(editor.form).toBeNull();
  });
  it('仅读写权限收回保留可查看草稿，恢复权限后仍能保存',async()=>{
    const s=await start(),preview=usePreviewStore(),editor=await ledgerEditor();await preview.load();await editor.openForm('DV-0001');editor.form!.fields.antennaHeightM='20';s.auth.currentPath='/resources';
    let w=readSystem(s.storage);w.roles.find(r=>r.id==='ROLE-RESOURCE')!.permissions=['resources.view'];writeSystem(s.storage,w);await s.auth.check();expect(s.auth.blocked).toBe(false);expect(editor.canEdit).toBe(false);expect(await editor.save()).toBe(false);
    w=readSystem(s.storage);w.roles.find(r=>r.id==='ROLE-RESOURCE')!.permissions=['resources.view','resources.edit'];writeSystem(s.storage,w);await s.auth.check();expect(await editor.save()).toBe(true);
  });
  it.each([false,true])('旧异步响应（业务失败=%s）不得覆盖新登录身份或返回旧数据',async(fails)=>{
    const s=await start('viewer');let resolve!:(v:PreviewData)=>void,reject!:(e:Error)=>void;
    const raw={...s.raw,loadPreview:()=>new Promise<PreviewData>((a,b)=>{resolve=a;reject=b;})};
    const service=createAccessService(()=>raw,null);const old=service.loadPreview();await Promise.resolve();await s.raw.logout();await s.raw.login({username:'planner',password:'Demo@2026'});
    const caught=expect(old).rejects.toMatchObject({code:'SESSION_CHANGED'});
    if(fails)reject(new ApiError('带数据业务失败',2001,{secret:'old'}));else resolve(await s.raw.loadPreview());
    await caught;expect(s.auth.identity?.id).toBe('SYS-PLANNER');expect(s.auth.error).toBe('');
  });
  it('退出清理规划内存不取消持久任务',async()=>{
    const s=await start('planner');await useResourceReadStore().activate('planning');
    const task=useTaskInputStore(),store=usePlanningApiStore();
    try{
      // 通过当前任务与规划入口建立真实 Mock 作业，再验证退出只清内存。
      await task.initialize('planning');expect(await task.save()).toBe(true);await store.submit();expect(store.job?.id).toBeTruthy();
      const persisted=[...s.storage.entries].filter(([k])=>k.includes('planning-workspace'));expect(persisted.length).toBeGreaterThan(0);
      const before=JSON.stringify(persisted);
      s.auth.registerCleaner(()=>{store.clearForSession();task.clearForSession();});
      expect(await s.auth.leaveSession()).toBe(true);expect(store.job).toBeNull();expect(task.draft).toBeNull();expect(task.saved).toBeNull();expect(task.taskId).toBe('');
      expect(JSON.stringify([...s.storage.entries].filter(([k])=>k.includes('planning-workspace')))).toBe(before);
    }finally{store.clearForSession();task.clearForSession();}
  });
  it('知识退出标记写失败时放弃选择不提前丢弃草稿和审核文本',async()=>{
    const s=await start('kg_editor'),store=useKnowledgeStore();await store.load();await store.changeTab('changes');await store.openChange(store.workspace!.changes.find(c=>c.state==='DRAFT')!);store.draft!.summary='未保存知识';
    s.auth.registerLeave(()=>store.allowLeave(false,true),()=>store.dirty);s.sessions.failWrite=true;
    const leave=s.auth.leaveSession();store.answer('discard');expect(await leave).toBe(false);expect(store.draft!.summary).toBe('未保存知识');expect(store.dirty).toBe(true);
  });
});

describe('本批新增输入会话隔离',()=>{
  it('频谱失权冻结输入；退出写失败不清表单，成功后再清理',async()=>{
    const s=await start(),store=useSpectrumStore();await store.load();await store.open();
    store.form!.name='尚未保存的配置';
    let w=readSystem(s.storage);w.roles.find(r=>r.id==='ROLE-RESOURCE')!.permissions=['resources.view'];writeSystem(s.storage,w);await s.auth.check();
    expect(store.canEdit).toBe(false);expect(await store.save()).toBe(false);expect(store.form!.name).toBe('尚未保存的配置');
    s.auth.registerLeave(()=>store.leave(true),()=>store.dirty);s.auth.registerCleaner(store.clearForSession);
    s.sessions.failWrite=true;let leave=s.auth.leaveSession();store.answer('discard');
    expect(await leave).toBe(false);expect(store.dirty).toBe(true);
    s.sessions.failWrite=false;leave=s.auth.leaveSession();store.answer('discard');
    expect(await leave).toBe(true);expect(store.form).toBeNull();
  });
  it('资源新增与错误导入退出可取消，导入不存在绕过错误的保存分支',async()=>{
    const s=await start(),preview=usePreviewStore(),editor=useResourceEditStore();await preview.load();
    // GIS 维护先读取共同版本，不再以完整 Preview 充当编辑上下文。
    await useResourceReadStore().activate('gis');
    await editor.newForm('station');editor.form!.fields.name='未完成站点';
    let leaving=editor.leave();editor.answer('cancel');expect(await leaving).toBe(false);expect(editor.form!.fields.name).toBe('未完成站点');
    editor.clearSession();await editor.openImport();
    await editor.previewImport({name:'bad.csv',bytes:new TextEncoder().encode('wrong\nvalue')});
    leaving=editor.leave();expect(editor.decision?.saveLabel).toBeUndefined();editor.answer('save');
    expect(await leaving).toBe(false);expect(editor.importFile).not.toBeNull();
    s.auth.registerCleaner(editor.clearSession);await s.auth.discardRestricted();expect(editor.importFile).toBeNull();
  });
  it('旧频谱加载结果与旧资源保存错误不污染新会话',async()=>{
    const s=await start(),spectrum=useSpectrumStore(),preview=usePreviewStore(),editor=await ledgerEditor();
    let resolve!:(w:Awaited<ReturnType<typeof s.raw.querySpectrumSources>>)=>void;const initial=await s.raw.querySpectrumSources({pageNum:1,pageSize:20,sort:'name',order:'asc'});
    vi.spyOn(previewService,'querySpectrumSources').mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const loading=spectrum.load();spectrum.clearForSession();
    await preview.load();await editor.openForm('DV-0001');editor.form!.fields.antennaHeightM='18';
    let reject!:(e:Error)=>void;vi.spyOn(previewService,'saveResourceChanges').mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
    const saving=editor.save();editor.clearForSession();preview.clearForSession();
    await s.service.logout();await s.login('viewer');await s.auth.check();
    resolve(initial);reject(new ApiError('旧保存失败','SESSION_CHANGED'));await loading;await saving;
    expect(spectrum.workspace).toBeNull();expect(spectrum.error).toBe('');expect(editor.error).toBe('');expect(editor.form).toBeNull();
  });
});

describe('独立任务的会话隔离',()=>{
  it('旧任务保存响应不能覆盖重新登录后的任务草稿',async()=>{
    const s=await start('planner'),resources=useResourceReadStore(),planning=useTaskInputStore();
    await resources.activate('planning');await planning.initialize('planning');
    planning.updateInput({...JSON.parse(JSON.stringify(planning.draft)),name:'旧账号已提交的独立任务'});
    let complete!:()=>void,request!:Parameters<typeof previewService.saveTaskInputReceipt>[0];
    // 先真实落盘再延迟回执，确保验证的是迟到保存而非未执行的请求。
    const spy=vi.spyOn(previewService,'saveTaskInputReceipt').mockImplementationOnce(async r=>{
      request=r;const saved=await s.raw.saveTaskInputReceipt(r);return new Promise(resolve=>{complete=()=>resolve(saved);});
    });
    const pending=planning.save();await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));
    const persisted=await s.raw.loadTaskWorkspace();expect(persisted.tasks.find(t=>t.id===request.taskId)!.versions.at(-1)!.input).toEqual(request.input);
    planning.clearForSession();resources.clearForSession();await s.service.logout();await s.login('viewer');await s.auth.check();
    await resources.activate('planning');await planning.initialize('planning');
    expect(planning.draft!.name).not.toBe(request.input.name);
    const snapshot=()=>JSON.stringify({draft:planning.draft,taskId:planning.taskId,saved:planning.saved,notice:planning.notice,pendingSave:planning.pendingSave,busy:planning.busy,changed:planning.changed});
    const before=snapshot();complete();expect(await pending).toBe(false);expect(snapshot()).toBe(before);spy.mockRestore();
  });
});

describe('干扰状态会话隔离',()=>{
  it('措施和分析切换重置实际显示，失败保留快照而成功缺省响应清除旧预览',async()=>{
    await start('planner');const f=await createWorkbenchFixture(),store=await enterWorkbenchStore(f);
    await store.loadMeasurePreview('UNIT-CM1');store.after=true;
    const preview=JSON.stringify(store.selectedMeasurePreview),impact=JSON.stringify(store.impact);
    f.workbench.getContext.mockRejectedValueOnce(new ApiError('读取中断','NETWORK_ERROR'));
    await store.query();expect(store.queryError).toContain('读取中断');expect(store.effectiveAfter).toBe(true);
    expect(JSON.stringify(store.selectedMeasurePreview)).toBe(preview);expect(JSON.stringify(store.impact)).toBe(impact);
    await store.loadMeasurePreview('UNIT-CM2');expect(store.after).toBe(false);
    expect(store.selectedMeasurePreview!.measure_id).toBe(store.measureId);store.after=true;
    f.workbench.getPreview.mockResolvedValueOnce({...f.preview,measure_id:'UNIT-CM2',impact_after:null});
    await store.query();await store.loadMeasurePreview('UNIT-CM2');expect(store.queryError).toBe('');expect(store.canPreviewAfter).toBe(false);
    expect(store.selectedMeasurePreview!.impact_after).toBeNull();expect(store.effectiveAfter).toBe(false);expect(store.impact).toEqual(f.run.result);
    expect(store.previewUnavailableReason).toContain('措施后影响');
    await store.loadMeasurePreview('UNIT-CM2');store.after=true;expect(store.effectiveAfter).toBe(true);
    f.workbench.getRun.mockResolvedValueOnce({...f.run,run_id:'UNIT-RUN2'});await store.selectRun('UNIT-RUN2');
    expect(store.measureId).toBe('');expect(store.preview).toBeNull();expect(store.effectiveAfter).toBe(false);f.assertNoWrites();
  });
  it('预览重复、结构不完整或缺少措施后影响均不能显示后态',async()=>{
    await start('planner');const f=await createWorkbenchFixture(),store=await enterWorkbenchStore(f);
    const incomplete={...f.preview,proposed_changes:undefined},duplicate=structuredClone(f.preview);
    duplicate.impact_after!.affected_nodes.push({...duplicate.impact_after!.affected_nodes[0]!});
    for(const payload of [incomplete,duplicate]){
      const http=createInterferenceWorkbenchHttp(async<T>()=>structuredClone(payload) as T);
      f.workbench.getPreview.mockImplementationOnce(http.getPreview);
      await store.loadMeasurePreview('UNIT-CM1');store.after=true;
      expect(store.canPreviewAfter).toBe(false);expect(store.effectiveAfter).toBe(false);expect(store.impact).toEqual(f.run.result);
      expect(store.queryError).toContain('冻结契约');
    }
    f.workbench.getPreview.mockResolvedValueOnce({...f.preview,impact_after:null});await store.loadMeasurePreview('UNIT-CM1');store.after=true;
    expect(store.canPreviewAfter).toBe(false);expect(store.previewUnavailableReason).toContain('措施后影响');f.assertNoWrites();
  });
  it('退出后的迟到查询不能重新带回完整预览或影响统计',async()=>{
    await start('planner');const f=await createWorkbenchFixture(),store=await enterWorkbenchStore(f);
    await store.loadMeasurePreview('UNIT-CM1');store.after=true;
    const late=deferred<typeof f.preview>();f.workbench.getPreview.mockReturnValueOnce(late.promise);
    const pending=store.loadMeasurePreview('UNIT-CM1');store.clearForSession();late.resolve(f.preview);await pending;
    expect(store.selected).toBeNull();expect(store.selectedMeasurePreview).toBeNull();expect(store.effectiveAfter).toBe(false);expect(store.impact).toBeNull();f.assertNoWrites();
  });
  it('离页/换账号不取消已提交分析，迟到加载不能覆盖新缓存',async()=>{
    await start('planner');const f=await createWorkbenchFixture(),store=await enterWorkbenchStore(f);
    const late=deferred<typeof f.context>();f.workbench.getContext.mockReturnValueOnce(late.promise);
    const pending=store.load();store.stop();store.clearForSession();
    const next=await createWorkbenchFixture();next.context.resource_revision='NEW-SESSION';store.bindServices(next);await store.enterPlan(next.target);
    late.resolve({...f.context,resource_revision:'late-old'});await pending;
    expect(store.context?.resource_revision).toBe('NEW-SESSION');expect(store.error).toBe('');
    f.assertNoWrites();next.assertNoWrites();store.clearForSession();expect(store.context).toBeNull();expect(store.selected).toBeNull();expect(store.historyOpen).toBe(false);
  });
  it('查询失败保留已知快照，显式重试恢复；失权后不能提交或采纳',async()=>{
    const s=await start('planner'),f=await createWorkbenchFixture(),store=await enterWorkbenchStore(f),id=store.analysisId;
    f.workbench.getContext.mockRejectedValueOnce(new ApiError('查询中断','NETWORK_ERROR'));
    await store.query();expect(store.queryError).toContain('查询中断');expect(store.analysisId).toBe(id);
    await store.query();expect(store.queryError).toBe('');expect(store.selected!.state).toBe('SUCCESS');
    const identity=s.auth.identity!;s.auth.accept({...identity,permissions:['situation.view','planning.view']});
    const writes=s.storage.writes;await store.submitAnalysis();await store.adoptMeasure('UNIT-CM1');
    expect(store.executable).toBe(false);expect(store.adoptable).toBe(false);expect(s.storage.writes).toBe(writes);f.assertNoWrites();
  });
});

// 当前帧不持久化；失权冻结、成功退出清理，与其他业务的会话边界保持一致。
describe('态势监控会话',()=>{
  it('撤回规划查看权限停止设备/链路刷新，成功退出清理观测内存',async()=>{
    const s=await start('viewer'),fixture=await monitoringFixture('balanced',s.storage),monitor=useMonitoringStore();
    monitor.showNetwork();monitor.visible=true;await monitor.loadNetwork(fixture.plan.taskId);await settleMonitoring();
    const frame=monitor.networkResult!.frame.id;
    const w=readSystem(s.storage),role=w.roles.find(row=>row.id===s.auth.identity!.roleId)!;
    role.permissions=role.permissions.filter(p=>p!=='planning.view');writeSystem(s.storage,w);await s.auth.check();
    expect(monitor.networkReadable).toBe(false);expect(monitor.networkState.active).toBe(false);expect(monitor.networkResult!.frame.id).toBe(frame);
    s.auth.registerCleaner(monitor.clearForSession);expect(await s.auth.leaveSession()).toBe(true);
    expect(monitor.networkResult).toBeNull();expect(monitor.spectrumResult).toBeNull();expect(monitor.networkState.index).toBe(-1);
  });
  it('旧会话迟到帧不能覆盖新会话页面',async()=>{
    const s=await start('viewer'),fixture=await monitoringFixture('balanced',s.storage),monitor=useMonitoringStore();
    monitor.showNetwork();monitor.visible=true;await monitor.loadNetwork(fixture.plan.taskId);await settleMonitoring();
    const old=monitor.networkResult!,next=await fixture.monitoring.getMonitoringObservation({taskId:fixture.plan.taskId,networkKey:old.context.network!.key,index:1});
    let resolve!:(value:Awaited<ReturnType<typeof fixture.monitoring.getMonitoringObservation>>)=>void;
    vi.spyOn(previewService,'getMonitoringObservation').mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const request=monitor.refreshNetwork();await settleMonitoring();
    s.auth.registerCleaner(monitor.clearForSession);await s.auth.leaveSession();resolve(next);await request;await settleMonitoring();
    expect(monitor.networkResult).toBeNull();expect(monitor.networkState.index).toBe(-1);
  });
});
