import { afterEach,describe,expect,it,vi } from 'vitest';
import { effectScope,nextTick,ref } from 'vue';
import { useFrozenCoverage } from '../src/composables/useFrozenCoverage';
import { ApiError } from '../src/services/types';
import type { FrozenCoverageClient,FrozenCoverageQuery } from '../src/types/frozen-coverage';
import { coverageCase } from './helpers/frozen-coverage';
const scopes:ReturnType<typeof effectScope>[]=[];
afterEach(()=>{scopes.splice(0).forEach(scope=>scope.stop());vi.useRealTimers();});
function fixture(){
  const data=coverageCase(),query=ref<FrozenCoverageQuery|null>(data.query),owner=ref<string>(crypto.randomUUID()),writable=ref(true);
  const rows=new Map<string,string>(),storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}} as Storage;
  const client={getCache:vi.fn<FrozenCoverageClient['getCache']>().mockResolvedValue(data.cache),compute:vi.fn<FrozenCoverageClient['compute']>().mockResolvedValue(data.job),getJob:vi.fn<FrozenCoverageClient['getJob']>().mockResolvedValue(data.job),cancel:vi.fn<FrozenCoverageClient['cancel']>().mockResolvedValue({...data.job,state:'CANCELLED'})};
  const scope=effectScope();scopes.push(scope);
  const create=()=>scope.run(()=>useFrozenCoverage({query:()=>query.value,parameters:()=>data.parameters,owner:()=>owner.value,canWrite:()=>writable.value,client:()=>client,requestId:()=> 'request-1',storage:()=>storage,pollMs:100}))!;
  return {data,query,owner,writable,client,rows,storage,scope,create,state:create()};
}
describe('冻结覆盖来源与请求状态',()=>{
  it('显式读取不发起计算，显示仅绑定所选设备；来源变化清空旧图',async()=>{
    const f=fixture();expect(f.client.getCache).not.toHaveBeenCalled();await f.state.read();expect(f.client.compute).not.toHaveBeenCalled();
    expect(f.state.overlay.value?.deviceId).toBe('D1');f.state.visible.value=false;expect(f.state.overlay.value).toBeNull();f.state.visible.value=true;
    f.query.value={...f.data.query,planId:'PLAN-2'};expect(f.state.cache.value).toBeNull();expect(f.state.overlay.value).toBeNull();
  });
  it.each(['source','identity','dispose'] as const)('%s变化拒绝迟到缓存并取消旧读取',async kind=>{
    const f=fixture();let finish!:(value:typeof f.data.cache)=>void;
    f.client.getCache.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const reading=f.state.read(),signal=f.client.getCache.mock.calls[0][2];
    if(kind==='source')f.query.value=null;else if(kind==='identity')f.owner.value='different';else f.scope.stop();
    finish(f.data.cache);await reading;expect(signal?.aborted).toBe(true);expect(f.state.overlay.value).toBeNull();
  });
  it('未知提交保留原号，重试不造新请求；成功后只读缓存',async()=>{
    const f=fixture();f.client.compute.mockRejectedValueOnce(new ApiError('网络中断','NETWORK_ERROR'));
    await f.state.compute();expect(f.state.pending.value?.requestId).toBe('request-1');expect(f.rows.size).toBe(1);
    await f.state.retry();expect(f.client.compute).toHaveBeenCalledTimes(2);
    expect(f.client.compute.mock.calls.map(row=>row[2])).toEqual(['request-1','request-1']);
    expect(f.state.pending.value).toBeNull();expect([...f.rows.keys()].some(key=>key.startsWith('frozen-coverage.pending:'))).toBe(false);expect(f.state.cache.value?.state).toBe('HIT');
  });
  it('同标签重新挂载恢复原号，但不自动写；不同身份不回放前人请求',async()=>{
    const f=fixture();f.client.compute.mockRejectedValueOnce(new ApiError('超时','TIMEOUT'));await f.state.compute();
    const other=effectScope();scopes.push(other);
    const restored=other.run(()=>useFrozenCoverage({query:()=>f.query.value,parameters:()=>f.data.parameters,owner:()=>f.owner.value,canWrite:()=>true,client:()=>f.client,storage:()=>f.storage}))!;
    expect(restored.pending.value?.requestId).toBe('request-1');expect(f.client.compute).toHaveBeenCalledOnce();
    f.owner.value='new-account';expect(restored.pending.value).toBeNull();expect(f.client.compute).toHaveBeenCalledOnce();
  });
  it('确定拒绝与GIS只读均不保留假在途请求',async()=>{
    const f=fixture();f.client.compute.mockRejectedValueOnce(new ApiError('拒绝','FORBIDDEN',null,undefined,403));await f.state.compute();expect(f.state.pending.value).toBeNull();
    f.query.value={...f.data.query,context:'gis'};await f.state.compute();await f.state.cancel();expect(f.client.compute).toHaveBeenCalledOnce();expect(f.client.cancel).not.toHaveBeenCalled();
  });
  it('作业单次轮询后终态读取缓存，取消明确走独立原号',async()=>{
    vi.useFakeTimers();const f=fixture();f.client.compute.mockResolvedValueOnce({...f.data.job,state:'PENDING',progress:0,finished_at:null});
    await f.state.compute();expect(f.state.running.value).toBe(true);await vi.advanceTimersByTimeAsync(100);
    expect(f.client.getJob).toHaveBeenCalledOnce();expect(f.state.running.value).toBe(false);expect(f.state.cache.value?.state).toBe('HIT');
    f.state.job.value={...f.data.job,state:'RUNNING'};await f.state.cancel();expect(f.client.cancel.mock.calls[0].slice(1,3)).toEqual([f.data.job.job_id,'request-1']);expect(f.state.job.value?.state).toBe('CANCELLED');
  });
  it('非法采样不生成待核实请求，轮询失败仍能手动刷新',async()=>{
    const f=fixture();f.data.parameters.cell_m=NaN;await f.state.compute();expect(f.client.compute).not.toHaveBeenCalled();expect(f.state.pending.value).toBeNull();expect(f.state.error.value).not.toBe('');
  });
  it('同身份同来源重新挂载可回读已确认作业，换身份不显示前人作业号',async()=>{
    const f=fixture();await f.state.compute();const scope=effectScope();scopes.push(scope);
    const state=scope.run(()=>useFrozenCoverage({query:()=>f.query.value,parameters:()=>f.data.parameters,owner:()=>f.owner.value,canWrite:()=>true,client:()=>f.client,storage:()=>f.storage}))!;
    expect(state.knownJobId.value).toBe(f.data.job.job_id);expect(f.client.getJob).not.toHaveBeenCalled();
    await state.refreshJob();expect(f.client.getJob).toHaveBeenCalledOnce();f.owner.value='another';expect(state.knownJobId.value).toBe('');
  });
});
