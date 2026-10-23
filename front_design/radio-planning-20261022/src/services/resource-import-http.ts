import type { AuthenticatedRequest } from './auth-http';
import type { ResourceImportPreview, ResourceServices } from '../types/resource-edit';
import { createResourceWorkspaceHttp, resourceWorkspaceCall } from './resource-workspace-http';
import { importSignature, importValidationError, readResourceImportPreview, readResourceTemplate, resourceImportBody, snapshotImportRequest, templateArguments } from './resource-import-validation';
import { readWorkspaceMutation, workspaceEqual, workspaceId, workspaceKeys, workspaceRecord, workspaceRevision } from './resource-workspace-validation';

type ImportServices = Pick<ResourceServices, 'getResourceTemplate' | 'previewResourceImport' | 'applyResourceImport' | 'commitResourceImport'>;
export function createResourceImportHttp(request: AuthenticatedRequest): ImportServices {
  const workspace = createResourceWorkspaceHttp(request);
  const previews = new Map<string, ResourceImportPreview>();
  async function commit(input: Parameters<ImportServices['applyResourceImport']>[0]) {
    let preview: ResourceImportPreview, requestId: string;
    try {
      const v = workspaceRecord(input); workspaceKeys(v, ['baseRevision', 'requestId', 'preview']);
      requestId = workspaceId(v.requestId);
      workspaceRevision(v.baseRevision);
      const bound = previews.get(importSignature(input.preview?.signature));
      if (!bound || !workspaceEqual(input.preview, bound) || v.baseRevision !== bound.request.baseRevision || bound.issues.length) throw importValidationError();
      preview = structuredClone(bound);
      importSignature(preview.signature);
    } catch { throw importValidationError(); }
    const payload = { ...resourceImportBody(preview.request), signature: preview.signature, request_id: requestId };
    // 一次调用只发送一次提交；超时后的原 requestId 由 store 保留并核实。
    const value = await resourceWorkspaceCall(request, '/resource/import/commit', { method: 'POST', body: JSON.stringify(payload) });
    return readWorkspaceMutation(value, preview.request.baseRevision, 'resource-import', preview.rows.filter(row => row.action !== 'UNCHANGED').map(row => row.id));
  }
  return {
    async getResourceTemplate(format, kind = 'nodes') {
      const expected = templateArguments(format, kind), current = await workspace.loadWorkspace('ledger');
      const params = new URLSearchParams({ context: 'ledger', revision: current.revision, format: expected.format, kind: expected.kind });
      const value = await resourceWorkspaceCall(request, '/resource/import/template?' + params, undefined, 'blob');
      return readResourceTemplate(value, expected.format, expected.kind, current.revision);
    },
    async previewResourceImport(input) {
      const snapshot = snapshotImportRequest(input), payload = resourceImportBody(snapshot);
      const value = await resourceWorkspaceCall(request, '/resource/import/preview', { method: 'POST', body: JSON.stringify(payload) });
      const preview = readResourceImportPreview(value, snapshot);
      // store 可深拷贝预检；绑定依据服务签名和完整快照，不依赖对象身份。
      previews.delete(preview.signature);
      previews.set(preview.signature, structuredClone(preview));
      if (previews.size > 8) previews.delete(previews.keys().next().value!);
      return preview;
    },
    async applyResourceImport(input) { return (await commit(input)).receipt; },
    async commitResourceImport(input) { return (await commit(input)).result; },
  };
}
