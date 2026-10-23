import { describe,expect,it,vi } from 'vitest';
import { createFrozenCoverageHttp } from '../src/services/frozen-coverage-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { coverageParameters } from '../src/services/frozen-coverage-decode';
import { coverageCase } from './helpers/frozen-coverage';
describe('冻结覆盖HTTP契约',()=>{
  it('GET只读绑定明确参数与来源，不调用旧CSV覆盖接口',async()=>{
    const f=coverageCase(),request=vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache),client=createFrozenCoverageHttp(request as AuthenticatedRequest),control=new AbortController();
    expect(await client.getCache(f.query,f.parameters,control.signal)).toEqual(f.cache);
    const path=request.mock.calls[0][0],qs=new URL(path,'http://localhost').searchParams;
    expect(path).toContain('/planning-coverages/PLAN-1/cache?');expect(qs.get('snapshot_id')).toBe(f.query.snapshotId);expect(qs.get('context')).toBe('planning');expect(JSON.parse(qs.get('parameters')!)).toEqual(f.parameters);
    expect(request).toHaveBeenCalledWith(expect.any(String),{signal:control.signal});
  });
  it('计算/原号重放/作业/取消分别保留真实请求号和锚点',async()=>{
    const f=coverageCase(),request=vi.fn<AuthenticatedRequest>().mockResolvedValue(f.job),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    await client.compute(f.query,{cell_m:5000,az_step_deg:10},'request-1');await client.getJob(f.query,f.job.job_id);await client.cancel(f.query,f.job.job_id,'cancel-1');
    const body=JSON.parse((request.mock.calls[0][1] as RequestInit).body as string);expect(body).toEqual({task_id:'TASK-1',snapshot_id:'SNP-PL-1',request_id:'request-1',parameters:{cell_m:5000,az_step_deg:10}});
    expect(request.mock.calls[1][0]).toContain('/jobs/'+f.job.job_id+'?');expect(JSON.parse((request.mock.calls[2][1] as RequestInit).body as string).request_id).toBe('cancel-1');
  });
  it.each(['compute','cancel'] as const)('GIS拒绝%s且不发送请求',async method=>{
    const f=coverageCase(),request=vi.fn(async()=>f.job),client=createFrozenCoverageHttp(request as AuthenticatedRequest),query={...f.query,context:'gis' as const};
    const promise=method==='compute'?client.compute(query,{},'r'):client.cancel(query,f.job.job_id,'r');
    await expect(promise).rejects.toMatchObject({code:'FORBIDDEN'});expect(request).not.toHaveBeenCalled();
  });
  it.each(['plan','task','snapshot','resource','fingerprint','parameters','unit','geometry','status','duplicate'] as const)('拒绝坏成功响应%s，不伪造空覆盖',async kind=>{
    const f=coverageCase();
    if(kind==='plan')f.anchor.plan_id='other';if(kind==='task')f.anchor.task_id='other';if(kind==='snapshot')f.anchor.snapshot_id='other';if(kind==='resource')f.anchor.resource_revision='current';
    if(kind==='fingerprint')f.result.provenance.terrain_fingerprint='0'.repeat(64);if(kind==='parameters')f.result.provenance.parameters={...f.parameters,hour:1};
    if(kind==='unit')Object.assign(f.result.provenance.units,{margin_db:'dBuV/m'});
    if(kind==='geometry')f.result.devices[0].computations[0].geojson.features[0].geometry={type:'Point',coordinates:[Infinity,37]};
    if(kind==='status')f.cache.state='MISS';if(kind==='duplicate')f.result.devices.push(structuredClone(f.result.devices[0]));
    const client=createFrozenCoverageHttp(vi.fn(async()=>f.cache) as AuthenticatedRequest);
    await expect(client.getCache(coverageCase().query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it('MISS/STALE保持null，未知设备不补频率或补零',async()=>{
    const f=coverageCase();f.result.devices[0]={...f.result.devices[0],band:'UNKNOWN_SOURCE',status:'UNAVAILABLE',reasons:['缺少带宽'],computations:[]};f.result.status='UNAVAILABLE';
    const request=vi.fn(async()=>f.cache),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    expect((await client.getCache(f.query,f.parameters)).result!.devices[0].band).toBe('UNKNOWN_SOURCE');
    for(const state of ['MISS','STALE'] as const){f.cache.state=state;f.cache.result=null;expect((await client.getCache(f.query,f.parameters)).result).toBeNull();}
  });
  it.each([{az_step_deg:7},{cell_m:NaN},{cell_m:6000},{hour:24},{radius_m:250,cell_m:500},{ring_vertices:25},{hf_max_km:1.5},{extra:1}])('拒绝非法参数%j',parameters=>{
    expect(()=>coverageParameters(parameters as never)).toThrow();
  });
});
