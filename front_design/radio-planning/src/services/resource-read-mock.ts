import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { Bounds, ReadDevice, ReadInterference, ReadNode, ReadObject, ResourceMapCluster, ResourceMapFrame, ResourceMapPoint, ResourcePageQuery, ResourceReadFilter, ResourceReadServices, VersionedRead } from '../types/resource-read';
import { assertMapQuery, assertPageQuery, assertReadOptions, requireRevision } from './resource-read-validation';
import { ApiError } from './types';

// Mock 只在读取边界模拟分页/显示聚合，不写资源、不运行规划或覆盖算法。
export function createResourceReadMock(read: () => { resources: ResourcesData; meta: ResourceMeta }): ResourceReadServices {
  let clusters = new Map<string, { revision: string; kind: 'node' | 'interference'; ids: string[] }>();
  const revisionOf = (r: ReturnType<typeof read>) => `${r.resources.version}:${r.meta.resourceEpoch}:${r.meta.revision}`;
  function snapshot(input?: VersionedRead) {
    const source = read(), revision = revisionOf(source);
    if (input) { assertReadOptions(input, true); requireRevision(revision, input.revision); }
    const { resources: r } = source;
    const nodes: ReadNode[] = r.stations.map(s => ({ ...s, kind: 'node', alert: s.alert ?? null, origin: s.origin ?? null,
      childCount: r.stations.filter(n => n.parentIds.includes(s.id)).length, deviceCount: r.devices.filter(d => d.stationId === s.id).length }));
    const devices: ReadDevice[] = r.devices.map(d => {
      const s = nodes.find(s => s.id === d.stationId), m = r.models.find(m => m.id === d.modelId), a = r.antennas.find(a => a.id === d.antennaId);
      if (!s || !m || !a) throw new ApiError('资源引用缺失', 'INVALID_RESOURCE_RESPONSE');
      return { ...d, kind: 'device', alert: d.alert ?? null, origin: d.origin ?? null, availability: d.availability ?? null, stationName: s.name, stationCoordinate: s.coordinate, modelName: m.name, deviceClass: m.deviceClass, antennaName: a.name };
    });
    const interferences: ReadInterference[] = (r.interferences ?? []).map(i => ({ ...i, kind: 'interference', origin: i.origin ?? null }));
    return { ...source, revision, nodes, devices, interferences };
  }
  function matches(row: ReadObject, q: ResourceReadFilter): boolean {
    const name = row.kind === 'device' ? `${row.modelName} ${row.stationName}` : row.name;
    if (q.search && !`${row.id} ${name}`.toLowerCase().includes(q.search.trim().toLowerCase())) return false;
    if (q.deviceClass && (row.kind === 'device' ? row.deviceClass !== q.deviceClass : row.kind === 'node' ? !row.classes.includes(q.deviceClass) : true)) return false;
    if (q.status && (row.kind === 'interference' || row.status !== q.status)) return false;
    if (q.alert && (row.kind === 'interference' || (q.alert === 'UNKNOWN' ? row.alert !== null : row.alert !== (q.alert === 'YES')))) return false;
    if (q.availability && (row.kind !== 'device' || (q.availability === 'UNKNOWN' ? row.availability !== null : row.availability !== q.availability))) return false;
    return true;
  }
  function page<T extends ReadObject>(rows: T[], q: ResourcePageQuery, revision: string) {
    assertPageQuery(q);
    let selected = rows.filter(r => matches(r, q));
    if (q.nodeId) selected = selected.filter(r => r.kind === 'device' && r.stationId === q.nodeId);
    const parentId = q.parentId;
    if (parentId !== undefined) selected = selected.filter(r => r.kind === 'node' && (parentId === null ? !r.parentIds.length : r.parentIds.includes(parentId)));
    if (q.clusterId) {
      const cluster = clusters.get(q.clusterId);
      if (!cluster || cluster.revision !== revision) throw new ApiError('聚合已过期，请重新查询地图', 'RESOURCE_VERSION_CHANGED');
      selected = selected.filter(r => r.kind === cluster.kind && cluster.ids.includes(r.id));
    }
    const field = (r: T) => q.sort === 'name' ? r.kind === 'device' ? r.modelName : r.name : q.sort === 'status' ? r.kind === 'interference' ? String(r.active) : r.status : r.id;
    selected.sort((a, b) => (field(a).localeCompare(field(b)) || a.id.localeCompare(b.id)) * (q.order === 'desc' ? -1 : 1));
    return { revision, items: selected.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: selected.length, page: q.page, pageSize: q.pageSize };
  }
  return {
    async loadResourceReadContext(input) {
      assertReadOptions(input); const r = snapshot();
      const points = [...r.nodes, ...r.interferences].map(x => x.coordinate);
      const bounds: Bounds = points.length ? [Math.max(-180, Math.min(...points.map(p => p[0])) - .02), Math.max(-90, Math.min(...points.map(p => p[1])) - .02), Math.min(180, Math.max(...points.map(p => p[0])) + .02), Math.min(90, Math.max(...points.map(p => p[1])) + .02)] : [114.0465, 36.911, 115.4045, 37.989];
      return { revision: r.revision, bounds, updatedAt: r.meta.savedAt ?? '2026-10-05T00:00:00Z', source: 'Mock 资源读取', stats: {
        nodes: r.nodes.length, devices: r.devices.length, models: r.resources.models.length, interferences: r.interferences.length,
        hf: r.devices.filter(d => d.deviceClass === 'HF').length, vuhf: r.devices.filter(d => d.deviceClass === 'VUHF').length,
        alerts: r.devices.filter(d => d.alert === true).length, unknownAlerts: r.devices.filter(d => d.alert === null).length,
        active: r.devices.filter(d => d.availability === 'ACTIVE').length, offShelf: r.devices.filter(d => d.availability === 'OFF_SHELF').length, unknownAvailability: r.devices.filter(d => d.availability === null).length } };
    },
    async queryResourceNodes(input) { const r = snapshot(input); return page(r.nodes, input, r.revision); },
    async queryResourceDevices(input) { const r = snapshot(input); return page(r.devices, input, r.revision); },
    async queryResourceInterferences(input) { const r = snapshot(input); return page(r.interferences, input, r.revision); },
    async getResourceObject(input) {
      const r = snapshot(input), rows = input.kind === 'node' ? r.nodes : input.kind === 'device' ? r.devices : r.interferences;
      const object = rows.find(o => o.id === input.id);
      if (!object) throw new ApiError('资源对象不存在', 'RESOURCE_NOT_FOUND');
      return { revision: r.revision, object, model: object.kind === 'device' ? r.resources.models.find(m => m.id === object.modelId)! : null, antenna: object.kind === 'device' ? r.resources.antennas.find(a => a.id === object.antennaId)! : null };
    },
    async queryResourceMap(input) {
      assertMapQuery(input); const r = snapshot(input), b = input.bbox;
      const rows = [...(input.showNodes ? r.nodes : []), ...(input.showInterferences ? r.interferences : [])].filter(p => matches(p, input) && p.coordinate[0] >= b[0] && p.coordinate[0] <= b[2] && p.coordinate[1] >= b[1] && p.coordinate[1] <= b[3]);
      const buckets = new Map<string, typeof rows>();
      const size = 360 / 2 ** (Math.floor(input.zoom) + 3);
      for (const row of rows) {
        const key = `${row.kind}:${Math.floor((row.coordinate[0] + 180) / size)}:${Math.floor((row.coordinate[1] + 90) / size)}`;
        buckets.set(key, [...(buckets.get(key) ?? []), row]);
      }
      const points: ResourceMapPoint[] = [], groups: ResourceMapCluster[] = [];
      // 有界缓存仅供 Mock 聚合成员查询，不保存业务历史。
      if (clusters.size > 1000) clusters = new Map();
      for (const [key, members] of buckets) {
        const row = members[0];
        if (members.length === 1) points.push({ kind: row.kind, id: row.id, name: row.name, coordinate: row.coordinate, status: row.kind === 'node' ? row.status : null, alert: row.kind === 'node' ? row.alert : null, active: row.kind === 'interference' ? row.active : null });
        else {
          const clusterId = `${r.revision}:${input.zoom}:${key}:${members.map(m => m.id).join(',')}`;
          // 缩放/范围/筛选都进入标识，避免后一次读取覆盖旧聚合成员。
          const id = 'mock-' + Array.from(clusterId).reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 7).toString(16);
          const bounds: Bounds = [Math.min(...members.map(m => m.coordinate[0])) - .000001, Math.min(...members.map(m => m.coordinate[1])) - .000001, Math.max(...members.map(m => m.coordinate[0])) + .000001, Math.max(...members.map(m => m.coordinate[1])) + .000001];
          const coordinate: [number, number] = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
          const samePoint = members.every(m => m.coordinate[0] === row.coordinate[0] && m.coordinate[1] === row.coordinate[1]);
          groups.push({ kind: row.kind, id, coordinate, count: members.length, bounds, expansionZoom: input.zoom >= 17 || samePoint ? null : Math.min(17, input.zoom + 2) });
          clusters.set(id, { revision: r.revision, kind: row.kind, ids: members.map(m => m.id) });
        }
      }
      return { revision: r.revision, bbox: input.bbox, zoom: input.zoom, points, clusters: groups, totalNodes: rows.filter(r => r.kind === 'node').length, totalInterferences: rows.filter(r => r.kind === 'interference').length } satisfies ResourceMapFrame;
    },
  };
}
