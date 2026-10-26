import { describe, expect, it } from 'vitest';
import { createPlanningHttp } from '../src/services/planning-http';
import { readApiPlan, readPlanningCatalog, readPlanningJob } from '../src/services/planning-api-validation';
import { exportApiPlanFile } from '../src/services/plan-export';
import type { PlanningAdjustment } from '../src/types/planning-adjustment';
import { frequencyDto, httpFixture, input, jobDto, planDto, presetDto, response } from './fixtures/planning-api';

const options = { context: 'planning' as const, taskId: 'T1' };
const adjustment = (): PlanningAdjustment => ({ schemaVersion: 1, sourcePlanId: 'P-parent', sourceSnapshotId: 'S-parent', manualOverrides: [{ deviceId: 'E1', txPowerDbm: 0, antennaHeightM: 0 }, { deviceId: 'E2', txPowerDbm: 30 }], manualPaths: [{ demandId: 'D1', nodePath: ['N1', 'N2'] }] });
const wire = () => ({ schema_version: 1, source_plan_id: 'P-parent', source_snapshot_id: 'S-parent', manual_override: [{ device_id: 'E1', tx_power_dbm: 0, antenna_height_m: 0 }, { device_id: 'E2', tx_power_dbm: 30 }], manual_paths: [{ demand_id: 'D1', node_path: ['N1', 'N2'] }] });
const submit = () => ({ ...options, requestId: 'adjust-1', revision: 't1', inputVersion: 'i1', conditionVersion: 'c1', resourceRevision: 'r1', parentPlanId: 'P-parent', adjustment: adjustment() });
const adjustedJob = () => ({ ...jobDto(), parent_plan_id: 'P-parent', adjustment: wire() });
const adjustedPlan = () => ({ ...planDto(), parent_plan_id: 'P-parent', adjustment: wire() });

