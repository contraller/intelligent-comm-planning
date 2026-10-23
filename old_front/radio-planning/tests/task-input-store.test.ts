import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePinia } from 'pinia';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { useTaskInputStore } from '../src/stores/task-input';
import { apiTask, input, storeFixture } from './fixtures/planning-api';
const sessions:Awaited<ReturnType<typeof storeFixture>>[]=[];
async function setup(){const f=await storeFixture();sessions.push(f);return f;}
afterEach(()=>{for(const f of sessions.splice(0)){f.task.clearForSession();disposePinia(f.pinia);}vi.restoreAllMocks();});
describe('双页任务草稿与保存',()=>{
  // 校验竞态中的用户输入和已发送请求，避免恢复权限后重复写入。
  it('保存返回时权限已变化，保留请求回执并冻结原草稿',async()=>{
    const {task,auth}=await setup();task.draft!.name='保存中的输入';
    vi.spyOn(previewService,'saveTaskInput').mockImplementationOnce(async()=>{auth.accept({...auth.identity!,permissions:[]});task.stop();return {...apiTask(),revision:'t2'};});
    expect(await task.save()).toBe(false);expect(task.pendingSave?.requestId).toBeTruthy();expect(task.draft!.name).toBe('保存中的输入');expect(task.saved!.revision).toBe('t1');
  });
  it('核实导入目标期间的新输入不会被预览覆盖',async()=>{
    const {task}=await setup();vi.spyOn(previewService,'previewTaskInputImport').mockResolvedValue({input:input(),taskId:'T1',issues:[],notes:[],signature:'sig',existing:true,differences:[],taskRevision:'t1',resourceRevision:'r1'});
    await task.previewImport([{name:'x.xlsx',bytes:new Uint8Array([1])}]);
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(async()=>{task.draft!.description='核实期间编辑';return apiTask();});
    expect(await task.applyImport()).toBe(false);expect(task.draft!.description).toBe('核实期间编辑');expect(task.importFiles).toHaveLength(1);
  });
  it('GIS 与规划共用同一草稿，重新进入不会用默认值覆盖编辑',async()=>{
    const {task}=await setup();task.draft!.name='未保存内容';await task.initialize('gis');expect(useTaskInputStore()).toBe(task);expect(task.draft!.name).toBe('未保存内容');expect(task.dirty).toBe(true);expect(task.context).toBe('gis');
  });
  it('保存失败保留草稿和基线，确认成功才替换版本',async()=>{
    const {task}=await setup();task.draft!.name='新名称';const save=vi.spyOn(previewService,'saveTaskInput').mockRejectedValueOnce(new ApiError('版本冲突',1203,{},'r',409));
    expect(await task.save()).toBe(false);expect(task.saved!.revision).toBe('t1');expect(task.draft!.name).toBe('新名称');expect(task.pendingSave).toBeNull();
    save.mockResolvedValueOnce({...apiTask(),revision:'t2',inputVersion:'i2',input:{...input(),name:'新名称'}});expect(await task.save()).toBe(true);expect(task.saved!.revision).toBe('t2');expect(task.dirty).toBe(false);
  });
  it('超时保留原请求并禁止新写入，回执核实后恢复保存状态',async()=>{
    const {task}=await setup();task.draft!.name='保存超时';const save=vi.spyOn(previewService,'saveTaskInput').mockRejectedValue(new ApiError('超时','REQUEST_TIMEOUT'));
    await task.save();const id=task.pendingSave!.requestId;expect(task.editable).toBe(false);await task.save();expect(save).toHaveBeenCalledTimes(1);
    vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({requestId:id,taskId:'T1',kind:'saveTask',state:'SUCCEEDED',entityId:'T1',message:'已写入'});vi.mocked(previewService.getTaskInput).mockResolvedValue({...apiTask(),revision:'t2',input:{...input(),name:'保存超时'}});
    await task.reconcileSave();expect(task.pendingSave).toBeNull();expect(task.saved!.revision).toBe('t2');expect(save).toHaveBeenCalledTimes(1);
  });
  it('导入预览只替换草稿，版本或草稿变化后必须重新校验',async()=>{
    const {task}=await setup(),candidate={...input(),name:'导入名称'};
    vi.spyOn(previewService,'previewTaskInputImport').mockResolvedValue({input:candidate,taskId:'T1',issues:[],notes:[],signature:'sig',existing:true,differences:[],taskRevision:'t1',resourceRevision:'r1'});
    const save=vi.spyOn(previewService,'saveTaskInput');await task.previewImport([{name:'x.xlsx',bytes:new Uint8Array([1])}]);task.draft!.description='预览后改动';expect(await task.applyImport()).toBe(false);expect(task.error).toContain('重新校验');
    await task.previewImport(task.importFiles);vi.mocked(previewService.getTaskInput).mockResolvedValue({...apiTask(),revision:'t2'});expect(await task.applyImport()).toBe(false);expect(task.error).toContain('预览后已变化');
    vi.mocked(previewService.getTaskInput).mockResolvedValue(apiTask());expect(await task.applyImport()).toBe(true);expect(task.draft!.name).toBe('导入名称');expect(task.saved!.input.name).toBe('测试通信任务');expect(save).not.toHaveBeenCalled();
  });
  it('快速打开任务与身份变化均丢弃迟到响应',async()=>{
    const {task,auth}=await setup();let resolve!:(t:ReturnType<typeof apiTask>)=>void;
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(()=>new Promise(r=>resolve=r));const old=task.open('OLD');await task.open('T1');resolve({...apiTask(),taskId:'OLD'});await old;expect(task.taskId).toBe('T1');
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(()=>new Promise(r=>resolve=r));const swapped=task.open('OTHER');await vi.waitFor(()=>expect(vi.mocked(previewService.getTaskInput).mock.calls.at(-1)![0].taskId).toBe('OTHER'));auth.accept({...auth.identity!,sessionId:'new-user'});resolve({...apiTask(),taskId:'OTHER'});await swapped;expect(task.taskId).toBe('T1');
  });
  it('失去权限保留草稿，明确清理后移除所有任务现场',async()=>{
    const {task,auth}=await setup();task.draft!.name='保留输入';auth.accept({...auth.identity!,permissions:[]});expect(task.editable).toBe(false);expect(task.draft!.name).toBe('保留输入');task.clearForSession();expect(task.draft).toBeNull();expect(task.catalog).toBeNull();expect(task.nodes).toEqual([]);
  });
  it('未保存离开支持取消、保存失败和明确放弃',async()=>{
    const {task}=await setup();task.draft!.name='新名称';let decision=task.allowLeave();task.answer('cancel');expect(await decision).toBe(false);expect(task.dirty).toBe(true);
    vi.spyOn(previewService,'saveTaskInput').mockRejectedValue(new ApiError('冲突','REVISION_CONFLICT'));decision=task.allowLeave();task.answer('save');expect(await decision).toBe(false);
    decision=task.allowLeave();task.answer('discard');expect(await decision).toBe(true);expect(task.draft!.name).toBe('测试通信任务');expect(task.dirty).toBe(false);
  });
});
