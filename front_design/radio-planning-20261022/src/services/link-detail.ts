import { LINK_STATUS_STYLES } from '../config/link-status';
import type { ResourcesData, SituationData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { LinkDetailCatalog, LinkDetailContext, LinkMetricKey, LinkMetricStatus } from '../types/link-detail';
import { assessmentOwner, assessmentMetrics, selectLinkAssessment } from './link-assessment';
import type { LinkAssessmentOwner } from '../types/link-assessment';

export const LINK_METRICS: { key: LinkMetricKey; label: string; unit: string }[] = [
  { key: 'snrDb', label: '信噪比', unit: 'dB' },
  { key: 'ber', label: '误码率', unit: '比率' },
  { key: 'packetLossRate', label: '丢包率', unit: '%' },
  { key: 'delayMs', label: '时延', unit: 'ms' },
  { key: 'throughputKbps', label: '吞吐量', unit: 'kbps' },
];
export const LINK_METRIC_STYLES: Record<LinkMetricStatus, { label: string; color: string }> = {
  NORMAL: { label: '正常', color: '#8ed66b' }, WARNING: { label: '预警越限', color: '#f2cf5b' },
  FAULT: { label: '故障越限', color: '#ef5f64' }, MISSING: { label: '未采集', color: '#9aafc9' },
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();

// 要求含时区的完整时间，并拒绝会被 Date 自动进位的无效日期。
function validTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && Number(value.slice(11, 13)) < 24;
}
function validMetric(metric: unknown, key: LinkMetricKey) {
  if (!object(metric) || typeof metric.status !== 'string' || !Object.hasOwn(LINK_METRIC_STYLES, metric.status)
    || typeof metric.reason !== 'string' || (metric.status !== 'NORMAL' && !metric.reason.trim())) return false;
  if (metric.value === null) return metric.status === 'MISSING';
  if (metric.status === 'MISSING' || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) return false;
  if (key !== 'snrDb' && metric.value < 0) return false;
  return !['ber', 'packetLossRate'].includes(key) || metric.value <= 1;
}
function validCatalog(value: unknown, situation: SituationData, resources: ResourcesData): value is LinkDetailCatalog {
  if (!object(value) || value.version !== 'link-detail-v1' || value.snapshotId !== situation.snapshotId
    || !nonempty(value.source) || !Array.isArray(value.records)) return false;
  const links = new Map(situation.links.map(row => [row.id, row]));
  if (links.size !== situation.links.length) return false;
  const stations = new Set(resources.stations.map(row => row.id));
  const devices = new Map(resources.devices.map(row => [row.id, row]));
  const ids = new Set<string>();
  for (const row of value.records) {
    if (!object(row) || !nonempty(row.linkId) || ids.has(row.linkId)) return false;
    ids.add(row.linkId);
    const link = links.get(row.linkId);
    if (!link || link.a === link.b || !stations.has(link.a) || !stations.has(link.b)
      || devices.get(link.deviceA)?.stationId !== link.a || devices.get(link.deviceB)?.stationId !== link.b
      || row.a !== link.a || row.b !== link.b || row.deviceA !== link.deviceA || row.deviceB !== link.deviceB
      || !Object.hasOwn(LINK_STATUS_STYLES, link.state) || !['HF', 'VUHF'].includes(link.deviceClass)
      || !Number.isFinite(link.frequencyKhz) || link.frequencyKhz <= 0
      || typeof row.bandwidthKhz !== 'number' || !Number.isFinite(row.bandwidthKhz) || row.bandwidthKhz <= 0
      || !Array.isArray(row.samples) || !row.samples.length) return false;
    let previous = -Infinity;
    for (const sample of row.samples) {
      if (!object(sample) || !validTime(sample.timestamp) || Date.parse(sample.timestamp) <= previous
        || typeof sample.linkState !== 'string' || !Object.hasOwn(LINK_STATUS_STYLES, sample.linkState)
        || !object(sample.metrics)) return false;
      const metrics = sample.metrics;
      if (!LINK_METRICS.every(({ key }) => validMetric(metrics[key], key))) return false;
      previous = Date.parse(sample.timestamp);
    }
    if (row.samples.at(-1).linkState !== link.state) return false;
  }
  return true;
}

export function createLinkDetailContext(
  situation: SituationData, resources: ResourcesData, meta: ResourceMeta, draftDirty = false,
): LinkDetailContext {
  const context: LinkDetailContext = { state: 'missing', message: '暂无当前网络的链路指标与历史资料。',
    snapshotId: situation.snapshotId, source: '', records: [] };
  // 与 GIS 旧结果保护一致，不用新的资源配置解释旧采样。
  if (draftDirty || meta.changedStationIds.length || meta.changedDeviceIds.length || (meta.interferenceVersion ?? 'initial') !== 'initial')
    return { ...context, state: 'stale', message: draftDirty
      ? '资源存在未保存修改，暂停展示链路指标与历史趋势；撤销或取消修改后可恢复。'
      : '资源已变更，暂无匹配的链路指标与历史样例；恢复演示基线后可查看。' };
  if (situation.linkDetails == null) return context;
  if (!validCatalog(situation.linkDetails, situation, resources))
    return { ...context, state: 'invalid', message: '链路资料关联、指标或时间无效，或网络版本不匹配，暂不可用。' };
  return { ...context, state: 'ready', message: '', source: situation.linkDetails.source, records: situation.linkDetails.records };
}
export function selectLinkDetail(context: LinkDetailContext, linkId: string) {
  const record = context.state === 'ready' ? context.records.find(row => row.linkId === linkId) : undefined;
  return { state: context.state === 'ready' && !record ? 'missing' as const : context.state, record,
    message: context.state === 'ready' && !record ? '此链路暂无指标与历史资料。' : context.message };
}

// 解释附加字段独立校验，不让坏解释使合法指标和趋势失效。
export function selectHistoryAssessment(context: LinkDetailContext, linkId: string) {
  const record = selectLinkDetail(context, linkId).record, sample = record?.samples.at(-1);
  const owner = record && sample ? assessmentOwner(context.snapshotId, { ...record, id: record.linkId }, sample.timestamp,
    Object.fromEntries(assessmentMetrics.map(key => [key, sample.metrics[key].value])) as LinkAssessmentOwner['metrics']) : null;
  return { owner, display: selectLinkAssessment(sample?.assessment, owner) };
}

// 仅做展示单位转换；零值与缺测严格区分。
export function linkMetricValue(key: LinkMetricKey, value: number | null) {
  return value === null ? null : key === 'packetLossRate' ? value * 100 : value;
}
export function formatLinkMetric(key: LinkMetricKey, value: number | null) {
  if (value === null) return '未采集';
  if (key === 'ber') return value === 0 ? '0' : value.toExponential(2);
  return String(Number(linkMetricValue(key, value)!.toPrecision(6)));
}
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const formatLinkTime = (value: string | number) => timeFormat.format(new Date(value));
