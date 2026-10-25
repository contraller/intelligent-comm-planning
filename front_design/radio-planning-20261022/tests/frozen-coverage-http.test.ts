import { describe,expect,it,vi } from 'vitest';
import { createFrozenCoverageHttp } from '../src/services/frozen-coverage-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { coverageParameters } from '../src/services/frozen-coverage-decode';
import { bandwidthCase,coverageCase,coverageV4Case } from './helpers/frozen-coverage';
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

describe('V4活动分类与冻结构造来源',()=>{
  it.each([{complete:226,unavailable:26,skipped:208},{complete:1,unavailable:0,skipped:2},{complete:0,unavailable:1,skipped:1},{complete:0,unavailable:0,skipped:2},{complete:0,unavailable:0,skipped:0}])('只按活动设备判定状态并核对summary %j',async counts=>{
    const f=coverageV4Case(counts),request=vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    const cached=await client.getCache(f.query,f.parameters);
    expect(cached.result?.summary).toEqual({total:counts.complete+counts.unavailable+counts.skipped,eligible:counts.complete+counts.unavailable,...counts});
    expect(cached.result?.status).toBe(counts.complete+counts.unavailable===0?'NOT_APPLICABLE':counts.unavailable===0?'COMPLETE':counts.complete?'PARTIAL':'UNAVAILABLE');
  });
  it('新冻结型号构造来源逐字段保留，旧选择六字段可绑定同来源V4',async()=>{
    const f=coverageV4Case({complete:1,unavailable:0,skipped:1},true,true),request=vi.fn<AuthenticatedRequest>().mockResolvedValueOnce(f.options).mockResolvedValueOnce(f.cache).mockResolvedValueOnce(f.selection),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    const before=structuredClone(f);
    expect((await client.getBandwidthOptions(f.query)).devices[0]!.bandwidth_provenance).toEqual(f.result.devices[0]!.bandwidth_provenance);
    expect((await client.getCache(f.query,f.parameters)).result?.devices[0]!.frozen_model?.source_doc).toBe('原冻结型号资料');
    expect(Object.keys(await client.getBandwidthSelection(f.query,f.selection.selection_id))).toHaveLength(6);
    expect(f).toEqual(before);
  });
  it.each(['missing','origin','id','hash','note','original','source-doc','mixed','raw-source','raw-bandwidth'] as const)('拒绝损坏或混合的构造来源%s',async kind=>{
    const f=coverageV4Case({complete:1,unavailable:0,skipped:0},true),device=f.result.devices[0]!,source=device.bandwidth_provenance!;
    if(kind==='missing')delete device.bandwidth_provenance;
    if(kind==='origin')Object.assign(source,{origin:'MANUFACTURER'});
    if(kind==='id')Object.assign(source,{source_id:'unknown'});
    if(kind==='hash')source.source_sha256='A'.repeat(64);
    if(kind==='note')source.source_note=' ';
    if(kind==='original')Object.assign(source,{original_khz:'3'});
    if(kind==='source-doc'){delete (source as Partial<typeof source>).original_khz;Object.assign(source,{source_doc:''});}
    if(kind==='mixed')Object.assign(source,{source_doc:''});
    if(kind==='raw-source')device.frozen_model!.bandwidth_source_sha256='0'.repeat(64);
    if(kind==='raw-bandwidth')device.frozen_model!.bandwidth_khz='25';
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each(['missing','extra','origin','original','band','bandwidth'] as const)('V4选项目录严格检查每设备来源%s',async kind=>{
    const f=coverageV4Case({complete:1,unavailable:0,skipped:0},true),device=f.options.devices[0]!;
    if(kind==='missing')delete device.bandwidth_provenance;
    if(kind==='extra')Object.assign(device.bandwidth_provenance!,{source_doc:''});
    if(kind==='origin')Object.assign(device.bandwidth_provenance!,{origin:'UNKNOWN'});
    if(kind==='original')Object.assign(device.bandwidth_provenance!,{original_khz:null});
    if(kind==='band')device.band='VUHF';
    if(kind==='bandwidth')device.options_khz=[25];
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.options) as AuthenticatedRequest).getBandwidthOptions(f.query)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each(['model','band','antenna','pattern','plan','plan-node','number','duplicate','radio','computations','reason','summary','fraction','extra-summary','schema','missing-bandwidth','extra-bandwidth','missing-source','partial-raw-source'] as const)('SKIPPED不能放过结构损坏%s',async kind=>{
    const f=coverageV4Case({complete:0,unavailable:0,skipped:1}),device=f.result.devices[0]!;
    if(kind==='model')device.frozen_model!.model_id='unknown';
    if(kind==='band'){device.band='unknown';device.frozen_model!.device_class='unknown';}
    if(kind==='antenna')device.frozen_antenna!.antenna_id='other';
    if(kind==='pattern')device.frozen_antenna!.pattern_type=3;
    if(kind==='plan')device.planned_parameters!.device_id='other';
    if(kind==='plan-node')device.planned_parameters!.node_id='other';
    if(kind==='number')device.planned_parameters!.tx_power_dbm='bad';
    if(kind==='duplicate')f.result.devices.push(structuredClone(device));
    if(kind==='radio')device.radio_parameters=coverageV4Case().result.devices[0]!.radio_parameters;
    if(kind==='computations')device.computations=coverageV4Case().result.devices[0]!.computations;
    if(kind==='reason')device.reason_code='RX_BANDWIDTH_UNKNOWN';
    if(kind==='summary')f.result.summary!.skipped=0;
    if(kind==='fraction')f.result.summary!.eligible=0.5;
    if(kind==='extra-summary')Object.assign(f.result.summary!,{failed:0});
    if(kind==='schema')f.result.schema_version=1;
    if(kind==='missing-bandwidth')delete device.rx_bandwidth;
    if(kind==='extra-bandwidth')Object.assign(device.rx_bandwidth!,{origin:'ignored'});
    if(kind==='missing-source')delete device.bandwidth_provenance;
    if(kind==='partial-raw-source')device.frozen_model!.bandwidth_original_khz='';
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it('缺失射频资料的合法SKIPPED及有带宽的参数缺失分别保留原状态',async()=>{
    const f=coverageV4Case({complete:0,unavailable:1,skipped:1}),unavailable=f.result.devices[0]!,skipped=f.result.devices[1]!;
    unavailable.reason_code='FROZEN_PARAMETERS_UNKNOWN';unavailable.rx_bandwidth={value_khz:2.4,source:'FROZEN_MODEL_SINGLE_VALUE'};
    unavailable.frozen_model!.bandwidth_khz='2.4';
    skipped.frozen_model=null;skipped.frozen_antenna=null;skipped.band=null;
    skipped.rx_bandwidth={value_khz:null,source:'UNKNOWN'};
    const result=(await createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).result!;
    expect(result.devices.map(row=>row.status)).toEqual(['UNAVAILABLE','SKIPPED']);
  });
  it.each(['summary','reason','source'] as const)('旧V3响应不得混入未核验的V4字段%s',async kind=>{
    const f=bandwidthCase();
    if(kind==='summary')f.result.summary={total:1,eligible:1,complete:1,unavailable:0,skipped:0};
    if(kind==='reason')f.result.devices[0]!.reason_code=null;
    if(kind==='source')f.result.devices[0]!.bandwidth_provenance=null;
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each(['missing-summary','overall','radio','raw-radio','reason','null-computation'] as const)('V4完成结果拒绝损坏状态或射频参数%s',async kind=>{
    const f=coverageV4Case({complete:1,unavailable:0,skipped:0}),device=f.result.devices[0]!;
    if(kind==='missing-summary')delete f.result.summary;
    if(kind==='overall')f.result.status='PARTIAL';
    if(kind==='radio')device.radio_parameters!.bw=3;
    if(kind==='raw-radio')device.planned_parameters!.tx_power_dbm=99;
    if(kind==='reason')device.reasons=['错误完成状态'];
    if(kind==='null-computation')device.computations[0]=null as never;
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each(['single-mismatch','empty-token','negative','zero','nonfinite','unselected-scalar','unknown-known','explicit-outside'] as const)('V4普通型号原始带宽联核拒绝%s，跳过也不例外',async kind=>{
    const f=coverageV4Case(kind==='single-mismatch'||kind==='explicit-outside'?{complete:1,unavailable:0,skipped:0}:{complete:0,unavailable:0,skipped:1},false,kind==='explicit-outside'),device=f.result.devices[0]!;
    if(kind==='single-mismatch'||kind==='explicit-outside')device.frozen_model!.bandwidth_khz='25';
    if(kind==='empty-token')device.frozen_model!.bandwidth_khz='0.5;;3';
    if(kind==='negative')device.frozen_model!.bandwidth_khz='0.5;-3';
    if(kind==='zero')device.frozen_model!.bandwidth_khz=0;
    if(kind==='nonfinite')device.frozen_model!.bandwidth_khz='Infinity';
    if(kind==='unselected-scalar')device.rx_bandwidth={value_khz:null,source:'UNSELECTED'};
    if(kind==='unknown-known')device.rx_bandwidth={value_khz:null,source:'UNKNOWN'};
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it('V4合法选项去重不替用户选值，同来源显式选值仍须属于原集合',async()=>{
    const f=coverageV4Case({complete:1,unavailable:0,skipped:1},false,true),complete=f.result.devices[0]!,skipped=f.result.devices[1]!;
    complete.frozen_model!.bandwidth_khz='0.5;2.4;2.4';
    skipped.frozen_model!.bandwidth_khz='3;3';skipped.rx_bandwidth={value_khz:null,source:'UNSELECTED'};
    const result=(await createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).result!;
    expect(result.devices[0]!.rx_bandwidth).toEqual({value_khz:2.4,source:'EXPLICIT_COMPUTE_PARAMETER'});
    expect(result.devices[1]!.rx_bandwidth).toEqual({value_khz:null,source:'UNSELECTED'});
  });
  it.each(['0x1e','0b11110','0o36'])('SKIPPED不能将JS扩展数值%s当作合法冻结参数',async raw=>{
    const f=coverageV4Case({complete:0,unavailable:0,skipped:1});f.result.devices[0]!.planned_parameters!.tx_power_dbm=raw;
    await expect(createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
  it.each([' +3e1 ',' -3.0e1 ',' .5 ',' 30. '])('SKIPPED仍接受范围内十进制/指数和空白%s',async raw=>{
    const f=coverageV4Case({complete:0,unavailable:0,skipped:1});f.result.devices[0]!.planned_parameters!.tx_power_dbm=raw;
    expect((await createFrozenCoverageHttp(vi.fn<AuthenticatedRequest>().mockResolvedValue(f.cache) as AuthenticatedRequest).getCache(f.query,f.parameters)).result?.devices[0]!.status).toBe('SKIPPED');
  });
  it('engineVersion仅发送到cache历史GET，其他请求沿原契约且不将V3补成V4',async()=>{
    const f=bandwidthCase(),query={...f.query,engineVersion:'V01-3' as const},request=vi.fn<AuthenticatedRequest>().mockResolvedValueOnce(f.cache).mockResolvedValueOnce(f.job).mockResolvedValueOnce(f.options),client=createFrozenCoverageHttp(request as AuthenticatedRequest);
    const cached=await client.getCache(query,f.parameters);await client.compute(query,f.parameters,'request-1');await client.getBandwidthOptions(query);
    expect(new URL(request.mock.calls[0]![0],'http://localhost').searchParams.get('engine_version')).toBe('V01-3');
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).not.toHaveProperty('engine_version');
    expect(new URL(request.mock.calls[2]![0],'http://localhost').searchParams.has('engine_version')).toBe(false);
    expect(cached.result?.schema_version).toBe(1);expect(cached.result).not.toHaveProperty('summary');expect(cached.result?.devices[0]).not.toHaveProperty('bandwidth_provenance');
    request.mockResolvedValueOnce(coverageV4Case().cache);
    await expect(client.getCache(query,f.parameters)).rejects.toMatchObject({code:'INVALID_FROZEN_COVERAGE_RESPONSE'});
  });
});
