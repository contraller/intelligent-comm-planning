import { describe, expect, it, vi } from 'vitest';
import { createDiagnosisHttp } from '../src/services/diagnosis-http';
import { readDiagnosisNetwork, readDiagnosisProgress, readDiagnosisResult, readDiagnosisReport,readDiagnosisExport } from '../src/services/diagnosis-http-validation';
import { ApiError } from '../src/services/types';

const node=(id:string)=>({id,name:id,echelon:'',parentIds:[],coordinate:[114,37],elevationM:null,region:'',classes:['HF'],status:null,alert:null,relayCapable:false,key:false,mobility:''});
const network=()=>({id:'plan-a',taskId:'task-a',jobId:'job-a',name:'构造方案',version:'V1',snapshotId:'snapshot-a',preset:'SR4',state:'CONFIRMED',sourceChanged:false,inputSnapshot:{stations:[node('a')],devices:[]},stationIds:['a'],links:[],regions:[],metrics:{coveragePercent:null,connectivityPercent:100,survivabilityPercent:90,totalRadiatedPowerW:null,delayMs:null},notes:['非实测']});
const progress=()=>({id:'run-a',dataOrigin:'SAMPLE',state:'RUNNING',progress:50,phases:[{name:'诊断',state:'done'}],diagnosisReady:true,impactReady:false,error:null,source:{state:'CURRENT',reasons:[]},resultVersion:'result-v1'});
const result=()=>({fusionMode:'TWO_WAY_DEGRADED',disabledReason:'ML 未启用',conclusions:[],nodes:[],links:[],regions:[],summary:null,suggestions:[],notes:['构造联调']});

