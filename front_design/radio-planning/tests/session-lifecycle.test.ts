import { useMonitoringStore } from '../src/stores/monitoring';
import { monitoringFixture, settleMonitoring } from './helpers/monitoring';
import type { MonitoringFrameResult } from '../src/types/monitoring';
import { useInterferenceStore } from '../src/stores/interference';
import { interferenceFixture } from './helpers/interference';
import { savedRequest,taskMeta } from './helpers/tasks';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { usePlanningStore } from '../src/stores/planning';
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
    const s=await start(),preview=usePreviewStore(),editor=useResourceEditStore();await preview.load();await editor.openForm('device','DV-0001','ledger');editor.form!.fields.antennaHeightM='18';
    s.auth.registerLeave(()=>editor.leave(true),()=>editor.dirty);s.auth.registerCleaner(editor.clearSession);s.auth.registerCleaner(preview.clearForSession);
    let leave=s.auth.leaveSession();editor.answer('cancel');expect(await leave).toBe(false);expect(editor.dirty).toBe(true);
    s.sessions.failWrite=true;leave=s.auth.leaveSession();editor.answer('discard');expect(await leave).toBe(false);expect(editor.form!.fields.antennaHeightM).toBe('18');expect(editor.dirty).toBe(true);
    s.sessions.failWrite=false;leave=s.auth.leaveSession();editor.answer('discard');expect(await leave).toBe(true);expect(editor.form).toBeNull();expect(preview.data).toBeNull();
  });
  it('停用冻结草稿并禁止保存，明确丢弃前输入不变',async()=>{
    const s=await start(),preview=usePreviewStore(),editor=useResourceEditStore();await preview.load();await editor.openForm('device','DV-0001','ledger');editor.form!.fields.antennaHeightM='19';s.auth.currentPath='/resources';
    const w=readSystem(s.storage);w.accounts.find(a=>a.id==='SYS-RESOURCE')!.enabled=false;writeSystem(s.storage,w);await s.auth.check();expect(s.auth.blocked).toBe(true);expect(await editor.save()).toBe(false);expect(editor.form!.fields.antennaHeightM).toBe('19');
    s.auth.registerCleaner(editor.clearSession);expect(await s.auth.discardRestricted()).toBe(true);expect(editor.form).toBeNull();
  });
  it('仅读写权限收回保留可查看草稿，恢复权限后仍能保存',async()=>{
    const s=await start(),preview=usePreviewStore(),editor=useResourceEditStore();await preview.load();await editor.openForm('device','DV-0001','ledger');editor.form!.fields.antennaHeightM='20';s.auth.currentPath='/resources';
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
    const s=await start('planner'),store=usePlanningStore();await store.load();expect(await store.saveTask()).toBe(true);expect(await store.submit()).toBe(true);
    const before=JSON.stringify([...s.storage.entries].filter(([k])=>k.includes('planning-workspace')));
    s.auth.registerCleaner(store.clearForSession);expect(await s.auth.leaveSession()).toBe(true);expect(store.workspace).toBeNull();
    expect(JSON.stringify([...s.storage.entries].filter(([k])=>k.includes('planning-workspace')))).toBe(before);
  });
  it('知识退出标记写失败时放弃选择不提前丢弃草稿和审核文本',async()=>{
    const s=await start('kg_editor'),store=useKnowledgeStore();await store.load();await store.openChange(store.workspace!.changes.find(c=>c.state==='DRAFT')!);store.draft!.summary='未保存知识';
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
    await editor.newForm('station','gis');editor.form!.fields.name='未完成站点';
    let leaving=editor.leave();editor.answer('cancel');expect(await leaving).toBe(false);expect(editor.form!.fields.name).toBe('未完成站点');
    editor.clearSession();await editor.openImport('ledger');
    await editor.previewImport({name:'bad.csv',bytes:new TextEncoder().encode('wrong\nvalue')});
    leaving=editor.leave();expect(editor.decision?.saveLabel).toBeUndefined();editor.answer('save');
    expect(await leaving).toBe(false);expect(editor.importFile).not.toBeNull();
    s.auth.registerCleaner(editor.clearSession);await s.auth.discardRestricted();expect(editor.importFile).toBeNull();
  });
  it('旧频谱加载结果与旧资源保存错误不污染新会话',async()=>{
    const s=await start(),spectrum=useSpectrumStore(),preview=usePreviewStore(),editor=useResourceEditStore();
    let resolve!:(w:SpectrumWorkspace)=>void;const initial=await s.raw.loadSpectrumWorkspace();
    vi.spyOn(previewService,'loadSpectrumWorkspace').mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const loading=spectrum.load();spectrum.clearForSession();
    await preview.load();await editor.newForm('station','ledger');
    Object.assign(editor.form!.fields,{name:'A',longitude:'114.6',latitude:'37.5'});
    let reject!:(e:Error)=>void;vi.spyOn(previewService,'commitResources').mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
    const saving=editor.save();editor.clearSession();preview.clearForSession();
    await s.service.logout();await s.login('viewer');await s.auth.check();
    resolve(initial);reject(new ApiError('旧保存失败','SESSION_CHANGED'));await loading;await saving;
    expect(spectrum.workspace).toBeNull();expect(spectrum.error).toBe('');expect(editor.error).toBe('');expect(editor.form).toBeNull();
  });
});

