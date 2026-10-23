import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import type { DiagnosisServices, DiagnosisWorkspace, DiagnosisRunSummary, DiagnosisScenarioSummary, DiagnosisReadView, DiagnosisResult } from '../types/diagnosis';
import { readDiagnosisContext, readDiagnosisSources, readDiagnosisNetwork, readDiagnosisVersion, readDiagnosisReceipt, readDiagnosisProgress, readDiagnosisDetail, readDiagnosisResult, readDiagnosisReport, readDiagnosisPage } from './diagnosis-http-validation';

const root='/fault/workbench';
// 普通页面只调用分层接口；兼容入口同样读取后端，不使用预生成答案。
export function createDiagnosisHttp(request:AuthenticatedRequest):DiagnosisServices{
  const q=(input:object)=>new URLSearchParams(Object.entries(input).filter(([k,v])=>k!=='signal'&&v!==undefined).map(([k,v])=>[k,String(v)]));
  const read=(path:string,signal?:AbortSignal)=>request(root+path,{signal});
  async function write(action:string,input:unknown){return readDiagnosisReceipt(await request(root+'/actions/'+action,{method:'POST',body:JSON.stringify(input)}));}
  const unavailable=():never=>{throw new ApiError('真实联调不开放预生成答案或清空历史的演示操作','UNSUPPORTED_OPERATION');};
  async function download(id:string,kind:'report'|'impact',format:string,filters=''){
    if(!id||!['json','docx','pdf','xlsx','png'].includes(format))throw new ApiError('下载参数无效','VALIDATION_ERROR');
    const blob=await request<Blob>(`${root}/export/${encodeURIComponent(id)}?${q({kind,format,filters})}`,{},'blob');
    if(!(blob instanceof Blob)||blob.size===0||/json/.test(blob.type)&&format!=='json')throw new ApiError('导出响应不是预期文件','INVALID_DIAGNOSIS_RESPONSE');
    return {name:`${id}-${kind}.${format}`,mime:blob.type,bytes:new Uint8Array(await blob.arrayBuffer())};
  }
  const service:DiagnosisServices={
    async loadDiagnosisContext(input){return readDiagnosisContext(await read('',input?.signal));},
    async loadDiagnosisSourceOptions(input){return readDiagnosisSources(await read('/sources',input?.signal));},
    async getDiagnosisSource(input){return readDiagnosisNetwork(await read('/sources?'+q({planId:input.planId}),input.signal));},
    async queryDiagnosisScenarios(input){return readDiagnosisPage<DiagnosisScenarioSummary>(await read('/catalog/scenarios?'+q(input),input.signal),'scenarios',input);},
    async queryDiagnosisHistory(input){return readDiagnosisPage<DiagnosisRunSummary>(await read('/catalog/history?'+q(input),input.signal),'history',input);},
    async getDiagnosisVersion(input){return readDiagnosisVersion(await read('/version?'+q(input),input.signal),input);},
    async getDiagnosisPreset(){return unavailable();},
    async getDiagnosisProgress(input){return readDiagnosisProgress(await read(`/runs/${encodeURIComponent(input.id)}/progress`,input.signal),input.id);},
    async getDiagnosisDetail(input){return readDiagnosisDetail(await read(`/runs/${encodeURIComponent(input.id)}/detail`,input.signal),input.id);},
    async getDiagnosisStage(input){return readDiagnosisResult(await read(`/runs/${encodeURIComponent(input.id)}/stage?${q({stage:input.stage,resultVersion:input.resultVersion})}`,input.signal));},
    saveDiagnosisReceipt:input=>write('save',input),archiveDiagnosisReceipt:input=>write('archive',input),importDiagnosisReceipt:input=>write('import',input),
    async submitDiagnosisReceipt(input){const {demo,...payload}=input;if(demo!==undefined&&demo!=='normal')return unavailable();return write('submit',payload);},
    submitDiagnosisImpactReceipt:input=>write('impact',input),submitDiagnosisFeedback:input=>write('feedback',input),cancelDiagnosisReceipt:input=>write('cancel',input),
    async resetDiagnosisReceipt(){return unavailable();},
    async validateDiagnosisScenario(draft){const value=await request(root+'/validate',{method:'POST',body:JSON.stringify(draft)});if(!Array.isArray(value))throw new ApiError('场景校验响应无效','INVALID_DIAGNOSIS_RESPONSE');return value;},
    async getDiagnosisTemplate(format,planId){if(!planId)throw new ApiError('请先选择网络','VALIDATION_ERROR');const blob=await request<Blob>(root+'/template?'+q({format,planId}),{},'blob');if(!(blob instanceof Blob)||!blob.size)throw new ApiError('模板文件无效','INVALID_DIAGNOSIS_RESPONSE');return{name:`故障场景模板.${format}`,mime:blob.type,bytes:new Uint8Array(await blob.arrayBuffer())};},
    async previewDiagnosisImport(file,planId){if(file.bytes.byteLength>5*1024*1024)throw new ApiError('单文件最多 5 MiB','IMPORT_LIMIT');let encoded='';for(let i=0;i<file.bytes.length;i+=8192)encoded+=String.fromCharCode(...file.bytes.subarray(i,i+8192));const value=await request(root+'/import-preview',{method:'POST',body:JSON.stringify({name:file.name,planId,base64:btoa(encoded)})});if(!value||typeof value!=='object'||!Array.isArray((value as Record<string,unknown>).drafts)||!Array.isArray((value as Record<string,unknown>).issues))throw new ApiError('预检响应无效','INVALID_DIAGNOSIS_RESPONSE');return value as Awaited<ReturnType<DiagnosisServices['previewDiagnosisImport']>>;},
    async getDiagnosisReport(id){return readDiagnosisReport(await read(`/runs/${encodeURIComponent(id)}/report`),id);},
    exportDiagnosisReport:(id,format)=>download(id,'report',format),exportDiagnosisImpact:(id,format,filters)=>download(id,'impact',format,filters),
    async loadDiagnosisSources(){const s=await service.loadDiagnosisSourceOptions();return{error:s.error,plans:await Promise.all(s.plans.filter(p=>p.canCreate).map(p=>service.getDiagnosisSource({planId:p.id})))};},
    async loadDiagnosisWorkspace(){const c=await service.loadDiagnosisContext();return{workspace:await workspace(),error:c.error,presets:[],legacy:[],sources:await service.loadDiagnosisSources(),symptoms:c.symptoms,interferenceIds:c.interferenceIds};},
    async saveDiagnosisScenario(input){await service.saveDiagnosisReceipt(input);return workspace();},
    async archiveDiagnosisScenario(input){await service.archiveDiagnosisReceipt(input);return workspace();},
    async commitDiagnosisImport(input){await service.importDiagnosisReceipt(input);return workspace();},
    async submitDiagnosis(input){const r=await service.submitDiagnosisReceipt(input);return{workspace:await workspace(),view:await service.getDiagnosisRun(r.objectId)};},
    async getDiagnosisRun(id){const detail=await service.getDiagnosisDetail({id}),p=await service.getDiagnosisProgress({id});const result:DiagnosisResult=p.diagnosisReady?await service.getDiagnosisStage({id,stage:p.impactReady?'impact':'diagnosis',resultVersion:p.resultVersion}):{fusionMode:'TWO_WAY_DEGRADED',disabledReason:'尚未完成诊断',conclusions:[],nodes:[],links:[],regions:[],summary:null,suggestions:[],notes:[]};return{...detail,run:{...detail.run,demo:'normal',result},report:p.state==='SUCCESS'?await service.getDiagnosisReport(id):null};},
    async cancelDiagnosisRun(input){await service.cancelDiagnosisReceipt(input);return{workspace:await workspace(),view:await service.getDiagnosisRun(input.runId)};},
    async resetDiagnosisWorkspace(){return unavailable();},
  };
  async function workspace():Promise<DiagnosisWorkspace>{const c=await service.loadDiagnosisContext();const scenarios:DiagnosisWorkspace['scenarios']=[],runs:DiagnosisWorkspace['runs']=[];for(let pageNum=1;;pageNum++){const p=await service.queryDiagnosisScenarios({pageNum,pageSize:50,archived:false});for(const s of p.items){const versions=await Promise.all(s.versions.map(v=>service.getDiagnosisVersion({scenarioId:s.id,versionId:v.id})));scenarios.push({id:s.id,archived:s.archived,versions});}if(pageNum*50>=p.total)break;}return{schemaVersion:1,presetVersion:'backend-sr5-v1',revision:c.revision!,scenarios,runs,receipts:[]};}
  return service;
}
