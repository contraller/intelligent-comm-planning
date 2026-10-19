import type { PlanningDemand, PlanningInput, PlanningIssue } from '../types/planning';
import type { ApiPage, ApiPageQuery, ApiReceipt, ApiTask, TaskApiOptions, TaskValidationResult } from '../types/task-api';
import { ApiError } from './types';
import { TASK_MAX_DEMANDS } from '../config/demo';
import { deploymentConstraintIssues, readDeploymentConstraints } from './deployment-constraints';
import { planningOptionIssues, planningOptionKeys, readPlanningOption } from './planning-options';
import { readRouting, routingIssues } from './planning-routing';

// 传输结构校验与业务可行性分开；未知响应不能进入可写状态。
export const invalidApi = (field: string): never => { throw new ApiError('规划接口数据不完整或无效：' + field, 'INVALID_PLANNING_RESPONSE'); };
export const apiRecord = (v: unknown, field = 'data'): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalidApi(field);
export const apiText = (v: unknown, field: string, empty = false): string => typeof v === 'string' && (empty || !!v.trim()) && v.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) ? v : invalidApi(field);
export const apiId = (v: unknown, field = 'id'): string => typeof v === 'string' && v.length <= 120 && !!v.trim() && !/[\u0000-\u0020\u007f]/.test(v) ? v : invalidApi(field);
export const apiNumber = (v: unknown, field: string, min = -Infinity, max = Infinity): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : invalidApi(field);
export const apiBool = (v: unknown, field: string): boolean => typeof v === 'boolean' ? v : invalidApi(field);
export const apiNullableNumber = (v: unknown, field: string, min = -Infinity, max = Infinity): number | null => v === null ? null : apiNumber(v, field, min, max);
export const apiList = <T>(v: unknown, field: string, read: (x: unknown) => T): T[] => Array.isArray(v) && v.length <= 20000 ? v.map(read) : invalidApi(field);
export function apiChoice<const T extends string>(v: unknown, choices: readonly T[], field: string): T { return choices.includes(v as T) ? v as T : invalidApi(field); }
export function uniqueIds<T>(rows: T[], id: (row: T) => string, field: string): T[] { if (new Set(rows.map(id)).size !== rows.length) invalidApi(field); return rows; }
// 先核对项目 ISO 格式和真实日历，避免 Date.parse 把越界日期归一化。
function validApiDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}
export function apiDate(v: unknown, field: string): string { const s = apiText(v, field); if (!validApiDate(s)) invalidApi(field); return s; }
export function assertTaskOptions(input: TaskApiOptions) {
  if (!input || !['gis', 'planning'].includes(input.context)) throw new ApiError('任务页面上下文无效', 'INVALID_TASK_QUERY');
  if (input.signal?.aborted) throw new ApiError('读取已取消', 'REQUEST_ABORTED');
}
export function assertApiPage(input: ApiPageQuery) {
  assertTaskOptions(input);
  if (!Number.isSafeInteger(input.page) || input.page < 1 || ![5, 10, 20, 50].includes(input.pageSize)) throw new ApiError('分页参数无效', 'INVALID_TASK_QUERY');
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 120)) throw new ApiError('查询条件过长', 'INVALID_TASK_QUERY');
}
export function readIssue(value: unknown): PlanningIssue {
  const v = apiRecord(value); return { objectId: apiText(v.objectId, 'objectId', true), field: apiText(v.field, 'field'), message: apiText(v.message, 'message') };
}
export function taskInputIssues(input: PlanningInput): PlanningIssue[] {
  const issues: PlanningIssue[] = [], add = (field: string, message: string, objectId = '') => issues.push({ field, message, objectId });
  // 本地只检查输入结构，通视节点存在性及可行性由保存服务核验。
  issues.push(...deploymentConstraintIssues(input.deploymentConstraints));
  issues.push(...planningOptionIssues(input));
  if (!input.name.trim() || input.name.length > 60) add('name', '任务名称为 1–60 字');
  if (input.description.length > 500) add('description', '任务说明不超过 500 字');
  if (input.stationIds.length < 2 || new Set(input.stationIds).size !== input.stationIds.length) add('stationIds', '至少选择两个不同节点');
  if (input.bbox.length !== 4 || input.bbox.some(x => !Number.isFinite(x)) || input.bbox[0] >= input.bbox[2] || input.bbox[1] >= input.bbox[3] || Math.abs(input.bbox[0]) > 180 || Math.abs(input.bbox[2]) > 180 || Math.abs(input.bbox[1]) > 90 || Math.abs(input.bbox[3]) > 90) add('bbox', '请输入有效 WGS84 范围');
  if (!input.presetId || !input.frequencyId) add('presetId', '请选择参数预设及频率资源');
  if (input.constraints.connectivityPercent !== 100 || input.constraints.maxRelayHops !== 2 || input.constraints.survivabilityPercent !== 90) add('constraints', '目标固定为连通率 100%、中继最多 2 跳、抗毁性至少 90%');
  if (input.startTime && !validApiDate(input.startTime)) add('startTime', '时间须为带时区的有效 ISO 8601 文本');
  if (input.durationH != null && (!Number.isFinite(input.durationH) || input.durationH <= 0)) add('durationH', '持续时长必须大于零');
  if (!input.demands.length || input.demands.length > TASK_MAX_DEMANDS) add('demands', `通联需求需为 1–${TASK_MAX_DEMANDS} 条`);
  const seen = new Set<string>(), ids = new Set<string>();
  for (const d of input.demands) {
    issues.push(...routingIssues(d));
    const key = [d.endpointMode ?? 'station', d.sourceDeviceId ?? d.sourceId, d.targetDeviceId ?? d.targetId, d.service].join('|');
    if (!d.id || ids.has(d.id)) add('id', '需求编号不能为空或重复', d.id); ids.add(d.id);
    if (seen.has(key)) add('demands', '同方向同业务的通联需求重复', d.id); seen.add(key);
    if (!input.stationIds.includes(d.sourceId) || !input.stationIds.includes(d.targetId) || d.sourceId === d.targetId) add('sourceId', '两端必须是参与集合中的不同节点', d.id);
    if (d.endpointMode === 'device' && (!d.sourceDeviceId || !d.targetDeviceId || d.sourceDeviceId === d.targetDeviceId)) add('sourceDeviceId', '请选择两个不同设备', d.id);
    if (!['P1', 'P2', 'P3'].includes(d.priority) || typeof d.mandatory !== 'boolean' || !['', '话音', '数据', '短消息'].includes(d.service)) add('service', '业务、优先级或必要通联标志无效', d.id);
    if (d.preferredClass != null && !['HF', 'VUHF'].includes(d.preferredClass)) add('preferredClass', '设备类别无效', d.id);
    for (const field of ['requiredRateKbps', 'maxDelayMs'] as const) if (d[field] == null || !Number.isFinite(d[field]) || d[field]! <= 0) add(field, '请输入有效正数', d.id);
    // 可靠性 0 是合法原值，不作为空值，也不由前端解释其业务可行性。
    if (d.minReliability == null || !Number.isFinite(d.minReliability) || d.minReliability < 0 || d.minReliability > 1) add('minReliability', '可靠性必填，范围为 0–1', d.id);
    if (d.dataVolumeMb != null && (!Number.isFinite(d.dataVolumeMb) || d.dataVolumeMb < 0)) add('dataVolumeMb', '数据量不可为负数', d.id);
  }
  return issues;
}
export function readTaskInput(value: unknown): PlanningInput {
  const v = apiRecord(value), constraints = apiRecord(v.constraints);
  const input: PlanningInput = {
    name: apiText(v.name, 'name'), description: apiText(v.description, 'description', true),
    bbox: apiList(v.bbox, 'bbox', x => apiNumber(x, 'bbox')), stationIds: apiList(v.stationIds, 'stationIds', x => apiId(x)),
    presetId: apiId(v.presetId), frequencyId: apiId(v.frequencyId), startTime: v.startTime == null ? null : apiDate(v.startTime, 'startTime'), durationH: v.durationH == null ? null : apiNumber(v.durationH, 'durationH', 0),
    constraints: { connectivityPercent: apiNumber(constraints.connectivityPercent, 'connectivityPercent'), maxRelayHops: apiNumber(constraints.maxRelayHops, 'maxRelayHops'), survivabilityPercent: apiNumber(constraints.survivabilityPercent, 'survivabilityPercent') },
    demands: apiList(v.demands, 'demands', (raw): PlanningDemand => { const d = apiRecord(raw);
      // 非法响应沿原契约错误分支处理，不能丢弃显式路由要求后继续保存。
      let routing; try { routing = readRouting(d); } catch { invalidApi('demand routing'); }
      return { ...routing,
      id: apiId(d.id), sourceId: apiId(d.sourceId), targetId: apiId(d.targetId), endpointMode: d.endpointMode === undefined ? 'station' : apiChoice(d.endpointMode, ['station', 'device'], 'endpointMode'),
      sourceDeviceId: d.sourceDeviceId == null ? null : apiId(d.sourceDeviceId), targetDeviceId: d.targetDeviceId == null ? null : apiId(d.targetDeviceId), preferredClass: d.preferredClass == null ? null : apiChoice(d.preferredClass, ['HF', 'VUHF'], 'preferredClass'),
      service: apiChoice(d.service, ['', '话音', '数据', '短消息'], 'service'), priority: apiChoice(d.priority, ['P1', 'P2', 'P3'], 'priority'), mandatory: apiBool(d.mandatory, 'mandatory'),
      dataVolumeMb: apiNullableNumber(d.dataVolumeMb, 'dataVolumeMb', 0), requiredRateKbps: apiNullableNumber(d.requiredRateKbps, 'requiredRateKbps', 0), maxDelayMs: apiNullableNumber(d.maxDelayMs, 'maxDelayMs', 0), minReliability: apiNullableNumber(d.minReliability, 'minReliability', 0, 1),
    }; }),
  };
  // 显式保留可选字段；缺省不补值，防止保存及历史回读时丢掉约束。
  for (const key of planningOptionKeys) if (Object.hasOwn(v, key)) {
    try { Object.assign(input, { [key]: readPlanningOption(key, v[key]) }); }
    catch { invalidApi(key); }
  }
  if (Object.hasOwn(v, 'deploymentConstraints')) {
    try { input.deploymentConstraints = readDeploymentConstraints(v.deploymentConstraints); }
    catch { invalidApi('deploymentConstraints'); }
  }
  const issues = taskInputIssues(input); if (issues.length) throw new ApiError('任务输入校验失败', 'VALIDATION_ERROR', issues);
  return input;
}
// 服务器返回的坏输入属于响应不确定，不能误判为写入前本地校验失败。
export function readResponseTaskInput(value: unknown): PlanningInput {
  try { return readTaskInput(value); }
  catch (error) { if (error instanceof ApiError && error.code === 'VALIDATION_ERROR') invalidApi('response input'); throw error; }
}
export function readApiTask(value: unknown, expectedId?: string): ApiTask {
  const v = apiRecord(value), taskId = apiId(v.task_id, 'task_id'); if (expectedId && taskId !== expectedId) invalidApi('task_id');
  return { taskId, revision: apiId(v.revision, 'revision'), inputVersion: apiId(v.input_version), conditionVersion: apiId(v.condition_version), resourceRevision: apiId(v.resource_revision), input: readResponseTaskInput(v.input), updatedAt: apiDate(v.updated_at, 'updated_at'), activeJobId: v.active_job_id === null ? null : apiId(v.active_job_id) };
}
export function readApiPage<T>(value: unknown, query: ApiPageQuery, read: (x: unknown) => T): ApiPage<T> {
  const v = apiRecord(value), items = apiList(v.items, 'items', read), total = apiNumber(v.total, 'total', 0), page = apiNumber(v.page, 'page', 1), pageSize = apiNumber(v.page_size, 'page_size', 1);
  if (![total, page, pageSize].every(Number.isSafeInteger) || page !== query.page || pageSize !== query.pageSize || items.length > pageSize || items.length > total || (page - 1) * pageSize + items.length > total && items.length > 0) invalidApi('pagination');
  return { items, total, page, pageSize };
}
export function readTaskValidation(value: unknown, taskId: string): TaskValidationResult {
  const v = apiRecord(value), valid = apiBool(v.valid, 'valid'), issues = apiList(v.issues, 'issues', readIssue);
  if (valid === !!issues.length) invalidApi('valid/issues');
  return { valid, issues, task: v.task === null ? null : readApiTask(v.task, taskId) };
}
export function readReceipt(value: unknown, request: { requestId: string; taskId: string; kind: string }): ApiReceipt {
  const v = apiRecord(value);
  if (v.request_id !== request.requestId || v.task_id !== request.taskId || v.kind !== request.kind) invalidApi('receipt owner');
  const state = apiChoice(v.state, ['PENDING', 'SUCCEEDED', 'FAILED', 'NOT_FOUND'], 'state'), entityId = v.entity_id === null ? null : apiId(v.entity_id);
  if (state === 'SUCCEEDED' && !entityId) invalidApi('receipt entity');
  return { requestId: request.requestId, taskId: request.taskId, kind: apiChoice(v.kind, ['saveTask', 'submit', 'cancel', 'savePlan', 'confirm'], 'kind'), state, entityId, message: apiText(v.message, 'message', true) };
}
