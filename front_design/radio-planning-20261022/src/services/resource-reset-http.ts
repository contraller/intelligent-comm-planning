import type { AuthenticatedRequest } from './auth-http';
import type { ResourceServices } from '../types/resource-edit';
import { resourceWorkspaceCall } from './resource-workspace-http';
import { readWorkspaceIssues, workspaceIds, workspaceKeys, workspaceRecord, workspaceRevision } from './resource-workspace-validation';
import { ApiError } from './types';

export function createResourceResetHttp(request: AuthenticatedRequest): Pick<ResourceServices, 'resetResourceData'> {
  return { async resetResourceData(input) {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || !Object.hasOwn(input, 'requestId') || !Object.hasOwn(input, 'baseRevision')
      || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 120
      || /\s|[\u0000-\u001f\u007f]/.test(input.requestId) || Object.keys(input).some(key => !['baseRevision', 'requestId'].includes(key)))
      throw new ApiError('恢复资源必须绑定当前版本及原请求号', 'VALIDATION_ERROR');
    let base: string;
    try { base = workspaceRevision(input.baseRevision); }
    catch { throw new ApiError('请先读取当前资源版本', 'VALIDATION_ERROR'); }
    const data = workspaceRecord(await resourceWorkspaceCall(request, '/resource/reset', {
      method: 'POST', body: JSON.stringify({ base_revision: base, request_id: input.requestId }),
    }));
    workspaceKeys(data, ['objectId', 'changed', 'revision', 'readRevision', 'affectedIds', 'warnings', 'restoredFromRevision']);
    const revision = workspaceRevision(data.revision);
    const affectedIds = workspaceIds(data.affectedIds);
    workspaceRevision(data.restoredFromRevision);
    if (data.objectId !== 'resource-reset' || typeof data.changed !== 'boolean' || data.readRevision !== revision
      || data.changed === (revision === base) || data.changed === false && affectedIds.length > 0)
      throw new ApiError('资源恢复回执不符合契约', 'INVALID_RESOURCE_RESPONSE');
    return { objectId: data.objectId, changed: data.changed, revision, readRevision: revision,
      affectedIds, warnings: readWorkspaceIssues(data.warnings) };
  } };
}
