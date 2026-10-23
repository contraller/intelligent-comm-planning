import { describe, expect, it } from 'vitest';
import { interferenceFixture } from './helpers/interference';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { planningPresets } from '../src/mocks/planning-presets';
import { monitoringPresets } from '../src/mocks/monitoring-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import { interferenceScenarios } from '../src/mocks/interference-presets';
import { networkDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { assertDiagnosisNetwork } from '../src/services/diagnosis-validation';
import { assertBaseNetwork } from '../src/services/interference-validation';
import { monitoringPresetForPlan } from '../src/services/monitoring-validation';
import { createMonitoringMock } from '../src/services/monitoring-mock';
import { exportPlanFile } from '../src/services/plan-export';
import type { PlanVersion } from '../src/types/domain';
import type { PlanningAdjustment } from '../src/types/planning-adjustment';

type Fixture = Awaited<ReturnType<typeof interferenceFixture>>;

// 端到端走真实前端服务和存储，不直接伪造“已确认”状态。
function adjustment(parent: PlanVersion, targetId: string): PlanningAdjustment {
  const target = planningPresets.find(row => row.id === targetId)!;
  return {
    schemaVersion: 1, sourcePlanId: parent.id, sourceSnapshotId: parent.snapshotId,
    manualOverrides: target.result!.configuration.devices.map(row => ({
      deviceId: row.deviceId, txPowerDbm: row.txPowerDbm, antennaHeightM: row.antennaHeightM,
    })),
    manualPaths: target.result!.configuration.routes.filter(row => !row.backup).map(row => ({
      demandId: row.demandId, nodePath: [...row.nodeIds],
    })),
  };
}
async function adjust(s: Fixture, parent: PlanVersion, targetId = 'economical') {
  const request = {
    baseRevision: (await s.planning.loadPlanningWorkspace()).workspace.revision,
    requestId: crypto.randomUUID(), taskId: parent.taskId, parentPlanVersionId: parent.id,
    input: structuredClone(parent.workflow!.input), adjustment: adjustment(parent, targetId),
  };
  const submitted = await s.planning.submitPlanning(request);
  s.advance();
  const viewed = await s.planning.getPlanningJob(submitted.view.job.id);
  expect(viewed.state).toBe('SUCCESS');
  const saved = await s.planning.savePlanVersion({
    baseRevision: submitted.workspace.revision, requestId: crypto.randomUUID(),
    jobId: viewed.job.id, name: '具体参数与路由调整', note: '保持原任务条件',
  });
  return saved.plan;
}
async function diagnose(s: Fixture, plan: PlanVersion) {
  const preset = networkDiagnosisPresets(plan).find(row => row.id.endsWith(':hardware'))!;
  const workspace = (await s.diagnosis.loadDiagnosisWorkspace()).workspace!;
  const saved = await s.diagnosis.saveDiagnosisScenario({
    baseRevision: workspace.revision, requestId: crypto.randomUUID(), scenarioId: null,
    draft: { name: '调整网络诊断', description: '', planId: plan.id, faults: structuredClone(preset.faults) },
  });
  const submitted = await s.diagnosis.submitDiagnosis({
    baseRevision: saved.revision, requestId: crypto.randomUUID(),
    scenarioVersionId: saved.scenarios.at(-1)!.versions.at(-1)!.id, demo: 'normal',
  });
  s.advance();
  return s.diagnosis.getDiagnosisReport(submitted.view.run.id);
}

describe('独立方案调整与现有业务关联', () => {
  it('多代调整、保存、比较、导出和确认不改任务、资源或父快照', async () => {
    const s = await interferenceFixture();
    const bytes = s.storage.getItem(RESOURCE_STORAGE_KEY), parent = structuredClone(s.plan);
    const first = await adjust(s, parent);
    expect(first.workflow).toMatchObject({ input: parent.workflow!.input, resultPresetId: 'economical', parentPlanVersionId: parent.id });
    expect(first.coverage).not.toEqual(parent.coverage);
    expect(first.workflow!.configuration.routes.find(row => row.id === 'ROUTE-2')!.nodeIds).toEqual(['ND-0001', 'ND-0003', 'ND-0004']);
    expect(first.workflow!.configuration.devices.every(row => row.txPowerDbm === 40)).toBe(true);
    let workspace = (await s.planning.loadPlanningWorkspace()).workspace;
    expect(workspace.plans.find(row => row.id === parent.id)).toEqual(parent);
    expect(workspace.currentConfirmedByTask[parent.taskId]).toBe(parent.id);
    expect((await s.planning.comparePlanVersions([parent.id, first.id])).map(row => row.metrics.totalRadiatedPowerW)).toEqual([190, 60]);

    const json = await exportPlanFile(first, 'json');
    expect(JSON.parse(new TextDecoder().decode(json.bytes)).plan.workflow.adjustment).toEqual(first.workflow!.adjustment);
    const xlsx = await exportPlanFile(first, 'xlsx');
    const Excel = (await import('exceljs')).default, book = new Excel.Workbook();
    await book.xlsx.load(xlsx.bytes as never);
    const text = book.worksheets.flatMap(sheet => [sheet.name, JSON.stringify(sheet.getSheetValues())]).join('\n');
    expect(text).toContain(first.workflow!.adjustment!.sourceSnapshotId);
    expect(text).toContain('DV-0001'); expect(text).toContain('ND-0003');

    const confirmed = (await s.confirm(first.id)).plan;
    const second = await adjust(s, confirmed, 'balanced');
    expect(second.workflow!.input).toEqual(parent.workflow!.input);
    expect(second.workflow!.resultPresetId).toBe('balanced');
    expect(second.metrics).toEqual(parent.metrics);
    await s.confirm(second.id);
    workspace = (await s.planning.loadPlanningWorkspace()).workspace;
    expect(workspace.currentConfirmedByTask[parent.taskId]).toBe(second.id);
    expect(workspace.plans.find(row => row.id === parent.id)).toEqual(parent);
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bytes);
  });

  it('监控和诊断使用调整后的节能结果，旧诊断保留并可脱离规划记录恢复', async () => {
    const s = await interferenceFixture(), before = await diagnose(s, s.plan);
    const next = (await s.confirm((await adjust(s, s.plan)).id)).plan;
    const monitoring = createMonitoringMock(() => s.storage, s.resource.read);
    const context = await monitoring.loadMonitoringContext(next.taskId);
    expect(context).toMatchObject({ errorCode: null, source: { state: 'CURRENT' }, network: { planId: next.id, presetId: 'economical' } });
    const frame = await monitoring.getMonitoringFrame({ taskId: next.taskId, networkKey: context.network!.key, index: 0 });
    expect(frame.frame.devices).toEqual(monitoringPresets.find(row => row.id === 'economical')!.frames[0].devices);
    expect(networkDiagnosisPresets(next).every(row => row.networkPresetId === 'economical')).toBe(true);
    const after = await diagnose(s, next);
    expect(after.result.conclusions[0].confidence).toBe(diagnosisPresets.find(row => row.id === 'economical:hardware')!.result.conclusions[0].confidence);
    expect(after.network.workflow!.input.presetId).toBe('balanced');
    expect(after.network.workflow!.resultPresetId).toBe('economical');
    const old = await s.diagnosis.getDiagnosisReport(before.id);
    expect(old.result).toEqual(before.result); expect(old.network).toEqual(before.network);
    expect(old.source.state).toBe('HISTORICAL');

    await s.planning.resetPlanningWorkspace((await s.planning.loadPlanningWorkspace()).workspace.revision);
    const restored = await s.diagnosis.getDiagnosisReport(after.id);
    expect(restored.network).toEqual(after.network); expect(restored.result).toEqual(after.result);
    expect(restored.source.state).toBe('HISTORICAL');

    // 上游已重置时仍拒绝伪造的调整声明和串用的父覆盖图。
    const raw = s.storage.getItem(DIAGNOSIS_STORAGE_KEY)!;
    for (const change of [
      (plan: PlanVersion) => { plan.workflow!.adjustment!.manualOverrides[0].txPowerDbm = 99; },
      (plan: PlanVersion) => { plan.coverage = structuredClone(before.network.coverage); },
    ]) {
      const corrupt = JSON.parse(raw);
      for (const scene of corrupt.scenarios) for (const version of scene.versions)
        if (version.network.id === after.network.id) change(version.network);
      for (const run of corrupt.runs) if (run.scenario.network.id === after.network.id) change(run.scenario.network);
      s.storage.entries.set(DIAGNOSIS_STORAGE_KEY, JSON.stringify(corrupt));
      await expect(s.diagnosis.getDiagnosisReport(after.id)).rejects.toThrow();
    }
    s.storage.entries.set(DIAGNOSIS_STORAGE_KEY, raw);
  });

  it('调整后网络可分析、预览、采纳，再进入对应变体监控和诊断', async () => {
    const s = await interferenceFixture(), next = (await s.confirm((await adjust(s, s.plan)).id)).plan;
    const resourceBytes = s.storage.getItem(RESOURCE_STORAGE_KEY);
    const run = await s.service.submitInterferenceAnalysis({
      baseRevision: (await s.planning.loadPlanningWorkspace()).workspace.revision,
      baseResourceRevision: s.resource.read().meta.revision, requestId: crypto.randomUUID(),
      planId: next.id, scenarioId: 'single', interferenceIds: interferenceScenarios.find(row => row.id === 'single')!.sources.map(row => row.id),
    });
    s.advance();
    const viewed = await s.service.getInterferenceAnalysis(run.view.run.analysisId);
    const measure = viewed.result!.measures.find(row => row.id === 'FREQ_ADJUST')!;
    expect(measure.variantId).toBe('economical:FREQ_ADJUST');
    const preview = viewed.measurePreviews!.find(row => row.measureId === measure.id)!.result!;
    const adopted = (await s.adopt(run.view.run.analysisId, 'FREQ_ADJUST')).plan;
    expect(adopted.workflow!.input).toEqual(next.workflow!.input);
    expect(adopted.workflow!.resultPresetId).toBe('economical');
    expect(adopted.workflow).not.toHaveProperty('adjustment');
    expect(adopted.workflow!.configuration).toEqual(preview.configuration);
    expect(adopted.resultDetails).toEqual(preview.resultDetails);
    const confirmed = (await s.confirm(adopted.id)).plan;
    expect(monitoringPresetForPlan(confirmed).id).toBe(measure.variantId);
    expect(() => assertDiagnosisNetwork(confirmed)).not.toThrow();
    expect(networkDiagnosisPresets(confirmed).every(row => row.networkPresetId === 'interference:' + measure.variantId)).toBe(true);
    expect((await s.planning.loadPlanningWorkspace()).workspace.plans.find(row => row.id === next.id)).toEqual(next);
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(resourceBytes);

    // 采纳后的身份不能被替换成父任务档位，也不能伪造人工调整来源。
    const raw = s.storage.getItem(PLANNING_STORAGE_KEY)!;
    const corrupt = JSON.parse(raw), persisted = corrupt.plans.find((row: PlanVersion) => row.id === adopted.id);
    persisted.workflow.resultPresetId = 'balanced';
    s.storage.entries.set(PLANNING_STORAGE_KEY, JSON.stringify(corrupt));
    await expect(s.planning.loadPlanningWorkspace()).rejects.toThrow();
    s.storage.entries.set(PLANNING_STORAGE_KEY, raw);
    expect((await s.planning.loadPlanningWorkspace()).workspace.plans).toHaveLength(3);
  });

  it('下游完整匹配仍拒绝篡改频率、配置和错误结果身份', async () => {
    const s = await interferenceFixture(), next = (await s.confirm((await adjust(s, s.plan)).id)).plan;
    for (const change of [
      (plan: PlanVersion) => { plan.workflow!.input.frequencyId = 'hf-limited'; },
      (plan: PlanVersion) => { plan.workflow!.configuration.devices[0].txPowerDbm = 99; },
      (plan: PlanVersion) => { plan.workflow!.resultPresetId = 'balanced'; },
      (plan: PlanVersion) => { plan.workflow!.adjustment!.manualOverrides[0].deviceId = 'UNKNOWN'; },
      (plan: PlanVersion) => { plan.workflow!.adjustment!.manualOverrides[0].txPowerDbm = 99; },
      (plan: PlanVersion) => { plan.workflow!.adjustment!.manualPaths[0].demandId = 'UNKNOWN'; },
      (plan: PlanVersion) => { plan.workflow!.adjustment!.manualPaths[1].nodePath = ['ND-0001', 'ND-0004']; },
      (plan: PlanVersion) => { plan.coverage = structuredClone(s.plan.coverage); },
    ]) {
      const invalid = structuredClone(next); change(invalid);
      expect(() => assertDiagnosisNetwork(invalid)).toThrow();
      expect(() => assertBaseNetwork(invalid)).toThrow();
      expect(() => monitoringPresetForPlan(invalid)).toThrow();
    }
    const roundtrip = (await s.confirm((await adjust(s, next, 'balanced')).id)).plan;
    delete roundtrip.workflow!.resultPresetId;
    expect(() => assertDiagnosisNetwork(roundtrip)).toThrow();
    expect(() => assertBaseNetwork(roundtrip)).toThrow();
    expect(() => monitoringPresetForPlan(roundtrip)).toThrow();
  });
});
