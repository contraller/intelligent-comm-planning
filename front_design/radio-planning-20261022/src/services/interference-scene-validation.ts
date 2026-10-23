import type {
  InterferenceSceneDetail, InterferenceSceneDetailQuery, InterferenceScenePage, InterferenceSceneReceipt,
  InterferenceSceneSave, InterferenceSceneSummary, InterferenceSceneVersion, SceneJsonObject,
} from '../types/interference-scene';
import { ApiError } from './types';

const invalid = (): never => { throw new ApiError('干扰场景响应不符合冻结版本契约', 'INVALID_RESPONSE'); };
function ensure(condition: unknown): asserts condition { if (!condition) invalid(); }
function record(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  ensure(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)));
}
function text(value: unknown, max = Number.MAX_SAFE_INTEGER): string {
  ensure(typeof value === 'string' && value.length <= max);
  return value;
}
function id(value: unknown, max = 120): string {
  const result = text(value, max);
  ensure(result.length > 0 && !/\s|[\u0000-\u001f\u007f]/u.test(result));
  return result;
}
function integer(value: unknown, min = 0): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min);
  return value;
}
function hash(value: unknown): string {
  const result = text(value);
  ensure(/^[0-9a-f]{64}$/.test(result));
  return result;
}
function planVersion(value: unknown): string {
  const result = text(value);
  ensure(/^V[1-9][0-9]*$/.test(result));
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value);
  ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result) && Number.isFinite(Date.parse(result)));
  return result;
}
function jsonObject(value: unknown): SceneJsonObject {
  record(value);
  function json(item: unknown): boolean {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(json);
    return !!item && typeof item === 'object' && Object.values(item).every(json);
  }
  ensure(json(value));
  return structuredClone(value) as SceneJsonObject;
}

const summaryKeys = ['scene_id', 'task_id', 'version_id', 'version_no', 'name', 'plan_id', 'plan_version',
  'resource_revision', 'source_count', 'snapshot_hash', 'data_origin', 'saved_at'];

function summary(value: Record<string, unknown>): InterferenceSceneSummary {
  const name = text(value.name, 60);
  ensure(name.length > 0 && name === name.trim());
  return {
    sceneId: id(value.scene_id), taskId: id(value.task_id), versionId: id(value.version_id, 40),
    versionNo: integer(value.version_no, 1), name, planId: id(value.plan_id), planVersion: planVersion(value.plan_version),
    resourceRevision: id(value.resource_revision), sourceCount: integer(value.source_count), snapshotHash: hash(value.snapshot_hash),
    dataOrigin: id(value.data_origin), savedAt: timestamp(value.saved_at),
  };
}

// 原始拓扑保留原字段；只校验身份和引用，不将未知状态、地形或物理参数补成默认值。
function topology(raw: SceneJsonObject, input: SceneJsonObject) {
  id(raw.solution_id);
  record(raw.summary);
  record(raw.detail);
  const detail = raw.detail;
  function objects(value: unknown): Record<string, unknown>[] {
    ensure(Array.isArray(value) && value.length > 0);
    value.forEach(record);
    return value as Record<string, unknown>[];
  }
  function indexed(rows: Record<string, unknown>[], field: string) {
    const result = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const key = id(row[field]);
      ensure(!result.has(key));
      result.set(key, row);
    }
    return result;
  }
  const nodes = indexed(objects(detail.nodes), 'node_id');
  const devices = indexed(objects(detail.devices), 'device_id');
  const links = indexed(objects(detail.links), 'link_id');
  const demands = indexed(objects(input.demands), 'id');
  for (const device of devices.values()) ensure(nodes.has(id(device.node_id)));
  for (const link of links.values()) {
    ensure(nodes.has(id(link.node_a_id)) && nodes.has(id(link.node_b_id)));
    if (String(link.is_available ?? 'true').toLowerCase() === 'false') continue;
    for (const side of ['a', 'b']) {
      const device = devices.get(id(link[`device_${side}_id`]));
      ensure(device && device.node_id === link[`node_${side}_id`]);
    }
  }
  record(detail.routes);
  for (const route of objects(detail.routes.routes)) {
    ensure(demands.has(id(route.demand_id)));
    for (const path of [route.primary, route.backup]) {
      if (path === null || path === undefined) continue;
      record(path);
      ensure(Array.isArray(path.node_path) && Array.isArray(path.link_path));
      ensure(path.node_path.length === path.link_path.length + 1 && path.node_path.length > 0);
      path.node_path.forEach(node => ensure(nodes.has(id(node))));
      path.link_path.forEach((linkId, index) => {
        const link = links.get(id(linkId));
        const nodePath = path.node_path as unknown[];
        ensure(link && ((link.node_a_id === nodePath[index] && link.node_b_id === nodePath[index + 1])
          || (link.node_b_id === nodePath[index] && link.node_a_id === nodePath[index + 1])));
      });
    }
  }
  if (Object.hasOwn(raw, 'terrain_fingerprint')) ensure(raw.terrain_fingerprint === null || typeof raw.terrain_fingerprint === 'string');
}

