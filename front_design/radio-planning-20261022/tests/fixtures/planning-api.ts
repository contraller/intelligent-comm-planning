import type { PlanningInput } from '../../src/types/planning';
import { createAuthHttp } from '../../src/services/auth-http';
import { readApiPlan, readPlanningJob, readPlanningCatalog, withPlanningReads } from '../../src/services/planning-api-validation';
import { readApiTask } from '../../src/services/task-api-validation';
import { vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { authorizeStore } from '../helpers/auth';
import { useTaskInputStore } from '../../src/stores/task-input';
import { useResourceReadStore } from '../../src/stores/resource-read';
import { previewService } from '../../src/services';
import type { ReadNode } from '../../src/types/resource-read';

// 独立合成契约样本，不修改甲方资料，也不借用 Mock 结果验证 HTTP 可行性。
export const input = (): PlanningInput => ({ name:'测试通信任务',description:'接口验证',bbox:[113,36,116,39],stationIds:['N1','N2'],presetId:'P1',frequencyId:'F1',startTime:null,durationH:null,constraints:{connectivityPercent:100,maxRelayHops:2,survivabilityPercent:90},demands:[{id:'D1',sourceId:'N1',targetId:'N2',endpointMode:'station',sourceDeviceId:null,targetDeviceId:null,preferredClass:null,service:'数据',priority:'P1',mandatory:true,dataVolumeMb:10,requiredRateKbps:64,maxDelayMs:100,minReliability:0.95}] });
export const taskDto = () => ({task_id:'T1',revision:'t1',input_version:'i1',condition_version:'c1',resource_revision:'r1',input:input(),updated_at:'2026-10-05T00:00:00Z',active_job_id:null as string|null});
export const coverageDto = () => ({
  contour:{type:'FeatureCollection',features:[{type:'Feature',id:'C1',properties:{level:'STRONG',field_strength_dbuvm_min:40},geometry:{type:'MultiPolygon',coordinates:[[[[114,37],[115,37],[115,38],[114,38],[114,37]],[[114.2,37.2],[114.2,37.4],[114.4,37.4],[114.4,37.2],[114.2,37.2]]],[[[115.1,37],[115.4,37],[115.4,37.3],[115.1,37.3],[115.1,37]]]]}}]},
  raster_png:{url:'/api/v1/files/coverage-J1.png',bbox:[114,37,115.5,38],crs:'EPSG:4326',width:1,height:1,colormap:[{value_dbuvm:0,rgba:[0,0,0,0]},{value_dbuvm:40,rgba:[30,200,100,255]}]},
});
export const resultDto = () => ({snapshot_id:'S1',nodes:[{id:'N1',name:'节点一',coordinate:[114,37],status:'NORMAL',alert:null},{id:'N2',name:'节点二',coordinate:[115,38],status:'NORMAL',alert:false}],devices:['N1','N2'].map((stationId,i)=>({id:'E'+(i+1),stationId,modelId:'M1',modelName:'短波设备',deviceClass:'HF',availability:null,workFreqKhz:3000,txPowerDbm:30,antennaHeightM:5,tiltDeg:null,azimuthDeg:null})),links:[{id:'L1',a:'N1',b:'N2',deviceA:'E1',deviceB:'E2',state:'GOOD',deviceClass:'HF',frequencyKhz:3000,backup:false}],coverage:coverageDto(),
  configuration:{deployment:[{stationId:'N1',deviceIds:['E1'],role:'任务节点'},{stationId:'N2',deviceIds:['E2'],role:'任务节点',plannedCoordinate:[115.1,38.1]}],devices:['N1','N2'].map((stationId,i)=>({deviceId:'E'+(i+1),stationId,frequencyKhz:3000,txPowerDbm:30,antennaHeightM:5})),routes:[{id:'R1',demandId:'D1',nodeIds:['N1','N2'],linkIds:['L1'],backup:false}],frequencies:[{id:'F1',minKhz:2000,maxKhz:5000,allocatedKhz:[3000]}]},
  metrics:{connectivityPercent:100,totalRadiatedPowerW:2,survivabilityPercent:90,coveragePercent:null,delayMs:10},deployment_cost:null,cost_unit:'万元',checks:['connectivity','survivability','relay','frequency'].map(id=>({id,label:id,passed:true as boolean|null,detail:'接口校验'})),notes:['预生成接口样本'],
});
export const outcomeDto = () => ({code:0,message:'规划完成',suggestions:[] as string[],gap:[] as {objectId:string;field:string;message:string}[]});
export const jobDto = () => ({job_id:'J1',task_id:'T1',revision:'j1',input_version:'i1',condition_version:'c1',resource_revision:'r1',input:input(),parent_plan_id:null,status:'SUCCESS',progress:1,phases:[{name:'部署与优化',state:'done'}],result:resultDto(),outcome:outcomeDto(),error:null,expired:false,source_changed:false,saved_plan_id:null});
export const planDto = (id='P-1') => ({plan_id:id,task_id:'T1',job_id:'J1',revision:'p1',version:'V1',name:'保存方案',note:'',input_version:'i1',condition_version:'c1',resource_revision:'r1',input:input(),parent_plan_id:null,state:'SAVED',current:false,source_changed:false,saved_at:'2026-10-05T00:00:00Z',confirmed_at:null as string|null,source:'测试接口',result:resultDto(),outcome:outcomeDto()});
export const presetDto = () => ({revision:'catalog1',items:[{id:'P1',label:'默认配置',description:'允许编辑条件',defaults:input()}]});
export const frequencyDto = () => ({revision:'catalog1',items:[{id:'F1',label:'短波频率池',min_khz:2000,max_khz:5000}]});
export const apiTask = () => readApiTask(taskDto());
export const apiJob = () => readPlanningJob(jobDto(),{taskId:'T1'});
export const apiPlan = (id='P-1') => readApiPlan(planDto(id),{taskId:'T1'});
export const catalog = () => readPlanningCatalog(presetDto(),frequencyDto());
export const readNode = (id='N1'): ReadNode => ({kind:'node',id,name:'节点'+id,coordinate:id==='N1'?[114,37]:[115,38],status:'NORMAL',alert:null,origin:null,parentIds:[],echelon:'营',region:'测试区域',classes:['HF'],elevationM:null,relayCapable:true,key:false,mobility:'固定',childCount:0,deviceCount:1});
export async function storeFixture() {
  const pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),resources=useResourceReadStore();
  resources.context='planning';resources.workspace={revision:'r1',bounds:[113,36,116,39],updatedAt:'2026-10-05T00:00:00Z',source:'测试接口',stats:{nodes:2,devices:2,models:1,interferences:0,hf:2,vuhf:0,alerts:null,unknownAlerts:null,active:null,offShelf:null,unknownAvailability:null}};
  vi.spyOn(previewService,'loadPlanningCatalog').mockResolvedValue(catalog());
  vi.spyOn(previewService,'loadPlanningOptions').mockResolvedValue({...catalog(),presets:catalog().presets.map(({defaults:_input,...row})=>row)});
  vi.spyOn(previewService,'getPlanningPreset').mockResolvedValue(catalog().presets[0]);
  vi.spyOn(previewService,'loadPlanningReadContext').mockResolvedValue({revision:'p1'});
  vi.spyOn(previewService,'getPlanningAdjustmentExamples').mockResolvedValue([]);
  vi.spyOn(previewService,'saveTaskInputReceipt').mockImplementation(async request=>{const {input:_input,activeJobId:_active,...row}=apiTask();return {...row,name:request.input.name,objectId:row.taskId,changed:true};});
  vi.spyOn(previewService,'getResourceObject').mockImplementation(async q=>({revision:'r1',object:readNode(q.id),model:null,antenna:null}));
  let storedTask=apiTask(),storedJob=apiJob(),storedPlan=apiPlan();
  vi.spyOn(previewService,'getTaskInput').mockImplementation(async()=>storedTask);
  vi.spyOn(previewService,'saveTaskInput').mockResolvedValue(apiTask());
  vi.mocked(previewService.saveTaskInputReceipt).mockImplementation(async request=>{
    storedTask=await previewService.saveTaskInput(request);const {input:taskInput,activeJobId:_active,...row}=storedTask;
    return {...row,name:taskInput.name,objectId:row.taskId,changed:true};
  });
  vi.spyOn(previewService,'queryTaskInputs').mockResolvedValue({items:[apiTask()],pageNum:1,pageSize:10,total:1});
  vi.spyOn(previewService,'queryTaskSummaries').mockImplementation(async request=>{const page=await previewService.queryTaskInputs(request);return {...page,items:page.items.map(({input:taskInput,...row})=>({...row,name:taskInput.name}))};});
  vi.spyOn(previewService,'queryPlanningPlanSummaries').mockResolvedValue({items:[],pageNum:1,pageSize:10,total:0});
  vi.spyOn(previewService,'queryPlanningPlans').mockResolvedValue({items:[],pageNum:1,pageSize:10,total:0});
  vi.spyOn(previewService,'getPlanningTask').mockImplementation(async()=>storedJob);
  vi.spyOn(previewService,'getPlanningPlan').mockImplementation(async()=>storedPlan);
  // 原测试仍控制写入/详情桩，新页面出口只投影回执及进度。
  const lean=withPlanningReads(previewService);
  for(const name of ['submitPlanningReceipt','cancelPlanningReceipt','savePlanningReceipt','confirmPlanningReceipt','getPlanningTaskProgress'] as const)
    vi.spyOn(previewService,name).mockImplementation(lean[name] as never);
  vi.mocked(previewService.queryPlanningPlanSummaries).mockImplementation(lean.queryPlanningPlanSummaries);
  for(const [command,legacy] of [['submitPlanningReceipt','submitPlanningTask'],['cancelPlanningReceipt','cancelPlanningTask'],['savePlanningReceipt','savePlanningPlan'],['confirmPlanningReceipt','confirmPlanningPlan']] as const){
    vi.mocked(previewService[command]).mockImplementation((async(request:any)=>{
      const value=await (previewService[legacy] as any)(request);
      if(legacy==='submitPlanningTask'||legacy==='cancelPlanningTask')storedJob=value;else storedPlan=value;
      return {objectId:value.id,taskId:value.taskId,revision:value.revision,changed:true};
    }) as never);
  }
  const task=useTaskInputStore();await task.initialize('planning');await task.open('T1',false);
  return {pinia,auth,resources,task};
}
export const response = (data:unknown,code=0,status=200) => new Response(JSON.stringify({code,message:code?'业务拒绝':'ok',data,request_id:'response-id'}),{status,headers:{'Content-Type':'application/json'}});
export function httpFixture(handler:(path:string,init:RequestInit)=>Promise<Response>|Response,timeoutMs=1000){
  const calls:{path:string;init:RequestInit}[]=[];
  const identity={session_id:'session1',account_id:'U1',username:'planner',display_name:'规划员',role_id:'R1',role_name:'规划角色',permissions:['planning.view','planning.execute','planning.save','planning.confirm','situation.view'],identity_revision:'a1',session_generation:'e1'};
  const authentication=createAuthHttp({baseUrl:()=>'/api/v1',origin:()=> 'http://local',timeoutMs,fetcher:async(url,init={})=>{const path=String(url);calls.push({path,init});if(path.endsWith('/auth/session'))return response(identity);if(path.endsWith('/auth/csrf'))return response({csrf_token:'csrf1',session_id:identity.session_id});return handler(path,init);}});
  return {request:authentication.authenticatedRequest,calls,identity,authentication};
}
