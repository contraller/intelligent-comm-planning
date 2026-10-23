import { describe,it,expect } from 'vitest';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import { saveTaskInput } from './helpers/tasks';
// 验证持久行为与历史不变量，不只校验序列化形状。
describe('任务独立保存与共享存储',()=>{
  it('读取不写入；保存任务只写共享键且不提升资源版本，刷新恢复',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);
    expect((await service.loadTaskWorkspace()).tasks).toEqual([]);expect(storage.writes).toBe(0);
    await saveTaskInput(storage,planningPresets[0].input,'T1');
    expect(storage.writeHistory).toEqual([RESOURCE_STORAGE_KEY]);expect(storage.getItem(PLANNING_STORAGE_KEY)).toBeNull();
    const fresh=createMockService(()=>storage),loaded=await fresh.loadPreview();
    expect(loaded.resourceMeta.revision).toBe('initial');expect(loaded.resourceMeta.savedAt).toBeNull();
    expect((await fresh.loadTaskWorkspace()).tasks[0].versions[0].input).toEqual(planningPresets[0].input);
  });
  it('名称说明只新增修订，规划条件变化与改回均产生新的条件版本',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),input=structuredClone(planningPresets[0].input);
    await saveTaskInput(storage,input,'T');input.name='重命名';await saveTaskInput(storage,input,'T');
    input.demands[0].maxDelayMs=101;await saveTaskInput(storage,input,'T');input.demands[0].maxDelayMs=100;await saveTaskInput(storage,input,'T');
    const versions=(await service.loadTaskWorkspace()).tasks[0].versions;
    expect(versions.map(v=>v.number)).toEqual([1,2,3,4]);
    expect(versions[0].conditionVersion).toBe(versions[1].conditionVersion);
    expect(new Set(versions.map(v=>v.conditionVersion)).size).toBe(3);
    expect(versions[0].input.name).toBe(planningPresets[0].input.name);
  });
  it('保存失败保留原字节；相同请求重试幂等，异内容拒绝',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),request={taskId:'T',input:structuredClone(planningPresets[0].input),requestId:'save',baseResourceRevision:'initial',baseTaskRevision:'initial'};
    storage.failWrite=true;await expect(service.saveTask(request)).rejects.toMatchObject({code:'STORAGE_WRITE_FAILED'});expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBeNull();
    storage.failWrite=false;await service.saveTask(request);const raw=storage.getItem(RESOURCE_STORAGE_KEY);
    await service.saveTask(request);expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);
    await expect(service.saveTask({...request,input:{...request.input,name:'其他'}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(raw);
  });
  it('资源维护与两个独立重置都保留任务库',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage);await saveTaskInput(storage,planningPresets[0].input,'T');
    const tasks=await service.loadTaskWorkspace();
    const r=await service.commitResources({baseRevision:'initial',stations:[{id:'ND-0001',name:'变化'}],devices:[]});
    await service.resetResources(r.meta.revision);await service.resetPlanningWorkspace(null);
    expect(await service.loadTaskWorkspace()).toEqual(tasks);
  });
  it('旧 v3 读取不写回且不丢新增资源；损坏任务记录拒绝覆盖',async()=>{
    const storage=new TestStorage(),service=createMockService(()=>storage),p=await service.loadPreview();
    await service.commitResources({baseRevision:'initial',stations:[],devices:[],newStations:[{...p.resources.stations[0],id:'NEW',origin:'MANUAL'}]});
    const record=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);record.schemaVersion=3;delete record.taskWorkspace;const old=JSON.stringify(record);storage.entries.set(RESOURCE_STORAGE_KEY,old);
    expect((await service.loadPreview()).resources.stations.some(n=>n.id==='NEW')).toBe(true);expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(old);
    await saveTaskInput(storage,planningPresets[0].input,'T');const next=JSON.parse(storage.getItem(RESOURCE_STORAGE_KEY)!);next.taskWorkspace.tasks.push(next.taskWorkspace.tasks[0]);
    const bad=JSON.stringify(next);storage.entries.set(RESOURCE_STORAGE_KEY,bad);await expect(service.loadTaskWorkspace()).rejects.toMatchObject({code:'STORAGE_CORRUPT'});await expect(service.resetResources(null)).rejects.toBeDefined();expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bad);
  });
});
