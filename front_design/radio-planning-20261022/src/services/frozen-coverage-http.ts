import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import type { FrozenCoverageClient,FrozenCoverageInput,FrozenCoverageQuery } from '../types/frozen-coverage';
import { coverageBandwidthChoices,coverageParameters,coverageSelectionId,readFrozenBandwidthOptions,readFrozenBandwidthSelection,readFrozenCoverageCache,readFrozenCoverageJob,validateCoverageQuery } from './frozen-coverage-decode';

// 只复用主客户端的认证请求；响应必须属于发起时的冻结版本和参数。
export function createFrozenCoverageHttp(request:AuthenticatedRequest):FrozenCoverageClient {
  const base='/planning-coverages';
  const capture=(query:FrozenCoverageQuery)=>{validateCoverageQuery(query);return {...query,...query.bandwidthSelection?{bandwidthSelection:{...query.bandwidthSelection}}:{}};};
  const input=(value:FrozenCoverageInput)=>{coverageParameters(value);return {...value};};
  const id=(value:string,job=false)=>{if(!value||value.length>160||/[\u0000-\u001f\u007f]/.test(value)||job&&!/^FCJ-[a-f0-9]{32}$/.test(value))throw new ApiError('冻结覆盖请求标识无效','VALIDATION_ERROR');return value;};
  const queryString=(query:FrozenCoverageQuery)=>new URLSearchParams({task_id:query.taskId,snapshot_id:query.snapshotId,context:query.context});
  return {
    async getLatestCache(query,signal){
      const frozen=capture(query),qs=queryString(frozen);
      if(frozen.engineVersion)qs.set('engine_version',frozen.engineVersion);
      const raw=await request<unknown>(`${base}/${encodeURIComponent(frozen.planId)}/latest-cache?${qs}`,{signal});
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ApiError('覆盖历史响应无效','INVALID_FROZEN_COVERAGE_RESPONSE');
      const value=raw as import('../types/frozen-coverage').FrozenCoverageCache;
      const expected={...frozen,...value.bandwidth_selection_id?{bandwidthSelection:{selectionId:value.bandwidth_selection_id,selectionHash:value.bandwidth_selection_hash!}}:{}};
      return readFrozenCoverageCache(value,expected,coverageParameters(value.parameters));
    },
    async getBandwidthOptions(query,signal){
      const frozen=capture(query);
      return readFrozenBandwidthOptions(await request<unknown>(`${base}/${encodeURIComponent(frozen.planId)}/bandwidth-options?${queryString(frozen)}`,{signal}),frozen);
    },
    async saveBandwidthSelection(query,choices,requestId,signal){
      const frozen=capture(query),values=coverageBandwidthChoices(choices),rid=id(requestId);
      if(frozen.context!=='planning')throw new ApiError('GIS覆盖入口只读','FORBIDDEN');
      return readFrozenBandwidthSelection(await request<unknown>(`${base}/${encodeURIComponent(frozen.planId)}/bandwidth-selections`,{method:'POST',body:JSON.stringify({task_id:frozen.taskId,snapshot_id:frozen.snapshotId,request_id:rid,choices:values}),signal}),frozen,undefined,values);
    },
    async getBandwidthSelection(query,selectionId,signal){
      const frozen=capture(query),sid=coverageSelectionId(selectionId);
      const value=readFrozenBandwidthSelection(await request<unknown>(`${base}/${encodeURIComponent(frozen.planId)}/bandwidth-selections/${sid}?${queryString(frozen)}`,{signal}),frozen);
      if(value.selection_id!==sid)throw new ApiError('带宽选择版本编号不一致','INVALID_FROZEN_COVERAGE_RESPONSE');return value;
    },
    async getCache(query,parameters,signal){
      const frozen=capture(query),options=input(parameters),qs=queryString(frozen);qs.set('parameters',JSON.stringify(options));
      if(frozen.bandwidthSelection)qs.set('bandwidth_selection_id',frozen.bandwidthSelection.selectionId);
      if(frozen.engineVersion)qs.set('engine_version',frozen.engineVersion);
      return readFrozenCoverageCache(await request<unknown>(`${base}/${encodeURIComponent(frozen.planId)}/cache?${qs}`,{signal}),frozen,options);
    },
    async compute(query,parameters,requestId,signal){
      const frozen=capture(query),options=input(parameters),rid=id(requestId);
      if(frozen.context!=='planning')throw new ApiError('GIS覆盖入口只读','FORBIDDEN');
      const dto=readFrozenCoverageJob(await request<unknown>(`${base}/${encodeURIComponent(frozen.planId)}/compute`,{method:'POST',body:JSON.stringify({task_id:frozen.taskId,snapshot_id:frozen.snapshotId,request_id:rid,parameters:options,...frozen.bandwidthSelection?{bandwidth_selection_id:frozen.bandwidthSelection.selectionId}:{}}),signal}),frozen,options);
      if(dto.request_id!==rid)throw new ApiError('覆盖作业未绑定原请求号','INVALID_FROZEN_COVERAGE_RESPONSE');return dto;
    },
    async getJob(query,jobId,signal){
      const frozen=capture(query),jid=id(jobId,true),qs=queryString(frozen);qs.set('plan_id',frozen.planId);
      const dto=readFrozenCoverageJob(await request<unknown>(`${base}/jobs/${encodeURIComponent(jid)}?${qs}`,{signal}),frozen);
      if(dto.job_id!==jid)throw new ApiError('覆盖作业编号不一致','INVALID_FROZEN_COVERAGE_RESPONSE');return dto;
    },
    async cancel(query,jobId,requestId,signal){
      const frozen=capture(query),jid=id(jobId,true),rid=id(requestId);
      if(frozen.context!=='planning')throw new ApiError('GIS覆盖入口只读','FORBIDDEN');
      const dto=readFrozenCoverageJob(await request<unknown>(`${base}/jobs/${jid}/cancel`,{method:'POST',body:JSON.stringify({task_id:frozen.taskId,plan_id:frozen.planId,snapshot_id:frozen.snapshotId,request_id:rid}),signal}),frozen);
      if(dto.job_id!==jid)throw new ApiError('覆盖取消作业编号不一致','INVALID_FROZEN_COVERAGE_RESPONSE');return dto;
    },
  };
}
