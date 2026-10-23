import type { AuthenticatedRequest } from './auth-http';
import type { GisResourceEditContext, GisResourceServices } from '../types/gis-workspace';
import type { ResourceCommit, ResourceMaintenanceRequest } from '../types/resource-edit';
import { ApiError } from './types';
import { readWorkspaceContext, readWorkspaceMutation, workspaceCommitBody, workspaceKeys, workspaceRecord, workspaceRevision } from './resource-workspace-validation';

export async function resourceWorkspaceCall(request: AuthenticatedRequest, path: string, init?: RequestInit, responseType: 'json' | 'blob' = 'json'): Promise<unknown> {
  try { return await request<unknown>(path, init, responseType); }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'RESOURCE_NOT_FOUND', 1205: 'RESOURCE_VERSION_CHANGED', 1206: 'REQUEST_CONFLICT' };
    const code = typeof error.code === 'number' ? codes[error.code] : undefined;
    if (!code) throw error;
    const mapped = new ApiError(error.message, code, error.data, error.requestId, error.status);
    mapped.cause = error;
    throw mapped;
  }
}
function query(context: unknown, revision?: unknown): { context: 'ledger' | 'gis'; revision?: string } {
  try {
    if (context !== 'ledger' && context !== 'gis') throw new Error('context');
    return { context, ...(revision === undefined ? {} : { revision: workspaceRevision(revision) }) };
  } catch { throw new ApiError('资源编辑上下文参数无效', 'VALIDATION_ERROR'); }
}
export function createResourceWorkspaceHttp(request: AuthenticatedRequest) {
  async function loadWorkspace(context: 'ledger' | 'gis', revision?: string, signal?: AbortSignal) {
    const expected = query(context, revision);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ApiError('取消信号无效', 'VALIDATION_ERROR');
    if (signal?.aborted) throw new ApiError('读取已取消', 'REQUEST_ABORTED');
    const params = new URLSearchParams({ context: expected.context });
    if (expected.revision !== undefined) params.set('revision', expected.revision);
    const value = await resourceWorkspaceCall(request, '/resource/edit-context?' + params, signal ? { signal } : undefined);
    return readWorkspaceContext(value, expected.context, expected.revision);
  }
  async function commit(input: ResourceCommit) {
    const payload = workspaceCommitBody(input);
    const devices = [...payload.changes.devices, ...payload.changes.newDevices ?? []];
    const deviceOnly = devices.length === 1 && Object.entries(payload.changes).every(([key, rows]) => ['devices', 'newDevices'].includes(key) || !rows?.length);
    const objectId = deviceOnly ? devices[0].id : 'resource-workspace';
    const submittedIds = Object.values(payload.changes).flatMap(rows => rows?.map((row: { id: string }) => row.id) ?? []);
    const value = await resourceWorkspaceCall(request, '/resource/workspace/changes', { method: 'POST', body: JSON.stringify(payload) });
    return readWorkspaceMutation(value, payload.base_revision, objectId, submittedIds);
  }
  return {
    loadWorkspace,
    async loadResourceMaintenanceContext(input: ResourceMaintenanceRequest) {
      try {
        const v = workspaceRecord(input); workspaceKeys(v, ['context', 'revision'], ['deviceId', 'ids']);
        if (v.context !== 'ledger' || v.deviceId !== undefined || v.ids !== undefined) throw new Error('dispatch');
        workspaceRevision(v.revision);
      } catch { throw new ApiError('完整台账上下文不接受设备选择参数', 'VALIDATION_ERROR'); }
      return loadWorkspace('ledger', input.revision);
    },
    async loadGisResourceEditContext(input: Parameters<GisResourceServices['loadGisResourceEditContext']>[0]): Promise<GisResourceEditContext> {
      try {
        const v = workspaceRecord(input); workspaceKeys(v, ['context', 'revision'], ['signal']);
        if (v.context !== 'gis') throw new Error('context');
        workspaceRevision(v.revision);
      } catch { throw new ApiError('GIS 编辑上下文参数无效', 'VALIDATION_ERROR'); }
      const result = await loadWorkspace('gis', input.revision, input.signal);
      if (!result.resourceMeta || !result.situation || !result.validationSource) throw new ApiError('GIS 编辑上下文缺少完整基线', 'INVALID_RESOURCE_RESPONSE');
      return { revision: result.revision, baseRevision: result.baseRevision, resources: result.resources, resourceMeta: result.resourceMeta,
        situation: result.situation, validationSource: result.validationSource };
    },
    async saveResourceChanges(input: ResourceCommit) { return (await commit(input)).receipt; },
    async commitResources(input: ResourceCommit) { return (await commit(input)).result; },
  };
}
