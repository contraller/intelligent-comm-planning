// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import type { ResourcesData, NetworkLink } from '../types/domain';
import type { ResourceCommit, ResourceMeta, ResourceSaveResult, ResourceMutationReceipt, ResourceServices, ResourceStorage } from '../types/resource-edit';
import { initialResources } from '../mocks/resource-presets';
import { applyChanges, assertValid, changesPresent, diffResources, resourceIdValid, resourceSignature } from './resource-validation';
import { checkRevision, initialMeta, readResources, writeResources } from './resource-storage';
import { exportResourceFile, parseResourceImport, resourceFingerprint, resourceTemplate, selectResourceExport } from './resource-files';
import type { DeviceStatusSnapshot } from '../types/resource-status';
import type { ResourceExportRequest } from '../types/resource-edit';
import { ApiError } from './types';
import { settleCandidateLinks } from './candidate-link';
import { deviceChanges, restoreDevice, maintenanceEqual, maintenanceFields } from './device-maintenance';
import type { AuthIdentity } from '../types/system';
import { mockResourceRevision } from './mock-resource-revision';

export function createResourceMock(getStorage:()=>ResourceStorage,readObservation?:(id:string,revision:string)=>DeviceStatusSnapshot,readLinks:()=>NetworkLink[]=()=>[], identity:()=>AuthIdentity|null=()=>null){
  const source=initialResources(),read=()=>readResources(getStorage(),source);
  // 导出、观测和维护复用同一资源读取版本编码。
  function exportContext(request:ResourceExportRequest){
    const current=read();
    if(request.gis&&request.gis.revision!==mockResourceRevision(current))throw new ApiError('资源版本已变化，请刷新后导出','RESOURCE_VERSION_CHANGED');
    if(request.ledger&&request.ledger.revision!==mockResourceRevision(current))throw new ApiError('资源版本已变化，请刷新后导出','RESOURCE_VERSION_CHANGED');
    const id=request.ledger?.filter?.observationSnapshotId;
    const observation=id?readObservation?.(id,mockResourceRevision(current)):undefined;
    if(id&&!observation)throw new ApiError('观测快照不可用，请重新同步','RESOURCE_VERSION_CHANGED');
    return {current,observation};
  }
  async function commit(request:ResourceCommit,allowAvailability=false,importSignature=''):Promise<ResourceSaveResult>{
    if(request.context==='ledger'&&[request.newCandidateLinks,request.candidateLinks,request.importedCandidateLinks].some(rows=>rows?.length))throw new ApiError('候选链路仅在 GIS 维护','VALIDATION_ERROR');
    const signature=await resourceFingerprint(importSignature?{request,importSignature}:request),current=read();
    if(request.requestId!==undefined&&!resourceIdValid(request.requestId))throw new ApiError('请求 ID 无效','VALIDATION_ERROR');
    const prior=current.meta.receipts?.find(r=>r.requestId===request.requestId);
    if(prior){if(prior.signature!==signature)throw new ApiError('请求 ID 内容不一致','REQUEST_CONFLICT');return {...current,changed:prior.changed,warnings:[]};}
    checkRevision(request.baseRevision,current.meta.revision);
    const draft=applyChanges(current.resources,request,allowAvailability);
    // 提交时复核恢复归属和候选，恢复标识不能绕开普通校验。
    for (const [deviceId, historyId] of Object.entries(request.restoreFrom ?? {})) {
      const history=current.meta.deviceHistory?.find(h=>h.id===historyId&&h.deviceId===deviceId), device=current.resources.devices.find(d=>d.id===deviceId), next=draft.devices.find(d=>d.id===deviceId);
      if(!history||!device||!next)throw new ApiError('恢复历史或设备不存在','RESTORE_INVALID');
      const restore=restoreDevice(history,device,request.baseRevision,current.meta.resourceEpoch,current.resources.models.find(m=>m.id===device.modelId)!);
      const expected={...device,...restore.values};
      if(!restore.compatible||maintenanceFields.some(key=>!maintenanceEqual(next[key],expected[key])))throw new ApiError('恢复候选已变化或不兼容，请重新预览','RESTORE_INVALID');
    }
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
    const revision=randomUuid();
    const actor=identity(), time=new Date().toISOString();
    const history=[...new Set([...diff.devices,...diff.newDevices??[],...diff.availability??[]].map(d=>d.id))].map(deviceId=>{
      const before=current.resources.devices.find(d=>d.id===deviceId)??null, after=candidate.devices.find(d=>d.id===deviceId)!;
      return {id:randomUuid(),deviceId,revision,previousRevision:current.meta.deviceVersions[deviceId]??'initial',epoch:current.meta.resourceEpoch,time,
        actor:actor?{id:actor.id,name:actor.name,roleId:actor.roleId,roleName:actor.roleName}:null,
        source:request.restoreFrom?.[deviceId]?'历史恢复':importSignature?'模板导入':allowAvailability?'上下架维护':request.context==='gis'?'GIS 保存':'资源维护',
        requestId:request.requestId??null,restoredFrom:request.restoreFrom?.[deviceId]??null,before:structuredClone(before),after:structuredClone(after),changes:deviceChanges(before,after)};
    });
    const deviceIds=[...diff.devices,...diff.newDevices??[],...diff.availability??[]].map(r=>r.id);
    const stationIds=[...diff.stations,...diff.newStations??[]].map(r=>r.id);
    for(const row of [...diff.newDevices??[],...diff.availability??[]]){
      const device=candidate.devices.find(d=>d.id===row.id)!;stationIds.push(device.stationId);
    }
    const interferenceIds=[...diff.interferences??[],...diff.newInterferences??[]].map(r=>r.id);
    const meta:ResourceMeta={...current.meta,revision,savedAt:new Date().toISOString(),
      // 首次修改时记录变更前基线，时间是本次留存时间，不伪造过去操作人。
      deviceHistory:[...current.meta.deviceHistory??[],...history.flatMap(h=>h.before&&!current.meta.deviceHistory?.some(old=>old.deviceId===h.deviceId)?[
        {...h,id:randomUuid(),revision:h.previousRevision,actor:null,source:'首次留存的变更前快照',requestId:null,restoredFrom:null,before:null,after:h.before,changes:deviceChanges(null,h.before)},h]:[h])],
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
  // 内部保存仍返回完整快照供组合使用，公开页面命令只投影回执及本次设备。
  function receipt(result: ResourceSaveResult, ids: string[] = []): ResourceMutationReceipt {
    return { objectId: ids.join(','), revision: result.meta.revision, readRevision: mockResourceRevision(result),
      changed: result.changed, warnings: result.warnings, affectedIds: ids,
      ...(ids.length === 1 ? { device: result.resources.devices.find(d => d.id === ids[0]) } : {}) };
  }
  function reset(baseRevision: string | null) {
    if(baseRevision!==null)try{checkRevision(baseRevision,read().meta.revision);}catch(e){if(!(e instanceof ApiError)||!['STORAGE_CORRUPT','STORAGE_INCOMPATIBLE'].includes(String(e.code)))throw e;}
    const tasks=read().meta.taskWorkspace;
    const resources=initialResources(),meta={...initialMeta(),taskWorkspace:tasks,resourceEpoch:randomUuid(),revision:randomUuid(),savedAt:new Date().toISOString()};
    const warnings=assertValid(resources,resources,source);writeResources(getStorage(),resources,meta);
    return {resources,meta,changed:true,warnings};
  }
  const services:ResourceServices={
    async saveResourceChanges(request) {
      const ids = ['stations','devices','newStations','newDevices','interferences','newInterferences','availability'].flatMap(k =>
        ((request as unknown as Record<string, { id: string }[] | undefined>)[k] ?? []).map(row => row.id));
      return receipt(await commit(request), [...new Set(ids)]);
    },
    async applyResourceImport(request) { return receipt(await services.commitResourceImport(request), request.preview.rows.map(row => row.id)); },
    async updateDeviceAvailability(request) {
      const result = await services.setDeviceAvailability(request);
      return { ...receipt(result, request.ids), updated: result.updated, unchanged: result.unchanged };
    },
    async resetResourceData(request) { return { ...receipt(reset(request.baseRevision)), objectId: 'resource-workspace' }; },
    async loadResourceMaintenanceContext(request){
      const current=read();
      if(request.context!=='ledger'||request.revision!==mockResourceRevision(current))throw new ApiError('资源版本已变化，请刷新后维护','RESOURCE_VERSION_CHANGED');
      const device=request.deviceId?current.resources.devices.find(d=>d.id===request.deviceId):null;
      if(request.deviceId&&!device||request.ids?.some(id=>!current.resources.devices.some(d=>d.id===id)))throw new ApiError('设备已不存在，请刷新资源','RESOURCE_NOT_FOUND');
      return structuredClone({revision:mockResourceRevision(current),baseRevision:current.meta.revision,device:device??null,
        stations:current.resources.stations,models:current.resources.models,antennas:current.resources.antennas,
        impact:{planIds:[],linkIds:[],description:'当前资源工作区关联提示'}});
    },
    async previewResourceExport(request){
      const {current,observation}=exportContext(request),selected=selectResourceExport(current.resources,request,observation,readLinks());
      return {tables:selected.tables.map(t=>({kind:t.kind,count:t.rows.length})),added:selected.added};
    },
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
    async exportResources(request){const {current,observation}=exportContext(request);return exportResourceFile(current.resources,request,observation,readLinks());},
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
    // 共享记录无法读取时仍拒绝重置，避免丢失独立保存的任务。
    reset,
  };
}
