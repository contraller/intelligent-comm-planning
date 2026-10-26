import { describe, expect, it } from 'vitest';
import { createMockService } from '../src/services/mock';
import { createLinkDetailContext, selectHistoryAssessment } from '../src/services/link-detail';
import { selectLinkAssessment } from '../src/services/link-assessment';
import { selectMonitoringAssessment, assertNetworkObservation } from '../src/services/monitoring-validation';
import { withMonitoringAssessments, withOrdinaryAssessments } from '../src/services/link-assessment-mock';
import { monitoringPresets } from '../src/mocks/monitoring-presets';
import oldCatalog from '../src/mocks/link-details.json';
import { TestStorage } from './helpers/storage';
import { monitoringFixture } from './helpers/monitoring';
import type { LinkStateAssessment } from '../src/types/link-assessment';
import type { LinkDetailCatalog } from '../src/types/link-detail';

async function ordinary() {
  const storage = new TestStorage(), service = createMockService(() => storage), data = await service.loadPreview();
  const context = () => createLinkDetailContext(data.situation, data.resources, data.resourceMeta);
  return { storage, service, data, context, detail: () => selectHistoryAssessment(context(), 'PL-002') };
}
describe('冻结链路判定依据', () => {
  it('七条最新采样各有声明，旧资产及历史采样无写入', async () => {
    const s = await ordinary(), original = JSON.stringify(oldCatalog), writes = s.storage.writes;
    for (const record of s.context().records) {
      const d = selectHistoryAssessment(s.context(), record.linkId);
      expect(d.display.state).toBe('ready'); expect(d.display.assessment?.state).toBe(record.samples.at(-1)!.linkState);
      expect(record.samples.slice(0, -1).every(v => v.assessment === undefined)).toBe(true);
    }
    expect(JSON.stringify(oldCatalog)).toBe(original); expect(s.storage.writes).toBe(writes);
  });
  it.each(monitoringPresets.map(p => p.id))('预设 %s 每帧只附加说明，指标和旧资产完整保留', id => {
    const p = monitoringPresets.find(p => p.id === id)!, before = JSON.stringify(p), network = { ...p.network, key: 'network-' + id };
    p.frames.forEach((frame, i) => {
      const next = withMonitoringAssessments(network, frame, i); assertNetworkObservation(next, p);
      next.links.forEach(row => {
        const d = selectMonitoringAssessment(network, next, row.linkId); expect(d.display.state).toBe('ready');
        expect(d.display.assessment?.state).toBe(row.state);
        const { assessment, ...base } = row; expect(base).toEqual(frame.links.find(r => r.linkId === row.linkId));
        expect(assessment?.owner.networkKey).toBe(network.key);
      });
      expect(next.devices).toEqual(frame.devices); expect(next.statistics).toEqual(frame.statistics);
    });
    expect(JSON.stringify(p)).toBe(before);
  });
  it('真实确认网络服务出帧使用最终身份，查询不改已保存方案', async () => {
    const s = await monitoringFixture(), before = [...s.storage.entries], c = await s.monitoring.loadMonitoringContext(s.plan.taskId);
    const r = await s.monitoring.getMonitoringFrame({ taskId: s.plan.taskId, networkKey: c.network!.key, index: 1 });
    expect(selectMonitoringAssessment(r.context.network, r.frame, 'LINK-B').display.assessment?.owner.networkKey).toBe(c.network!.key);
    expect([...s.storage.entries]).toEqual(before);
  });
  it.each([0, 1, null, undefined])('置信度 %s 不补默认值', async confidence => {
    const s = await ordinary(), d = s.detail(), a = structuredClone(d.display.assessment!); a.confidence = confidence;
    expect(selectLinkAssessment(a, d.owner).assessment?.confidence).toBe(confidence);
  });
  it('缺解释、未提供规则信息、明确空命中与缺摘录互不混淆', async () => {
    const s = await ordinary(), d = s.detail(), a = structuredClone(d.display.assessment!);
    expect(selectLinkAssessment(null, d.owner).state).toBe('missing'); expect(selectLinkAssessment(undefined, d.owner).state).toBe('missing');
    delete a.rules; delete a.matchedRuleIds; expect(selectLinkAssessment(a, d.owner).assessment?.matchedRuleIds).toBeUndefined();
    a.matchedRuleIds = []; expect(selectLinkAssessment(a, d.owner).assessment?.matchedRuleIds).toEqual([]);
    a.matchedRuleIds = ['NO-DETAIL']; expect(selectLinkAssessment(a, d.owner).state).toBe('ready');
  });
  const invalid: [string, (a: LinkStateAssessment) => void][] = [
    ['负置信度', a => { a.confidence = -.1; }], ['越界置信度', a => { a.confidence = 1.1; }], ['非有限', a => { a.confidence = NaN; }],
    ['非法指标', a => { a.dominantMetric = 'margin' as never; }], ['空说明', a => { a.explanation = ''; }],
    ['未知状态', a => { a.state = 'UNKNOWN' as never; }], ['重复规则', a => { a.matchedRuleIds!.push(a.matchedRuleIds![0]); }],
    ['无命中摘录', a => { a.matchedRuleIds = []; }], ['重复摘录', a => { a.rules!.push(a.rules![0]); }],
    ['空来源', a => { a.source = ''; }], ['坏归属', a => { a.owner.metrics.ber = NaN; }],
    ['稀疏规则', a => { a.matchedRuleIds = new Array(1); }], ['稀疏摘录', a => { a.rules = new Array(1); }],
    ['数组状态', a => { a.state = ['GOOD'] as never; }], ['无效日期', a => { a.owner.observedAt = '2026-02-30T00:00:00+08:00'; }],
  ];
  it.each(invalid)('%s 仅使解释失效，原采样仍可读', async (_label, mutate) => {
    const s = await ordinary(); mutate(s.data.situation.linkDetails!.records[1].samples.at(-1)!.assessment!);
    expect(s.context().state).toBe('ready'); expect(s.detail().display.state).toBe('invalid');
    expect(s.context().records[1].samples.at(-1)!.metrics.snrDb.value).toBe(8.4);
  });
  it.each(['networkKey', 'linkId', 'a', 'b', 'deviceA', 'deviceB', 'observedAt', 'metrics'])('%s 变化不能借用解释', async key => {
    const s = await ordinary(), d = s.detail(), owner = structuredClone(d.owner!);
    if (key === 'metrics') owner.metrics.snrDb = 99;
    else (owner as unknown as Record<string, unknown>)[key] = key === 'observedAt' ? '2026-10-03T09:43:18+08:00' : 'OTHER';
    expect(selectLinkAssessment(d.display.assessment, owner).state).toBe('stale');
  });
  it('不同服务等级可并列展示，不能替换原等级；未匹配输入不补解释', async () => {
    const s = await ordinary(), row = s.context().records[1].samples.at(-1)!; row.assessment!.state = 'GOOD';
    expect(s.detail().display.assessment?.state).toBe('GOOD'); expect(row.linkState).toBe('WARNING');
    const input = structuredClone(oldCatalog) as LinkDetailCatalog; input.records[0].samples.at(-1)!.metrics.snrDb.value = 999;
    expect(withOrdinaryAssessments(input).records[0].samples.at(-1)!.assessment).toBeUndefined();
    s.data.resourceMeta.changedDeviceIds.push('DV-0001'); expect(s.detail().display.state).toBe('stale');
  });
});
