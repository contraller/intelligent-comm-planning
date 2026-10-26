import { describe,it,expect,afterEach,vi } from 'vitest';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import { authFixture } from './helpers/auth';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { useAuthStore } from '../src/stores/auth';
import { useResourceReadStore } from '../src/stores/resource-read';
import { usePreviewStore } from '../src/stores/preview';
import { useTaskInputStore } from '../src/stores/task-input';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { emptyCandidateAssessment } from '../src/services/candidate-link';
// 底层联合服务仅保留兼容验证，当前 GIS 用户流程不再调用它。
describe('保留的底层联合 Mock 服务兼容',()=>{
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
    // 新增测试设备不继承原实例的端口清单，仍验证原有联合保存行为。
    const station={...structuredClone(source.stations[0]),id:'NEW-NODE',name:'新节点',origin:'MANUAL' as const},device={...structuredClone(source.devices[0]),ports:undefined,id:'NEW-DEVICE',stationId:station.id,txPowerDbm:40,origin:'MANUAL' as const};
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


describe('GIS 资源独立保存与校验',()=>{
  it('规划草稿无效也不参与 GIS 保存，资源成功后任务输入与保存版本均不变',async()=>{
    const pinia=createPinia();setActivePinia(pinia);
    try{
      const f=authFixture();f.bind();await f.login('admin');await useAuthStore().check();
      const preview=usePreviewStore(),planning=useTaskInputStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
      // 先通过当前入口保存基线，再验证 GIS 不采纳未保存任务修改。
      await preview.load();await useResourceReadStore().activate('planning');await planning.initialize('planning');expect(await planning.save()).toBe(true);
      gis.start();await useResourceReadStore().activate('gis');await gis.begin();
      const valid=JSON.parse(JSON.stringify(planning.draft));planning.updateInput({...valid,name:''});
      const tasks=await f.raw.loadTaskWorkspace(),before=JSON.stringify(planning.draft),baseline=JSON.stringify(planning.saved);
      await editor.openForm('station','ND-0100');editor.form!.fields.name='独立保存资源';
      expect(await gis.save(),editor.error).toBe(true);expect(gis.validationIssues).toEqual([]);
      expect(JSON.stringify(planning.draft)).toBe(before);expect(JSON.stringify(planning.saved)).toBe(baseline);expect(planning.changed).toBe(true);
      expect(await f.raw.loadTaskWorkspace()).toEqual(tasks);expect((await f.raw.loadPreview()).resources.stations.find(row=>row.id==='ND-0100')!.name).toBe('独立保存资源');
    }finally{vi.restoreAllMocks();disposePinia(pinia);}
  });
  it('资源应用失败进入资源清单，退出编辑与清理会话清除资源错误',async()=>{
    const pinia=createPinia();setActivePinia(pinia);
    try{
      const f=authFixture();f.bind();await f.login('resource');await useAuthStore().check();
      const preview=usePreviewStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();await preview.load();gis.start();await useResourceReadStore().activate('gis');await gis.begin();
      await editor.openForm('device','DV-0001');editor.form!.fields.txPowerDbm='bad';
      expect(editor.applyForm()).toBe(false);expect(gis.validationIssues[0]).toMatchObject({source:'resource',objectId:'DV-0001',field:'txPowerDbm'});
      editor.clearSession();expect(gis.validationIssues).toEqual([]);
      gis.clearForSession();expect(gis.validationIssues).toEqual([]);
    }finally{vi.restoreAllMocks();disposePinia(pinia);}
  });
});
describe('GIS 资源编辑与规划草稿隔离',()=>{
  let pinia:ReturnType<typeof createPinia>;
  afterEach(()=>{vi.restoreAllMocks();if(pinia)disposePinia(pinia);});
  it('只撤销重做资源；保存失败保留现场，成功不移动规划草稿基线',async()=>{
    pinia=createPinia();setActivePinia(pinia);const f=authFixture();f.bind();await f.login('planner');const w=readSystem(f.storage),role=w.roles.find(r=>r.id===w.accounts.find(a=>a.username==='planner')!.roleId)!;role.permissions=[...new Set([...role.permissions,'resources.view','resources.edit','situation.view'] as const)];writeSystem(f.storage,w);await useAuthStore().check();
    const preview=usePreviewStore(),planning=useTaskInputStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
    await preview.load();await useResourceReadStore().activate('planning');await planning.initialize('planning');expect(await planning.save()).toBe(true);
    gis.start();await useResourceReadStore().activate('gis');await gis.begin();
    const original=editor.resources.stations.find(s=>s.id==='ND-0100')!.name,baseline=JSON.stringify(planning.saved);
    await editor.openForm('station','ND-0100');editor.form!.fields.name='资源草稿';editor.applyForm();
    const steps=gis.undoStack.length;planning.updateInput({...JSON.parse(JSON.stringify(planning.draft)),name:'任务草稿'});expect(gis.undoStack).toHaveLength(steps);
    await gis.moveHistory('undo');expect(planning.draft!.name).toBe('任务草稿');expect(editor.resources.stations.find(s=>s.id==='ND-0100')!.name).toBe(original);
    await gis.moveHistory('redo');expect(planning.draft!.name).toBe('任务草稿');expect(editor.resources.stations.find(s=>s.id==='ND-0100')!.name).toBe('资源草稿');
    f.storage.failWrite=true;expect(await gis.save()).toBe(false);expect(editor.draftDirty).toBe(true);expect(planning.draft!.name).toBe('任务草稿');expect(gis.undoStack.length).toBeGreaterThan(0);
    f.storage.failWrite=false;expect(await gis.save(),editor.error).toBe(true);expect(editor.draftDirty).toBe(false);expect(planning.changed).toBe(true);expect(JSON.stringify(planning.saved)).toBe(baseline);expect(gis.undoStack).toHaveLength(0);
  });
  it('任务草稿与导入不进入资源历史，GIS离开与放弃资源不清理规划输入',async()=>{
    pinia=createPinia();setActivePinia(pinia);const f=authFixture();f.bind();await f.login('admin');await useAuthStore().check();
    const preview=usePreviewStore(),planning=useTaskInputStore(),gis=useGisWorkspaceStore();await preview.load();await useResourceReadStore().activate('planning');await planning.initialize('planning');gis.start();
    planning.updateInput({...JSON.parse(JSON.stringify(planning.draft)),name:'待保留任务草稿'});
    const file=await f.service.getTaskInputTemplate({context:'planning',format:'xlsx',input:JSON.parse(JSON.stringify(planning.draft))});await planning.previewImport([file]);
    expect(planning.importFiles).toHaveLength(1);expect(planning.importPreview).not.toBeNull();
    const before=JSON.stringify(planning.draft),request=JSON.stringify([planning.importFiles,planning.importPreview]),id=planning.taskId;
    expect(gis.dirty).toBe(false);expect(gis.undoStack).toHaveLength(0);expect(await gis.leave()).toBe(true);
    const editor=useResourceEditStore();expect(editor.decision).toBeNull();await useResourceReadStore().activate('gis');await gis.begin();await editor.openForm('station','ND-0100');editor.form!.fields.name='待放弃资源';editor.applyForm();
    const pending=gis.leave();editor.answer('discard');expect(await pending).toBe(true);
    expect(JSON.stringify(planning.draft)).toBe(before);expect(planning.taskId).toBe(id);expect(JSON.stringify([planning.importFiles,planning.importPreview])).toBe(request);expect(planning.dirty).toBe(true);
  });

});

describe('干扰分析前的 GIS 草稿决策',()=>{
  it.each(['save','discard','cancel'] as const)('%s 明确处理草稿，不隐式提交',async(choice)=>{
    const pinia=createPinia();setActivePinia(pinia);
    try{
      const f=authFixture();f.bind();await f.login('resource');await useAuthStore().check();
      const preview=usePreviewStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
      await preview.load();gis.start();await useResourceReadStore().activate('gis');await gis.begin();await editor.openForm('station','ND-0100');
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
