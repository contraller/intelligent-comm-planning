import { afterEach,describe,expect,it,vi } from 'vitest';
import { disposePinia } from 'pinia';
import { createTaskHttp } from '../src/services/task-http';
import { createPlanningHttp } from '../src/services/planning-http';
import { readApiPlan,readPlanningCatalog } from '../src/services/planning-api-validation';
import { emptyDeploymentConstraints } from '../src/services/deployment-constraints';
import { previewService } from '../src/services';
import Excel from 'exceljs';
import { taskTemplate } from '../src/services/task-files';
import { input,taskDto,jobDto,planDto,presetDto,frequencyDto,storeFixture,httpFixture,response,readNode } from './fixtures/planning-api';
afterEach(()=>vi.restoreAllMocks());
const value=()=>({...input(),deploymentConstraints:{...emptyDeploymentConstraints(),maxSlopeDeg:0,losRequiredNodeIds:['N3'],forcedInclude:[{lon:170,lat:-70}]}});
// 使用真实 HTTP 适配器验证报文，不将请求桩称为真实后端联调。
describe('部署条件 HTTP 与引用隔离',()=>{
  it('服务返回不存在的通视节点时，导入错误定位实际任务行',async()=>{
    const file=await taskTemplate('xlsx','task_scenarios',value()),book=new Excel.Workbook();await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    const sheet=book.getWorksheet('task_scenarios')!;sheet.getRow(4).values=sheet.getRow(2).values;sheet.getRow(2).values=[];
    const f=httpFixture((path,init)=>{expect(path).toBe('/api/v1/task-files/preview');expect(JSON.parse(String(init.body)).files[0].bytes_base64).toBeTruthy();return response({taskId:'TASK-NEW',input:null,issues:[{objectId:'TASK',field:'deploymentConstraints.losRequiredNodeIds',message:'节点N3不存在',sheet:'task_scenarios',row:4}],notes:[],differences:[],signature:'a'.repeat(64),existing:false,taskRevision:null,resourceRevision:'r1',requestContext:{context:'planning',taskId:'T1',taskRevision:'t1',resourceRevision:'r1'}});});
    const preview=await createTaskHttp(f.request).previewTaskInputImport({context:'planning',taskId:'T1',revision:'t1',resourceRevision:'r1',input:value(),files:[{...file,bytes:new Uint8Array(await book.xlsx.writeBuffer())}]});
    expect(preview.input).toBeNull();expect(preview.issues[0]).toMatchObject({sheet:'task_scenarios',row:4,field:'deploymentConstraints.losRequiredNodeIds'});
  });
  it('完整保存扩展，sr4只提交已保存版本且作业保留扩展',async()=>{
    const f=httpFixture(path=>response(path.endsWith('/plan/sr4-flow')?{...jobDto(),input:value()}:{...taskDto(),input:value()}));
    const saved=await createTaskHttp(f.request).saveTaskInput({context:'planning',taskId:'T1',revision:'t1',resourceRevision:'r1',requestId:'save',input:value()});
    expect(saved.input).toEqual(value());expect(JSON.parse(String(f.calls.find(c=>c.path.includes('/task-inputs/'))!.init.body)).input).toEqual(value());
    const job=await createPlanningHttp(f.request,()=>'/api/v1').submitPlanningTask({context:'planning',taskId:'T1',revision:'t1',inputVersion:'i1',conditionVersion:'c1',resourceRevision:'r1',parentPlanId:null,requestId:'run'});
    expect(job.input).toEqual(value());expect(f.calls.some(c=>c.path.includes('candidate-sites'))).toBe(false);expect(JSON.parse(String(f.calls.at(-1)!.init.body))).not.toHaveProperty('input');
  });
  it('目录与冻结方案保留新字段，坏响应不落为成功',async()=>{
    expect(readApiPlan({...planDto(),input:value()},{taskId:'T1'}).input).toEqual(value());
    const preset=presetDto();preset.items[0].defaults=value();expect(readPlanningCatalog(preset,frequencyDto()).presets[0].defaults).toEqual(value());
    const bad=value();bad.deploymentConstraints.maxSlopeDeg=100;
    const f=httpFixture(()=>response({...taskDto(),input:bad}));await expect(createTaskHttp(f.request).getTaskInput({context:'planning',taskId:'T1'})).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
  });
  it('额外通视节点独立缓存，草稿变化使迟到引用失效',async()=>{
    const s=await storeFixture();s.task.updateInput(value());await s.task.refreshReferences(false);
    expect(s.task.nodes.map(n=>n.id)).toEqual(['N1','N2']);expect(s.task.losNodes.map(n=>n.id)).toEqual(['N3']);
    let resolve!:(v:any)=>void;vi.mocked(previewService.getResourceObject).mockImplementation(q=>q.id==='N3'?new Promise(r=>resolve=r):Promise.resolve({revision:'r1',object:readNode(q.id),model:null,antenna:null}));
    const pending=s.task.refreshReferences(false);const next=value();next.deploymentConstraints.losRequiredNodeIds=['N4'];s.task.updateInput(next);
    resolve({revision:'r1',object:readNode('N3'),model:null,antenna:null});await pending;expect(s.task.draft!.deploymentConstraints!.losRequiredNodeIds).toEqual(['N4']);
    s.task.clearForSession();expect(s.task.losNodes).toEqual([]);disposePinia(s.pinia);
  });
});
