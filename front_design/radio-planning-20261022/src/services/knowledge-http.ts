import type { AuthenticatedRequest } from './auth-http';
import type { KnowledgeServices, KnowledgeWorkspace, KnowledgeHistoryQuery, KnowledgeChangeSummary, KnowledgeVersionSummary, KnowledgeLog } from '../types/knowledge';
import { ApiError } from './types';
import { readKnowledgeMetadata, readKnowledgeVersion, readKnowledgeChange, readKnowledgeReceipt, readKnowledgeSearch, readKnowledgeGraph, readKnowledgeDetail, readKnowledgePage } from './knowledge-http-validation';

export function createKnowledgeHttp(request:AuthenticatedRequest):KnowledgeServices{
  const root='/kg/workbench',q=(input:object)=>new URLSearchParams(Object.entries(input).filter(([k,v])=>k!=='signal'&&v!==undefined).map(([k,v])=>[k,k==='expandedIds'?JSON.stringify(v):Array.isArray(v)?v.join(','):String(v)]));
  async function call(path:string,signal?:AbortSignal):Promise<unknown>{try{return await request(root+path,{signal});}catch(e){if(e instanceof ApiError&&Number(e.code)===4001&&path.startsWith('/browse/entity'))throw new ApiError(e.message,'KNOWLEDGE_ENTITY_MISSING',e.data,e.requestId,e.status);throw e;}}
  const unsupported=():never=>{throw new ApiError('联调知识库保留历史，不开放清空重置','UNSUPPORTED_OPERATION');};
  async function mutate(action:string,input:unknown){return readKnowledgeReceipt(await request(root+'/actions/'+action,{method:'POST',body:JSON.stringify(input)}));}
  const service:KnowledgeServices={
    async loadKnowledgeMetadata(input){return readKnowledgeMetadata(await call('',input?.signal));},
    async searchKnowledgeSummaries(input){const value=readKnowledgeSearch(await call('/browse/search?'+q(input),input.signal),input.versionId);if(input.pageNum!==undefined&&value.pageNum!==input.pageNum||input.pageSize!==undefined&&value.pageSize!==input.pageSize)throw new ApiError('检索分页不符','INVALID_KNOWLEDGE_RESPONSE');return value;},
    async getKnowledgeGraph(input){return readKnowledgeGraph(await call('/browse/graph?'+q(input),input.signal),input.versionId);},
    async queryKnowledgeChanges(input){return readKnowledgePage<KnowledgeChangeSummary>(await call('/history/changes?'+q(input),input.signal),'changes',input);},
    async queryKnowledgeVersions(input){return readKnowledgePage<KnowledgeVersionSummary>(await call('/history/versions?'+q(input),input.signal),'versions',input);},
    async queryKnowledgeLogs(input){return readKnowledgePage<KnowledgeLog>(await call('/history/logs?'+q(input),input.signal),'logs',input);},
    async getKnowledgeChange(input){return readKnowledgeChange(await call('/detail/change/'+encodeURIComponent(input.id),input.signal),input.id);},
    async getKnowledgeVersion(input){return readKnowledgeVersion(await call('/detail/version/'+encodeURIComponent(input.id),input.signal),input.id);},
    saveKnowledgeReceipt:input=>mutate('save',input),submitKnowledgeReceipt:input=>mutate('submit',input),withdrawKnowledgeReceipt:input=>mutate('withdraw',input),
    reviewKnowledgeReceipt:input=>mutate('review',input),publishKnowledgeReceipt:input=>mutate('publish',input),rollbackKnowledgeReceipt:input=>mutate('rollback',input),
    async resetKnowledgeReceipt(){return unsupported();},
    async getKnowledgeEntity(input){return readKnowledgeDetail(await call('/browse/entity?'+q(input),input.signal),input.versionId,input.entityId);},
    async getDeviceKnowledge(input){const raw=await call('/browse/device?'+q(input),input.signal);if(!raw||typeof raw!=='object')throw new ApiError('设备知识响应无效','INVALID_KNOWLEDGE_RESPONSE');const v=raw as Record<string,unknown>;if(v.versionId!==input.versionId||v.modelId!==input.modelId||!Array.isArray(v.items))throw new ApiError('设备知识归属无效','INVALID_KNOWLEDGE_RESPONSE');return{versionId:input.versionId,modelId:input.modelId,items:v.items.map(x=>{const id=(x as {entity?:{id?:unknown}})?.entity?.id;if(typeof id!=='string')throw new ApiError('设备知识缺少实体编号','INVALID_KNOWLEDGE_RESPONSE');return readKnowledgeDetail(x,input.versionId,id);})};},
    async loadKnowledgeWorkspace(){const m=await service.loadKnowledgeMetadata();return{...m,workspace:await workspace()};},
    searchKnowledge:input=>service.searchKnowledgeSummaries(input),queryKnowledgeGraph:input=>service.getKnowledgeGraph(input),
    async saveKnowledgeChange(input){const r=await service.saveKnowledgeReceipt(input);return{workspace:await workspace(),entityId:r.entityId,changed:r.changed};},
    async submitKnowledgeChange(input){const r=await service.submitKnowledgeReceipt(input);return{workspace:await workspace(),entityId:r.entityId,changed:r.changed};},
    async withdrawKnowledgeChange(input){const r=await service.withdrawKnowledgeReceipt(input);return{workspace:await workspace(),entityId:r.entityId,changed:r.changed};},
    async reviewKnowledgeChange(input){const r=await service.reviewKnowledgeReceipt(input);return{workspace:await workspace(),entityId:r.entityId,changed:r.changed};},
    async publishKnowledgeChange(input){const r=await service.publishKnowledgeReceipt(input);return{workspace:await workspace(),entityId:r.entityId,changed:r.changed};},
    async rollbackKnowledgeVersion(input){const r=await service.rollbackKnowledgeReceipt(input);return{workspace:await workspace(),entityId:r.entityId,changed:r.changed};},
    async resetKnowledgeWorkspace(){return unsupported();},
  };
  async function workspace():Promise<KnowledgeWorkspace>{const m=await service.loadKnowledgeMetadata();if(!m.workspace)throw new ApiError('知识库不可用','KNOWLEDGE_UNAVAILABLE');const versions:KnowledgeWorkspace['versions']=[],changes:KnowledgeWorkspace['changes']=[],logs:KnowledgeWorkspace['logs']=[];for(let pageNum=1;;pageNum++){const p=await service.queryKnowledgeVersions({pageNum,pageSize:50});versions.push(...await Promise.all(p.items.map(v=>service.getKnowledgeVersion({id:v.id}))));if(pageNum*50>=p.total)break;}for(let pageNum=1;;pageNum++){const p=await service.queryKnowledgeChanges({pageNum,pageSize:50});changes.push(...await Promise.all(p.items.map(v=>service.getKnowledgeChange({id:v.id}))));if(pageNum*50>=p.total)break;}return{schemaVersion:1,presetVersion:'backend-sr6-v1',revision:m.workspace.revision,currentVersionId:m.workspace.currentVersionId,identitySnapshots:m.workspace.identitySnapshots,versions,changes,logs,receipts:[]};}
  return service;
}
