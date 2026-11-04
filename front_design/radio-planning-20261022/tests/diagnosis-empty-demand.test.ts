import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { h, ssrContextKey, type App, type Slots } from 'vue';
import GisDiagnosisPanel from '../src/components/GisDiagnosisPanel.vue';
import { diagnosisReportSections, reportValue } from '../src/reports/diagnosis-report';
import { createMockService } from '../src/services/mock';
import { projectGisDiagnosisReport } from '../src/services/gis-diagnosis-display';
import type { DiagnosisRecord } from '../src/types/diagnosis';
import { TestStorage } from './helpers/storage';
import { all, clientTemplate, node, renderer, textOf } from './helpers/vue-client';

let base: DiagnosisRecord;
const apps: App[] = [];
beforeAll(async () => {
  await clientTemplate(GisDiagnosisPanel, 'src/components/GisDiagnosisPanel.vue', 'empty-demand-render.ts');
  base = await createMockService(() => new TestStorage()).getDiagnosisReport('DG-HW');
});
afterEach(() => apps.splice(0).forEach(app => app.unmount()));

function sample(ids: string[] | null) {
  const record = structuredClone(base);
  record.result.summary = ids === null ? null : {
    affectedNodeCount: record.result.nodes.length, directCount: 0, indirectCount: 0,
    interruptedNodeCount: 0, degradedNodeCount: 0,
    affectedLinkCount: record.result.links.length, totalBandwidthLossKbps: 0,
    affectedDemandIds: ids,
  };
  return record;
}

function mount(record: DiagnosisRecord) {
  const display = projectGisDiagnosisReport(record, record.id), root = node('root');
  const app = renderer.createApp({ render: () => h(GisDiagnosisPanel, {
    targetId: record.id, display, status: 'ready', error: '', refreshing: false,
    levels: [], selected: null,
    impact: { nodes: display.nodes, links: display.impactLinks, regions: display.regions, paths: display.paths },
    actions: { select: () => undefined, setLevel: () => undefined, retry: () => undefined },
  }) });
  app.component('RouterLink', { setup: (_: unknown, { slots }: { slots: Slots }) => () => h('a', slots.default?.()) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root); apps.push(app);
  return root;
}

describe('受影响必要需求的已知空集合与缺失统计', () => {
  it.each([
    { ids: [], expected: '无' },
    { ids: ['REQ-A', 'REQ-B'], expected: 'REQ-A；REQ-B' },
  ])('报告保留明确的需求结果 $expected', ({ ids, expected }) => {
    const record = sample(ids), before = JSON.stringify(record);
    const section = diagnosisReportSections(record).find(row => row.title === '影响统计')!;
    expect(section.rows.find(row => row[0] === '受影响必要需求')).toEqual(['受影响必要需求', expected]);
    expect(JSON.stringify(record)).toBe(before);
  });

  it.each([
    { ids: [], expected: '无' },
    { ids: ['REQ-A', 'REQ-B'], expected: 'REQ-A、REQ-B' },
  ])('GIS报告面板展示明确的需求结果 $expected', ({ ids, expected }) => {
    const record = sample(ids), before = JSON.stringify(record), root = mount(record);
    const summary = all(root, row => row.tag === 'dl').find(row =>
      all(row, child => child.tag === 'dt').some(child => textOf(child) === '受影响需求'))!;
    expect(all(summary, row => row.tag === 'dd').at(-1)).toBeDefined();
    expect(textOf(all(summary, row => row.tag === 'dd').at(-1)!)).toBe(expected);
    expect(textOf(root)).not.toContain('服务返回空集合');
    expect(JSON.stringify(record)).toBe(before);
  });

  it('报告没有summary时保持未提供，不生成“无”的需求结果', () => {
    const section = diagnosisReportSections(sample(null)).find(row => row.title === '影响统计')!;
    expect(section.rows).toEqual([]);
    expect(section.text).toEqual(['此结果未提供结构化统计，不按清单自行补算。']);
  });

  it('GIS报告面板没有summary时保留缺失统计说明', () => {
    const root = mount(sample(null));
    expect(textOf(root)).toContain('未提供结构化影响统计，不按清单补算。');
    expect(all(root, row => row.tag === 'dt').some(row => textOf(row) === '受影响需求')).toBe(false);
  });

  it('通用空值、零和false的报告规则保持原样', () => {
    expect([null, undefined, ''].map(reportValue)).toEqual(['未提供', '未提供', '未提供']);
    expect([0, false].map(reportValue)).toEqual(['0', 'false']);
  });
});
