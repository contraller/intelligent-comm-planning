import { ordinaryAssessmentPreset, monitoringAssessmentPresets } from '../mocks/link-assessment-presets';
import { assessmentOwner, assessmentMetrics, sameAssessmentOwner } from './link-assessment';
import type { LinkAssessmentOwner, LinkStateAssessment } from '../types/link-assessment';
import type { LinkDetail, LinkDetailCatalog, LinkHistorySample } from '../types/link-detail';
import type { MonitoringNetwork, NetworkObservationFrame } from '../types/monitoring';

export function historyAssessmentOwner(snapshotId: string, record: LinkDetail, sample: LinkHistorySample) {
  return assessmentOwner(snapshotId, { ...record, id: record.linkId }, sample.timestamp,
    Object.fromEntries(assessmentMetrics.map(k => [k, sample.metrics[k].value])) as LinkAssessmentOwner['metrics']);
}
const wrap = (owner: LinkAssessmentOwner, conclusion: Omit<LinkStateAssessment, 'owner' | 'source' | 'version'>): LinkStateAssessment =>
  structuredClone({ ...conclusion, owner, source: '独立固定 Mock 评估说明 · 非实时算法结果', version: 'assessment-demo-v1' });

// 不写原 JSON 或任何已保存快照；返回的扩展仍属于当前服务副本。
export function withOrdinaryAssessments(input: LinkDetailCatalog): LinkDetailCatalog {
  const result = structuredClone(input), preset = ordinaryAssessmentPreset;
  if (result.snapshotId !== preset.catalog.snapshotId || result.version !== preset.catalog.version) return result;
  for (const record of result.records) {
    const index = preset.catalog.records.findIndex(r => r.linkId === record.linkId), expected = preset.catalog.records[index];
    const sample = record.samples.at(-1), saved = expected?.samples.at(-1);
    if (!sample || !saved || sample.assessment !== undefined || sample.linkState !== saved.linkState) continue;
    const owner = historyAssessmentOwner(result.snapshotId, record, sample);
    if (sameAssessmentOwner(owner, historyAssessmentOwner(preset.catalog.snapshotId, expected, saved))) sample.assessment = wrap(owner, preset.conclusions[index]);
  }
  return result;
}
export function withMonitoringAssessments(network: MonitoringNetwork, frame: NetworkObservationFrame, index: number): NetworkObservationFrame {
  const result = structuredClone(frame), preset = monitoringAssessmentPresets.find(p => p.id === network.presetId), saved = preset?.frames[index];
  if (!preset || !saved || frame.observedAt !== saved.observedAt) return result;
  for (const row of result.links) {
    const i = saved.links.findIndex(r => r.linkId === row.linkId), original = saved.links[i];
    const link = network.links.find(r => r.id === row.linkId), expected = preset.network.links.find(r => r.id === row.linkId);
    if (!link || !expected || !original || row.assessment !== undefined || row.state !== original.state) continue;
    const owner = assessmentOwner(network.key, link, frame.observedAt, row);
    if (sameAssessmentOwner(owner, assessmentOwner(network.key, expected, saved.observedAt, original))) row.assessment = wrap(owner, preset.conclusions[index][i]);
  }
  return result;
}
