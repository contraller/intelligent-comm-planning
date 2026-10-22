import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import type { FaultAnalysis, FaultScenario, FaultScenarioInput, FaultSource, FaultTaskReceipt } from '../types/fault-api';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function invalid(name: string): never { throw new ApiError(`${name} 返回字段不符合 SR5 契约`, 'INVALID_FAULT_RESPONSE'); }
const id = (value: string) => {
  if (!string(value) || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('任务或方案编号无效', 'INVALID_FAULT_ID');
  return encodeURIComponent(value);
};

function source(value: unknown): FaultSource {
  if (!object(value) || !['task_id', 'plan_id', 'revision', 'resource_revision', 'name', 'version'].every(key => string(value[key])) || value.state !== 'CONFIRMED') invalid('方案来源');
  return { taskId: value.task_id as string, planId: value.plan_id as string, revision: value.revision as string,
    resourceRevision: value.resource_revision as string, name: value.name as string, version: value.version as string, state: 'CONFIRMED' };
}

function scenario(value: unknown): FaultScenario {
  if (!object(value) || !['scenario_id', 'task_id', 'plan_id', 'plan_revision', 'resource_revision', 'version_id', 'saved_at', 'scenario_name'].every(key => string(value[key]))
    || typeof value.version_no !== 'number' || !Number.isInteger(value.version_no) || value.version_no < 1
    || typeof value.archived !== 'boolean' || !Array.isArray(value.faults)
    || value.description !== undefined && typeof value.description !== 'string') invalid('故障场景');
  return { scenarioId: value.scenario_id as string, taskId: value.task_id as string, planId: value.plan_id as string,
    planRevision: value.plan_revision as string, resourceRevision: value.resource_revision as string,
    versionId: value.version_id as string, versionNo: value.version_no as number, archived: value.archived as boolean,
    savedAt: value.saved_at as string, scenario_name: value.scenario_name as string,
    description: (value.description as string | undefined) ?? '', faults: value.faults as FaultScenario['faults'] };
}

function receipt(value: unknown): FaultTaskReceipt {
  if (!object(value) || !string(value.task_id) || !string(value.request_id) || typeof value.replayed !== 'boolean') invalid('故障任务回执');
  return { taskId: value.task_id, requestId: value.request_id, replayed: value.replayed };
}

function analysis(value: unknown): FaultAnalysis {
  if (!object(value) || !string(value.task_id) || !string(value.plan_id) || !string(value.diagnose_task_id)
    || value.impact_task_id !== null && !string(value.impact_task_id)
    || !['PENDING', 'RUNNING', 'DIAGNOSIS_READY', 'SUCCESS', 'FAILED', 'CANCELLED'].includes(String(value.state))
    || typeof value.progress !== 'number' || value.progress < 0 || value.progress > 1
    || !Array.isArray(value.phases) || !object(value.scenario) || !object(value.source)
    || typeof value.diagnosis_ready !== 'boolean' || typeof value.impact_ready !== 'boolean' || typeof value.report_ready !== 'boolean'
    || value.diagnosis_ready && !object(value.diagnosis) || value.impact_ready && !object(value.impact)
    || value.report_ready && !object(value.report)) invalid('统一分析结果');
  if (value.diagnosis_ready && (!Array.isArray((value.diagnosis as Record<string, unknown>).results)
    || typeof (value.diagnosis as Record<string, unknown>).data_source !== 'string')) invalid('诊断结果');
  if (value.impact_ready && (!Array.isArray((value.impact as Record<string, unknown>).affected_nodes)
    || !Array.isArray((value.impact as Record<string, unknown>).affected_links)
    || !object((value.impact as Record<string, unknown>).summary))) invalid('影响结果');
  return { taskId: value.task_id, planId: value.plan_id, diagnoseTaskId: value.diagnose_task_id,
    impactTaskId: value.impact_task_id as string | null, state: value.state as FaultAnalysis['state'], progress: value.progress,
    phases: value.phases as FaultAnalysis['phases'], diagnosisReady: value.diagnosis_ready,
    impactReady: value.impact_ready, reportReady: value.report_ready, error: value.error as string | null,
    source: value.source as FaultAnalysis['source'], scenario: value.scenario as FaultAnalysis['scenario'],
    diagnosis: value.diagnosis as FaultAnalysis['diagnosis'], impact: value.impact as FaultAnalysis['impact'],
    suggestions: value.suggestions as FaultAnalysis['suggestions'], report: value.report as FaultAnalysis['report'] };
}

export function createFaultHttp(request: AuthenticatedRequest) {
  const body = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const context = (taskId: string) => new URLSearchParams({ context: 'planning', task_id: taskId }).toString();
  return {
    async sources(taskId: string) {
      const value = await request<unknown>(`/fault/plan-sources?task_id=${id(taskId)}`);
      if (!object(value) || !Array.isArray(value.items) || value.items.length > 1 || typeof value.total !== 'number'
        || value.reason !== null && typeof value.reason !== 'string') invalid('方案来源');
      const items = value.items.map(source);
      if (value.total !== items.length || items.some(item => item.taskId !== taskId)) invalid('方案来源');
      return { items, reason: value.reason as string | null };
    },
    async scenarios(taskId: string) {
      id(taskId);
      const value = await request<unknown>(`/fault/scenarios?${context(taskId)}&include_archived=true`);
      if (!object(value) || !Array.isArray(value.items) || value.total !== value.items.length) invalid('故障场景列表');
      const items = value.items.map(scenario);
      if (items.some(item => item.taskId !== taskId)) invalid('故障场景列表');
      return items;
    },
    async validate(taskId: string, planId: string, input: FaultScenarioInput) {
      const value = await request<unknown>('/fault/scenarios/validate', body({ context: 'planning', task_id: taskId, plan_id: planId, ...input }));
      if (!object(value) || value.valid !== true || value.plan_id !== planId || value.fault_count !== input.faults.length) invalid('场景校验');
    },
    async save(taskId: string, planId: string, input: FaultScenarioInput, scenarioId?: string) {
      const path = scenarioId ? `/fault/scenarios/${id(scenarioId)}` : '/fault/scenarios';
      const value = await request<unknown>(path, { ...body({ context: 'planning', task_id: taskId, plan_id: planId, ...input }), method: scenarioId ? 'PUT' : 'POST' });
      const saved = scenario(value);
      if (saved.taskId !== taskId || saved.planId !== planId || scenarioId && saved.scenarioId !== scenarioId) invalid('场景保存');
      return saved;
    },
    async archive(taskId: string, scenarioId: string, archived: boolean) {
      const value = await request<unknown>(`/fault/scenarios/${id(scenarioId)}/archive`, body({ task_id: taskId, archived }));
      const saved = scenario(value);
      if (saved.taskId !== taskId || saved.scenarioId !== scenarioId || saved.archived !== archived) invalid('场景归档');
      return saved;
    },
    async diagnose(taskId: string, planId: string, scenarioId: string, versionId: string, requestId: string) {
      const value = await request<unknown>('/fault/diagnose', body({ context: 'planning', request_id: requestId, task_id: taskId,
        plan_id: planId, scenario_id: scenarioId, scenario_version_id: versionId }));
      const saved = receipt(value);
      if (saved.requestId !== requestId) invalid('诊断任务回执');
      return saved;
    },
    async impact(taskId: string, planId: string, diagnoseTaskId: string, requestId: string) {
      const value = await request<unknown>('/fault/impact', body({ context: 'planning', request_id: requestId, task_id: taskId,
        plan_id: planId, diagnose_task_id: diagnoseTaskId, consider_backup_route: true }));
      const saved = receipt(value);
      if (saved.requestId !== requestId) invalid('影响任务回执');
      return saved;
    },
    async analysis(taskId: string, diagnoseTaskId: string, impactTaskId?: string) {
      const params = new URLSearchParams({ task_id: taskId });
      if (impactTaskId) params.set('impact_task_id', impactTaskId);
      const value = await request<unknown>(`/fault/analyses/${id(diagnoseTaskId)}?${params}`);
      const read = analysis(value);
      if (read.taskId !== taskId || read.diagnoseTaskId !== diagnoseTaskId || read.impactTaskId !== (impactTaskId ?? null)) invalid('统一分析结果');
      return read;
    },
  };
}
