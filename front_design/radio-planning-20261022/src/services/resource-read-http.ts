import { resolveAuthApiBaseUrl } from '../config/env';
import type { ReadDevice, ReadInterference, ReadNode, ReadOptions, ResourcePageQuery, ResourceReadServices } from '../types/resource-read';
import { assertMapQuery, assertPageQuery, assertReadOptions, decodeMap, decodeModel, decodeObject, decodePage, decodeWorkspace, readRecord, readText, requireRevision } from './resource-read-validation';
import { createHttpClient } from './http-client';
import { ApiError } from './types';

interface Options { baseUrl: () => string; fetcher?: typeof fetch; origin?: () => string | undefined; timeoutMs?: number }
const paths = { node: 'nodes', device: 'devices', interference: 'interference-sources' } as const;
// 只读适配不复用全量 PreviewData；所有路径/传输差异集中在本文件。
export function createResourceReadHttp(options: Options): ResourceReadServices {
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  async function get(path: string, params: Record<string, string | number | boolean | undefined>, input: ReadOptions): Promise<unknown> {
    assertReadOptions(input);
    const base = resolveAuthApiBaseUrl(options.baseUrl(), options.origin?.() ?? globalThis.location?.origin);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ context: input.context, ...params })) if (value !== undefined) query.set(key, String(value));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {};
    try {
      return await Promise.race([
        createHttpClient(base, fetcher)(`${path}?${query}`, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          abort = () => { reject(new ApiError('资源读取已取消', 'REQUEST_ABORTED')); controller.abort(); };
          input.signal?.addEventListener('abort', abort, { once: true });
          if (input.signal?.aborted) abort();
          timer = setTimeout(() => { reject(new ApiError('资源读取超时，请重试', 'REQUEST_TIMEOUT')); controller.abort(); }, options.timeoutMs ?? 15000);
        }),
      ]);
    } catch (reason) {
      if (!(reason instanceof ApiError)) throw reason;
      // 沿用认证业务码，身份失效不能因 HTTP 200 或 409 被当成普通资源错误。
      const codes: Record<number, string> = { 1102: 'AUTH_EXPIRED', 1103: 'AUTH_DISABLED', 1104: 'FORBIDDEN', 1106: 'SESSION_REPLACED', 1201: 'RESOURCE_VERSION_CHANGED', 1202: 'RESOURCE_VERSION_CHANGED' };
      const code = typeof reason.code === 'number' ? codes[reason.code] : undefined;
      const mappedCode = code ?? ([409, 410].includes(reason.status ?? 0) ? 'RESOURCE_VERSION_CHANGED'
        : reason.status === 401 ? 'AUTH_REQUIRED' : reason.status === 403 ? 'FORBIDDEN' : reason.status === 404 ? 'RESOURCE_NOT_FOUND' : undefined);
      if (!mappedCode) throw reason;
      const mapped = new ApiError(mappedCode === 'RESOURCE_VERSION_CHANGED' ? '资源版本已变化或过期，请手动刷新' : reason.message, mappedCode, reason.data, reason.requestId, reason.status);
      mapped.cause = reason; throw mapped;
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
  }
  function params(input: ResourcePageQuery) {
    assertPageQuery(input);
    // 状态快照协议待接入时显式失败，不能忽略快照后返回基线结果。
    if (input.statusMode === 'observed' || input.observationSnapshotId) throw new ApiError('观测快照查询尚未接入，已保留上次成功结果', 'NOT_IMPLEMENTED');
    return { revision: input.revision, page: input.pageNum, page_size: input.pageSize, search: input.search, sort: input.sort, order: input.order,
      device_class: input.deviceClass, status: input.status, availability: input.availability, alert: input.alert, node_id: input.nodeId, parent_id: input.parentId === null ? '' : input.parentId, cluster_id: input.clusterId,
      mobility: input.mobility, node_role: input.nodeRole, relay_capable: input.relayCapable, frequency_mode: input.frequency?.mode,
      frequency_presence: input.frequency?.presence, min_khz: input.frequency?.minKhz ?? undefined, max_khz: input.frequency?.maxKhz ?? undefined };
  }
  return {
    async loadResourceReadContext(input) { return decodeWorkspace(await get('/resource/context', {}, input)); },
    async queryResourceDevices(input) { return decodePage<ReadDevice>('device', await get('/resource/devices', params(input), input), input); },
    async queryResourceNodes(input) { return decodePage<ReadNode>('node', await get('/resource/nodes', params(input), input), input); },
    async queryResourceInterferences(input) { return decodePage<ReadInterference>('interference', await get('/resource/interference-sources', params(input), input), input); },
    async getResourceObject(input) {
      if(input.observationSnapshotId)throw new ApiError('详情观测快照协议尚待确认','NOT_IMPLEMENTED');
      assertReadOptions(input, true); readText(input.id, 'id');
      if (!Object.hasOwn(paths, input.kind)) throw new ApiError('不支持的资源类型', 'INVALID_RESOURCE_QUERY');
      const data = readRecord(await get(`/resource/${paths[input.kind]}/${encodeURIComponent(input.id)}`, { revision: input.revision }, input));
      const revision = requireRevision(data.revision, input.revision), object = decodeObject(input.kind, data.item);
      if (object.id !== input.id) throw new ApiError('详情 ID 与请求不一致', 'INVALID_RESOURCE_RESPONSE');
      if (object.kind !== 'device') return { revision, object, model: null, antenna: null };
      // 所属节点、型号和天线按 ID 与同一版本读取，不拉取整库补分页关联。
      const values = await Promise.all([
        get('/resource/device-models', { revision, ids: object.modelId }, input),
        get('/resource/antenna-models', { revision, ids: object.antennaId }, input),
        get(`/resource/nodes/${encodeURIComponent(object.stationId)}`, { revision }, input),
      ]);
      const singleton = (value: unknown) => {
        const d = readRecord(value); requireRevision(d.revision, revision);
        if (!Array.isArray(d.items) || d.items.length !== 1) throw new ApiError('关联字典响应不完整', 'INVALID_RESOURCE_RESPONSE');
        return readRecord(d.items[0]);
      };
      const model = decodeModel(singleton(values[0])), a = singleton(values[1]);
      const antenna = { id: readText(a.antenna_id, 'antenna_id'), name: readText(a.antenna_name, 'antenna_name') };
      if (model.id !== object.modelId || antenna.id !== object.antennaId || model.deviceClass !== object.deviceClass || model.name !== object.modelName || antenna.name !== object.antennaName) throw new ApiError('设备与型号/天线关联不一致', 'INVALID_RESOURCE_RESPONSE');
      const related = readRecord(values[2]); requireRevision(related.revision, revision);
      const node = decodeObject('node', related.item);
      if (node.kind !== 'node' || node.id !== object.stationId || node.coordinate.some((v, i) => v !== object.stationCoordinate[i])) throw new ApiError('设备与所属节点关联不一致', 'INVALID_RESOURCE_RESPONSE');
      return { revision, object, model, antenna, node };
    },
    async queryResourceMap(input) {
      assertMapQuery(input);
      // 未对齐的空间筛选不能被适配器静默丢弃。
      if(input.frequency||input.availability||input.statusMode==='observed'||input.observationSnapshotId)
        throw new ApiError('空间查询的频率、上下架及观测筛选协议尚待确认', 'NOT_IMPLEMENTED');
      return decodeMap(await get('/resource/map', { revision: input.revision, bbox: input.bbox.join(','), zoom: input.zoom,
        show_nodes: input.showNodes, show_interferences: input.showInterferences, search: input.search, device_class: input.deviceClass, status: input.status, alert: input.alert,
        mobility: input.mobility, node_role: input.nodeRole, relay_capable: input.relayCapable }, input), input);
    },
  };
}
