import { describe, expect, it } from 'vitest';
import { createTaskHttp } from '../src/services/task-http';
import { taskTemplate } from '../src/services/task-files';
import { taskInputIssues } from '../src/services/task-api-validation';
import { input, taskDto, httpFixture, response } from './fixtures/planning-api';

const options={context:'planning' as const};
describe('任务输入 HTTP 契约',()=>{
  // 边界值必须经过页面校验和真实请求序列化，不能被正数校验或空值转换吞掉。
  it.each([0,1])('可靠性边界 %s 原值保存并可提交服务端预检',async minReliability=>{
    const candidate=input();candidate.demands[0].minReliability=minReliability;
    expect(taskInputIssues(candidate)).toEqual([]);
    const f=httpFixture(path=>response(path.endsWith('/validate')?{valid:true,issues:[],task:null}:{...taskDto(),input:candidate})),service=createTaskHttp(f.request);
    const request={...options,taskId:'T1',revision:'t1',resourceRevision:'r1',input:candidate};
    expect((await service.saveTaskInput({...request,requestId:'reliability'})).input.demands[0].minReliability).toBe(minReliability);
    expect((await service.validateTaskInputApi(request)).valid).toBe(true);
    const calls=f.calls.filter(c=>c.path.includes('/task-inputs'));
    expect(calls).toHaveLength(2);
    for(const call of calls)expect(JSON.parse(String(call.init.body)).input.demands[0].minReliability).toBe(minReliability);
  });
  it.each([-0.01,1.01,null,undefined,NaN,Infinity,-Infinity])('无效可靠性 %s 给出范围提示且不发送保存请求',async minReliability=>{
    const candidate=input();Object.assign(candidate.demands[0],{minReliability});
    expect(taskInputIssues(candidate)).toContainEqual({objectId:'D1',field:'minReliability',message:'可靠性必填，范围为 0–1'});
    const f=httpFixture(()=>response(taskDto()));
    await expect(createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'invalid-reliability',input:candidate})).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each(['requiredRateKbps','maxDelayMs'] as const)('%s 仍拒绝零，可靠性放宽不改变速率和时延',async field=>{
    const candidate=input();candidate.demands[0].minReliability=0;candidate.demands[0][field]=0;
    expect(taskInputIssues(candidate)).toEqual([{objectId:'D1',field,message:'请输入有效正数'}]);
    const f=httpFixture(()=>response(taskDto()));
    await expect(createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'invalid-positive',input:candidate})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(f.calls).toEqual([]);
  });
  it.each([null,'2024-02-29T09:00:00+08:00','2000-02-29T23:59:59.123456Z','2026-10-15T09:00:00-05:30','2026-10-15T09:00:00+14:00'])('合法任务日期 %s 原样往返，不转换时区或空值',async startTime=>{
    const candidate=input();candidate.startTime=startTime;
    expect(taskInputIssues(candidate)).toEqual([]);
    const f=httpFixture(()=>response({...taskDto(),input:candidate}));
    const saved=await createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'valid-date',input:candidate});
    expect(saved.input.startTime).toBe(startTime);
    expect(JSON.parse(String(f.calls.at(-1)!.init.body)).input.startTime).toBe(startTime);
  });
  it.each([
    '2026-02-30T09:00:00+08:00','2026-02-29T09:00:00Z','1900-02-29T09:00:00Z',
    '2026-04-31T09:00:00Z','2026-00-01T09:00:00Z','2026-13-01T09:00:00Z','2026-01-00T09:00:00Z',
    '2026/10/15 09:00:00+08:00','2026-10-15T09:00:00','2026-10-15T09:00:00+0800',
    '2026-10-15T24:00:00Z','2026-10-15T09:60:00Z','2026-10-15T09:00:60Z',
    '2026-10-15T09:00:00+15:00','2026-10-15T09:00:00+08:60',
  ])('无效任务日期 %s 不自动归一化，也不发送业务请求',async startTime=>{
    const candidate=input();candidate.startTime=startTime;
    expect(taskInputIssues(candidate)).toContainEqual({objectId:'',field:'startTime',message:'时间须为带时区的有效 ISO 8601 文本'});
    const f=httpFixture(()=>response(taskDto()));
    await expect(createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'invalid-date',input:candidate})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
    expect(f.calls).toEqual([]);
  });
  it('任务响应的开始时间和更新时间均拒绝无效日历，合法更新时间保留原时区',async()=>{
    for(const field of ['startTime','updated_at'] as const){
      const dto=taskDto();if(field==='startTime')dto.input.startTime='2026-02-30T09:00:00+08:00';else dto.updated_at='2026-02-30T09:00:00+08:00';
      const f=httpFixture(()=>response(dto));
      await expect(createTaskHttp(f.request).getTaskInput({...options,taskId:'T1'})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
    }
    const updated_at='2024-02-29T09:00:00.123+08:00',f=httpFixture(()=>response({...taskDto(),updated_at}));
    expect((await createTaskHttp(f.request).getTaskInput({...options,taskId:'T1'})).updatedAt).toBe(updated_at);
  });
  it('保存的成功包络内输入无效时标记响应错误，不能当成本地校验拒绝',async()=>{
    const bad=taskDto();bad.input.demands[0].requiredRateKbps=0;const f=httpFixture(()=>response(bad));
    await expect(createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'bad-reply',input:input()})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
  });
  it('任务分页不读取完整资源，并保留独立的输入与条件版本',async()=>{
    const f=httpFixture(()=>response({items:[taskDto()],page:2,page_size:10,total:11})),service=createTaskHttp(f.request);
    const page=await service.queryTaskInputs({...options,pageNum:2,pageSize:10,search:'通信'});
    expect(page.items[0]).toMatchObject({taskId:'T1',revision:'t1',inputVersion:'i1',conditionVersion:'c1'});
    expect(f.calls.at(-1)!.path).toContain('/task-inputs?context=planning&page=2&page_size=10&search=');
    expect(f.calls.some(c=>c.path.includes('/resource/'))).toBe(false);
  });
  it('保存携带原版本、资源版本、幂等 ID 和当前会话 CSRF',async()=>{
    const f=httpFixture(()=>response(taskDto())),service=createTaskHttp(f.request);
    await service.saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'save-1',input:input()});
    const c=f.calls.at(-1)!;expect(c.init.method).toBe('PUT');expect(JSON.parse(String(c.init.body))).toMatchObject({request_id:'save-1',expected_revision:'t1',resource_revision:'r1'});
    expect(new Headers(c.init.headers).get('X-CSRF-Token')).toBe('csrf1');expect(new Headers(c.init.headers).get('X-Session-Id')).toBe('session1');expect(c.init.credentials).toBe('same-origin');
  });
  it('任意合法输入可保存，不检查 Mock 档位是否匹配',async()=>{
    const custom=input();custom.demands[0].requiredRateKbps=777;
    const f=httpFixture(()=>response({...taskDto(),input:custom}));expect((await createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:null,resourceRevision:'r1',requestId:'custom',input:custom})).input.demands[0].requiredRateKbps).toBe(777);
  });
  it('版本冲突及失败建议保留，不返回伪造保存成功',async()=>{
    const detail={expected:'t1',actual:'t2',suggestions:['重新打开任务']},f=httpFixture(()=>response(detail,1203,409));
    await expect(createTaskHttp(f.request).saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'save-2',input:input()})).rejects.toMatchObject({status:409,code:1203,data:detail,requestId:'response-id'});
  });
  it('导入上传原文件供服务端预检，不调用本地解析或任务保存',async()=>{
    const files=await Promise.all(['task_scenarios','task_links'].map(k=>taskTemplate('csv',k as 'task_links',input())));
    const f=httpFixture((path,init)=>{const body=JSON.parse(String(init.body));expect(path).toBe('/api/v1/task-files/preview');expect(body.input.stationIds).toEqual(['N1','N2']);expect(body.files).toHaveLength(2);expect(body.files.every((file:{bytes_base64:string})=>!!file.bytes_base64)).toBe(true);return response({taskId:'TASK-NEW',input:input(),issues:[],notes:[],differences:[],signature:'a'.repeat(64),existing:false,taskRevision:null,resourceRevision:'r1',requestContext:{context:'planning',taskId:'T1',taskRevision:'t1',resourceRevision:'r1'}});});
    const result=await createTaskHttp(f.request).previewTaskInputImport({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',input:input(),files:files.map(x=>({name:x.name,bytes:x.bytes}))});
    expect(result.input?.demands).toHaveLength(1);expect(result.taskId).toBe('TASK-NEW');expect(f.calls.filter(c=>!c.path.includes('/auth/')).map(c=>c.path)).toEqual(['/api/v1/task-files/preview']);
  });
  it('响应归属、页码、重复 ID 与回执归属不一致时拒绝',async()=>{
    const f=httpFixture(()=>response({...taskDto(),task_id:'OTHER'}));await expect(createTaskHttp(f.request).getTaskInput({...options,taskId:'T1'})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
    const duplicate=httpFixture(()=>response({items:[taskDto(),taskDto()],page:1,page_size:10,total:2}));await expect(createTaskHttp(duplicate.request).queryTaskInputs({...options,pageNum:1,pageSize:10})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
    const receipt=httpFixture(()=>response({request_id:'other',task_id:'T1',kind:'saveTask',state:'SUCCEEDED',entity_id:'T1',message:'完成'}));await expect(createTaskHttp(receipt.request).getPlanningOperation({...options,requestId:'request',taskId:'T1',kind:'saveTask'})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
  });
  it('写入超时只发一次请求，后续按同一请求 ID 查询回执',async()=>{
    const f=httpFixture((path)=>path.includes('/planning-operations/')?response({request_id:'lost',task_id:'T1',kind:'saveTask',state:'SUCCEEDED',entity_id:'T1',message:'已保存'}):new Promise(()=>{}),10),service=createTaskHttp(f.request);
    await expect(service.saveTaskInput({...options,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'lost',input:input()})).rejects.toMatchObject({code:'REQUEST_TIMEOUT'});
    const receipt=await service.getPlanningOperation({...options,requestId:'lost',taskId:'T1',kind:'saveTask'});expect(receipt.state).toBe('SUCCEEDED');expect(f.calls.filter(c=>c.init.method==='PUT')).toHaveLength(1);
  });
});
