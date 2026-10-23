import type { ResourcesData } from '../types/domain';
import type { ResourceCommit, ResourceMeta, ResourceSaveResult, ResourceServices, ResourceStorage } from '../types/resource-edit';
import { initialResources } from '../mocks/resource-presets';
import { applyChanges, assertValid, changesPresent, diffResources, resourceIdValid, resourceSignature } from './resource-validation';
import { checkRevision, initialMeta, readResources, writeResources } from './resource-storage';
import { exportResourceFile, parseResourceImport, resourceFingerprint, resourceTemplate } from './resource-files';
import { ApiError } from './types';
import { settleCandidateLinks } from './candidate-link';

export function createResourceMock(getStorage:()=>ResourceStorage){
  const source=initialResources(),read=()=>readResources(getStorage(),source);
  async function commit(request:ResourceCommit,allowAvailability=false,importSignature=''):Promise<ResourceSaveResult>{
    if(request.context==='ledger'&&[request.newCandidateLinks,request.candidateLinks,request.importedCandidateLinks].some(rows=>rows?.length))throw new ApiError('候选链路仅在 GIS 维护','VALIDATION_ERROR');
    const signature=await resourceFingerprint(importSignature?{request,importSignature}:request),current=read();
    if(request.requestId!==undefined&&!resourceIdValid(request.requestId))throw new ApiError('请求 ID 无效','VALIDATION_ERROR');
    const prior=current.meta.receipts?.find(r=>r.requestId===request.requestId);
    if(prior){if(prior.signature!==signature)throw new ApiError('请求 ID 内容不一致','REQUEST_CONFLICT');return {...current,changed:prior.changed,warnings:[]};}
    checkRevision(request.baseRevision,current.meta.revision);
    const draft=applyChanges(current.resources,request,allowAvailability);
    assertValid(draft,current.resources,source);
    // 保存服务返回待评估分支；局部表单应用与撤销重做不改服务状态。
    const draftDiff=diffResources(current.resources,draft);
    const candidate=settleCandidateLinks(draft,current.resources,draftDiff);
    const warnings=assertValid(candidate,current.resources,source),diff=diffResources(current.resources,candidate);
    if(!changesPresent(diff)){
      // 带请求 ID 的无变化提交仅留回执，业务 revision/epoch/对象版本均不变。
      if(!request.requestId)return {...current,changed:false,warnings};
      const meta:ResourceMeta={...current.meta,receipts:[...current.meta.receipts??[],{requestId:request.requestId,signature,revision:current.meta.revision,changed:false,
        ...(allowAvailability?{availabilityResult:{updated:[],unchanged:(request.availability??[]).map(r=>r.id)}}:{})}]};
      writeResources(getStorage(),current.resources,meta);return {resources:current.resources,meta,changed:false,warnings};
    }
    const revision=crypto.randomUUID();
    const deviceIds=[...diff.devices,...diff.newDevices??[],...diff.availability??[]].map(r=>r.id);
    const stationIds=[...diff.stations,...diff.newStations??[]].map(r=>r.id);
    for(const row of [...diff.newDevices??[],...diff.availability??[]]){
      const device=candidate.devices.find(d=>d.id===row.id)!;stationIds.push(device.stationId);
    }
    const interferenceIds=[...diff.interferences??[],...diff.newInterferences??[]].map(r=>r.id);
    const meta:ResourceMeta={...current.meta,revision,savedAt:new Date().toISOString(),
      stationVersions:{...current.meta.stationVersions,...Object.fromEntries(stationIds.map(id=>[id,revision]))},
      deviceVersions:{...current.meta.deviceVersions,...Object.fromEntries(deviceIds.map(id=>[id,revision]))},
      changedStationIds:[...new Set([...current.meta.changedStationIds,...stationIds])],changedDeviceIds:[...new Set([...current.meta.changedDeviceIds,...deviceIds])],
      interferenceVersion:interferenceIds.length?revision:current.meta.interferenceVersion??'initial',
      changedInterferenceIds:[...new Set([...current.meta.changedInterferenceIds??[],...interferenceIds])],
      receipts:[...current.meta.receipts??[],...(request.requestId?[{requestId:request.requestId,signature,revision,changed:true,...(allowAvailability?{availabilityResult:{updated:(request.availability??[]).filter(r=>current.resources.devices.find(d=>d.id===r.id)!.availability!==r.availability).map(r=>r.id),unchanged:(request.availability??[]).filter(r=>current.resources.devices.find(d=>d.id===r.id)!.availability===r.availability).map(r=>r.id)}}:{})}]:[])],
    };
    // 哈希/解析异步之后再核对存储，不能覆盖预检期间发生的保存。
    checkRevision(current.meta.revision,read().meta.revision);
    writeResources(getStorage(),candidate,meta);return {resources:candidate,meta,changed:true,warnings};
  }
  const services:ResourceServices={
    async getResourceTemplate(format,kind){return resourceTemplate(format,kind);},
    async previewResourceImport(request){const current=read();checkRevision(request.baseRevision,current.meta.revision);return parseResourceImport(request,current.resources,source);},
    async commitResourceImport(request){
      if(request.preview.request.context!=='ledger')throw new ApiError('GIS 导入需先应用草稿再统一保存','VALIDATION_ERROR');
      if(request.baseRevision!==request.preview.request.baseRevision)throw new ApiError('预检版本不一致','REVISION_CONFLICT');
      const current=read();
      // 重试使用已校验的差异生成原事务签名；伪造内容仍不能命中回执。
      const commitRequest={baseRevision:request.baseRevision,requestId:request.requestId,...request.preview.changes};
      const prior=current.meta.receipts?.find(r=>r.requestId===request.requestId);
      if(prior){
        if(request.preview.signature!==await resourceFingerprint(request.preview.request)||prior.signature!==await resourceFingerprint({request:commitRequest,importSignature:request.preview.signature}))throw new ApiError('导入请求内容不一致','REQUEST_CONFLICT');
        return {...current,changed:prior.changed,warnings:[]};
      }
      checkRevision(request.baseRevision,current.meta.revision);
      const fresh=await parseResourceImport(request.preview.request,current.resources,source);
      if(fresh.signature!==request.preview.signature||resourceSignature(fresh.changes)!==resourceSignature(request.preview.changes))throw new ApiError('导入预检内容已改变，请重新预检','IMPORT_STALE');
      if(fresh.issues.length)throw new ApiError('导入校验失败，整批未写入','VALIDATION_ERROR',{issues:fresh.issues});
      return commit({...commitRequest,...fresh.changes},false,fresh.signature);
    },
    async exportResources(request){return exportResourceFile(read().resources,request);},
    async setDeviceAvailability(request){
      const current=read();
      if(!Array.isArray(request.ids)||!request.ids.length||new Set(request.ids).size!==request.ids.length||request.ids.some(id=>!current.resources.devices.some(d=>d.id===id))||!['ACTIVE','OFF_SHELF'].includes(request.availability))
        throw new ApiError('设备清单包含未知/重复 ID 或目标状态无效，整批未保存','VALIDATION_ERROR');
      const updated=request.ids.filter(id=>current.resources.devices.find(d=>d.id===id)!.availability!==request.availability);
      const result=await commit({baseRevision:request.baseRevision,requestId:request.requestId,stations:[],devices:[],availability:request.ids.map(id=>({id,availability:request.availability}))},true);
      const receipt=result.meta.receipts?.find(r=>r.requestId===request.requestId)?.availabilityResult;
      return {...result,...receipt??{updated,unchanged:request.ids.filter(id=>!updated.includes(id))}};
    },
  };
  return {
    source,read,services,commit,
    reset(baseRevision:string|null){
      if(baseRevision!==null)try{checkRevision(baseRevision,read().meta.revision);}catch(e){if(!(e instanceof ApiError)||!['STORAGE_CORRUPT','STORAGE_INCOMPATIBLE'].includes(String(e.code)))throw e;}
      // 共享记录无法读取时拒绝重置，避免丢失独立保存的任务。
      const tasks=read().meta.taskWorkspace;
      const resources=initialResources(),meta={...initialMeta(),taskWorkspace:tasks,resourceEpoch:crypto.randomUUID(),revision:crypto.randomUUID(),savedAt:new Date().toISOString()};
      const warnings=assertValid(resources,resources,source);writeResources(getStorage(),resources,meta);
      return {resources,meta,changed:true,warnings};
    },
  };
}
