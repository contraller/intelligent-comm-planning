import { describe,it,expect,afterEach,vi } from 'vitest';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import { authFixture } from './helpers/auth';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { useAuthStore } from '../src/stores/auth';
import { usePreviewStore } from '../src/stores/preview';
import { usePlanningStore } from '../src/stores/planning';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { emptyCandidateAssessment } from '../src/services/candidate-link';
// 跨对象保存验证真实写入次数，避免串行两个成功提示伪装事务。
describe('GIS 资源任务整体保存',()=>{
  it.each(['success','invalid-task','invalid-candidate','write-failed'])('候选与新增节点设备任务保持一次原子保存：%s',async(mode)=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview(),source=before.resources,old=source.candidateLinks![0];
    const station={...structuredClone(source.stations.find(row=>row.id===old.nodeAId)!),id:'C-NODE',name:'候选新节点',origin:'MANUAL' as const};
    const device={...structuredClone(source.devices.find(row=>row.id===old.deviceAId)!),id:'C-DEVICE',stationId:station.id,txPowerDbm:40,origin:'MANUAL' as const};
    const link={...structuredClone(old),...emptyCandidateAssessment(),id:'C-LINK',nodeAId:station.id,deviceAId:mode==='invalid-candidate'?'NO-DEVICE':device.id,freqKhz:null,assessmentState:'PENDING' as const,reference:null,source:{kind:'MANUAL' as const,file:null,row:null}};
    const input=structuredClone(planningPresets[0].input);input.stationIds.push(station.id);input.demands[0].targetId=mode==='invalid-task'?'NO-NODE':station.id;
    const request={context:'gis' as const,requestId:'candidate-joint',baseResourceRevision:'initial',baseTaskRevision:'initial',changes:{stations:[],devices:[],newStations:[station],newDevices:[device],newCandidateLinks:[link]},task:{taskId:'C-TASK',input}};
    if(mode==='write-failed')storage.failWrite=true;
    if(mode!=='success'){await expect(service.commitGisWorkspace(request)).rejects.toBeDefined();expect(storage.writes).toBe(0);expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBeNull();return;}
    const saved=await service.commitGisWorkspace(request);expect(storage.writeHistory).toEqual([RESOURCE_STORAGE_KEY]);
    expect(saved.resources.candidateLinks!.find(row=>row.id===link.id)).toMatchObject({nodeAId:station.id,deviceAId:device.id,assessmentState:'PENDING'});
    expect(saved.tasks.tasks[0].versions[0].input.stationIds).toContain(station.id);
    await service.commitGisWorkspace(request);expect(storage.writes).toBe(1);
  });
  it('候选单独联合提交只变工作区事务版本，不变任务条件及原资源依赖',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),before=await service.loadPreview();
    const saved=await service.commitGisWorkspace({context:'gis',requestId:'candidate-only',baseResourceRevision:'initial',baseTaskRevision:'initial',changes:{stations:[],devices:[],candidateLinks:[{id:'LK-0001',isBackup:true}]},task:null});
    expect(saved.meta.revision).not.toBe('initial');expect(saved.tasks.revision).toBe('initial');expect(saved.tasks.tasks).toEqual([]);
    for(const field of ['resourceEpoch','stationVersions','deviceVersions','interferenceVersion','changedStationIds','changedDeviceIds'] as const)expect(saved.meta[field]).toEqual(before.resourceMeta[field]);
    expect((await service.loadPreview()).planning).toEqual(before.planning);
  });
  it.each(['success','invalid-task','write-failed'])('新增资源及任务一次提交：%s',async(mode)=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),source=(await service.loadPreview()).resources;
    const station={...structuredClone(source.stations[0]),id:'NEW-NODE',name:'新节点',origin:'MANUAL' as const},device={...structuredClone(source.devices[0]),id:'NEW-DEVICE',stationId:station.id,txPowerDbm:40,origin:'MANUAL' as const};
    const input=structuredClone(planningPresets[0].input);input.stationIds.push(station.id);input.demands[0].targetId=mode==='invalid-task'?'MISSING':station.id;
    if(mode==='write-failed')storage.failWrite=true;
    const request={context:'gis' as const,requestId:'combined',baseResourceRevision:'initial',baseTaskRevision:'initial',changes:{stations:[],devices:[],newStations:[station],newDevices:[device]},task:{taskId:'T',input}};
    if(mode!=='success'){await expect(service.commitGisWorkspace(request)).rejects.toBeDefined();expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBeNull();expect(storage.writes).toBe(0);return;}
    const saved=await service.commitGisWorkspace(request);expect(storage.writeHistory).toEqual([RESOURCE_STORAGE_KEY]);expect(saved.tasks.tasks[0].versions[0].input.stationIds).toContain(station.id);
    expect((await service.loadPreview()).resources.devices.find(d=>d.id===device.id)?.stationId).toBe(station.id);
    await service.commitGisWorkspace(request);expect(storage.writes).toBe(1);
  });
  it('旧任务版本冲突阻止资源部分保存',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    await service.saveTask({taskId:'T',input:structuredClone(planningPresets[0].input),baseResourceRevision:'initial',baseTaskRevision:'initial',requestId:'task'});
    const before=storage.getItem(RESOURCE_STORAGE_KEY);
    await expect(service.commitGisWorkspace({context:'gis',requestId:'stale',baseResourceRevision:'initial',baseTaskRevision:'initial',changes:{stations:[{id:'ND-0001',name:'不应写入'}],devices:[]},task:null})).rejects.toMatchObject({code:'TASK_REVISION_CONFLICT'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(before);
  });
});


