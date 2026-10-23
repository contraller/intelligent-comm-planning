// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import type { SpectrumServices, SpectrumWorkspace } from '../types/spectrum';
import type { ResourceStorage } from '../types/resource-edit';
import { initialSpectrum, spectrumDemos } from '../mocks/spectrum-presets';
import { readSpectrum, writeSpectrum } from './spectrum-storage';
import { spectrumIssues } from './spectrum-validation';
import { resourceIdValid, resourceSignature, same } from './resource-validation';
import { checkRevision } from './resource-storage';
import { ApiError } from './types';
import { assertReading, pageItems } from './data-access';

export function createSpectrumMock(getStorage:()=>ResourceStorage):SpectrumServices {
  const read=()=>readSpectrum(getStorage());
  function receipt(w:SpectrumWorkspace,requestId:string,signature:string){
    if(!resourceIdValid(requestId))throw new ApiError('请求 ID 无效','VALIDATION_ERROR');
    const prior=w.receipts.find(r=>r.requestId===requestId);
    if(prior&&prior.signature!==signature)throw new ApiError('请求 ID 已用于不同内容','REQUEST_CONFLICT');
    return prior;
  }
  const persist=(w:SpectrumWorkspace)=>{w.revision=randomUuid();writeSpectrum(getStorage(),w);};
  const service:SpectrumServices = {
    async querySpectrumSources(input){
      assertReading(input);const w=read();
      // 只接受本列表声明的排序字段和共同方向码。
      if(input.sort!==undefined&&!['name','intervalSeconds'].includes(input.sort)||input.order!==undefined&&!['asc','desc'].includes(input.order))throw new ApiError('频谱列表排序条件无效','VALIDATION_ERROR');
      const rows=w.sources.filter(row=>(input.enabled===undefined||row.enabled===input.enabled)&&(!input.search||`${row.id} ${row.name}`.toLowerCase().includes(input.search.toLowerCase())))
        .sort((a,b)=>{const value=input.sort==='intervalSeconds'?a.intervalSeconds-b.intervalSeconds:a.name.localeCompare(b.name);return (input.order==='desc'?-value:value)||a.id.localeCompare(b.id);});
      const page=pageItems(rows,input);
      return {...page,revision:w.revision,items:page.items.map(source=>({...source,latestCheck:w.checks.filter(check=>check.sourceId===source.id).at(-1)??null}))};
    },
    async getSpectrumSource(input){assertReading(input);const w=read();checkRevision(input.revision,w.revision);const source=w.sources.find(row=>row.id===input.sourceId);if(!source)throw new ApiError('采集配置不存在','RESOURCE_NOT_FOUND');return source;},
    async saveSpectrumReceipt(request){const result=await service.saveSpectrumSource(request);return {revision:result.workspace.revision,objectId:result.objectId,changed:result.changed,source:result.workspace.sources.find(row=>row.id===result.objectId)};},
    async checkSpectrumReceipt(request){const result=await service.checkSpectrumSource(request);return {revision:result.workspace.revision,objectId:result.objectId,changed:result.changed,check:result.check};},
    async resetSpectrumReceipt(revision){const result=await service.resetSpectrumWorkspace(revision);return {revision:result.workspace.revision,objectId:result.objectId,changed:result.changed};},
    async loadSpectrumWorkspace(){return read();},
    async saveSpectrumSource(request){
      const w=read(),signature=resourceSignature(request),prior=receipt(w,request.requestId,signature);
      if(prior)return {workspace:w,objectId:prior.objectId,changed:prior.changed};
      checkRevision(request.baseRevision,w.revision);
      const source=structuredClone(request.source),issues=spectrumIssues(source);
      if(issues.length)throw new ApiError(issues.join('；'),'VALIDATION_ERROR');
      const old=w.sources.find(s=>s.id===source.id);
      if(old&&old.revision!==source.revision)throw new ApiError('配置版本已变化','REVISION_CONFLICT');
      const changed=!old||!same(old,source);
      if(!changed){
        // 只保存幂等回执；无变化不会升配置或工作区版本、不会使检查过期。
        w.receipts.push({requestId:request.requestId,signature,objectId:source.id,changed:false});
        writeSpectrum(getStorage(),w);return {workspace:w,objectId:source.id,changed:false};
      }
      source.revision=randomUuid();
      if(old)w.sources[w.sources.indexOf(old)]=source;else w.sources.push(source);
      w.receipts.push({requestId:request.requestId,signature,objectId:source.id,changed:true});
      persist(w);return {workspace:w,objectId:source.id,changed:true};
    },
    async checkSpectrumSource(request){
      const w=read(),signature=resourceSignature(request),prior=receipt(w,request.requestId,signature);
      if(prior)return {workspace:w,objectId:prior.objectId,changed:true,check:w.checks.find(c=>c.id===prior.objectId)};
      checkRevision(request.baseRevision,w.revision);
      const source=w.sources.find(s=>s.id===request.sourceId);
      if(!source||!source.enabled)throw new ApiError('配置不存在或已停用','VALIDATION_ERROR');
      if(source.revision!==request.configRevision)throw new ApiError('配置已改变，请重新检查','REVISION_CONFLICT');
      if(spectrumIssues(source).length)throw new ApiError('请先补齐并保存配置','VALIDATION_ERROR');
      if(!Object.hasOwn(spectrumDemos,request.demo))throw new ApiError('未知检查预设','NO_PRESET');
      // 结果来自明确预设；不会向配置中的地址发送任何请求。
      const check={id:randomUuid(),sourceId:source.id,configRevision:source.revision,checkedAt:new Date().toISOString(),demo:request.demo,
        connection:request.demo==='connection-failed'?'FAILED' as const:'SUCCESS' as const,
        validation:request.demo==='connection-failed'?'NOT_RUN' as const:request.demo==='success'?'SUCCESS' as const:'FAILED' as const,message:spectrumDemos[request.demo]};
      w.checks.push(check);w.receipts.push({requestId:request.requestId,signature,objectId:check.id,changed:true});
      persist(w);return {workspace:w,objectId:check.id,changed:true,check};
    },
    async resetSpectrumWorkspace(baseRevision){
      if(baseRevision!==null){try{checkRevision(baseRevision,read().revision);}catch(e){if(!(e instanceof ApiError)||e.code!=='SPECTRUM_CORRUPT')throw e;}}
      const w=initialSpectrum();persist(w);return {workspace:w,objectId:'spectrum-workspace',changed:true};
    },
  };
  return service;
}