describe('SR5 真实适配契约',()=>{
  it('正式 PDF 先读取授权 JSON，再用同一报告生成图文；错快照禁止下载',async()=>{
    const {createPinia,disposePinia,setActivePinia}=await import('pinia');
    const {authorizeStore}=await import('./helpers/auth');
    const {useDiagnosisStore}=await import('../src/stores/diagnosis');
    const {previewService}=await import('../src/services');
    const {env}=await import('../src/config/env');
    const exports=await import('../src/reports/diagnosis-export');
    const pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),store=useDiagnosisStore();
    const previousMode=env.mode;(env as {mode:string}).mode='http';
    const report=readDiagnosisReport({id:'run-a',legacy:false,dataOrigin:'SAMPLE',scenarioId:'scene-a',scenarioVersion:'V1',name:'报告',description:'',startedAt:null,completedAt:null,diagnoseTaskId:'diagnose-a',impactTaskId:'impact-a',network:network(),faults:[],result:result(),source:{state:'CURRENT',reasons:[]}},'run-a');
    store.record=structuredClone(report);
    const file={name:'报告.pdf',mime:'application/pdf',bytes:new Uint8Array([1])};
    const check=vi.spyOn(auth,'check').mockResolvedValue(true),generate=vi.spyOn(exports,'createDiagnosisExport').mockResolvedValue(file),download=vi.spyOn(exports,'downloadDiagnosisFile').mockImplementation(()=>{});
    const authorized=vi.spyOn(previewService,'exportDiagnosisReport').mockResolvedValue({name:'报告.json',mime:'application/json',bytes:new TextEncoder().encode(JSON.stringify(report))});
    try{
      await store.download('pdf');
      expect(authorized).toHaveBeenCalledExactlyOnceWith('run-a','json');expect(generate).toHaveBeenCalledExactlyOnceWith(report,'pdf');expect(download).toHaveBeenCalledExactlyOnceWith(file);
      authorized.mockResolvedValueOnce({name:'报告.json',mime:'application/json',bytes:new TextEncoder().encode(JSON.stringify({...report,network:{...report.network,snapshotId:'other'}}))});
      await store.download('pdf');expect(store.exportError).toContain('版本');expect(generate).toHaveBeenCalledTimes(1);expect(download).toHaveBeenCalledTimes(1);
    }finally{check.mockRestore();generate.mockRestore();download.mockRestore();authorized.mockRestore();(env as {mode:string}).mode=previousMode;disposePinia(pinia);}
  });
  it('图文导出严格绑定预览来源，拒绝换快照及无效可选字段',()=>{
    const report=readDiagnosisReport({id:'run-a',legacy:false,dataOrigin:'SAMPLE',scenarioId:'scene-a',scenarioVersion:'V1',name:'报告',description:'',startedAt:null,completedAt:null,diagnoseTaskId:'diagnose-a',impactTaskId:'impact-a',network:network(),faults:[],result:result(),source:{state:'CURRENT',reasons:[]}},'run-a');
    const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
    expect(readDiagnosisExport(bytes(report),report).network.snapshotId).toBe('snapshot-a');
    expect(()=>readDiagnosisExport(bytes({...report,network:{...report.network,snapshotId:'other'}}),report)).toThrow('版本');
    expect(()=>readDiagnosisExport(bytes({...report,result:{...report.result,propagationPaths:[{}]}}),report)).toThrow();
    expect(()=>readDiagnosisExport(new Uint8Array([1,2]),report)).toThrow('JSON');
  });
  it('保留未知指标和状态，不把 null 转为零或正常',()=>{const value=readDiagnosisNetwork(network());expect(value.metrics.coveragePercent).toBeNull();expect(value.inputSnapshot.stations[0].status).toBeNull();expect(()=>readDiagnosisNetwork({...network(),stationIds:['other']})).toThrow();});
  it.each([{...progress(),id:'other'},{...progress(),state:'SUCCESS'},{...progress(),impactReady:true,diagnosisReady:false},{...progress(),dataOrigin:'BUSINESS'}])('拒绝错身份、假成功或不明来源：%j',value=>{expect(()=>readDiagnosisProgress(value,'run-a')).toThrow();});
  it('诊断与影响是两个独立 POST，读取接口不携带写入请求',async()=>{
    const request=vi.fn(async(path:string,init?:RequestInit)=>{
      if(path.includes('/actions/'))return{objectId:'run-a',entityIds:['run-a'],revision:'SR5-2',changed:true};
      return progress();
    });
    const service=createDiagnosisHttp(request as any),base={baseRevision:'SR5-1',requestId:'request-a'};
    await service.submitDiagnosisReceipt({...base,scenarioVersionId:'version-a'});
    await service.getDiagnosisProgress({id:'run-a'});
    await service.submitDiagnosisImpactReceipt({...base,requestId:'impact-a',runId:'run-a'});
    expect(request.mock.calls.map(c=>c[0])).toEqual(['/fault/workbench/actions/submit','/fault/workbench/runs/run-a/progress','/fault/workbench/actions/impact']);
    expect(request.mock.calls[1][1]?.method).toBeUndefined();
    expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toEqual({...base,requestId:'impact-a',runId:'run-a'});
  });
  it('错误和取消原样传播，不回退预生成结果',async()=>{const controller=new AbortController(),request=vi.fn(async()=>{throw new ApiError('版本冲突',1203,null,undefined,409);});const service=createDiagnosisHttp(request as any);await expect(service.getDiagnosisProgress({id:'run-a',signal:controller.signal})).rejects.toMatchObject({code:1203});expect(request).toHaveBeenCalledTimes(1);await expect(service.resetDiagnosisReceipt('SR5-1')).rejects.toMatchObject({code:'UNSUPPORTED_OPERATION'});});
  it('影响引用和计数不符不能进入报告',()=>{const bad={...result(),nodes:[{nodeId:'other',affectType:'DIRECT',level:'SEVERE',state:'INTERRUPTED',reason:'构造',detourRoute:[]}],summary:{affectedNodeCount:0,directCount:1,indirectCount:0,interruptedNodeCount:1,degradedNodeCount:0,affectedLinkCount:0,totalBandwidthLossKbps:0,affectedDemandIds:[]}};expect(()=>readDiagnosisResult(bad,readDiagnosisNetwork(network()),[])).toThrow();expect(()=>readDiagnosisReport({id:'wrong'},'run-a')).toThrow();});
});
