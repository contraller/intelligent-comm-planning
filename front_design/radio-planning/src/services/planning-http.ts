import type { AuthenticatedRequest } from './auth-http';
import type { PlanningApiServices } from '../types/planning-api';
import type { TaskApiOptions } from '../types/task-api';
import { apiId, apiList, assertApiPage, assertTaskOptions, invalidApi, readApiPage, uniqueIds } from './task-api-validation';
import { readApiPlan, readPlanningCatalog, readPlanningJob } from './planning-api-validation';
import { createCoverageHttp } from './coverage-http';
import { exportApiPlanFile } from './plan-export';
import { ApiError } from './types';
import { readPlanningAdjustment } from './planning-adjustment';
import type { PlanningAdjustment } from '../types/planning-adjustment';

function adjustmentDto(adjustment: PlanningAdjustment) {
  [adjustment.sourcePlanId, adjustment.sourceSnapshotId, ...adjustment.manualOverrides.map(d => d.deviceId), ...adjustment.manualPaths.flatMap(r => [r.demandId, ...r.nodePath])].forEach(id => apiId(id));
  return { schema_version: adjustment.schemaVersion, source_plan_id: adjustment.sourcePlanId, source_snapshot_id: adjustment.sourceSnapshotId,
    manual_override: adjustment.manualOverrides.map(d => ({ device_id: d.deviceId, ...(d.txPowerDbm === undefined ? {} : { tx_power_dbm: d.txPowerDbm }), ...(d.antennaHeightM === undefined ? {} : { antenna_height_m: d.antennaHeightM }) })),
    manual_paths: adjustment.manualPaths.map(r => ({ demand_id: r.demandId, node_path: [...r.nodePath] })),
  };
}

