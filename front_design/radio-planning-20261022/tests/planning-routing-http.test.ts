import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskHttp } from '../src/services/task-http';
import { createPlanningHttp } from '../src/services/planning-http';
import { readApiPlan } from '../src/services/planning-api-validation';
import { taskTemplate } from '../src/services/task-files';
import { input,taskDto,jobDto,planDto,httpFixture,response } from './fixtures/planning-api';
const value=()=>{const v=input();Object.assign(v.demands[0],{routeStrategy:'SHORTEST_PATH',needBackup:false});return v;};
const request=()=>({context:'planning' as const,taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'save-routing',input:value()});
afterEach(()=>vi.restoreAllMocks());
// 拦截响应仅验证HTTP适配契约，不表示真实接口联调通过。
describe('路由请求HTTP保存与回显',()=>{
  it('任务完整保存，sr4仍按保存版本提交',async()=>{
    const f=httpFixture(path=>response(path.endsWith('/plan/sr4-flow')?{...jobDto(),input:value()}:{...taskDto(),input:value()}));
    expect((await createTaskHttp(f.request).saveTaskInput(request())).input).toEqual(value());
    expect(JSON.parse(String(f.calls.find(c=>c.path.includes('/task-inputs/'))!.init.body)).input.demands[0].needBackup).toBe(false);
    const job=await createPlanningHttp(f.request,()=>'/api/v1').submitPlanningTask({context:'planning',taskId:'T1',revision:'t1',inputVersion:'i1',conditionVersion:'c1',resourceRevision:'r1',parentPlanId:null,requestId:'run-routing'});
    expect(job.input).toEqual(value());const body=JSON.parse(String(f.calls.at(-1)!.init.body));expect(body).not.toHaveProperty('input');expect(body).not.toHaveProperty('demands');expect(f.calls.some(c=>c.path.endsWith('/plan/route'))).toBe(false);
  });
  it.each(['missing','changed','bad'])('服务 %s 回显不伪装保存成功',async mode=>{
    const returned=value();if(mode==='missing')delete returned.demands[0].needBackup;else if(mode==='changed')returned.demands[0].needBackup=true;else Object.assign(returned.demands[0],{needBackup:'false'});
    const f=httpFixture(()=>response({...taskDto(),input:returned}));await expect(createTaskHttp(f.request).saveTaskInput(request())).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
  });
  it('保存方案回读原样保留，非法策略拒绝',()=>{
    expect(readApiPlan({...planDto(),input:value()},{taskId:'T1'}).input).toEqual(value());const bad=value();Object.assign(bad.demands[0],{routeStrategy:['MIN_DELAY']});expect(()=>readApiPlan({...planDto(),input:bad},{taskId:'T1'})).toThrow();
  });
  it('同编号服务任务的已有路由要求在旧模板导入时提示清空',async()=>{
    const file=await taskTemplate('xlsx','task_scenarios',input());
    const f=httpFixture(()=>response({valid:true,issues:[],task:{...taskDto(),task_id:'TASK-NEW',input:value()}}));
    const result=await createTaskHttp(f.request).previewTaskInputImport({...request(),input:input(),files:[file]});
    expect(result.notes.join('')).toContain('清空');expect(result.input!.demands[0]).not.toHaveProperty('needBackup');
  });
});