describe('GIS 联合保存校验明细',()=>{
  it('任务错误数组进入 GIS 清单；失败不写入，修正保存后清理',async()=>{
    const pinia=createPinia();setActivePinia(pinia);
    try{
      const f=authFixture();f.bind();await f.login('planner');await useAuthStore().check();
      const preview=usePreviewStore(),planning=usePlanningStore(),gis=useGisWorkspaceStore();
      await preview.load();await planning.load();gis.start();
      const valid=JSON.parse(JSON.stringify(planning.draft));planning.updateDraft({...valid,name:''});
      const saved=f.storage.getItem(RESOURCE_STORAGE_KEY),before=JSON.stringify(planning.draft);
      expect(await gis.save()).toBe(false);expect(gis.taskIssues).toContainEqual(expect.objectContaining({source:'task',objectId:'TASK',field:'name'}));
      expect(gis.validationIssues).toEqual(gis.taskIssues);expect(JSON.stringify(planning.draft)).toBe(before);expect(f.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(saved);
      planning.updateDraft({...valid,name:'修正任务'});expect(await gis.save()).toBe(true);expect(gis.taskIssues).toEqual([]);expect(gis.validationIssues).toEqual([]);
    }finally{vi.restoreAllMocks();disposePinia(pinia);}
  });
  it('资源应用失败进入资源清单，退出编辑与新身份不保留任务错误',async()=>{
    const pinia=createPinia();setActivePinia(pinia);
    try{
      const f=authFixture();f.bind();await f.login('resource');await useAuthStore().check();
      const preview=usePreviewStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();await preview.load();gis.start();gis.begin();
      await editor.openForm('device','DV-0001','gis');editor.form!.fields.txPowerDbm='bad';
      expect(editor.applyForm()).toBe(false);expect(gis.validationIssues[0]).toMatchObject({source:'resource',objectId:'DV-0001',field:'txPowerDbm'});
      gis.taskIssues=[{source:'task',objectId:'TASK',field:'name',message:'未填'}];
      editor.clearSession();expect(gis.validationIssues).toEqual([]);
      gis.taskIssues=[{source:'task',objectId:'TASK',field:'name',message:'未填'}];gis.clearForSession();expect(gis.taskIssues).toEqual([]);
    }finally{vi.restoreAllMocks();disposePinia(pinia);}
  });
});
describe('GIS 联合编辑状态',()=>{
  let pinia:ReturnType<typeof createPinia>;
  afterEach(()=>{vi.restoreAllMocks();if(pinia)disposePinia(pinia);});
  it('资源与任务按顺序撤销重做；失败保留草稿、成功移动两份基线',async()=>{
    pinia=createPinia();setActivePinia(pinia);const f=authFixture();f.bind();await f.login('planner');const w=readSystem(f.storage),role=w.roles.find(r=>r.id===w.accounts.find(a=>a.username==='planner')!.roleId)!;role.permissions=[...new Set([...role.permissions,'resources.view','resources.edit','situation.view'] as const)];writeSystem(f.storage,w);await useAuthStore().check();
    const preview=usePreviewStore(),planning=usePlanningStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
    await preview.load();await planning.load();gis.start();gis.begin();
    await editor.openForm('station','ND-0100','gis');editor.form!.fields.name='资源草稿';editor.applyForm();
    const original=planning.draft!.name;planning.updateDraft({...JSON.parse(JSON.stringify(planning.draft)),name:'任务草稿'});
    await gis.moveHistory('undo');expect(planning.draft!.name).toBe(original);expect(editor.resources.stations.find(s=>s.id==='ND-0100')!.name).toBe('资源草稿');
    await gis.moveHistory('redo');expect(planning.draft!.name).toBe('任务草稿');
    f.storage.failWrite=true;expect(await gis.save()).toBe(false);expect(editor.draftDirty).toBe(true);expect(planning.draft!.name).toBe('任务草稿');expect(gis.undoStack.length).toBeGreaterThan(0);
    f.storage.failWrite=false;expect(await gis.save(),editor.error).toBe(true);expect(editor.draftDirty).toBe(false);expect(planning.needsTaskSave).toBe(false);expect(gis.undoStack).toHaveLength(0);
  });
  it('任务导入是一个撤销步骤，草稿变化使旧预览失效',async()=>{
    pinia=createPinia();setActivePinia(pinia);const f=authFixture();f.bind();await f.login('planner');await useAuthStore().check();
    const preview=usePreviewStore(),planning=usePlanningStore(),gis=useGisWorkspaceStore();await preview.load();await planning.load();gis.start();
    const original=JSON.parse(JSON.stringify(planning.draft)),id=planning.taskId,baselineId=planning.baselineTaskId;
    const file=await f.service.getTaskTemplate('xlsx');await planning.previewTaskFiles([file],'gis',gis.changes());
    planning.updateDraft({...JSON.parse(JSON.stringify(planning.draft)),name:'预览后的编辑'});expect(await planning.confirmTaskImport(gis.changes())).toBe(false);
    planning.discardTaskDraft();gis.clearHistory();await planning.previewTaskFiles([file],'gis',gis.changes());
    expect(await planning.confirmTaskImport(gis.changes())).toBe(true);expect(planning.taskId).toBe('TASK-IMPORT-DEMO');expect(gis.undoStack).toHaveLength(1);
    await gis.moveHistory('undo');expect(planning.taskId).toBe(id);expect(planning.baselineTaskId).toBe(baselineId);expect(planning.draft).toEqual(original);
    await gis.moveHistory('redo');expect(planning.taskId).toBe('TASK-IMPORT-DEMO');expect(planning.dirty).toBe(true);
  });

});

describe('干扰分析前的 GIS 草稿决策',()=>{
  it.each(['save','discard','cancel'] as const)('%s 明确处理草稿，不隐式提交',async(choice)=>{
    const pinia=createPinia();setActivePinia(pinia);
    try{
      const f=authFixture();f.bind();await f.login('resource');await useAuthStore().check();
      const preview=usePreviewStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
      await preview.load();gis.start();gis.begin();await editor.openForm('station','ND-0100','gis');
      editor.form!.fields.name='分析前未保存名称';editor.applyForm();
      const before=f.storage.getItem(RESOURCE_STORAGE_KEY),pending=gis.prepareAnalysis();
      expect(editor.decision).not.toBeNull();editor.answer(choice);
      expect(await pending).toBe(choice!=='cancel');
      expect(editor.dirty).toBe(choice==='cancel');
      expect(f.storage.getItem(RESOURCE_STORAGE_KEY)===before).toBe(choice!=='save');
      if(choice==='save')expect((await f.raw.loadPreview()).resources.stations.find(row=>row.id==='ND-0100')!.name).toBe('分析前未保存名称');
    }finally{vi.restoreAllMocks();disposePinia(pinia);}
  });
});