describe('独立任务的会话隔离',()=>{
  it('旧任务保存响应不能覆盖重新登录后的任务草稿',async()=>{
    const s=await start('planner'),preview=usePreviewStore(),planning=usePlanningStore();await preview.load();await planning.load();
    let complete!:(value:Awaited<ReturnType<typeof previewService.saveTask>>)=>void;
    const original=s.raw.saveTask.bind(s.raw),spy=vi.spyOn(previewService,'saveTask').mockImplementationOnce(async r=>{
      const saved=await original(r);return new Promise(resolve=>{complete=()=>resolve(saved);});
    });
    const pending=planning.saveTask();await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));
    planning.clearForSession();preview.clearForSession();await s.service.logout();await s.login('viewer');await s.auth.check();await planning.load();
    const before=JSON.stringify(planning.draft);complete(undefined as never);expect(await pending).toBe(false);expect(JSON.stringify(planning.draft)).toBe(before);expect(planning.notice).toBe('');spy.mockRestore();
  });
});

describe('干扰状态会话隔离',()=>{
  it('措施和分析切换重置实际显示，失败保留快照而成功缺省响应清除旧预览',async()=>{
    const s=await start('planner'),simulation=await interferenceFixture('balanced',s.storage);
    Object.assign(s.raw,simulation.service,simulation.planning);
    await simulation.submit();simulation.advance();const store=useInterferenceStore();await store.load();
    store.inspectMeasure(store.selected!.result!.measures[0]);store.after=true;
    const preview=JSON.stringify(store.selectedMeasurePreview),impact=JSON.stringify(store.impact);
    vi.spyOn(previewService,'getInterferenceAnalysis').mockRejectedValueOnce(new ApiError('读取中断','NETWORK_ERROR'));
    await store.query();expect(store.queryError).toContain('读取中断');expect(store.effectiveAfter).toBe(true);
    expect(JSON.stringify(store.selectedMeasurePreview)).toBe(preview);expect(JSON.stringify(store.impact)).toBe(impact);
    store.inspectMeasure(store.selected!.result!.measures[1]);expect(store.after).toBe(false);
    expect(store.selectedMeasurePreview!.measureId).toBe(store.measureId);store.after=true;
    const next=await simulation.service.getInterferenceAnalysis(store.analysisId);
    vi.spyOn(previewService,'getInterferenceAnalysis').mockResolvedValueOnce({...next,measurePreviews:undefined});
    await store.query();expect(store.queryError).toBe('');expect(store.canPreviewAfter).toBe(false);
    expect(store.selectedMeasurePreview).toBeNull();expect(store.effectiveAfter).toBe(false);expect(store.impact).toEqual(next.result!.impact);
    const writes=s.storage.writes;expect(await store.adopt()).toBeUndefined();expect(s.storage.writes).toBe(writes);
    expect(store.error).toContain('未提供完整措施预览');
    await store.query();store.after=true;expect(store.effectiveAfter).toBe(true);
    const second=await simulation.submit();simulation.advance();await store.load();
    store.analysisId=second.view.run.analysisId;
    expect(store.measureId).toBe('');expect(store.measureOpen).toBe(false);expect(store.effectiveAfter).toBe(false);
  });
  it('预览重复、结构不完整或缺少措施后影响均不能显示后态',async()=>{
    const s=await start('planner'),simulation=await interferenceFixture('balanced',s.storage);
    Object.assign(s.raw,simulation.service,simulation.planning);await simulation.submit();simulation.advance();
    const store=useInterferenceStore();await store.load();store.inspectMeasure(store.selected!.result!.measures[0]);
    const original=await simulation.service.getInterferenceAnalysis(store.analysisId),entry=original.measurePreviews![0];
    store.views=[{...original,measurePreviews:[entry,entry]}];expect(store.canPreviewAfter).toBe(false);
    store.views=[{...original,measurePreviews:[{...entry,result:{...entry.result!,configuration:undefined} as never}]}];
    expect(store.previewUnavailableReason).toContain('完整措施预览');
    const noImpact=structuredClone(original);noImpact.result!.measures[0].after=null;store.views=[noImpact];store.after=true;
    expect(store.canPreviewAfter).toBe(false);expect(store.effectiveAfter).toBe(false);expect(store.impact).toEqual(original.result!.impact);
    expect(store.previewUnavailableReason).toContain('措施后影响');
  });
  it('退出后的迟到查询不能重新带回完整预览或影响统计',async()=>{
    const s=await start('planner'),simulation=await interferenceFixture('balanced',s.storage);
    Object.assign(s.raw,simulation.service,simulation.planning);await simulation.submit();simulation.advance();
    const store=useInterferenceStore();await store.load();store.inspectMeasure(store.selected!.result!.measures[0]);store.after=true;
    const result=await simulation.service.getInterferenceAnalysis(store.analysisId);
    let resolve!:(view:typeof result)=>void;
    vi.spyOn(previewService,'getInterferenceAnalysis').mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const pending=store.query();store.clearForSession();resolve(result);await pending;
    expect(store.views).toEqual([]);expect(store.selectedMeasurePreview).toBeNull();expect(store.effectiveAfter).toBe(false);expect(store.impact).toBeNull();
  });
  it('离页/换账号不取消已提交分析，迟到加载不能覆盖新缓存',async()=>{
    const s=await start('planner'),simulation=await interferenceFixture('balanced',s.storage);
    Object.assign(s.raw,simulation.service,simulation.planning);
    const submitted=await simulation.submit(),loaded=await simulation.service.loadInterferenceWorkspace();
    const store=useInterferenceStore();let resolve!:(v:typeof loaded)=>void;
    vi.spyOn(previewService,'loadInterferenceWorkspace').mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const pending=store.load();store.clearForSession();await store.load();
    const revision=store.workspace!.revision;
    resolve({...loaded,workspace:{...loaded.workspace,revision:'late-old'}});await pending;
    expect(store.workspace!.revision).toBe(revision);expect(store.error).toBe('');
    store.stop();simulation.advance();expect((await simulation.service.getInterferenceAnalysis(submitted.view.run.analysisId)).state).toBe('SUCCESS');
    store.clearForSession();expect(store.workspace).toBeNull();expect(store.views).toEqual([]);expect(store.historyOpen).toBe(false);
  });
  it('查询失败保留已知快照，显式重试恢复；失权后不能提交或采纳',async()=>{
    const s=await start('planner'),simulation=await interferenceFixture('balanced',s.storage);
    Object.assign(s.raw,simulation.service,simulation.planning);
    await simulation.submit();const store=useInterferenceStore();await store.load();
    const id=store.analysisId;
    vi.spyOn(previewService,'getInterferenceAnalysis').mockRejectedValueOnce(new ApiError('查询中断','NETWORK_ERROR'));
    await store.query();expect(store.queryError).toContain('状态未确认');expect(store.analysisId).toBe(id);
    simulation.advance();await store.query();expect(store.queryError).toBe('');expect(store.selected!.state).toBe('SUCCESS');
    const identity=s.auth.identity!;s.auth.accept({...identity,permissions:['situation.view','planning.view']});
    const writes=s.storage.writes;
    expect(await store.submit()).toBe(false);expect(await store.adopt()).toBeUndefined();expect(s.storage.writes).toBe(writes);
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
    const old=monitor.networkResult!,next=await fixture.monitoring.getMonitoringFrame({taskId:fixture.plan.taskId,networkKey:old.context.network!.key,index:1});
    let resolve!:(value:MonitoringFrameResult)=>void;
    vi.spyOn(previewService,'getMonitoringFrame').mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const request=monitor.refreshNetwork();await settleMonitoring();
    s.auth.registerCleaner(monitor.clearForSession);await s.auth.leaveSession();resolve(next);await request;await settleMonitoring();
    expect(monitor.networkResult).toBeNull();expect(monitor.networkState.index).toBe(-1);
  });
});
