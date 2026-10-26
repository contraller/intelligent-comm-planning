import { describe, expect, it, vi } from 'vitest';
import { createDiagnosisHttp } from '../src/services/diagnosis-http';
import { readDiagnosisNetwork, readDiagnosisProgress, readDiagnosisResult, readDiagnosisReport } from '../src/services/diagnosis-http-validation';
import { ApiError } from '../src/services/types';

const node=(id:string)=>({id,name:id,echelon:'',parentIds:[],coordinate:[114,37],elevationM:null,region:'',classes:['HF'],status:null,alert:null,relayCapable:false,key:false,mobility:''});
const network=()=>({id:'plan-a',taskId:'task-a',jobId:'job-a',name:'构造方案',version:'V1',snapshotId:'snapshot-a',preset:'SR4',state:'CONFIRMED',sourceChanged:false,inputSnapshot:{stations:[node('a')],devices:[]},stationIds:['a'],links:[],regions:[],metrics:{coveragePercent:null,connectivityPercent:100,survivabilityPercent:90,totalRadiatedPowerW:null,delayMs:null},notes:['非实测']});
const progress=()=>({id:'run-a',dataOrigin:'SAMPLE',state:'RUNNING',progress:50,phases:[{name:'诊断',state:'done'}],diagnosisReady:true,impactReady:false,error:null,source:{state:'CURRENT',reasons:[]},resultVersion:'result-v1'});
const result=()=>({fusionMode:'TWO_WAY_DEGRADED',disabledReason:'ML 未启用',conclusions:[],nodes:[],links:[],regions:[],summary:null,suggestions:[],notes:['构造联调']});

describe('SR5 真实适配契约',()=>{
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
