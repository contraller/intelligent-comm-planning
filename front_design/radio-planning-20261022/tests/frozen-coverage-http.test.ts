import { describe,expect,it,vi } from 'vitest';
import { createFrozenCoverageHttp } from '../src/services/frozen-coverage-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { coverageParameters } from '../src/services/frozen-coverage-decode';
import { bandwidthCase,coverageCase } from './helpers/frozen-coverage';
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
  it.each(['anchor','provenance','both'] as const)('拒绝%s含V01-1的旧或混合缓存，不兼容降级',async part=>{
    const f=coverageCase();
    if(part!=='provenance')f.anchor.engine_version='V01-1';
    if(part!=='anchor')f.result.provenance.engine_version='V01-1';
    const client=createFrozenCoverageHttp(vi.fn(async()=>f.cache) as AuthenticatedRequest);
    await expect(client.getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it('新夹具只提供V01-2，旧版本作业也不能混入本轮响应',async()=>{
    const f=coverageCase();expect(f.anchor.engine_version).toBe('V01-2');expect(f.result.provenance.engine_version).toBe('V01-2');
    f.job.anchor.engine_version='V01-1';
    const client=createFrozenCoverageHttp(vi.fn(async()=>f.job) as AuthenticatedRequest);
    await expect(client.getJob(f.query,f.job.job_id)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each([{az_step_deg:7},{cell_m:NaN},{cell_m:6000},{hour:24},{radius_m:250,cell_m:500},{ring_vertices:25},{hf_max_km:1.5},{extra:1}])('拒绝非法参数%j',parameters=>{
    expect(()=>coverageParameters(parameters as never)).toThrow();
  });
});

describe('V3接收带宽选择HTTP契约',()=>{
  it('选项目录/精确版本只读，选择提交仅带独立choices，不塞计算参数',async()=>{
    const f=bandwidthCase(),request=vi.fn<AuthenticatedRequest>().mockResolvedValueOnce(f.options).mockResolvedValueOnce(f.selection).mockResolvedValueOnce(f.selection),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    expect(await client.getBandwidthOptions(f.query)).toEqual(f.options);
    await client.getBandwidthSelection(f.query,f.selection.selection_id);
    expect(await client.saveBandwidthSelection(f.query,f.selection.choices,'select-1')).toEqual(f.selection);
    expect(request.mock.calls[0]![0]).toContain('/bandwidth-options?');expect(request.mock.calls[1]![0]).toContain('/bandwidth-selections/'+f.selection.selection_id+'?');
    expect(JSON.parse(request.mock.calls[2]![1]!.body as string)).toEqual({task_id:f.query.taskId,snapshot_id:f.query.snapshotId,request_id:'select-1',choices:[{device_id:'D1',rx_bandwidth_khz:2.4}]});
  });
  it('V3计算/cache只发送选择ID，响应id/hash及每设备选值全部匹配',async()=>{
    const f=bandwidthCase(),request=vi.fn<AuthenticatedRequest>().mockResolvedValueOnce(f.job).mockResolvedValueOnce(f.cache),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    await client.compute(f.query,f.parameters,'request-1');await client.getCache(f.query,f.parameters);
    const body=JSON.parse(request.mock.calls[0]![1]!.body as string),qs=new URL(request.mock.calls[1]![0],'http://localhost').searchParams;
    expect(body.bandwidth_selection_id).toBe(f.selection.selection_id);expect(Object.keys(body.parameters)).toHaveLength(8);expect(body).not.toHaveProperty('choices');expect(body).not.toHaveProperty('bandwidth_selection_hash');
    expect(qs.get('bandwidth_selection_id')).toBe(f.selection.selection_id);expect(qs.has('choices')).toBe(false);expect(qs.has('bandwidth_selection_hash')).toBe(false);
  });
  it('空选择是合法独立版本，GIS拒绝任何选择写入',async()=>{
    const f=bandwidthCase(),empty={...f.selection,choices:[]},request=vi.fn<AuthenticatedRequest>().mockResolvedValue(empty),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    expect((await client.saveBandwidthSelection(f.query,[],'empty-1')).choices).toEqual([]);
    request.mockClear();await expect(client.saveBandwidthSelection({...f.query,context:'gis'},[],'forbidden')).rejects.toMatchObject({code:'FORBIDDEN'});expect(request).not.toHaveBeenCalled();
  });
  it.each(['id','hash','source','version','options','state','duplicate','selected-value','raw','extra'] as const)('选项目录拒绝坏成功%s',async kind=>{
    const f=bandwidthCase();
    if(kind==='id')f.selection.selection_id='other';if(kind==='hash')f.selection.selection_hash='bad';
    if(kind==='source')f.selection.source_anchor.raw_snapshot_sha256='1'.repeat(64);if(kind==='version')f.selection.version_no=0;
    if(kind==='options')f.options.devices[0]!.options_khz=[NaN];if(kind==='state')f.options.devices[0]!.reason_code='RX_BANDWIDTH_UNKNOWN';
    if(kind==='duplicate')f.options.devices.push({...f.options.devices[0]!});if(kind==='selected-value')f.selection.choices[0]!.rx_bandwidth_khz=99;
    if(kind==='raw')Object.assign(f.options.devices[0]!,{model_bandwidth_khz:{value:2.4}});if(kind==='extra')Object.assign(f.selection,{actor_password:'not-allowed'});
    const client=createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.options) as AuthenticatedRequest);
    await expect(client.getBandwidthOptions(f.query)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each(['cache-id','cache-hash','job-id','provenance-hash','choices','rx-value','rx-source','missing-v3','v2'] as const)('含选择的响应拒绝错配%s',async kind=>{
    const f=bandwidthCase();
    if(kind==='cache-id')f.cache.bandwidth_selection_id='FBS-'+'3'.repeat(32);if(kind==='cache-hash')f.cache.bandwidth_selection_hash='0'.repeat(64);
    if(kind==='job-id')f.job.bandwidth_selection_id=null;if(kind==='provenance-hash')f.result.provenance.bandwidth_selection_hash='0'.repeat(64);
    if(kind==='choices')f.result.provenance.bandwidth_choices=[];if(kind==='rx-value')f.result.devices[0]!.rx_bandwidth!.value_khz=0.5;
    if(kind==='rx-source')f.result.devices[0]!.rx_bandwidth!.source='FROZEN_MODEL_SINGLE_VALUE';if(kind==='missing-v3')delete f.cache.bandwidth_selection_hash;
    if(kind==='v2'){f.anchor.engine_version='V01-2';f.result.provenance.engine_version='V01-2';}
    const request=vi.fn<AuthenticatedRequest>().mockResolvedValue(kind==='job-id'?f.job:f.cache),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    await expect(kind==='job-id'?client.getJob(f.query,f.job.job_id):client.getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it('V3无选择保持null及结构化未知，旧V2历史仍独立可读',async()=>{
    const f=bandwidthCase(false),request=vi.fn<AuthenticatedRequest>().mockResolvedValueOnce(f.cache).mockResolvedValueOnce(coverageCase().cache),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    expect((await client.getCache(f.query,f.parameters)).result!.devices[0]!.rx_bandwidth).toEqual({value_khz:null,source:'UNSELECTED'});
    expect((await client.getCache(coverageCase().query,f.parameters)).anchor.engine_version).toBe('V01-2');
  });
  it.each([{choices:[{device_id:'D1',rx_bandwidth_khz:NaN}]},{choices:[{device_id:'D1',rx_bandwidth_khz:0}]},{choices:[{device_id:'D1',rx_bandwidth_khz:2.4},{device_id:'D1',rx_bandwidth_khz:0.5}]}])('非法或重复choices不发请求',async ({choices})=>{
    const request=vi.fn<AuthenticatedRequest>(),client=createFrozenCoverageHttp(request as AuthenticatedRequest),f=bandwidthCase();
    await expect(client.saveBandwidthSelection(f.query,choices,'bad')).rejects.toBeInstanceOf(Error);expect(request).not.toHaveBeenCalled();
  });
  it('精确版本GET及选择提交不能接受另一个id/另一个请求值',async()=>{
    const f=bandwidthCase(),client=createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.selection) as AuthenticatedRequest);
    await expect(client.getBandwidthSelection(f.query,'FBS-'+'4'.repeat(32))).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
    await expect(client.saveBandwidthSelection(f.query,[{device_id:'D1',rx_bandwidth_khz:0.5}],'different')).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
});
