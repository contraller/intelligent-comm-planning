import { afterEach,describe,expect,it,vi } from 'vitest';
import { effectScope,nextTick,ref } from 'vue';
import { useFrozenCoverage } from '../src/composables/useFrozenCoverage';
import { ApiError } from '../src/services/types';
import type { FrozenCoverageClient,FrozenCoverageQuery } from '../src/types/frozen-coverage';
import { bandwidthCase,coverageCase } from './helpers/frozen-coverage';
const scopes:ReturnType<typeof effectScope>[]=[];
afterEach(()=>{scopes.splice(0).forEach(scope=>scope.stop());vi.useRealTimers();});
async function fixture(){
  const data=coverageCase(),query=ref<FrozenCoverageQuery|null>(data.query),owner=ref<string>(crypto.randomUUID()),writable=ref(true);
  const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}} as Storage;
  const extra=bandwidthCase(false);
  const client={getBandwidthOptions:vi.fn<FrozenCoverageClient['getBandwidthOptions']>().mockResolvedValue(extra.options),saveBandwidthSelection:vi.fn<FrozenCoverageClient['saveBandwidthSelection']>().mockResolvedValue(extra.selection),getBandwidthSelection:vi.fn<FrozenCoverageClient['getBandwidthSelection']>().mockResolvedValue(extra.selection),getCache:vi.fn<FrozenCoverageClient['getCache']>().mockResolvedValue(data.cache),compute:vi.fn<FrozenCoverageClient['compute']>().mockResolvedValue(data.job),getJob:vi.fn<FrozenCoverageClient['getJob']>().mockResolvedValue(data.job),cancel:vi.fn<FrozenCoverageClient['cancel']>().mockResolvedValue({...data.job,state:'CANCELLED'})};
  const scope=effectScope();scopes.push(scope);
  const create=()=>scope.run(()=>useFrozenCoverage({query:()=>query.value,parameters:()=>data.parameters,owner:()=>owner.value,canWrite:()=>writable.value,client:()=>client,requestId:()=> 'request-1',storage:()=>storage,pollMs:100}))!;
  const state=create();await state.loadBandwidthOptions();
  return {data,query,owner,writable,client,rows,storage,scope,create,state,optionData:extra};
}
describe('冻结覆盖来源与请求状态',()=>{
  it('显式读取不发起计算，显示仅绑定所选设备；来源变化清空旧图',async()=>{
    const f=await fixture();expect(f.client.getCache).not.toHaveBeenCalled();await f.state.read();expect(f.client.compute).not.toHaveBeenCalled();
    expect(f.state.overlay.value?.deviceId).toBe('D1');f.state.visible.value=false;expect(f.state.overlay.value).toBeNull();f.state.visible.value=true;
    f.query.value={...f.data.query,planId:'PLAN-2'};expect(f.state.cache.value).toBeNull();expect(f.state.overlay.value).toBeNull();
  });
  it.each(['source','identity','dispose'] as const)('%s变化拒绝迟到缓存并取消旧读取',async kind=>{
    const f=await fixture();let finish!:(value:typeof f.data.cache)=>void;
    f.client.getCache.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const reading=f.state.read(),signal=f.client.getCache.mock.calls[0][2];
    if(kind==='source')f.query.value=null;else if(kind==='identity')f.owner.value='different';else f.scope.stop();
    finish(f.data.cache);await reading;expect(signal?.aborted).toBe(true);expect(f.state.overlay.value).toBeNull();
  });
  it('未知提交保留原号，重试不造新请求；成功后只读缓存',async()=>{
    const f=await fixture();f.client.compute.mockRejectedValueOnce(new ApiError('网络中断','NETWORK_ERROR'));
    await f.state.compute();expect(f.state.pending.value?.requestId).toBe('request-1');expect(f.rows.size).toBe(1);
    await f.state.retry();expect(f.client.compute).toHaveBeenCalledTimes(2);
    expect(f.client.compute.mock.calls.map(row=>row[2])).toEqual(['request-1','request-1']);
    expect(f.state.pending.value).toBeNull();expect([...f.rows.keys()].some(key=>key.startsWith('frozen-coverage.pending:'))).toBe(false);expect(f.state.cache.value?.state).toBe('HIT');
  });
  it('同标签重新挂载恢复原号，但不自动写；不同身份不回放前人请求',async()=>{
    const f=await fixture();f.client.compute.mockRejectedValueOnce(new ApiError('超时','TIMEOUT'));await f.state.compute();
    const other=effectScope();scopes.push(other);
    const restored=other.run(()=>useFrozenCoverage({query:()=>f.query.value,parameters:()=>f.data.parameters,owner:()=>f.owner.value,canWrite:()=>true,client:()=>f.client,storage:()=>f.storage}))!;
    expect(restored.pending.value?.requestId).toBe('request-1');expect(f.client.compute).toHaveBeenCalledOnce();
    f.owner.value='new-account';expect(restored.pending.value).toBeNull();expect(f.client.compute).toHaveBeenCalledOnce();
  });
  it('确定拒绝与GIS只读均不保留假在途请求',async()=>{
    const f=await fixture();f.client.compute.mockRejectedValueOnce(new ApiError('拒绝','FORBIDDEN',null,undefined,403));await f.state.compute();expect(f.state.pending.value).toBeNull();
    f.query.value={...f.data.query,context:'gis'};await f.state.compute();await f.state.cancel();expect(f.client.compute).toHaveBeenCalledOnce();expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it('作业单次轮询后终态读取缓存，取消明确走独立原号',async()=>{
    vi.useFakeTimers();const f=await fixture();f.client.compute.mockResolvedValueOnce({...f.data.job,state:'PENDING',progress:0,finished_at:null});
    await f.state.compute();expect(f.state.running.value).toBe(true);await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getJob).toHaveBeenCalledOnce();expect(f.state.running.value).toBe(false);expect(f.state.cache.value?.state).toBe('HIT');
    f.state.job.value={...f.data.job,state:'RUNNING'};await f.state.cancel();expect(f.client.cancel.mock.calls[0].slice(1,3)).toEqual([f.data.job.job_id,'request-1']);expect(f.state.job.value?.state).toBe('CANCELLED');
  });
  it('非法采样不生成待核实请求，轮询失败仍能手动刷新',async()=>{
    const f=await fixture();f.data.parameters.cell_m=NaN;await f.state.compute();expect(f.client.compute).not.toHaveBeenCalled();expect(f.state.pending.value).toBeNull();expect(f.state.error.value).not.toBe('');
  });
  it('同身份同来源重新挂载可回读已确认作业，换身份不显示前人作业号',async()=>{
    const f=await fixture();await f.state.compute();const scope=effectScope();scopes.push(scope);
    const state=scope.run(()=>useFrozenCoverage({query:()=>f.query.value,parameters:()=>f.data.parameters,owner:()=>f.owner.value,canWrite:()=>true,client:()=>f.client,storage:()=>f.storage}))!;
    expect(state.knownJobId.value).toBe(f.data.job.job_id);expect(f.client.getJob).not.toHaveBeenCalled();
    await state.refreshJob();expect(f.client.getJob).toHaveBeenCalledOnce();f.owner.value='another';expect(state.knownJobId.value).toBe('');
  });
});

describe('带宽版本回读与写入边界',()=>{
  it('保存独立选择后回读最新版本，不自动计算；新计算绑定回读id/hash',async()=>{
    const f=await fixture(),selected=bandwidthCase();await f.state.read();expect(f.state.overlay.value).not.toBeNull();
    f.client.getBandwidthOptions.mockResolvedValue(selected.options);
    await f.state.saveBandwidthSelection(selected.selection.choices);
    expect(f.state.bandwidthReceipt.value).toEqual(selected.selection);expect(f.state.bandwidthReady.value).toBe(true);
    expect(f.state.bandwidthOptions.value?.current_selection).toEqual(selected.selection);
    expect(f.state.overlay.value).toBeNull();expect(f.client.compute).not.toHaveBeenCalled();expect(f.client.getCache).toHaveBeenCalledOnce();
    expect(f.rows.size).toBe(0);
    f.client.compute.mockResolvedValue(selected.job);f.client.getCache.mockResolvedValue(selected.cache);await f.state.compute();
    expect(f.client.compute.mock.calls[0]![0].bandwidthSelection).toEqual(selected.query.bandwidthSelection);
    expect(f.state.overlay.value?.bandwidthSelection).toEqual(selected.query.bandwidthSelection);
  });
  it.each(['network','older-current','same-version-conflict'] as const)('保存成功但%s回读失败不伪报提交失败或自动重写',async kind=>{
    const f=await fixture(),selected=bandwidthCase();
    if(kind==='network')f.client.getBandwidthOptions.mockRejectedValueOnce(new ApiError('读取超时','TIMEOUT'));
    if(kind==='same-version-conflict')f.client.getBandwidthOptions.mockResolvedValueOnce({...selected.options,current_selection:{...selected.selection,selection_id:'FBS-'+'4'.repeat(32)}});
    await f.state.saveBandwidthSelection(selected.selection.choices);
    expect(f.state.bandwidthReceipt.value).toEqual(selected.selection);expect(f.state.bandwidthPending.value).toBeNull();
    expect(f.state.bandwidthReady.value).toBe(false);expect(f.state.bandwidthError.value).not.toBe('');
    await f.state.compute();expect(f.client.compute).not.toHaveBeenCalled();
    f.client.getBandwidthOptions.mockResolvedValue(selected.options);await f.state.loadBandwidthOptions();
    expect(f.state.bandwidthReady.value).toBe(true);expect(f.client.saveBandwidthSelection).toHaveBeenCalledOnce();
  });
  it('原号重放回执早于全局当前选择时，以GET最新版本为准',async()=>{
    const f=await fixture(),selected=bandwidthCase(),newer=structuredClone(selected.selection);
    newer.version_no=2;newer.selection_id='FBS-'+'3'.repeat(32);newer.selection_hash='8'.repeat(64);newer.choices[0]!.rx_bandwidth_khz=0.5;
    f.client.getBandwidthOptions.mockResolvedValue({...selected.options,current_selection:newer});
    await f.state.saveBandwidthSelection(selected.selection.choices);
    expect(f.state.bandwidthReceipt.value?.version_no).toBe(1);expect(f.state.bandwidthOptions.value?.current_selection).toEqual(newer);
    expect(f.state.bandwidthReady.value).toBe(true);expect(f.client.compute).not.toHaveBeenCalled();
  });
  it('未知选择提交保留深拷贝的原号正文，重挂载不自动写，不同身份不接管',async()=>{
    const f=await fixture(),selected=bandwidthCase(),choices=structuredClone(selected.selection.choices);
    f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('未收到响应','NETWORK_ERROR'));
    await f.state.saveBandwidthSelection(choices);choices[0]!.rx_bandwidth_khz=0.5;
    expect(f.state.bandwidthPending.value?.choices).toEqual(selected.selection.choices);expect(f.rows.size).toBe(0);
    await f.state.saveBandwidthSelection(choices);expect(f.client.saveBandwidthSelection).toHaveBeenCalledOnce();
    const restored=f.create();expect(restored.bandwidthPending.value?.requestId).toBe('request-1');
    expect(f.client.saveBandwidthSelection).toHaveBeenCalledOnce();
    f.client.getBandwidthOptions.mockResolvedValue(selected.options);await restored.retryBandwidthSelection();
    expect(f.client.saveBandwidthSelection.mock.calls.map(call=>call.slice(1,3))).toEqual([[selected.selection.choices,'request-1'],[selected.selection.choices,'request-1']]);
    expect(restored.bandwidthReady.value).toBe(true);f.owner.value='peer';
    expect(restored.bandwidthPending.value).toBeNull();expect(restored.bandwidthOptions.value).toBeNull();
  });
  it.each(['source','identity','dispose'] as const)('%s变化拒绝迟到选项目录并取消请求',async kind=>{
    const f=await fixture();let finish!:(value:typeof f.optionData.options)=>void;
    f.client.getBandwidthOptions.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const loading=f.state.loadBandwidthOptions(),signal=f.client.getBandwidthOptions.mock.lastCall![1];
    if(kind==='source')f.query.value=null;else if(kind==='identity')f.owner.value='different';else f.scope.stop();
    finish(bandwidthCase().options);await loading;
    expect(signal?.aborted).toBe(true);expect(f.state.bandwidthOptions.value?.current_selection??null).toBeNull();
  });
  it('换来源中的迟到保存不回填新来源，原请求仅原身份来源可核实',async()=>{
    const f=await fixture();let finish!:(value:typeof f.optionData.selection)=>void;
    f.client.saveBandwidthSelection.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const saving=f.state.saveBandwidthSelection(f.optionData.selection.choices),signal=f.client.saveBandwidthSelection.mock.lastCall![3];
    f.query.value={...f.data.query,planId:'PLAN-other'};finish(f.optionData.selection);await saving;
    expect(signal?.aborted).toBe(true);expect(f.state.bandwidthReceipt.value).toBeNull();expect(f.state.bandwidthPending.value).toBeNull();
    f.query.value={...f.data.query};expect(f.state.bandwidthPending.value?.requestId).toBe('request-1');
    expect(f.client.getBandwidthOptions).toHaveBeenCalledOnce();
  });
  it('非法值/无资料/GIS/失权均不提交，确定403不保留假未知',async()=>{
    const f=await fixture();
    await f.state.saveBandwidthSelection([{device_id:'D1',rx_bandwidth_khz:99}]);
    await f.state.saveBandwidthSelection([{device_id:'absent',rx_bandwidth_khz:2.4}]);
    expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
    f.writable.value=false;await f.state.saveBandwidthSelection(f.optionData.selection.choices);expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
    f.writable.value=true;f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('无权限','FORBIDDEN',null,undefined,403));
    await f.state.saveBandwidthSelection(f.optionData.selection.choices);expect(f.state.bandwidthPending.value).toBeNull();
    f.query.value={...f.data.query,context:'gis'};await f.state.loadBandwidthOptions();await f.state.saveBandwidthSelection(f.optionData.selection.choices);
    expect(f.client.saveBandwidthSelection).toHaveBeenCalledOnce();
  });
  it('新挂载从服务端恢复已保存选择，浏览器存储为空仍相同',async()=>{
    const f=await fixture(),selected=bandwidthCase();f.client.getBandwidthOptions.mockResolvedValue(selected.options);
    const restored=f.create();expect(restored.bandwidthOptions.value).toBeNull();await restored.loadBandwidthOptions();await nextTick();
    expect(restored.bandwidthOptions.value?.current_selection).toEqual(selected.selection);expect(f.rows.size).toBe(0);
    expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();expect(f.client.compute).not.toHaveBeenCalled();
  });
});
