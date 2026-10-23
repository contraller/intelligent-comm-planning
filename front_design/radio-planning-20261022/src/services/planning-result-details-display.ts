import type { PlanningResultDetails, PlanningResultDetailsContext } from '../types/planning-result-details';

// 仅格式化明确返回的值；0、false 与未提供保持区别，不计算业务结果。
export const detailValue = (value: string | number | null | undefined) => value ?? '未提供';
export const detailBoolean = (value: boolean | null | undefined, yes = '是', no = '否') => value === true ? yes : value === false ? no : '未提供';
export const detailCollection = (rows: readonly unknown[] | null | undefined, empty = '没有记录') => rows == null ? '未提供' : rows.length ? '' : empty;
export function deviceDetailCells(details: PlanningResultDetails | undefined, deviceId: string) {
  const row = details?.deviceParameters?.find(item => item.deviceId === deviceId);
  return { tiltDeg: detailValue(row?.tiltDeg), tiltEffective: detailBoolean(row?.tiltEffective, '参与', '未参与') };
}
export function routeDetailCells(details: PlanningResultDetails | undefined, routeId: string) {
  const row = details?.routeQuality?.find(item => item.routeId === routeId);
  return { hopCount: detailValue(row?.hopCount), totalDistanceM: detailValue(row?.totalDistanceM), totalDelayMs: detailValue(row?.totalDelayMs),
    bottleneckMarginDb: detailValue(row?.bottleneckMarginDb), reliability: row?.reliability == null ? '未提供' : `${Number((row.reliability * 100).toFixed(8))}%`,
    isFeasible: detailBoolean(row?.isFeasible, '可行', '不可行'), bottleneckLinkId: detailValue(row?.bottleneckLinkId) };
}
export const deviceDetailColumns = [{ field: 'tiltDeg', header: '天线倾角 / °' }, { field: 'tiltEffective', header: '倾角参与计算' }];
export const routeDetailColumns = [{ field: 'hopCount', header: '跳数' }, { field: 'totalDistanceM', header: '总距离 / m' },
  { field: 'totalDelayMs', header: '总时延 / ms' }, { field: 'bottleneckMarginDb', header: '瓶颈裕度 / dB' },
  { field: 'reliability', header: '可靠性' }, { field: 'isFeasible', header: '可行性' }, { field: 'bottleneckLinkId', header: '瓶颈链路' }];
export const assignmentColumns = [{ field: 'id', header: '分配 ID' }, { field: 'linkId', header: '链路' }, { field: 'resourceGroupId', header: '频率池' },
  { field: 'freqId', header: '频点 ID' }, { field: 'frequencyKhz', header: '频率 / kHz' }, { field: 'bandwidthKhz', header: '带宽 / kHz' }, { field: 'reuseGroup', header: '复用组' }];
export const conflictColumns = [{ field: 'id', header: '冲突 ID' }, { field: 'type', header: '类型' }, { field: 'linkIds', header: '关联链路' },
  { field: 'frequencyKhz', header: '频率 / kHz' }, { field: 'distanceM', header: '距离 / m' }, { field: 'requiredDistanceM', header: '要求距离 / m' }, { field: 'severity', header: '等级' }];
export function frequencyDetailRows(details: PlanningResultDetails | undefined) {
  return { assignments: (details?.frequencyAssignments ?? []).map(row => ({ ...row, resourceGroupId: detailValue(row.resourceGroupId), freqId: detailValue(row.freqId), bandwidthKhz: detailValue(row.bandwidthKhz), reuseGroup: detailValue(row.reuseGroup) })),
    conflicts: (details?.frequencyConflicts ?? []).map(row => ({ ...row, linkIds: row.linkIds.join(' / ') || '没有关联链路', frequencyKhz: detailValue(row.frequencyKhz), distanceM: detailValue(row.distanceM), requiredDistanceM: detailValue(row.requiredDistanceM), severity: detailValue(row.severity) })) };
}
export function frequencyDetailSummary(details: PlanningResultDetails | undefined) {
  return `所需信道：${detailValue(details?.frequencyGap?.requiredChannels)} · 可用信道：${detailValue(details?.frequencyGap?.availableChannels)} · 缺口：${detailValue(details?.frequencyGap?.shortage)} · 服务结论：${detailBoolean(details?.conflictFree, '明确无冲突', '存在冲突')}`;
}
export function unreachableDemandText(details: PlanningResultDetails | undefined) {
  return details?.unreachableDemandIds == null ? '未提供' : details.unreachableDemandIds.join(' / ') || '未列出不可达需求';
}

export type FrequencySelection = { kind: 'frequency' | 'assignment'; id: string };
export type FrequencyDisplayContext = Pick<PlanningResultDetailsContext, 'nodes' | 'devices' | 'links' | 'configuration'> & { resultDetails?: PlanningResultDetails };
export function resolveFrequencyFocus(context: FrequencyDisplayContext, selection: FrequencySelection) {
  const empty = (state: 'missing' | 'invalid', message: string) => ({ state, stationIds: [] as string[], linkIds: [] as string[], stationId: '', linkId: '', message });
  const missing = () => empty('missing', '未提供明确分配关系');
  const invalid = () => empty('invalid', '所选结果关联不完整，无法定位；未补配其他版本的数据。');
  const rows = context.resultDetails?.frequencyAssignments;
  if (!rows?.length) return missing();
  const one = <T>(items: readonly T[], matches: (item: T) => boolean) => { const found = items.filter(matches); return found.length === 1 ? found[0] : undefined; };
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.linkId)).size !== rows.length) return invalid();
  const chosen = selection.kind === 'assignment' ? rows.filter(row => row.id === selection.id) : rows.filter(row => row.resourceGroupId === selection.id);
  if (selection.kind === 'frequency' && !one(context.configuration.frequencies, row => row.id === selection.id)) return invalid();
  if (!chosen.length) return missing();
  const nodes: string[] = [], links: string[] = [];
  // 只核对显式 ID 和归属；相同频点从不用于搜索链路、设备或频率池。
  for (const row of chosen) {
    const link = one(context.links, item => item.id === row.linkId);
    const group = row.resourceGroupId === null ? null : one(context.configuration.frequencies, item => item.id === row.resourceGroupId);
    if (!link || link.a === link.b || link.frequencyKhz !== row.frequencyKhz || (row.resourceGroupId !== null && (!group || !group.allocatedKhz.includes(row.frequencyKhz)))) return invalid();
    for (const [nodeId, deviceId] of [[link.a, link.deviceA], [link.b, link.deviceB]]) {
      if (!one(context.nodes, item => item.id === nodeId) || one(context.devices, item => item.id === deviceId)?.stationId !== nodeId
        || one(context.configuration.devices, item => item.deviceId === deviceId)?.stationId !== nodeId) return invalid();
      nodes.push(nodeId);
    }
    links.push(link.id);
  }
  return { state: 'ready' as const, stationIds: [...new Set(nodes)], linkIds: links, stationId: '', linkId: '',
    message: `${selection.kind === 'assignment' ? '分配' : '频率资源'} ${selection.id} · 明确关联 ${links.length} 条链路` };
}
