import type { AuthenticatedRequest } from './auth-http';
import type { GisTaskHttp, GisTaskSnapshot, GisTaskSnapshotQuery } from '../types/gis-task';
import { apiBool, apiId, apiList, apiRecord, apiText, readApiTask, uniqueIds } from './task-api-validation';
import { decodeObject } from './resource-read-validation';
import { ApiError } from './types';

const invalid = (field: string): never => {
  throw new ApiError(`任务态势响应的身份、版本或数据无效：${field}`, 'INVALID_GIS_TASK_RESPONSE');
};

export function readGisTaskSnapshot(value: unknown, expected: GisTaskSnapshotQuery): GisTaskSnapshot {
  const row = apiRecord(value), task = readApiTask(row.task, expected.taskId);
  const taskRevision = apiId(row.task_revision, 'task_revision');
  const resourceRevision = apiId(row.resource_revision, 'resource_revision');
  if (taskRevision !== expected.revision || task.revision !== taskRevision) invalid('task_revision');
  if (task.resourceRevision !== resourceRevision) invalid('resource_revision');
  if (row.snapshot_id !== `GIS-TASK-${expected.revision}`) invalid('snapshot_id');
  const nodes = apiList(row.nodes, 'nodes', raw => {
    const node = decodeObject('node', raw);
    if (node.kind !== 'node') return invalid('node kind');
    apiId(node.id, 'node_id');
    return node;
  });
  const missingNodeIds = apiList(row.missing_node_ids, 'missing_node_ids', id => apiId(id, 'missing_node_id'));
  uniqueIds(nodes, node => node.id, 'duplicate nodes');
  uniqueIds(missingNodeIds, id => id, 'duplicate missing nodes');
  const found = new Set(nodes.map(node => node.id)), missing = new Set(missingNodeIds);
  // 冻结节点与缺失清单必须恰好覆盖任务参与集合，且保持任务原始顺序。
  const orderedNodes = task.input.stationIds.filter(id => found.has(id));
  const orderedMissing = task.input.stationIds.filter(id => missing.has(id));
  if (orderedNodes.length !== nodes.length || orderedNodes.some((id, index) => nodes[index]!.id !== id)
    || orderedMissing.length !== missingNodeIds.length || orderedMissing.some((id, index) => missingNodeIds[index] !== id)
    || task.input.stationIds.some(id => found.has(id) === missing.has(id))) invalid('node references/order');
  return {
    task, resourceRevision, taskRevision, snapshotId: row.snapshot_id as string,
    sourceChanged: apiBool(row.source_changed, 'source_changed'), nodes, missingNodeIds,
    message: apiText(row.message, 'message', true),
  };
}

// 共享认证请求仅执行 GET；历史资源缺失时保留错误，不拼接当前资源坐标。
export function createGisTaskHttp(request: AuthenticatedRequest): GisTaskHttp {
  return {
    async getSnapshot(query, signal) {
      const expected = { ...query };
      if (expected.context !== 'planning') throw new ApiError('任务态势上下文无效', 'INVALID_GIS_TASK_QUERY');
      apiId(expected.taskId, 'taskId'); apiId(expected.revision, 'revision');
      if (signal?.aborted) throw new ApiError('任务态势读取已取消', 'REQUEST_ABORTED');
      const params = new URLSearchParams({ context: 'planning', revision: expected.revision });
      const value = await request<unknown>(`/task-inputs/${encodeURIComponent(expected.taskId)}/gis-snapshot?${params}`, { method: 'GET', signal });
      if (signal?.aborted) throw new ApiError('任务态势读取已取消', 'REQUEST_ABORTED');
      return readGisTaskSnapshot(value, expected);
    },
  };
}