export function readSceneDetail(value: unknown, expected: InterferenceSceneDetailQuery): InterferenceSceneDetail {
  record(value); keys(value, ['version', 'source_state']);
  record(value.version);
  const row = value.version;
  keys(row, [...summaryKeys, 'schema_version', 'note', 'previous_version_id', 'saved_by', 'resource_content_hash',
    'source', 'interference_ids', 'interference_sources', 'plan_snapshot']);
  const base = summary(row);
  ensure(base.sceneId === expected.sceneId && base.taskId === expected.taskId
    && (expected.versionId === undefined || base.versionId === expected.versionId));
  ensure(row.schema_version === 1 && Array.isArray(row.interference_ids) && Array.isArray(row.interference_sources));
  const ids = row.interference_ids.map(v => id(v));
  ensure(new Set(ids).size === ids.length && ids.every((v, i) => v === [...ids].sort()[i]) && ids.length === base.sourceCount);
  const sources = row.interference_sources.map(source => {
    record(source); keys(source, ['interference_id', 'source_row']);
    record(source.source_row);
    ensure(Object.values(source.source_row).every(v => typeof v === 'string'));
    const interferenceId = id(source.interference_id);
    ensure(source.source_row.interference_id === interferenceId);
    return { interferenceId, sourceRow: { ...source.source_row } as Record<string, string> };
  });
  ensure(sources.length === ids.length && sources.every((v, i) => v.interferenceId === ids[i]));
  record(row.plan_snapshot);
  const plan = row.plan_snapshot;
  keys(plan, ['task_id', 'plan_id', 'plan_version', 'input_version', 'condition_version', 'resource_revision',
    'source', 'input_snapshot', 'raw_snapshot']);
  ensure(plan.task_id === base.taskId && plan.plan_id === base.planId && plan.plan_version === base.planVersion
    && plan.resource_revision === base.resourceRevision && plan.source === 'SR4');
  const inputSnapshot = jsonObject(plan.input_snapshot), rawSnapshot = jsonObject(plan.raw_snapshot);
  topology(rawSnapshot, inputSnapshot);
  const previous = row.previous_version_id === null ? null : id(row.previous_version_id, 40);
  ensure(base.versionNo === 1 ? previous === null : previous !== null && previous !== base.versionId);
  const version: InterferenceSceneVersion = {
    ...base, schemaVersion: 1, note: text(row.note, 500), previousVersionId: previous, savedBy: id(row.saved_by),
    resourceContentHash: hash(row.resource_content_hash), source: text(row.source), interferenceIds: ids,
    interferenceSources: sources, planSnapshot: {
      taskId: base.taskId, planId: base.planId, planVersion: base.planVersion, inputVersion: id(plan.input_version),
      conditionVersion: id(plan.condition_version), resourceRevision: base.resourceRevision, source: 'SR4', inputSnapshot, rawSnapshot,
    },
  };
  record(value.source_state); keys(value.source_state, ['state', 'reasons']);
  const state = value.source_state.state;
  ensure(state === 'CURRENT' || state === 'HISTORICAL' || state === 'UNKNOWN');
  ensure(Array.isArray(value.source_state.reasons));
  const reasons = value.source_state.reasons.map(v => { const reason = text(v); ensure(reason.trim().length > 0); return reason; });
  ensure(state === 'CURRENT' ? reasons.length === 0 : reasons.length > 0);
  return { version, sourceState: { state, reasons } };
}

export function readScenePage(value: unknown, expected: { taskId: string; page: number; pageSize: number; sceneId?: string }): InterferenceScenePage {
  record(value); keys(value, ['items', 'total', 'page', 'page_size']);
  ensure(Array.isArray(value.items));
  const page = integer(value.page, 1), pageSize = integer(value.page_size, 1), total = integer(value.total);
  ensure(page === expected.page && pageSize === expected.pageSize && pageSize <= 100);
  ensure(value.items.length === Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize)));
  const items = value.items.map(row => {
    record(row); keys(row, summaryKeys);
    const item = summary(row);
    ensure(item.taskId === expected.taskId && (expected.sceneId === undefined || item.sceneId === expected.sceneId));
    return item;
  });
  ensure(new Set(items.map(item => item.versionId)).size === items.length);
  if (expected.sceneId === undefined) ensure(new Set(items.map(item => item.sceneId)).size === items.length);
  else ensure(items.every((item, index) => index === 0 || item.versionNo < items[index - 1]!.versionNo));
  return { items, total, page, pageSize };
}

export function readSceneReceipt(value: unknown, expected: { requestId: string; taskId: string; sceneId: string }, save?: InterferenceSceneSave): InterferenceSceneReceipt {
  record(value);
  keys(value, ['request_id', 'operation', 'status', 'actor_id', 'task_id', 'scene_id', 'base_scene_version_id',
    'version_id', 'version_no', 'plan_id', 'plan_version', 'resource_revision', 'snapshot_hash', 'data_origin', 'changed', 'created_at']);
  ensure(value.request_id === expected.requestId && value.task_id === expected.taskId && value.scene_id === expected.sceneId
    && value.operation === 'SAVE_INTERFERENCE_SCENE' && value.status === 'SUCCEEDED' && typeof value.changed === 'boolean');
  const baseVersionId = value.base_scene_version_id === null ? null : id(value.base_scene_version_id, 40);
  const versionId = id(value.version_id, 40), versionNo = integer(value.version_no, 1);
  if (baseVersionId === null) ensure(value.changed === true && versionNo === 1);
  else ensure(value.changed ? versionId !== baseVersionId && versionNo >= 2 : versionId === baseVersionId);
  if (save) ensure(value.plan_id === save.planId && value.plan_version === save.planVersion
    && value.resource_revision === save.resourceRevision && baseVersionId === save.baseSceneVersionId);
  return {
    requestId: id(value.request_id), operation: 'SAVE_INTERFERENCE_SCENE', status: 'SUCCEEDED', actorId: id(value.actor_id),
    taskId: id(value.task_id), sceneId: id(value.scene_id), baseSceneVersionId: baseVersionId, versionId, versionNo,
    planId: id(value.plan_id), planVersion: planVersion(value.plan_version), resourceRevision: id(value.resource_revision),
    snapshotHash: hash(value.snapshot_hash), dataOrigin: id(value.data_origin), changed: value.changed, createdAt: timestamp(value.created_at),
  };
}
