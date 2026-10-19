import type { PlanVersion } from '../types/domain';
import type { PlanningJob, PlanningPreset, PlanningSolutionOrigin, PlanningSolutionSnapshot, PlanningSolutionView } from '../types/planning';
import { PLANNING_TTL_MS } from '../config/demo';
import { ApiError } from './types';
import { assertResult, getPresetCoverage, inputSignature, resultForJob, sameValue } from './planning-validation';
import { getPresetResultDetails } from './planning-result-details-mock';
import { normalizeResultInput } from './planning-result-identity';

export function solutionOrigin(value: PlanningSolutionSnapshot): PlanningSolutionOrigin {
  return { solutionId: value.solutionId, label: value.label, radioCount: value.radioCount, resultPresetId: value.resultPresetId };
}
// 校验/保存用的单份投影不回写原作业，不改变任何输入条件。
export function projectSolutionJob(job: PlanningJob, solutionId?: string): PlanningJob {
  if (job.solutions === undefined) {
    if (solutionId !== undefined) throw new ApiError('单结果作业没有此备选身份', 'INVALID_RESULT');
    return job;
  }
  const value = job.solutions.find(s => s.solutionId === solutionId);
  if (!value) throw new ApiError('请选择本作业的一份完整结果', 'INVALID_RESULT');
  const { solutions: _solutions, defaultSolutionId: _default, ...base } = job;
  return { ...base, snapshotId: value.result.snapshotId, resultPresetId: value.resultPresetId, solutionOrigin: solutionOrigin(value),
    coverage: structuredClone(value.result.coverage), resultDetails: structuredClone(value.result.resultDetails) };
}
export function createJobSolutions(job: PlanningJob, preset: PlanningPreset, presets: PlanningPreset[]): void {
  if (preset.solutionPresetIds === undefined || job.adjustment) return;
  job.solutions = preset.solutionPresetIds.map((id, index): PlanningSolutionSnapshot => {
    const target = presets.find(p => p.id === id);
    if (!target?.result) throw new ApiError('完整结果教学资产缺失', 'NO_PRESET');
    const projected = { ...job, snapshotId: index === 0 ? job.snapshotId : crypto.randomUUID(),
      coverage: getPresetCoverage(id), resultDetails: getPresetResultDetails(id, job.input) };
    const result = resultForJob(projected, target)!;
    return { solutionId: `${job.id}:solution:${index + 1}`, label: target.label, radioCount: target.radioCount ?? null,
      resultPresetId: id, outcome: structuredClone(target.outcome), result };
  });
  job.defaultSolutionId = job.solutions[0]?.solutionId ?? null;
}
export function assertJobSolutions(job: PlanningJob, preset: PlanningPreset, presets: PlanningPreset[]): void {
  const fail = (): never => { throw new ApiError('备选结果集合与冻结身份不一致', 'INVALID_RESULT'); };
  if (job.solutions === undefined) {
    if (job.defaultSolutionId !== undefined || preset.solutionPresetIds !== undefined && !job.adjustment) fail();
    return;
  }
  if (job.adjustment || !Array.isArray(job.solutions) || !preset.solutionPresetIds || job.solutions.length !== preset.solutionPresetIds.length
    || job.defaultSolutionId !== (job.solutions[0]?.solutionId ?? null)) fail();
  const snapshots = new Set<string>();
  job.solutions.forEach((s, i) => {
    if (!s || s.solutionId !== `${job.id}:solution:${i + 1}` || s.resultPresetId !== preset.solutionPresetIds![i]) fail();
    const target = presets.find(p => p.id === s.resultPresetId);
    if (!target?.result || !s.result || typeof s.result.snapshotId !== 'string' || !s.result.snapshotId.trim() || snapshots.has(s.result.snapshotId)
      || s.label !== target.label || s.radioCount !== (target.radioCount ?? null) || !sameValue(s.outcome, target.outcome)
      || !sameValue(inputSignature(normalizeResultInput(job.input, target.id)), inputSignature(target.input))) fail();
    snapshots.add(s.result.snapshotId);
    const projected = projectSolutionJob(job, s.solutionId);
    const expected = resultForJob(projected, target!);
    if (!sameValue(s.result, expected) || i === 0 && (s.result.snapshotId !== job.snapshotId
      || !sameValue(s.result.coverage, job.coverage) || !sameValue(s.result.resultDetails, job.resultDetails))) fail();
    assertResult(s.result, job.input, s.resultPresetId);
    // 明细必须与提交时声明的资产版本一致，不能只校验结构后接受修改值。
    if (s.result.resultDetails && !sameValue(s.result.resultDetails, getPresetResultDetails(s.resultPresetId, job.input, s.result.resultDetails.assetVersion))) fail();
  });
}
export function solutionViews(job: PlanningJob, plans: PlanVersion[], now: number): PlanningSolutionView[] {
  return (job.solutions ?? []).map(value => {
    const savedPlanId = plans.find(p => p.jobId === job.id && p.solutionId === value.solutionId)?.id ?? null;
    const expired = !savedPlanId && now - job.startedAt >= PLANNING_TTL_MS;
    return { solutionId: value.solutionId, label: value.label, radioCount: value.radioCount,
      outcome: structuredClone(value.outcome), result: expired ? null : structuredClone(value.result), savedPlanId, expired };
  });
}
