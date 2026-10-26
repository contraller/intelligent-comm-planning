import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { Bounds, ReadDevice, ReadInterference, ReadNode, ReadObject, ResourceMapCluster, ResourceMapFrame, ResourceMapPoint, ResourcePageQuery, ResourceReadFilter, ResourceReadServices, VersionedRead } from '../types/resource-read';
import { assertMapQuery, assertPageQuery, assertReadOptions, requireRevision } from './resource-read-validation';
import { projectGisTree } from './gis-workspace';
import type { NetworkLink } from '../types/domain';
import { mockResourceRevision } from './mock-resource-revision';
import { ApiError } from './types';
import { projectReadLedgerRows, matchesLedgerQuery } from './resource-ledger-workspace';
import { deviceStatusDisplay } from './resource-status-display';
import type { DeviceStatusSnapshot } from '../types/resource-status';

// Mock 只在读取边界模拟分页/显示聚合，不写资源、不运行规划或覆盖算法。
export function createResourceReadMock(read: () => { resources: ResourcesData; meta: ResourceMeta }, readObservation?: (id: string, revision: string) => DeviceStatusSnapshot, readLinks: () => NetworkLink[] = () => []): ResourceReadServices {
  let clusters = new Map<string, { revision: string; kind: 'node' | 'interference'; ids: string[] }>();
  const revisionOf = mockResourceRevision;
  function snapshot(input?: VersionedRead) {
    const source = read(), revision = revisionOf(source);
    if (input) { assertReadOptions(input, true); requireRevision(revision, input.revision); }
    const { resources: r } = source;
    const nodes: ReadNode[] = r.stations.map(s => ({ ...s, kind: 'node', alert: s.alert ?? null, origin: s.origin ?? null,
      childCount: r.stations.filter(n => n.parentIds.includes(s.id)).length, deviceCount: r.devices.filter(d => d.stationId === s.id).length }));
    const devices: ReadDevice[] = r.devices.map(d => {
      // 表格摘要不运输端口清单，详情通过独立维护接口读取。
      const { ports: _ports, ...summary } = d;
      const s = nodes.find(s => s.id === d.stationId), m = r.models.find(m => m.id === d.modelId), a = r.antennas.find(a => a.id === d.antennaId);
      if (!s || !m || !a) throw new ApiError('资源引用缺失', 'INVALID_RESOURCE_RESPONSE');
      return { ...summary, kind: 'device', alert: d.alert ?? null, origin: d.origin ?? null, availability: d.availability ?? null, stationName: s.name, stationCoordinate: s.coordinate, modelName: m.name, deviceClass: m.deviceClass, antennaName: a.name,
        region: s.region, mobility: s.mobility, nodeRole: s.role || null, relayCapable: s.relayCapable, freqMinKhz: m.freqMinKhz, freqMaxKhz: m.freqMaxKhz };
    });
    const interferences: ReadInterference[] = (r.interferences ?? []).map(i => ({ ...i, kind: 'interference', origin: i.origin ?? null }));
    return { ...source, revision, nodes, devices, interferences };
  }
  function matches(row: ReadObject, q: ResourceReadFilter): boolean {
    if (row.kind === 'device') return matchesLedgerQuery(projectReadLedgerRows([row])[0]!, q);
    const name = row.name;
    if (q.search && !`${row.id} ${name}`.toLowerCase().includes(q.search.trim().toLowerCase())) return false;
    if (q.deviceClass && (row.kind === 'node' ? !row.classes.includes(q.deviceClass) : true)) return false;
    if (q.status && (row.kind === 'interference' || row.status !== q.status)) return false;
    if (q.alert && (row.kind === 'interference' || (q.alert === 'UNKNOWN' ? row.alert !== null : row.alert !== (q.alert === 'YES')))) return false;
    if (row.kind === 'node' && (q.mobility && row.mobility !== q.mobility || q.nodeRole && row.role !== q.nodeRole || q.relayCapable !== undefined && row.relayCapable !== q.relayCapable)) return false;
    if (q.availability) return false;
    return true;
  }
  function page<T extends ReadObject>(rows: T[], q: ResourcePageQuery, revision: string, source: ReturnType<typeof snapshot>) {
    assertPageQuery(q);
    const tree = q.context === 'gis' ? projectGisTree(source.resources, readLinks(), q.search ?? '', q.alert === 'YES' ? '告警' : q.deviceClass ?? '全部', true, rows[0]?.kind === 'device' ? 'devices' : 'stations',
      { mobility: (q.mobility ?? '') as never, role: (q.nodeRole ?? '') as never, relay: q.relayCapable === undefined ? '' : q.relayCapable ? 'YES' : 'NO' }) : null;
    const ids = tree ? new Set([...tree.stationIds, ...tree.deviceIds, ...tree.interferences.map(row => row.id)]) : null;
    let selected = rows.filter(row => (!ids || ids.has(row.id)) && matches(row, ids ? { ...q, search: undefined } : q));
    if (q.nodeId) selected = selected.filter(r => r.kind === 'device' && r.stationId === q.nodeId);
    const parentId = q.parentId;
    if (parentId !== undefined) selected = selected.filter(r => r.kind === 'node' && (parentId === null ? !r.parentIds.length : r.parentIds.includes(parentId)));
    if (q.clusterId) {
      const cluster = clusters.get(q.clusterId);
      if (!cluster || cluster.revision !== revision) throw new ApiError('聚合已过期，请重新查询地图', 'RESOURCE_VERSION_CHANGED');
      selected = selected.filter(r => r.kind === cluster.kind && cluster.ids.includes(r.id));
    }
    const field = (r: T) => q.sort === 'name' ? r.kind === 'device' ? r.modelName : r.name : q.sort === 'status' ? r.kind === 'interference' ? String(r.active) : r.kind === 'device' && r.statusDisplay ? r.statusDisplay.status ?? 'UNKNOWN' : r.status : r.id;
    selected.sort((a, b) => {
      const difference = q.sort === 'workFreqKhz' && a.kind === 'device' && b.kind === 'device'
        ? a.workFreqKhz == null ? b.workFreqKhz == null ? 0 : 1 : b.workFreqKhz == null ? -1 : a.workFreqKhz - b.workFreqKhz
        : (field(a) ?? 'UNKNOWN').localeCompare(field(b) ?? 'UNKNOWN');
      return (difference || a.id.localeCompare(b.id)) * (q.order === 'desc' ? -1 : 1);
    });
    return { revision, items: selected.slice((q.pageNum - 1) * q.pageSize, q.pageNum * q.pageSize), total: selected.length, pageNum: q.pageNum, pageSize: q.pageSize };
  }
  const loadResourceReadContext: ResourceReadServices['loadResourceReadContext'] = async input => {
      assertReadOptions(input); const r = snapshot();
      const points = [...r.nodes, ...r.interferences].map(x => x.coordinate);
      const bounds: Bounds = points.length ? [Math.max(-180, Math.min(...points.map(p => p[0])) - .02), Math.max(-90, Math.min(...points.map(p => p[1])) - .02), Math.min(180, Math.max(...points.map(p => p[0])) + .02), Math.min(90, Math.max(...points.map(p => p[1])) + .02)] : [114.0465, 36.911, 115.4045, 37.989];
      return { revision: r.revision, bounds, updatedAt: r.meta.savedAt ?? '2026-10-05T00:00:00Z', source: 'Mock 资源读取', stats: {
        nodes: r.nodes.length, devices: r.devices.length, models: r.resources.models.length, interferences: r.interferences.length,
        hf: r.devices.filter(d => d.deviceClass === 'HF').length, vuhf: r.devices.filter(d => d.deviceClass === 'VUHF').length,
        alerts: r.devices.filter(d => d.alert === true).length, unknownAlerts: r.devices.filter(d => d.alert === null).length,
        active: r.devices.filter(d => d.availability === 'ACTIVE').length, offShelf: r.devices.filter(d => d.availability === 'OFF_SHELF').length, unknownAvailability: r.devices.filter(d => d.availability === null).length,
        deployments: Object.fromEntries(['HF', 'VUHF'].map(c => [c, Object.fromEntries(['FIXED', 'VEHICLE', 'MANPACK'].map(m => [m, r.devices.filter(d => d.deviceClass === c && d.mobility === m).length]))])) as Record<'HF' | 'VUHF', Record<string, number>> } };
  };
  return {
    loadResourceReadContext,
    async queryResourceNodes(input) { const r = snapshot(input); return page(r.nodes, input, r.revision, r); },
    async queryResourceDevices(input) {
      const r = snapshot(input);
      if (input.statusMode === 'observed' && !input.observationSnapshotId) throw new ApiError('缺少观测快照，请重新同步', 'INVALID_RESOURCE_QUERY');
      const observation = input.observationSnapshotId ? readObservation?.(input.observationSnapshotId, r.revision) : undefined;
      if (input.observationSnapshotId && !observation) throw new ApiError('观测快照不可用', 'RESOURCE_VERSION_CHANGED');
      const devices = observation ? r.devices.map(d => ({ ...d, statusDisplay: deviceStatusDisplay(d, 'observed', observation.records[d.id], observation.source.label) })) : r.devices;
      const context = await loadResourceReadContext(input);
      return { ...page(devices, input, r.revision, r), stats: { ...context.stats,
        alerts: devices.filter(d => (d.statusDisplay ?? d).alert === true).length,
        unknownAlerts: devices.filter(d => (d.statusDisplay ?? d).alert === null).length } };
    },
    async queryResourceInterferences(input) { const r = snapshot(input); return page(r.interferences, input, r.revision, r); },
    async getResourceObject(input) {
      const r = snapshot(input), rows = input.kind === 'node' ? r.nodes : input.kind === 'device' ? r.devices : r.interferences;
      let object = rows.find(o => o.id === input.id);
      if (!object) throw new ApiError('资源对象不存在', 'RESOURCE_NOT_FOUND');
      if(object.kind==='device'&&input.observationSnapshotId){const observation=readObservation?.(input.observationSnapshotId,r.revision);if(!observation)throw new ApiError('观测快照已失效','RESOURCE_VERSION_CHANGED');object={...object,statusDisplay:deviceStatusDisplay(object,'observed',observation.records[object.id],observation.source.label)};}
      return { revision: r.revision, object, model: object.kind === 'device' ? r.resources.models.find(m => m.id === object.modelId)! : null, antenna: object.kind === 'device' ? r.resources.antennas.find(a => a.id === object.antennaId)! : null,
        node: object.kind === 'device' ? r.nodes.find(n => n.id === object.stationId)! : null };
    },
    async queryResourceMap(input) {
      assertMapQuery(input); const r = snapshot(input), b = input.bbox;
      const tree = input.context === 'gis' ? projectGisTree(r.resources, readLinks(), input.search ?? '', input.alert === 'YES' ? '告警' : input.deviceClass ?? '全部', true, 'stations', { mobility: (input.mobility ?? '') as never, role: (input.nodeRole ?? '') as never, relay: input.relayCapable === undefined ? '' : input.relayCapable ? 'YES' : 'NO' }) : null;
      const rows = [...(input.showNodes ? r.nodes : []), ...(input.showInterferences ? r.interferences : [])].filter(p => matches(p, tree ? { ...input, search: undefined } : input) && (!tree || (p.kind === 'node' ? tree.stationIds.includes(p.id) : tree.interferences.some(row => row.id === p.id))) && p.coordinate[0] >= b[0] && p.coordinate[0] <= b[2] && p.coordinate[1] >= b[1] && p.coordinate[1] <= b[3]);
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
