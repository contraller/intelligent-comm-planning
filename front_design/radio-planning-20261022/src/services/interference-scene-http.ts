import type { AuthenticatedRequest } from './auth-http';
import type {
  InterferenceSceneDetailQuery, InterferenceScenePageQuery, InterferenceSceneSave, InterferenceSceneServices,
} from '../types/interference-scene';
import { readSceneDetail, readScenePage, readSceneReceipt } from './interference-scene-validation';
import { ApiError } from './types';

function invalid(): never { throw new ApiError('干扰场景请求不符合保存与查询契约', 'VALIDATION_ERROR'); }
function object(value: unknown, allowed: readonly string[], required: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
}
function identifier(value: unknown, max = 120, path = false): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || /\s|[\u0000-\u001f\u007f]/u.test(value)
    || path && /[/\\]/.test(value)) invalid();
}
function pageQuery(input: InterferenceScenePageQuery, sceneId?: string) {
  const history = sceneId !== undefined;
  object(input, history ? ['taskId', 'sceneId', 'page', 'pageSize'] : ['taskId', 'page', 'pageSize', 'search'],
    history ? ['taskId', 'sceneId'] : ['taskId']);
  identifier(input.taskId);
  if (history) identifier(sceneId, 120, true);
  const page = input.page === undefined ? 1 : input.page;
  const pageSize = input.pageSize === undefined ? 20 : input.pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) invalid();
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 120)) invalid();
  const query = new URLSearchParams({ task_id: input.taskId, page: String(page), page_size: String(pageSize) });
  if (input.search !== undefined) query.set('search', input.search);
  return { query, expected: { taskId: input.taskId, page, pageSize, ...(history ? { sceneId } : {}) } };
}
function saveBody(input: InterferenceSceneSave) {
  const fields = ['sceneId', 'requestId', 'taskId', 'planId', 'planVersion', 'resourceRevision', 'baseSceneVersionId', 'name', 'note', 'interferenceIds'];
  object(input, fields, fields);
  identifier(input.sceneId, 120, true); identifier(input.requestId, 120, true);
  identifier(input.taskId); identifier(input.planId); identifier(input.resourceRevision);
  if (typeof input.planVersion !== 'string' || !/^V[1-9][0-9]*$/.test(input.planVersion)) invalid();
  if (input.baseSceneVersionId !== null) identifier(input.baseSceneVersionId, 40);
  if (typeof input.name !== 'string' || !input.name || input.name.length > 60 || input.name !== input.name.trim()
    || typeof input.note !== 'string' || input.note.length > 500 || !Array.isArray(input.interferenceIds)
    || new Set(input.interferenceIds).size !== input.interferenceIds.length) invalid();
  input.interferenceIds.forEach(id => identifier(id));
  return {
    request_id: input.requestId, task_id: input.taskId, plan_id: input.planId, plan_version: input.planVersion,
    resource_revision: input.resourceRevision, base_scene_version_id: input.baseSceneVersionId,
    name: input.name, note: input.note, interference_ids: [...input.interferenceIds].sort(),
  };
}
function detailQuery(input: InterferenceSceneDetailQuery) {
  object(input, ['taskId', 'sceneId', 'versionId'], ['taskId', 'sceneId']);
  identifier(input.taskId); identifier(input.sceneId, 120, true);
  const query = new URLSearchParams({ task_id: input.taskId });
  if (input.versionId !== undefined) { identifier(input.versionId, 40); query.set('version_id', input.versionId); }
  return query;
}

// 只接收已有会话绑定请求函数；不发明身份、不自动重试写入或回退构造结果。
export function createInterferenceSceneHttp(request: AuthenticatedRequest): InterferenceSceneServices {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    try { return await request(path, init); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const mappings: Record<number, string> = {
        1001: 'VALIDATION_ERROR', 2001: 'NOT_FOUND', 1203: 'VERSION_CONFLICT',
        1205: 'RESOURCE_VERSION_CHANGED', 1206: 'REQUEST_CONFLICT',
      };
      const code = typeof error.code === 'number' ? mappings[error.code] : undefined;
      if (!code) throw error;
      throw new ApiError(error.message, code, error.data, error.requestId, error.status);
    }
  }
  return {
    async saveScene(input) {
      const body = saveBody(input);
      const expected: InterferenceSceneSave = {
        sceneId: input.sceneId, requestId: body.request_id, taskId: body.task_id, planId: body.plan_id,
        planVersion: body.plan_version, resourceRevision: body.resource_revision, baseSceneVersionId: body.base_scene_version_id,
        name: body.name, note: body.note, interferenceIds: [...body.interference_ids],
      };
      const value = await call('/interference/scenes/' + encodeURIComponent(expected.sceneId), { method: 'PUT', body: JSON.stringify(body) });
      return readSceneReceipt(value, expected, expected);
    },
    async listScenes(input) {
      const { query, expected } = pageQuery(input);
      return readScenePage(await call('/interference/scenes?' + query), expected);
    },
    async getScene(input) {
      const query = detailQuery(input);
      const expected: InterferenceSceneDetailQuery = {
        taskId: input.taskId, sceneId: input.sceneId,
        ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      };
      return readSceneDetail(await call('/interference/scenes/' + encodeURIComponent(expected.sceneId) + '?' + query), expected);
    },
    async listSceneVersions(input) {
      // 必须先检查输入对象，不能在空输入上取 sceneId。
      object(input, ['taskId', 'sceneId', 'page', 'pageSize'], ['taskId', 'sceneId']);
      identifier(input.sceneId, 120, true);
      const { query, expected } = pageQuery(input, input.sceneId);
      return readScenePage(await call('/interference/scenes/' + encodeURIComponent(input.sceneId) + '/versions?' + query), expected);
    },
    async getSceneReceipt(input) {
      object(input, ['taskId', 'sceneId', 'requestId'], ['taskId', 'sceneId', 'requestId']);
      identifier(input.taskId); identifier(input.sceneId, 120, true); identifier(input.requestId, 120, true);
      const expected = { taskId: input.taskId, sceneId: input.sceneId, requestId: input.requestId };
      const query = new URLSearchParams({ task_id: expected.taskId, scene_id: expected.sceneId });
      return readSceneReceipt(await call('/interference/scene-operations/' + encodeURIComponent(expected.requestId) + '?' + query), expected);
    },
  };
}
