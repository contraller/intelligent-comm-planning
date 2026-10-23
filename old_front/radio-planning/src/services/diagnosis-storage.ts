import { allDiagnosisPresets as diagnosisPresets } from './diagnosis-catalog';
import { DIAGNOSIS_PRESET_VERSION, DIAGNOSIS_SCHEMA_VERSION, DIAGNOSIS_STORAGE_KEY, DIAGNOSIS_PHASE_MS } from '../config/demo';
import type { DiagnosisWorkspace } from '../types/diagnosis';
import type { ResourceStorage } from '../types/resource-edit';
import { diagnosisDemoResult, diagnosisPhases } from '../mocks/diagnosis-presets';
import { assertDiagnosisNetwork, assertDiagnosisResult, bindDiagnosisResult, matchDiagnosisPreset, validateDiagnosisDraft } from './diagnosis-validation';
import { sameValue } from './planning-validation';
import { ApiError } from './types';

export function emptyDiagnosisWorkspace(): DiagnosisWorkspace {
  return { schemaVersion: DIAGNOSIS_SCHEMA_VERSION, presetVersion: DIAGNOSIS_PRESET_VERSION, revision: 'initial', scenarios: [], runs: [], receipts: [] };
}
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const unique = (ids: string[]) => ids.every(identifier) && new Set(ids).size === ids.length;
// 校验只依赖已冻结记录，不要求上游规划仍然存在。
export function validateDiagnosisWorkspace(w: DiagnosisWorkspace) {
  if (!w || w.schemaVersion !== DIAGNOSIS_SCHEMA_VERSION || w.presetVersion !== DIAGNOSIS_PRESET_VERSION)
    throw new ApiError('诊断存储版本不兼容；原记录已保留', 'DIAGNOSIS_INCOMPATIBLE');
  const fail = () => { throw new Error('诊断工作区结构或引用无效'); };
  if (!identifier(w.revision) || !Array.isArray(w.scenarios) || !Array.isArray(w.runs) || !Array.isArray(w.receipts)) fail();
  if (!unique(w.scenarios.map((s) => s.id)) || !unique(w.runs.map((r) => r.id)) || !unique(w.receipts.map((r) => r.requestId))) fail();
  const versions = w.scenarios.flatMap((s) => s.versions);
  if (!unique(versions.map((v) => v.id))) fail();
  for (const s of w.scenarios) {
    if (typeof s.archived !== 'boolean' || !Array.isArray(s.versions) || !s.versions.length) fail();
    s.versions.forEach((v,i) => {
      if (v.scenarioId !== s.id || v.version !== i + 1 || !Number.isFinite(Date.parse(v.savedAt)) || validateDiagnosisDraft(v, v.network).length) fail();
      assertDiagnosisNetwork(v.network);
    });
  }
  if (!unique(w.runs.flatMap((r) => [r.id, r.diagnoseTaskId, r.impactTaskId]))) fail();
  for (const r of w.runs) {
    if (r.presetVersion !== w.presetVersion || !['normal','low-confidence','diagnosis-failed','impact-failed'].includes(r.demo) ||
      !Number.isFinite(r.startedAt) || r.startedAt < 0 || !sameValue(r.scenario, versions.find((v) => v.id === r.scenario.id))) fail();
    const end = r.startedAt + DIAGNOSIS_PHASE_MS * (r.demo === 'diagnosis-failed' ? 3 : r.demo === 'impact-failed' ? 4 : diagnosisPhases.length);
    if (r.cancelledAt !== null && (!Number.isFinite(r.cancelledAt) || r.cancelledAt < r.startedAt || r.cancelledAt >= end)) fail();
    const preset = matchDiagnosisPreset(r.scenario, r.scenario.network, diagnosisPresets);
    const expected = bindDiagnosisResult(diagnosisDemoResult(preset.result, r.demo === 'low-confidence'), r.scenario, r.scenario.network);
    if (r.presetId !== preset.id || !sameValue(r.result, expected)) fail();
    assertDiagnosisResult(r.result, r.scenario.network, r.scenario.faults);
  }
  for (const receipt of w.receipts) if (!identifier(receipt.signature) || !Array.isArray(receipt.entityIds) || !receipt.entityIds.every(identifier)) fail();
  if (w.revision === 'initial' && (w.scenarios.length || w.runs.length || w.receipts.length)) fail();
}
export function readDiagnosis(storage: ResourceStorage): DiagnosisWorkspace {
  let raw: string | null;
  try { raw = storage.getItem(DIAGNOSIS_STORAGE_KEY); }
  catch { throw new ApiError('无法读取诊断存储；请检查访问权限', 'DIAGNOSIS_STORAGE_UNAVAILABLE'); }
  if (raw === null) return emptyDiagnosisWorkspace();
  try { const w = JSON.parse(raw) as DiagnosisWorkspace; validateDiagnosisWorkspace(w); return w; }
  catch (reason) {
    if (reason instanceof ApiError && reason.code === 'DIAGNOSIS_INCOMPATIBLE') throw reason;
    throw new ApiError('诊断记录损坏；原记录已保留，可显式重置', 'DIAGNOSIS_CORRUPT');
  }
}
export function checkDiagnosisRevision(expected: string, actual: string) {
  if (expected !== actual) throw new ApiError('诊断记录已变化，请重新加载后再操作', 'DIAGNOSIS_CONFLICT');
}
export function writeDiagnosis(storage: ResourceStorage, workspace: DiagnosisWorkspace) {
  validateDiagnosisWorkspace(workspace);
  try { storage.setItem(DIAGNOSIS_STORAGE_KEY, JSON.stringify(workspace)); }
  catch { throw new ApiError('诊断写入失败，可能已超配额；当前输入和原记录已保留', 'DIAGNOSIS_WRITE_FAILED'); }
}
