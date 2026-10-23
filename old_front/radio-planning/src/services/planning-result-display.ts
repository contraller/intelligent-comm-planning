import type { PlanningCheck, PlanningConfiguration, PlanningResult } from '../types/planning';
import { resolveFrequencyFocus } from './planning-result-details-display';

// 仅描述当前冻结结果的展示上下文，不扩展接口或持久化结构。
export type PlanningResultSnapshot = Pick<PlanningResult, 'snapshotId' | 'inputSnapshot' | 'links' | 'metrics' | 'resultDetails'>;
export interface PlanningResultDisplayContext {
  key: string;
  result: PlanningResultSnapshot | null;
  configuration?: PlanningConfiguration;
}
export type PlanningSelectionKind = 'route' | 'link' | 'deployment' | 'device' | 'input-device' | 'frequency' | 'assignment' | 'station';
export interface PlanningResultSelection { kind: PlanningSelectionKind; id: string }
export interface PlanningResultFocus {
  state: 'default' | 'ready' | 'missing' | 'invalid';
  stationIds: string[];
  linkIds: string[];
  stationId: string;
  linkId: string;
  message: string;
}
export interface PlanningMetricCard {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  icon: string;
  state: 'passed' | 'failed' | 'unknown' | 'objective';
  status: string;
  note: string;
}

// 只放宽展示入参以承接 HTTP 空值，不改变冻结结果的业务类型。
type PlanningMetricValues = Readonly<{
  connectivityPercent: number | null;
  totalRadiatedPowerW: number | null;
  survivabilityPercent: number | null;
}>;

export function planningMetricCards(metrics: PlanningMetricValues | undefined, checks: readonly PlanningCheck[] = []): PlanningMetricCard[] {
  const state = (id: PlanningCheck['id']) => {
    const rows = checks.filter(row => row?.id === id);
    const check = rows.length === 1 ? rows[0] : undefined;
    return { state: check?.passed === true ? 'passed' as const : check?.passed === false ? 'failed' as const : 'unknown' as const,
      status: check?.passed === true ? '达标' : check?.passed === false ? '未达标' : '未提供校验结论',
      detail: typeof check?.detail === 'string' ? check.detail : '' };
  };
  const connectivity = state('connectivity'), survivability = state('survivability');
  const value = (key: keyof PlanningMetricValues) => typeof metrics?.[key] === 'number' && Number.isFinite(metrics[key]) ? metrics[key] : null;
  // 等级只取显式结论，不能根据数值反推达标，也不把总功率声明为最优。
  return [
    { id: 'connectivity', label: '网络连通率', value: value('connectivityPercent'), unit: '%', icon: 'pi-globe',
      state: connectivity.state, status: connectivity.status, note: connectivity.detail || '目标 100%' },
    { id: 'power', label: '总辐射功率', value: value('totalRadiatedPowerW'), unit: 'W', icon: 'pi-bolt',
      state: 'objective', status: '最小化目标', note: '直接读取结果，未提供单项达标结论' },
    { id: 'survivability', label: '抗毁性', value: value('survivabilityPercent'), unit: '%', icon: 'pi-shield',
      state: survivability.state, status: survivability.status, note: survivability.detail || '目标 ≥90%' },
  ];
}

const unique = (ids: string[]) => [...new Set(ids)];
const one = <T>(rows: readonly T[], matches: (row: T) => boolean) => {
  const found = rows.filter(matches);
  return found.length === 1 ? found[0] : undefined;
};
const empty = (message = '', state: PlanningResultFocus['state'] = 'default'): PlanningResultFocus =>
  ({ state, stationIds: [], linkIds: [], stationId: '', linkId: '', message });

export function planningSelectionExists(context: PlanningResultDisplayContext, selection: PlanningResultSelection) {
  const { result, configuration: config } = context;
  if (!result || !selection.id) return false;
  switch (selection.kind) {
    case 'station': return !!one(result.inputSnapshot.stations, row => row.id === selection.id);
    case 'input-device': return !!one(result.inputSnapshot.devices, row => row.id === selection.id);
    case 'link': return !!one(result.links, row => row.id === selection.id);
    case 'route': return !!one(config?.routes ?? [], row => row.id === selection.id);
    case 'deployment': return !!one(config?.deployment ?? [], row => row.stationId === selection.id);
    case 'device': return !!one(config?.devices ?? [], row => row.deviceId === selection.id);
    case 'frequency': return !!one(config?.frequencies ?? [], row => row.id === selection.id);
    case 'assignment': return !!one(result.resultDetails?.frequencyAssignments ?? [], row => row.id === selection.id);
  }
}

