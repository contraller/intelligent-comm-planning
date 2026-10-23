import { describe, expect, it } from 'vitest';
import { createMockService } from '../src/services/mock';
import { createLinkDetailContext, formatLinkMetric, formatLinkTime, LINK_METRICS, linkMetricValue, selectLinkDetail } from '../src/services/link-detail';
import catalog from '../src/mocks/link-details.json';
import historical from '../src/mocks/planning.json';
import type { PreviewData } from '../src/types/domain';
import { TestStorage } from './helpers/storage';
import { monitoringFixture } from './helpers/monitoring';

async function fixture() {
  const storage = new TestStorage(), service = createMockService(() => storage), data = await service.loadPreview();
  return { storage, service, data, context: (dirty = false) => createLinkDetailContext(data.situation, data.resources, data.resourceMeta, dirty) };
}

// 剥离本批可选说明后仍逐字段核对旧指标；说明自身由独立用例验证。
function originalCatalog(value: typeof catalog | NonNullable<PreviewData['situation']['linkDetails']>) {
  return { ...value, records: value.records.map(row => ({ ...row, samples: row.samples.map(sample => {
    const { assessment: _assessment, ...original } = sample as import('../src/types/link-detail').LinkHistorySample;
    return original;
  }) })) };
}

describe('普通 GIS 链路详情契约', () => {
  it('七条链路各有四个固定时刻，端点和最新状态与当前快照一致', async () => {
    const s = await fixture(), before = JSON.stringify(s.data), context = s.context();
    expect(context.state).toBe('ready'); expect(context.snapshotId).toBe('NET-DEMO-03'); expect(context.records).toHaveLength(7);
    expect(context.records.map(row => row.linkId)).toEqual(s.data.situation.links.map(row => row.id));
    for (const link of s.data.situation.links) {
      const row = selectLinkDetail(context, link.id).record!;
      expect(row).toMatchObject({ a: link.a, b: link.b, deviceA: link.deviceA, deviceB: link.deviceB, bandwidthKhz: 3 });
      expect(row.samples).toHaveLength(4); expect(row.samples.at(-1)!.linkState).toBe(link.state);
      expect(row.samples.map(sample => sample.timestamp)).toEqual(['2026-10-03T09:39:18+08:00', '2026-10-03T09:40:18+08:00', '2026-10-03T09:41:18+08:00', '2026-10-03T09:42:18+08:00']);
      for (const sample of row.samples) expect(Object.keys(sample.metrics)).toEqual(LINK_METRICS.map(row => row.key));
    }
    expect(JSON.stringify(s.data)).toBe(before); expect(s.storage.writes).toBe(0);
    expect(s.data.planning.plans).toEqual(historical.plans);
  });
  it('候选线、其他网络 ID、缺记录和缺目录均不补配数据', async () => {
    const s = await fixture();
    for (const id of ['CL-DEMO-01', 'LINK-A', 'LK-0001', 'UNKNOWN']) expect(selectLinkDetail(s.context(), id)).toMatchObject({ state: 'missing', record: undefined });
    s.data.situation.linkDetails!.records.splice(0, 1);
    expect(s.context().state).toBe('ready'); expect(selectLinkDetail(s.context(), 'PL-001').state).toBe('missing');
    expect(selectLinkDetail(s.context(), 'PL-002').state).toBe('ready');
    delete s.data.situation.linkDetails; expect(s.context().state).toBe('missing');
  });
  it('越限标识直接读取，不从数值或历史状态推算；负信噪比合法', async () => {
    const s = await fixture(), sample = s.data.situation.linkDetails!.records[0].samples.at(-1)!;
    sample.metrics.snrDb = { value: -1, status: 'WARNING', reason: '甲方提供的预设判定' };
    expect(s.context().state).toBe('ready');
    expect(selectLinkDetail(s.context(), 'PL-001').record!.samples.at(-1)!.metrics.snrDb.status).toBe('WARNING');
    expect(sample.linkState).toBe('EXCELLENT');
  });
  it('比率展示、零值、空采样和时区不会改变业务数值', async () => {
    expect(formatLinkMetric('ber', .00021)).toBe('2.10e-4'); expect(formatLinkMetric('packetLossRate', .06)).toBe('6');
    expect(formatLinkMetric('delayMs', 95)).toBe('95'); expect(formatLinkMetric('snrDb', 8.4)).toBe('8.4');
    for (const { key } of LINK_METRICS) { expect(formatLinkMetric(key, 0)).toBe('0'); expect(formatLinkMetric(key, null)).toBe('未采集'); expect(linkMetricValue(key, null)).toBeNull(); }
    expect(linkMetricValue('packetLossRate', 1)).toBe(100); expect(formatLinkTime('2026-10-03T01:42:18Z')).toContain('09:42:18');
    const s = await fixture(), fault = selectLinkDetail(s.context(), 'PL-005').record!.samples.at(-1)!;
    expect(fault.metrics.throughputKbps).toMatchObject({ value: 0, status: 'FAULT' }); expect(fault.metrics.snrDb.value).toBeNull();
  });

  // 验证数据边界，防止损坏目录导致面板崩溃或错配网络。
  const corruptions: [string, (data: PreviewData) => void][] = [
    ['目录版本', d => { d.situation.linkDetails!.version = 'unknown' as never; }],
    ['网络快照', d => { d.situation.linkDetails!.snapshotId = 'OLD'; }],
    ['来源', d => { d.situation.linkDetails!.source = ''; }],
    ['记录数组', d => { d.situation.linkDetails!.records = null as never; }],
    ['空记录', d => { d.situation.linkDetails!.records[0] = null as never; }],
    ['重复记录', d => { d.situation.linkDetails!.records.push(d.situation.linkDetails!.records[0]); }],
    ['未知链路', d => { d.situation.linkDetails!.records[0].linkId = 'CL-DEMO-01'; }],
    ['重复链路', d => { d.situation.links.push(d.situation.links[0]); }],
    ['站点不一致', d => { d.situation.linkDetails!.records[0].a = 'ND-0002'; }],
    ['设备不一致', d => { d.situation.linkDetails!.records[0].deviceA = 'DV-0002'; }],
    ['设备归属', d => { d.resources.devices[0].stationId = 'ND-0002'; }],
    ['站点缺失', d => { d.resources.stations = d.resources.stations.filter(row => row.id !== 'ND-0001'); }],
    ['频率', d => { d.situation.links[0].frequencyKhz = NaN; }],
    ['带宽', d => { d.situation.linkDetails!.records[0].bandwidthKhz = 0; }],
    ['采样缺失', d => { d.situation.linkDetails!.records[0].samples = []; }],
    ['空采样', d => { d.situation.linkDetails!.records[0].samples[0] = null as never; }],
    ['无时区', d => { d.situation.linkDetails!.records[0].samples[0].timestamp = '2026-10-03 09:39:18'; }],
    ['无效日期', d => { d.situation.linkDetails!.records[0].samples[0].timestamp = '2026-02-30T09:39:18+08:00'; }],
    ['重复时刻', d => { const row = d.situation.linkDetails!.records[0]; row.samples[1].timestamp = row.samples[0].timestamp; }],
    ['时间倒序', d => { d.situation.linkDetails!.records[0].samples.reverse(); }],
    ['历史状态', d => { d.situation.linkDetails!.records[0].samples[0].linkState = 'UNKNOWN' as never; }],
    ['最新状态错配', d => { d.situation.linkDetails!.records[0].samples.at(-1)!.linkState = 'FAULT'; }],
    ['空指标', d => { d.situation.linkDetails!.records[0].samples[0].metrics = null as never; }],
    ['缺指标', d => { d.situation.linkDetails!.records[0].samples[0].metrics.ber = undefined as never; }],
    ['非数值', d => { d.situation.linkDetails!.records[0].samples[0].metrics.ber.value = '0' as never; }],
    ['非有限值', d => { d.situation.linkDetails!.records[0].samples[0].metrics.snrDb.value = Infinity; }],
    ['负时延', d => { d.situation.linkDetails!.records[0].samples[0].metrics.delayMs.value = -1; }],
    ['比率范围', d => { d.situation.linkDetails!.records[0].samples[0].metrics.packetLossRate.value = 6; }],
    ['空值正常', d => { d.situation.linkDetails!.records[0].samples[0].metrics.ber.value = null; }],
    ['越限原因缺失', d => { d.situation.linkDetails!.records[1].samples.at(-1)!.metrics.snrDb.reason = ''; }],
    ['缺采样状态有数值', d => { d.situation.linkDetails!.records[4].samples.at(-1)!.metrics.snrDb.value = 0; }],
  ];
  it.each(corruptions)('%s 损坏时隔离整个目录，不泄漏部分旧指标', async (_name, mutate) => {
    const s = await fixture(); mutate(s.data);
    expect(s.context().state).toBe('invalid'); expect(s.context().records).toEqual([]);
    expect(selectLinkDetail(s.context(), 'PL-001').record).toBeUndefined(); expect(s.storage.writes).toBe(0);
  });
  it.each(['draft', 'station', 'device', 'interference'])('%s 变更暂停指标和历史', async kind => {
    const s = await fixture();
    if (kind === 'station') s.data.resourceMeta.changedStationIds.push('ND-0001');
    if (kind === 'device') s.data.resourceMeta.changedDeviceIds.push('DV-0001');
    if (kind === 'interference') s.data.resourceMeta.interferenceVersion = 'changed';
    expect(s.context(kind === 'draft').state).toBe('stale'); expect(s.context(kind === 'draft').records).toEqual([]);
    expect(s.storage.writes).toBe(0);
  });
  it('保存后过期，恢复演示资源重新匹配；各次读取副本互不影响', async () => {
    const s = await fixture();
    const saved = await s.service.commitResources({ baseRevision: s.data.resourceMeta.revision, stations: [], devices: [{ id: 'DV-0001', txPowerDbm: 40 }] });
    const changed = await s.service.loadPreview();
    expect(createLinkDetailContext(changed.situation, changed.resources, changed.resourceMeta).state).toBe('stale');
    const reset = await s.service.resetResources(saved.meta.revision);
    expect(createLinkDetailContext(reset.preview.situation, reset.resources, reset.meta).state).toBe('ready');
    reset.preview.situation.linkDetails!.records[0].samples[0].metrics.snrDb.value = 999;
    const next = (await s.service.loadPreview()).situation.linkDetails!;
    expect(originalCatalog(next)).toEqual(catalog);
    expect(originalCatalog(s.data.situation.linkDetails!)).toEqual(catalog);
    expect(next.records.every(row => row.samples.at(-1)?.assessment?.owner.linkId === row.linkId)).toBe(true);
  });
  it('既有方案、监控快照和浏览器存储不被扩展资料回填', async () => {
    const s = await monitoringFixture(), service = createMockService(() => s.storage), before = [...s.storage.entries], writes = s.storage.writes;
    const preview = await service.loadPreview(), { workspace } = await service.loadPlanningWorkspace();
    const plan = workspace.plans.find(row => row.id === s.plan.id)!;
    const monitoring = await service.loadMonitoringContext(s.plan.taskId);
    expect(originalCatalog(preview.situation.linkDetails!)).toEqual(catalog); expect(plan).toEqual(s.plan); expect(plan).not.toHaveProperty('linkDetails');
    expect(monitoring.network!.links).toEqual(plan.links); expect(monitoring.network).not.toHaveProperty('linkDetails');
    expect([...s.storage.entries]).toEqual(before); expect(s.storage.writes).toBe(writes);
  });
});
