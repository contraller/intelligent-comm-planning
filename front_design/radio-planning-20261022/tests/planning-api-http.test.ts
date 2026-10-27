import { describe, expect, it } from 'vitest';
import { createPlanningHttp } from '../src/services/planning-http';
import { readPlanningResult, readApiPlan, readPlanningJob, readPlanningCatalog } from '../src/services/planning-api-validation';
import { httpFixture, response, jobDto, planDto, resultDto, presetDto, frequencyDto } from './fixtures/planning-api';
import type { PlanningResultDetails } from '../src/types/planning-result-details';
import { getPresetResultDetails } from '../src/services/planning-result-details-mock';
import { planningPresets } from '../src/mocks/planning-presets';
// 独立 HTTP 草案样本，刻意保留 0／false 及不由前端纠正的服务结论。
const detailsDto = (): PlanningResultDetails => ({ schemaVersion: 1, assetVersion: 'service-details-v7',
  deviceParameters: [{ deviceId: 'E1', tiltDeg: 0, tiltEffective: false }],
  routeQuality: [{ routeId: 'R1', demandId: 'D1', hopCount: 0, totalDistanceM: 0, totalDelayMs: null, bottleneckMarginDb: -3, reliability: 0, isFeasible: false, bottleneckLinkId: 'L1' }],
  frequencyAssignments: [{ id: 'A1', linkId: 'L1', resourceGroupId: 'F1', freqId: null, reuseGroup: 0, frequencyKhz: 3000, bandwidthKhz: 25 }],
  frequencyConflicts: [{ id: 'C1', type: 'SERVICE_DEFINED', linkIds: ['L1'], frequencyKhz: null, distanceM: 0, requiredDistanceM: null, severity: null }],
  frequencyGap: { requiredChannels: 353, availableChannels: 48, shortage: 0 }, conflictFree: true, unreachableDemandIds: [],
});
const options={context:'planning' as const,taskId:'T1'};
describe('网络规划 HTTP 契约',()=>{
  it('取消扩展可省略且与停止标记独立透传，进度清除两种标记后释放', async () => {
    expect(readPlanningJob(jobDto(), options)).not.toHaveProperty('cancelRequested');
    const raw = { ...jobDto(), status: 'RUNNING', result: null, outcome: null, stopping: true, cancel_requested: true };
    const http = createPlanningHttp(httpFixture(() => response(raw)).request, () => '/api/v1');
    expect(await http.getPlanningTaskProgress({ ...options, jobId: 'J1' })).toMatchObject({ stopping: true, cancelRequested: true });
    raw.stopping = false; raw.cancel_requested = false;
    expect(await http.getPlanningTaskProgress({ ...options, jobId: 'J1' })).toMatchObject({ stopping: false, cancelRequested: false });
  });
  it('轮询接纳3001无结果终态和取消受理，拒绝损坏的终态取消标记', async () => {
    let raw = { ...jobDto(), status: 'FAILED', result: null as any, cancel_requested: false, outcome: { code: 3001, message: '计算预算内未找到可行方案，尚未证明无解', gap: [], suggestions: ['检查冻结约束'] }, error: '本次计算已停止' };
    const fixture = httpFixture(() => response(raw, raw.status === 'FAILED' ? 3001 : 2002));
    const http = createPlanningHttp(fixture.request, () => '/api/v1');
    const failed = await http.getPlanningTask({ ...options, jobId: 'J1' });
    expect(failed.state).toBe('FAILED'); expect(failed.result).toBeNull(); expect(failed.outcome?.message).toContain('尚未证明无解');
    raw = { ...raw, status: 'RUNNING', cancel_requested: true };
    expect((await http.getPlanningTaskProgress({ ...options, jobId: 'J1' })).cancelRequested).toBe(true);
    expect(() => readPlanningJob({ ...raw, status: 'CANCELLED' }, options)).toThrow('cancel request state');
    expect(() => readPlanningJob({ ...raw, cancel_requested: 'true' }, options)).toThrow('cancel_requested');
  });
  it('停止标记可省略，提供时只接受布尔值并透传进度读取', async () => {
    expect(readPlanningJob(jobDto(), options)).not.toHaveProperty('stopping');
    const dto = { ...jobDto(), status: 'FAILED', result: null, outcome: null, stopping: true, error: '计算超时' };
    const service = createPlanningHttp(httpFixture(() => response(dto)).request, () => '/api/v1');
    expect((await service.getPlanningTaskProgress({ ...options, jobId: 'J1' })).stopping).toBe(true);
    dto.stopping = false;
    expect((await service.getPlanningTaskProgress({ ...options, jobId: 'J1' })).stopping).toBe(false);
    expect(() => readPlanningJob({ ...dto, stopping: 'false' }, options)).toThrow('stopping');
  });
  it('作业和保存方案回读同一部署摘要，旧快照缺省不补算', async () => {
    const details = detailsDto();
    details.deploymentSummary = { mode: 'FIXED_COUNT', requestedCount: 5, actualCount: 0,
      requestedSolutionCount: 2, returnedSolutionCount: 1, countSatisfied: false,
      shortfallReasons: ['没有满足条件的新增部署点'], forcedSiteIds: [], lowerBound: null, provedOptimal: false };
    const job = { ...jobDto(), result: { ...resultDto(), result_details: details } };
    const plan = { ...planDto(), state: 'REFERENCE', result: job.result,
      outcome: { code: 3001, message: '指定部署数量未满足', suggestions: ['核对部署条件'],
        gap: [{ objectId: 'T1', field: 'deploymentSolve.fixedCount', message: '实际新增部署数量为0' }] } };
    const f = httpFixture(path => response(path.includes('/plan/tasks/') ? job : plan));
    const http = createPlanningHttp(f.request, () => '/api/v1');
    expect((await http.getPlanningTask({ ...options, jobId: 'J1' })).result!.resultDetails!.deploymentSummary).toEqual(details.deploymentSummary);
    const saved = await http.getPlanningPlan({ ...options, planId: 'P-1' });
    expect(saved.result.resultDetails!.deploymentSummary).toEqual(details.deploymentSummary);
    expect(saved.outcome).toEqual(plan.outcome);
    expect(readApiPlan(planDto(), options).result).not.toHaveProperty('resultDetails');
    Object.assign(details.deploymentSummary, { actualCount: '0' });
    await expect(http.getPlanningPlan({ ...options, planId: 'P-1' })).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });
  it('HTTP候选来源和限制沿用原文、保留副本并拒绝损坏类型', () => {
    const details = detailsDto();
    details.candidateScreening = { sourceLabel: '冻结候选筛选', candidateCount: null, deployableCount: null,
      candidates: null, rejectedStats: null, unavailableReasons: ['尚无通视资料'], dataSources: ['冻结候选表（来源待确认）'] };
    const dto = { ...resultDto(), result_details: details };
    const read = readPlanningResult(dto).resultDetails!.candidateScreening!;
    expect(read).toEqual(details.candidateScreening);
    details.candidateScreening.dataSources!.push('后续变更');
    expect(read.dataSources).toEqual(['冻结候选表（来源待确认）']);
    Object.assign(details.candidateScreening, { dataSources: [{ source: '冻结候选表' }] });
    expect(() => readPlanningResult(dto)).toThrow('dataSources');
    details.candidateScreening.dataSources = null;
    Object.assign(details.candidateScreening, { unavailableReasons: [false] });
    expect(() => readPlanningResult(dto)).toThrow('unavailableReasons');
  });
  it('转正配置读取独立返回值，兼容旧响应并拒绝串用其他版本', async () => {
    const dto = { ...planDto(), state: 'CONFIRMED', current: true, confirmed_at: '2026-10-05T01:00:00Z' };
    expect(readApiPlan(dto, options).confirmedConfiguration).toBeUndefined();
    const configuration = structuredClone(dto.result.configuration);configuration.devices[0].txPowerDbm = 0;
    const confirmed = { source_plan_id: dto.plan_id, source_plan_version: dto.version, source_snapshot_id: dto.result.snapshot_id, confirmed_at: dto.confirmed_at, configuration };
    const f = httpFixture(() => response({ ...dto, confirmed_configuration: confirmed }));
    const value = await createPlanningHttp(f.request, () => '/api/v1').confirmPlanningPlan({ ...options, planId: dto.plan_id, revision: dto.revision, requestId: 'confirm-snapshot' });
    expect(value.confirmedConfiguration?.configuration.devices[0].txPowerDbm).toBe(0);
    expect(value.result.configuration.devices[0].txPowerDbm).not.toBe(0);
    confirmed.source_plan_id = 'another-plan';expect(() => readApiPlan({ ...dto, confirmed_configuration: confirmed }, options)).toThrow('confirmed configuration owner');
    confirmed.source_plan_id = dto.plan_id;confirmed.configuration.devices[0].stationId = 'another-node';
    expect(() => readApiPlan({ ...dto, confirmed_configuration: confirmed }, options)).toThrow('configuration association');
  });
  // HTTP扩展只接受本次响应内容，统计与明细条数不要求相等。
  it('候选扩展保留服务统计/评分/空值，损坏整批拒绝且不发新增请求', async () => {
    const details = detailsDto(); details.candidateScreening = getPresetResultDetails('balanced', planningPresets[0].input)!.candidateScreening;
    const screening = details.candidateScreening!; screening.sourceLabel = '接口独立候选结果'; screening.candidateCount = 1137;
    screening.deployableCount = 1117; screening.candidates = screening.candidates!.slice(0, 1); screening.candidates[0].score = 0.82;
    const dto = { ...resultDto(), result_details: details }, read = readPlanningResult(dto);
    expect(read.resultDetails?.candidateScreening).toEqual(screening); screening.candidates[0].score = 85.17;
    expect(read.resultDetails?.candidateScreening?.candidates![0].score).toBe(0.82);
    screening.candidates[0].coordinate = [181, 37]; expect(() => readPlanningResult(dto)).toThrow('result_details');
    const f = httpFixture(() => response({ ...jobDto(), result: dto }));
    await expect(createPlanningHttp(f.request, () => '/api/v1').getPlanningTask({ ...options, jobId: 'J1' })).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
    details.candidateScreening = null; expect(readPlanningResult(dto).resultDetails!.candidateScreening).toBeNull();
    delete details.candidateScreening; expect(readPlanningResult(dto).resultDetails).not.toHaveProperty('candidateScreening');
  });
  it('补充明细可省略或为 null，提供时保留服务版本和原始值且与 DTO 分离',()=>{
    for (const value of [resultDto(), { ...resultDto(), result_details: null }]) expect(readPlanningResult(value)).not.toHaveProperty('resultDetails');
    const details = detailsDto(), dto = { ...jobDto(), result: { ...resultDto(), result_details: details } };
    const read = readPlanningJob(dto, options).result!;
    expect(read.resultDetails).toEqual(details); expect(read.resultDetails).not.toBe(details);
    details.deviceParameters![0].tiltDeg = 15;
    expect(read.resultDetails!.deviceParameters![0].tiltDeg).toBe(0);
    expect(read.resultDetails!.conflictFree).toBe(true); expect(read.resultDetails!.frequencyGap!.shortage).toBe(0);
  });
  it('不可达需求只关联完整冻结输入，不按缺少路由或数组位置推断',()=>{
    const dto = jobDto(), extra = { ...dto.input.demands[0], id: 'D2', service: '话音' as const };
    dto.input.demands.push(extra);
    const details = detailsDto(); details.unreachableDemandIds = ['D2'];
    const value = { ...dto, result: { ...dto.result, result_details: details } };
    expect(readPlanningJob(value, options).result!.resultDetails!.unreachableDemandIds).toEqual(['D2']);
    details.unreachableDemandIds = ['D404']; expect(() => readPlanningJob(value, options)).toThrow('result_details');
  });
  it('独立结果读取允许同一需求包含主备路由，不把路由行数当需求身份数',()=>{
    const dto=resultDto();dto.configuration.routes.push({...dto.configuration.routes[0],id:'R2',backup:true});
    expect(readPlanningResult({...dto,result_details:detailsDto()}).resultDetails!.routeQuality![0].demandId).toBe('D1');
  });
  it.each(['schema', 'missing', 'device', 'route', 'bottleneck', 'link', 'frequency', 'group', 'duplicate', 'bandwidth', 'reuse', 'reliability', 'gap'] as const)('已有明细损坏时拒绝完整方案：%s', kind=>{
    const d = detailsDto();
    if (kind === 'schema') d.schemaVersion = 2 as 1;
    if (kind === 'missing') delete (d as Partial<PlanningResultDetails>).conflictFree;
    if (kind === 'device') d.deviceParameters![0].deviceId = 'E404';
    if (kind === 'route') d.routeQuality![0].demandId = 'D404';
    if (kind === 'bottleneck') d.routeQuality![0].bottleneckLinkId = 'L404';
    if (kind === 'link') d.frequencyAssignments![0].linkId = 'L404';
    if (kind === 'frequency') d.frequencyAssignments![0].frequencyKhz = 3100;
    if (kind === 'group') d.frequencyAssignments![0].resourceGroupId = 'F404';
    if (kind === 'duplicate') d.frequencyAssignments!.push({ ...d.frequencyAssignments![0], id: 'A2' });
    if (kind === 'bandwidth') d.frequencyAssignments![0].bandwidthKhz = 0;
    if (kind === 'reuse') d.frequencyAssignments![0].reuseGroup = 1.5;
    if (kind === 'reliability') d.routeQuality![0].reliability = 1.01;
    if (kind === 'gap') d.frequencyGap!.shortage = -1;
    expect(() => readApiPlan({ ...planDto(), result: { ...resultDto(), result_details: d } }, options)).toThrow('result_details');
  });
  it('无效明细不能被查询或导出静默降为无明细成功，也不接受算法局部响应',async()=>{
    const d = detailsDto(); d.frequencyAssignments![0].linkId = 'L404';
    const f = httpFixture(() => response({ ...jobDto(), result: { ...resultDto(), result_details: d } }));
    await expect(createPlanningHttp(f.request, () => '/api/v1').getPlanningTask({ ...options, jobId: 'J1' })).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
    expect(() => readPlanningJob({ assignments: [], conflict_free: true }, options)).toThrow();
  });
  // 日期读取器复用于详情、对比和导出，统一拒收损坏时间而不修补响应。
  it.each(['saved_at','confirmed_at'] as const)('方案 %s 拒绝无效日历和非项目时间格式',field=>{
    for(const value of ['2026-02-30T09:00:00+08:00','2026/10/15 09:00:00+08:00','2026-10-15T09:00:00']){
      const dto=planDto();dto[field]=value;if(field==='confirmed_at')dto.state='CONFIRMED';
      expect(()=>readApiPlan(dto,options)).toThrow(field);
    }
  });
  it('方案时间保留原时区与小数秒，未确认时间仍可为 null',()=>{
    const dto=planDto();dto.saved_at='2024-02-29T09:00:00.123+08:00';
    expect(readApiPlan(dto,options)).toMatchObject({savedAt:dto.saved_at,confirmedAt:null});
    dto.state='CONFIRMED';dto.confirmed_at='2024-02-29T09:01:00-05:30';
    expect(readApiPlan(dto,options)).toMatchObject({savedAt:dto.saved_at,confirmedAt:dto.confirmed_at});
  });
  it.each(['2026-02-30T09:00:00+08:00','2026/10/15 09:00:00+08:00'])('作业、方案和预设默认输入一致拒绝无效开始时间 %s',startTime=>{
    const job=jobDto(),plan=planDto(),presets=presetDto();
    job.input.startTime=startTime;plan.input.startTime=startTime;presets.items[0].defaults.startTime=startTime;
    for(const read of [()=>readPlanningJob(job,options),()=>readApiPlan(plan,options),()=>readPlanningCatalog(presets,frequencyDto())])expect(read).toThrow('startTime');
  });
  it.each([null,'2024-02-29T23:59:59.125+08:00'])('作业、方案和预设默认输入一致保留开始时间 %s',startTime=>{
    const job=jobDto(),plan=planDto(),presets=presetDto();
    job.input.startTime=startTime;plan.input.startTime=startTime;presets.items[0].defaults.startTime=startTime;
    expect(readPlanningJob(job,options).input.startTime).toBe(startTime);
    expect(readApiPlan(plan,options).input.startTime).toBe(startTime);
    expect(readPlanningCatalog(presets,frequencyDto()).presets[0].defaults.startTime).toBe(startTime);
  });
  it('2002 携带完整进行中作业时继续轮询，不接受未知状态',async()=>{
    const dto={...jobDto(),status:'RUNNING',result:null,outcome:null,progress:0.25};
    const f=httpFixture(()=>response(dto,2002)),service=createPlanningHttp(f.request,()=>'/api/v1');
    expect((await service.getPlanningTask({...options,jobId:'J1'})).progress).toBe(25);
    dto.status='OTHER';await expect(service.getPlanningTask({...options,jobId:'J1'})).rejects.toMatchObject({code:2002});
  });
  it('复用频率池与参数预设，版本不一致拒绝混合目录',async()=>{
    const f=httpFixture(path=>response(path.includes('param-presets')?presetDto():frequencyDto())),service=createPlanningHttp(f.request,()=>'/api/v1');
    expect((await service.loadPlanningCatalog(options)).presets[0].defaults.stationIds).toEqual(['N1','N2']);
    const bad=httpFixture(path=>response(path.includes('param-presets')?presetDto():{...frequencyDto(),revision:'other'}));await expect(createPlanningHttp(bad.request,()=>'/api/v1').loadPlanningCatalog(options)).rejects.toMatchObject({code:'INVALID_PLANNING_RESPONSE'});
  });
  it('全流程提交引用保存输入，进度由 0–1 转为展示百分比',async()=>{
    const f=httpFixture(()=>response({...jobDto(),status:'RUNNING',progress:0.42,result:null,outcome:null})),service=createPlanningHttp(f.request,()=>'/api/v1');
    const value=await service.submitPlanningTask({...options,requestId:'submit',revision:'t1',inputVersion:'i1',conditionVersion:'c1',resourceRevision:'r1',parentPlanId:null});
    expect(value.progress).toBe(42);expect(value.result).toBeNull();const c=f.calls.at(-1)!;expect(c.path).toBe('/api/v1/plan/sr4-flow');expect(JSON.parse(String(c.init.body))).toMatchObject({task_id:'T1',input_version:'i1',condition_version:'c1'});
  });
  it('复用作业查询及通用取消端点，取消竞态以返回状态为准',async()=>{
    const f=httpFixture(()=>response(jobDto())),service=createPlanningHttp(f.request,()=>'/api/v1');
    await service.getPlanningTask({...options,jobId:'J1'});expect(f.calls.at(-1)!.path).toContain('/plan/tasks/J1?');
    expect((await service.cancelPlanningTask({...options,jobId:'J1',revision:'j1',requestId:'cancel'})).state).toBe('SUCCESS');expect(f.calls.at(-1)!).toMatchObject({path:'/api/v1/tasks/J1',init:{method:'DELETE'}});
  });
  it('结果保留未知值、多面与孔洞，并拒绝断开的路由与设备归属',()=>{
    const dto=resultDto(),result=readPlanningResult(dto);expect(result.nodes[0].alert).toBeNull();expect(result.devices[0].availability).toBeNull();expect(result.metrics.coveragePercent).toBeNull();expect(result.coverage.contour!.features[0].geometry.coordinates).toEqual(dto.coverage.contour.features[0].geometry.coordinates);
    dto.links[0].deviceA='E2';expect(()=>readPlanningResult(dto)).toThrow('link association');
    const broken=resultDto();broken.configuration.routes[0].nodeIds=['N2','N1'];expect(()=>readApiPlan({...planDto(),result:broken},options)).toThrow('route/demand');
  });
  it('完整未达标可为参考方案，伪造达标状态不能通过校验',async()=>{
    const dto=planDto();dto.name='参考';dto.state='REFERENCE';dto.outcome.code=3001;dto.result.checks[0].passed=false;
    const f=httpFixture(()=>response(dto));expect((await createPlanningHttp(f.request,()=>'/api/v1').savePlanningPlan({...options,jobId:'J1',revision:'j1',requestId:'save',name:'参考',note:''})).state).toBe('REFERENCE');
    dto.state='CONFIRMED';dto.confirmed_at='2026-10-05T01:00:00Z';expect(()=>readApiPlan(dto,options)).toThrow('plan state');
  });
  it('保存、确认使用版本和幂等标识；对比保持所选顺序与同任务归属',async()=>{
    const f=httpFixture(path=>response(path.endsWith('/compare')?[planDto('B'),planDto('A')]:path.endsWith('/confirm')?{...planDto(),state:'CONFIRMED',current:true,confirmed_at:'2026-10-05T01:00:00Z'}:{...planDto(),name:'方案',note:'说明'})),service=createPlanningHttp(f.request,()=>'/api/v1');
    await service.savePlanningPlan({...options,jobId:'J1',revision:'j1',requestId:'save',name:'方案',note:'说明'});expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toMatchObject({expected_revision:'j1',request_id:'save'});
    await service.confirmPlanningPlan({...options,planId:'P-1',revision:'p1',requestId:'confirm'});expect(f.calls.at(-1)!.path).toBe('/api/v1/plans/P-1/confirm');
    expect((await service.comparePlanningPlans({...options,planIds:['A','B']})).map(p=>p.id)).toEqual(['A','B']);expect(f.calls.at(-1)!.path).toBe('/api/v1/plans/compare');
  });
  it('业务失败的缺口与建议随错误保留，HTTP 不回退 Mock',async()=>{
    const data={suggestions:['减少约束'],gap:[{objectId:'D1',field:'frequency',message:'频率不足'}]},f=httpFixture(()=>response(data,3002));
    await expect(createPlanningHttp(f.request,()=>'/api/v1').getPlanningTask({...options,jobId:'J1'})).rejects.toMatchObject({code:3002,data});
  });
  it('外层 3001 携带完整未达标结果时保留可保存的参考结果',async()=>{
    const dto=jobDto();dto.outcome={code:3001,message:'约束未达标',suggestions:['调整任务'],gap:[]};dto.result.checks[0].passed=false;
    const f=httpFixture(()=>response(dto,3001));const result=await createPlanningHttp(f.request,()=>'/api/v1').getPlanningTask({...options,jobId:'J1'});expect(result.result!.snapshotId).toBe('S1');expect(result.outcome!.code).toBe(3001);expect(result.result!.checks[0].passed).toBe(false);
  });
  it('导出先取冻结 JSON，XLSX 不调用资料中未实现的服务端格式',async()=>{
    const f=httpFixture(()=>response(planDto())),service=createPlanningHttp(f.request,()=>'/api/v1'),file=await service.exportPlanningPlan({...options,planId:'P-1',format:'json'});
    const record=JSON.parse(new TextDecoder().decode(file.bytes));expect(record.source).toBe('测试接口');expect(record.plan.result.coverage.rasterPng.url).toContain('/files/');expect(f.calls.at(-1)!.path).toContain('format=json');
  });
});