describe('独立方案调整 HTTP 契约', () => {
  it('只在调整时发送补充字段，保留 0、缺省高度和有序路径，回显不依赖本地档位', async () => {
    const f = httpFixture(() => response(adjustedJob())), service = createPlanningHttp(f.request, () => '/api/v1');
    const job = await service.submitPlanningTask(submit());
    const call = f.calls.at(-1)!;
    expect(call.path).toBe('/api/v1/plan/sr4-flow');
    expect(JSON.parse(String(call.init.body))).toEqual({ request_id: 'adjust-1', task_id: 'T1', expected_revision: 't1', context: 'planning', input_version: 'i1', condition_version: 'c1', resource_revision: 'r1', parent_plan_id: 'P-parent', adjustment: wire() });
    expect(job.adjustment).toEqual(adjustment()); expect(job).not.toHaveProperty('resultPresetId');
    const raw = adjustedJob(); const parsed = readPlanningJob(raw, options); raw.adjustment.manual_paths[0].node_path.reverse();
    expect(parsed.adjustment!.manualPaths[0].nodePath).toEqual(['N1', 'N2']);
  });

  it('普通提交继续使用原请求形状，旧 Job 和 Plan 不补调整字段', async () => {
    const f = httpFixture(() => response(jobDto())), request = submit();
    await createPlanningHttp(f.request, () => '/api/v1').submitPlanningTask({ ...request, parentPlanId: null, adjustment: undefined });
    expect(JSON.parse(String(f.calls.at(-1)!.init.body))).not.toHaveProperty('adjustment');
    expect(readPlanningJob(jobDto(), options)).not.toHaveProperty('adjustment');
    expect(readApiPlan(planDto(), options)).not.toHaveProperty('adjustment');
  });

  it('回显比较不受对象属性创建顺序影响，路径节点顺序仍严格保留', async () => {
    const f = httpFixture(() => response(adjustedJob())), request = submit();
    request.adjustment = { manualPaths: request.adjustment.manualPaths, manualOverrides: [{ antennaHeightM: 0, txPowerDbm: 0, deviceId: 'E1' }, { txPowerDbm: 30, deviceId: 'E2' }], sourceSnapshotId: 'S-parent', sourcePlanId: 'P-parent', schemaVersion: 1 };
    expect((await createPlanningHttp(f.request, () => '/api/v1').submitPlanningTask(request)).adjustment).toEqual(adjustment());
  });

  it.each(['missing', 'snapshot', 'power', 'path', 'unexpected'] as const)('拒绝与提交不同的回显：%s', async kind => {
    const dto: Record<string, unknown> = adjustedJob();
    if (kind === 'missing') delete dto.adjustment;
    if (kind === 'snapshot') dto.adjustment = { ...wire(), source_snapshot_id: 'S-other' };
    if (kind === 'power') dto.adjustment = { ...wire(), manual_override: [{ device_id: 'E1', tx_power_dbm: 1 }] };
    if (kind === 'path') dto.adjustment = { ...wire(), manual_paths: [] };
    const request = kind === 'unexpected' ? { ...submit(), adjustment: undefined } : submit();
    const f = httpFixture(() => response(dto));
    await expect(createPlanningHttp(f.request, () => '/api/v1').submitPlanningTask(request)).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });

  it.each(['null', 'schema', 'device', 'demand', 'node', 'endpoints', 'duplicate', 'height', 'source', 'snapshot', 'self'] as const)('存在但损坏的调整信息不会当成旧版本缺省：%s', kind => {
    const dto: Record<string, unknown> = adjustedPlan(), a: Record<string, unknown> = wire(); dto.adjustment = a;
    if (kind === 'null') dto.adjustment = null;
    if (kind === 'schema') a.schema_version = 2;
    if (kind === 'device') a.manual_override = [{ device_id: 'E404', tx_power_dbm: 0 }];
    if (kind === 'demand') a.manual_paths = [{ demand_id: 'D404', node_path: ['N1', 'N2'] }];
    if (kind === 'node') a.manual_paths = [{ demand_id: 'D1', node_path: ['N1', 'N404', 'N2'] }];
    if (kind === 'endpoints') a.manual_paths = [{ demand_id: 'D1', node_path: ['N2', 'N1'] }];
    if (kind === 'duplicate') a.manual_paths = [{ demand_id: 'D1', node_path: ['N1', 'N1', 'N2'] }];
    if (kind === 'height') a.manual_override = [{ device_id: 'E1', antenna_height_m: -1 }];
    if (kind === 'source') a.source_plan_id = 'P-other';
    if (kind === 'snapshot') a.source_snapshot_id = 'S1';
    if (kind === 'self') { a.source_plan_id = 'P-1'; dto.parent_plan_id = 'P-1'; }
    expect(() => readApiPlan(dto, options)).toThrow();
  });

  it('请求父版本不符与非有限输入在发送前拒绝', async () => {
    const f = httpFixture(() => response(adjustedJob())), service = createPlanningHttp(f.request, () => '/api/v1');
    await expect(service.submitPlanningTask({ ...submit(), parentPlanId: 'P-other' })).rejects.toBeDefined();
    const request = submit(); request.adjustment.manualOverrides[0].txPowerDbm = NaN;
    await expect(service.submitPlanningTask(request)).rejects.toBeDefined();
    expect(f.calls).toHaveLength(0);
  });

  it('目录可省示例；存在时带需求模板，重复身份或空扩展拒绝', () => {
    expect(readPlanningCatalog(presetDto(), frequencyDto())).not.toHaveProperty('adjustmentExamples');
    const example = { id: 'external-sample', label: '服务演示', source: '甲方测试样本', input: input(), manual_override: wire().manual_override, manual_paths: wire().manual_paths };
    const catalog = readPlanningCatalog({ ...presetDto(), adjustment_examples: [example] }, frequencyDto());
    expect(catalog.adjustmentExamples![0]).toMatchObject({ id: 'external-sample', input: input(), manualOverrides: adjustment().manualOverrides, manualPaths: adjustment().manualPaths });
    expect(() => readPlanningCatalog({ ...presetDto(), adjustment_examples: null }, frequencyDto())).toThrow();
    expect(() => readPlanningCatalog({ ...presetDto(), adjustment_examples: [example, example] }, frequencyDto())).toThrow();
    expect(() => readPlanningCatalog({ ...presetDto(), adjustment_examples: [{ ...example, input: undefined }] }, frequencyDto())).toThrow();
  });

  it('失败建议和字段详情原样保留，运行中与完整参考结果继续带调整回显', async () => {
    const details = { suggestions: ['调整设备功率'], gap: [{ objectId: 'E1', field: 'tx_power_dbm', message: '未满足服务能力范围' }] };
    const denied = httpFixture(() => response(details, 3002));
    await expect(createPlanningHttp(denied.request, () => '/api/v1').submitPlanningTask(submit())).rejects.toMatchObject({ code: 3002, data: details });
    const pending = httpFixture(() => response({ ...adjustedJob(), status: 'RUNNING', progress: 0.5, result: null, outcome: null }, 2002));
    expect((await createPlanningHttp(pending.request, () => '/api/v1').submitPlanningTask(submit())).adjustment).toEqual(adjustment());
    const dto = adjustedJob(); dto.outcome = { code: 3001, message: '未达标', suggestions: ['降低高度'], gap: [] }; dto.result.checks[0].passed = false;
    const reference = httpFixture(() => response(dto, 3001));
    expect((await createPlanningHttp(reference.request, () => '/api/v1').submitPlanningTask(submit())).outcome?.code).toBe(3001);
  });

  it('JSON 和 XLSX 保存父快照与人工输入，历史版本明确无调整信息', async () => {
    const plan = readApiPlan(adjustedPlan(), options), file = await exportApiPlanFile(plan, 'json');
    expect(JSON.parse(new TextDecoder().decode(file.bytes)).plan.adjustment).toEqual(adjustment());
    const Excel = (await import('exceljs')).default, workbook = new Excel.Workbook();
    await workbook.xlsx.load((await exportApiPlanFile(plan, 'xlsx')).bytes as never);
    expect(workbook.getWorksheet('方案调整来源')!.getRow(2).values).toContain('S-parent');
    expect(workbook.getWorksheet('人工设备输入')!.getRow(2).values).toEqual([, 'E1', 0, 0]);
    expect(workbook.getWorksheet('人工主路由')!.getRow(2).values).toContain('["N1","N2"]');
    const old = new Excel.Workbook(); await old.xlsx.load((await exportApiPlanFile(readApiPlan(planDto(), options), 'xlsx')).bytes as never);
    expect(old.getWorksheet('方案调整来源')!.getRow(1).values).toContain('此历史版本未保存人工调整信息');
  });
});