// 原路径与暂定补充字段集中在此；页面不拼 HTTP 请求，也不回退 Mock。
export function createPlanningHttp(request: AuthenticatedRequest, baseUrl: () => string): PlanningApiServices {
  const query = (input: TaskApiOptions, values: Record<string, string | number | undefined> = {}) => { assertTaskOptions(input); const q = new URLSearchParams({ context: input.context }); Object.entries(values).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); }); return q; };
  const mutation = (input: { requestId: string; taskId: string; revision: string } & TaskApiOptions) => { assertTaskOptions(input); [input.requestId, input.taskId, input.revision].forEach(x => apiId(x)); return { request_id: input.requestId, task_id: input.taskId, expected_revision: input.revision, context: input.context }; };
  async function jobRequest(action: () => Promise<unknown>, expected: {taskId: string; jobId?: string}) {
    try { return readPlanningJob(await action(), expected); }
    catch (error) {
      // 完整的未达标结果仍可作为参考保存，不能只因外层业务码丢弃有效结果。
      if (error instanceof ApiError && [2002,3001,3002].includes(Number(error.code))) {
        try {
          const value=readPlanningJob(error.data,expected);
          if (error.code===2002 && ['PENDING','RUNNING'].includes(value.state)) return value;
          if(value.state==='SUCCESS'&&(value.result||value.solutions?.some(s=>s.result))&&value.outcome?.code===error.code)return value;
        } catch { /* 无法校验的业务数据随原错误保留。 */ }
      }
      throw error;
    }
  }
  return {
    async loadPlanningCatalog(input) {
      const q = query(input); const [p, f] = await Promise.all([request('/resource/param-presets?' + q, { signal: input.signal }), request('/resource/frequency-pool?' + q, { signal: input.signal })]);
      return readPlanningCatalog(p, f);
    },
    async submitPlanningTask(input) {
      [input.inputVersion, input.conditionVersion, input.resourceRevision].forEach(x => apiId(x)); if (input.parentPlanId !== null) apiId(input.parentPlanId);
      const adjustment = input.adjustment === undefined ? undefined : readPlanningAdjustment(input.adjustment);
      if (adjustment && adjustment.sourcePlanId !== input.parentPlanId) invalidApi('adjustment source plan');
      const job = await jobRequest(() => request('/plan/sr4-flow', { method: 'POST', body: JSON.stringify({ ...mutation(input), input_version: input.inputVersion, condition_version: input.conditionVersion, resource_revision: input.resourceRevision, parent_plan_id: input.parentPlanId, ...(adjustment === undefined ? {} : { adjustment: adjustmentDto(adjustment) }) }), signal: input.signal }), input);
      if (job.inputVersion !== input.inputVersion || job.conditionVersion !== input.conditionVersion || job.resourceRevision !== input.resourceRevision || job.parentPlanId !== input.parentPlanId) invalidApi('submitted input version');
      // 比较规范化后的完整回显，不能将漏回调整或返回另一份快照视为提交成功。
      if (JSON.stringify(job.adjustment && adjustmentDto(job.adjustment)) !== JSON.stringify(adjustment && adjustmentDto(adjustment))) invalidApi('submitted adjustment echo');
      return job;
    },
    async getPlanningTask(input) { apiId(input.jobId); apiId(input.taskId); return jobRequest(() => request(`/plan/tasks/${encodeURIComponent(input.jobId)}?${query(input, { task_id: input.taskId })}`, { signal: input.signal }), input); },
    async cancelPlanningTask(input) { apiId(input.jobId); return readPlanningJob(await request(`/tasks/${encodeURIComponent(input.jobId)}`, { method: 'DELETE', body: JSON.stringify(mutation(input)), signal: input.signal }), input); },
    async queryPlanningPlans(input) {
      assertApiPage(input); apiId(input.taskId);
      const page = readApiPage(await request(`/plans?${query(input, { task_id: input.taskId, page: input.page, page_size: input.pageSize, search: input.search })}`, { signal: input.signal }), input, v => readApiPlan(v, input));
      uniqueIds(page.items, p => p.id, 'plan ids'); return page;
    },
    async getPlanningPlan(input) { apiId(input.planId); apiId(input.taskId); return readApiPlan(await request(`/plans/${encodeURIComponent(input.planId)}?${query(input, { task_id: input.taskId })}`, { signal: input.signal }), input); },
    async savePlanningPlan(input) {
      apiId(input.jobId); if (!input.name.trim() || input.name.length > 60 || input.note.length > 500) throw new ApiError('方案名称为 1–60 字，说明不超过 500 字', 'VALIDATION_ERROR');
      if (input.solutionId !== undefined) { apiId(input.solutionId); apiId(input.snapshotId, 'snapshotId'); }
      // 明确绑定所选结果；响应不可用默认项冒充保存目标。
      const plan = readApiPlan(await request('/plans', { method: 'POST', body: JSON.stringify({ ...mutation(input), job_id: input.jobId, name: input.name.trim(), note: input.note,
        ...(input.solutionId === undefined ? {} : { solution_id: input.solutionId, snapshot_id: input.snapshotId }) }), signal: input.signal }), input);
      if (plan.jobId !== input.jobId || plan.name !== input.name.trim() || plan.note !== input.note || plan.solutionId !== input.solutionId
        || input.solutionId !== undefined && plan.result.snapshotId !== input.snapshotId) invalidApi('saved plan association');
      return plan;
    },
    async confirmPlanningPlan(input) { apiId(input.planId); const plan = readApiPlan(await request(`/plans/${encodeURIComponent(input.planId)}/confirm`, { method: 'POST', body: JSON.stringify(mutation(input)), signal: input.signal }), input); if(plan.state!=='CONFIRMED')invalidApi('confirmation state');return plan; },
    async comparePlanningPlans(input) {
      assertTaskOptions(input); apiId(input.taskId);
      if (!Array.isArray(input.planIds) || input.planIds.length < 2 || input.planIds.length > 4 || new Set(input.planIds).size !== input.planIds.length) throw new ApiError('请选择同任务的 2–4 个不同版本', 'INVALID_COMPARISON'); input.planIds.forEach(x => apiId(x));
      const values = apiList(await request('/plans/compare', { method: 'POST', body: JSON.stringify({ context: input.context, task_id: input.taskId, solution_ids: input.planIds }), signal: input.signal }), 'comparison', x => readApiPlan(x, input));
      if (values.length !== input.planIds.length || new Set(values.map(p => p.id)).size !== values.length || input.planIds.some(id => !values.some(p => p.id === id))) throw new ApiError('对比结果与所选版本不一致', 'INVALID_PLANNING_RESPONSE');
      return input.planIds.map(id => values.find(p => p.id === id)!);
    },
    async exportPlanningPlan(input) {
      apiId(input.planId); apiId(input.taskId);
      const plan = readApiPlan(await request(`/plans/${encodeURIComponent(input.planId)}/export?${query(input, { format: 'json', task_id: input.taskId })}`, { signal: input.signal }), input);
      return exportApiPlanFile(plan, input.format);
    },
    getPlanningCoverageImage: createCoverageHttp(request, baseUrl),
  };
}