export function resolvePlanningResultFocus(
  context: PlanningResultDisplayContext, tab: string, selection: PlanningResultSelection | null,
): PlanningResultFocus {
  const { result, configuration: config } = context;
  if (!result) return empty();
  const station = (id: string) => one(result.inputSnapshot.stations, row => row.id === id);
  const device = (id: string) => one(result.inputSnapshot.devices, row => row.id === id);
  const link = (id: string) => one(result.links, row => row.id === id);
  const validLink = (row: PlanningResultSnapshot['links'][number]) => !!link(row.id) && row.a !== row.b
    && !!station(row.a) && !!station(row.b) && device(row.deviceA)?.stationId === row.a && device(row.deviceB)?.stationId === row.b;
  const validDevice = (row: PlanningConfiguration['devices'][number]) => !!station(row.stationId)
    && device(row.deviceId)?.stationId === row.stationId;
  const invalid = () => empty('所选结果关联不完整，无法定位；未补配其他版本的数据。', 'invalid');
  const focus = (stationIds: string[], linkIds: string[], message: string, stationId = '', linkId = ''): PlanningResultFocus =>
    ({ state: 'ready', stationIds: unique(stationIds), linkIds: unique(linkIds), stationId, linkId, message });

  if (!selection) {
    if (tab === '路由结果') return { ...empty(), linkIds: result.links.filter(validLink).map(row => row.id) };
    if (tab === '中继部署') return { ...empty(), stationIds: unique((config?.deployment ?? []).filter(row => station(row.stationId)).map(row => row.stationId)) };
    if (tab === '参数配置') return { ...empty(), stationIds: unique((config?.devices ?? []).filter(validDevice).map(row => row.stationId)) };
    return empty();
  }
  if (!planningSelectionExists(context, selection)) return invalid();
  const { kind, id } = selection;
  if (kind === 'station') return focus([id], [], `节点 ${id}`, id);
  // 任务快照保留原来的所属节点定位，不用输入参数替代方案配置。
  if (kind === 'input-device') {
    const row = device(id)!;
    return station(row.stationId) ? focus([row.stationId], [], `输入设备 ${id} · 节点 ${row.stationId}`, row.stationId) : invalid();
  }
  if (kind === 'link') {
    const row = link(id)!;
    return validLink(row) ? focus([row.a, row.b], [id], `链路 ${id} · 2 个节点`, '', id) : invalid();
  }
  if (kind === 'route') {
    const row = config!.routes.find(item => item.id === id)!;
    if (!row.linkIds.length || row.nodeIds.length !== row.linkIds.length + 1
      || unique(row.nodeIds).length !== row.nodeIds.length || unique(row.linkIds).length !== row.linkIds.length) return invalid();
    // 只核对已给出的有序路径和相邻端点，不搜索或生成路由。
    for (let i = 0; i < row.linkIds.length; i++) {
      const item = link(row.linkIds[i]), from = row.nodeIds[i], to = row.nodeIds[i + 1];
      if (!item || !validLink(item) || !(item.a === from && item.b === to || item.b === from && item.a === to)) return invalid();
    }
    return focus(row.nodeIds, row.linkIds, `${row.backup ? '备用' : '主'}路由 ${id} · ${row.nodeIds.length} 个节点 / ${row.linkIds.length} 条链路`, row.nodeIds[0]);
  }
  if (kind === 'deployment') {
    const row = config!.deployment.find(item => item.stationId === id)!;
    if (!station(id) || row.deviceIds.some(deviceId => device(deviceId)?.stationId !== id)) return invalid();
    return focus([id], [], `部署节点 ${id} · ${row.deviceIds.length} 台设备`, id);
  }
  if (kind === 'device') {
    const row = config!.devices.find(item => item.deviceId === id)!;
    const links = result.links.filter(item => item.deviceA === id || item.deviceB === id);
    if (!validDevice(row) || links.some(item => !validLink(item))) return invalid();
    return focus([row.stationId], links.map(item => item.id), `设备 ${id} · ${links.length} 条关联链路`, row.stationId);
  }
  return config ? resolveFrequencyFocus({ nodes: result.inputSnapshot.stations, devices: result.inputSnapshot.devices,
    links: result.links, configuration: config, resultDetails: result.resultDetails }, { kind, id }) : invalid();
}
