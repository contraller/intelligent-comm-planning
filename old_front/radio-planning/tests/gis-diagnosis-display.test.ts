import { beforeAll, describe, expect, it } from 'vitest';
import { reactive } from 'vue';
import { interferenceFixture } from './helpers/interference';
import { networkDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import legacyCases from '../src/mocks/diagnosis.json';
import type { DiagnosisRecord } from '../src/types/diagnosis';
import { filterGisDiagnosisImpact, gisDiagnosisObject, GIS_DIAGNOSIS_LEVELS, parseGisDiagnosisTarget, projectGisDiagnosisReport } from '../src/services/gis-diagnosis-display';

let current: DiagnosisRecord, redeployed: DiagnosisRecord;
let reports: DiagnosisRecord[] = [], historical: DiagnosisRecord[] = [];

// 使用实际保存、确认、执行及完整报告入口，展示校验不依赖拼装的伪成功任务。
beforeAll(async () => {
  for (const networkId of ['balanced', 'economical']) {
    const s = await interferenceFixture(networkId);
    for (const preset of diagnosisPresets.filter(row => row.networkPresetId === networkId)) {
      const loaded = await s.diagnosis.loadDiagnosisWorkspace();
      const saved = await s.diagnosis.saveDiagnosisScenario({ baseRevision: loaded.workspace!.revision,
        requestId: crypto.randomUUID(), scenarioId: null,
        draft: { name: preset.label, description: 'GIS 冻结展示测试', planId: s.plan.id, faults: structuredClone(preset.faults) } });
      const task = await s.diagnosis.submitDiagnosis({ baseRevision: saved.revision, requestId: crypto.randomUUID(),
        scenarioVersionId: saved.scenarios.at(-1)!.versions[0].id, demo: 'normal' });
      await expect(s.diagnosis.getDiagnosisReport(task.view.run.id)).rejects.toMatchObject({ code: 'REPORT_NOT_READY' });
      s.advance();
      reports.push(await s.diagnosis.getDiagnosisReport(task.view.run.id));
    }
    if (networkId === 'balanced') {
      current = reports[0];
      for (const legacy of legacyCases.cases) historical.push(await s.diagnosis.getDiagnosisReport(legacy.id));
      const analysis = await s.submit(); s.advance();
      const adopted = await s.adopt(analysis.view.run.analysisId, 'NODE_REDEPLOY');
      const plan = (await s.confirm(adopted.plan.id)).plan;
      const preset = networkDiagnosisPresets(plan)[0];
      const loaded = await s.diagnosis.loadDiagnosisWorkspace();
      const saved = await s.diagnosis.saveDiagnosisScenario({ baseRevision: loaded.workspace!.revision,
        requestId: crypto.randomUUID(), scenarioId: null,
        draft: { name: '重新部署后的诊断', description: '', planId: plan.id, faults: structuredClone(preset.faults) } });
      const run = await s.diagnosis.submitDiagnosis({ baseRevision: saved.revision, requestId: crypto.randomUUID(),
        scenarioVersionId: saved.scenarios.at(-1)!.versions[0].id, demo: 'normal' });
      s.advance(); redeployed = await s.diagnosis.getDiagnosisReport(run.view.run.id);
    }
  }
}, 20000);

describe('诊断明确目标', () => {
  it('无参数不进入诊断；保留合法不透明 ID 的原值', () => {
    expect(parseGisDiagnosisTarget({ stationId: 'ND-1' })).toEqual({ present: false, id: null, error: null });
    for (const id of ['报告/版本:一 + #', 'x'.repeat(120), ' DG-HW '])
      expect(parseGisDiagnosisTarget({ diagnosisId: id })).toEqual({ present: true, id, error: null });
  });
  it.each([null, undefined, '', '   ', [], ['DG-HW'], ['DG-HW', 'DG-HW'], 10, {}, 'x'.repeat(121), 'DG\nHW', 'DG\u0000', 'DG\u007f'])('拒绝无效值 %j 但保留明确入口状态', value => {
    expect(parseGisDiagnosisTarget({ diagnosisId: value })).toEqual({ present: true, id: null, error: expect.any(String) });
  });
  it.each(['stationId', 'deviceId', 'interferenceId', 'taskId'])('与 %s 互斥，包括空值参数', key => {
    for (const value of ['target', '', null, undefined])
      expect(parseGisDiagnosisTarget({ diagnosisId: 'DG-HW', [key]: value }).error).toContain('混用');
  });
});

describe('完整报告冻结展示', () => {
  it('真实两类规划的全部诊断报告可用，不依赖报告名称或本地预设选择', () => {
    expect(reports).toHaveLength(diagnosisPresets.filter(row => ['balanced', 'economical'].includes(row.networkPresetId)).length);
    for (const report of reports) {
      const before = JSON.stringify(report), display = projectGisDiagnosisReport(report, report.id);
      expect(display.record).toEqual(report);
      expect(display.links).toEqual(report.network.links);
      expect(display.faults).toEqual(report.faults);
      expect(display.regions).toEqual(report.result.regions);
      expect(display.nodes).toEqual(report.result.nodes);
      expect(display.record.result.summary).toEqual(report.result.summary);
      expect(JSON.stringify(report)).toBe(before);
    }
  });
  it('全部内置历史兼容 null、空故障与未分级影响，不补造故障或统计', () => {
    expect(historical).toHaveLength(legacyCases.cases.length);
    for (const record of historical) {
      const display = projectGisDiagnosisReport(record, record.id);
      expect(display.record.completedAt).toBeNull(); expect(display.record.diagnoseTaskId).toBeNull();
      expect(display.record.impactTaskId).toBeNull(); expect(display.record.result.summary).toBeNull();
      expect(display.faults).toEqual([]);
      expect(display.regions.every(region => region.level === null)).toBe(true);
      expect(filterGisDiagnosisImpact(display, [])).toEqual({ nodes: display.nodes, links: display.impactLinks, regions: display.regions });
    }
  });
  it('重部署坐标来自冻结规划输出，设备与链路定位跟随输出且不修改输入', () => {
    const before = JSON.stringify(redeployed), display = projectGisDiagnosisReport(redeployed, redeployed.id);
    const row = redeployed.network.workflow!.configuration.deployment.find(item => item.plannedCoordinate)!;
    const node = gisDiagnosisObject(display, { objectType: 'NODE', objectId: row.stationId })!;
    const device = gisDiagnosisObject(display, { objectType: 'DEVICE', objectId: row.deviceIds[0] })!;
    expect(node.coordinate).toEqual(row.plannedCoordinate); expect(device.coordinate).toEqual(row.plannedCoordinate);
    expect(node.coordinate).not.toEqual(redeployed.network.inputSnapshot.stations.find(item => item.id === row.stationId)!.coordinate);
    const link = display.links.find(item => item.a === row.stationId || item.b === row.stationId)!;
    const located = gisDiagnosisObject(display, { objectType: 'LINK', objectId: link.id })!;
    expect(located.coordinates).toContainEqual(row.plannedCoordinate);
    expect(JSON.stringify(redeployed)).toBe(before);
  });
  it('响应式输入和孔洞完整复制，修改显示值不会污染服务报告', () => {
    const report = structuredClone(current), ring = report.result.regions[0].rings[0];
    report.result.regions[0].rings.push(structuredClone(ring));
    const input = reactive(report), before = JSON.stringify(input), display = projectGisDiagnosisReport(input, input.id);
    expect(display.regions[0].rings).toEqual(report.result.regions[0].rings);
    display.regions[0].rings[1][0][0] += 0.01;
    display.stations[0].coordinate[0] += 1;
    display.devices[0].stationId = 'new';
    display.record.source.reasons.push('显示修改');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('空影响集合是合法缺口，统计直接展示服务值而不以列表重算', () => {
    const report = structuredClone(current);
    report.result.nodes = []; report.result.links = []; report.result.regions = [];
    report.result.summary!.affectedNodeCount = 99; report.result.summary!.totalBandwidthLossKbps = 8765.5;
    const display = projectGisDiagnosisReport(report, report.id);
    expect(filterGisDiagnosisImpact(display, GIS_DIAGNOSIS_LEVELS)).toEqual({ nodes: [], links: [], regions: [] });
    expect(display.record.result.summary!.affectedNodeCount).toBe(99);
    expect(display.record.result.summary!.totalBandwidthLossKbps).toBe(8765.5);
  });
  it('级别筛选仅过滤影响清单和区域，null 保留且基础网络、故障与完整统计不变', () => {
    const report = structuredClone(current);
    report.result.nodes[0].level = null;
    report.result.links[0].level = null;
    report.result.regions[0].level = null;
    const display = projectGisDiagnosisReport(report, report.id), before = JSON.stringify(display);
    const empty = filterGisDiagnosisImpact(display, []);
    expect(empty.nodes).toEqual(display.nodes.filter(row => row.level === null));
    expect(empty.links).toEqual(display.impactLinks.filter(row => row.level === null));
    expect(empty.regions).toEqual(display.regions.filter(row => row.level === null));
    const severe = filterGisDiagnosisImpact(display, ['SEVERE']);
    expect(severe.nodes.every(row => row.level === null || row.level === 'SEVERE')).toBe(true);
    expect(JSON.stringify(display)).toBe(before);
  });
  it('来源状态变化不改变内容身份，未知有效性仍可显示；内容变化会产生新身份', () => {
    const report = structuredClone(current), original = projectGisDiagnosisReport(report, report.id).contentKey;
    report.source = { state: 'UNKNOWN', reasons: ['来源存储不可用'] };
    expect(projectGisDiagnosisReport(report, report.id).contentKey).toBe(original);
    report.source = { state: 'HISTORICAL', reasons: ['源规划已重置'] };
    expect(projectGisDiagnosisReport(report, report.id).contentKey).toBe(original);
    const reordered = Object.fromEntries(Object.entries(report).reverse());
    expect(projectGisDiagnosisReport(reordered, report.id).contentKey).toBe(original);
    report.result.nodes[0].reason += ' · 后端修订';
    expect(projectGisDiagnosisReport(report, report.id).contentKey).not.toBe(original);
  });
  it('严格使用类型与 ID 定位，链路保留两端；设备不继承节点影响结论', () => {
    const display = projectGisDiagnosisReport(current, current.id), station = display.stations[0], link = display.links[0];
    const located = gisDiagnosisObject(display, { objectType: 'LINK', objectId: link.id })!;
    expect(located.coordinates).toEqual([display.stations.find(row => row.id === link.a)!.coordinate, display.stations.find(row => row.id === link.b)!.coordinate]);
    expect(located.link).toEqual(link);
    expect(gisDiagnosisObject(display, { objectType: 'NODE', objectId: link.id })).toBeNull();
    expect(gisDiagnosisObject(display, { objectType: 'DEVICE', objectId: station.id })).toBeNull();
    expect(gisDiagnosisObject(display, { objectType: 'NODE', objectId: '当前台账节点' })).toBeNull();
    expect(gisDiagnosisObject(display, { objectType: 'DEVICE', objectId: display.devices[0].id })!.nodeImpact).toBeNull();
    const a = gisDiagnosisObject(display, { objectType: 'NODE', objectId: station.id })!;
    a.coordinate[0] = 0; a.coordinates[0][0] = 0;
    expect(display.stations[0].coordinate).toEqual(station.coordinate);
    expect(display.stations[0].coordinate[0]).not.toBe(0);
  });
});

type Edit = (report: DiagnosisRecord) => void;
const invalidCases: [string, Edit][] = [
  ['报告 ID 错配', row => { row.id = 'other'; }],
  ['来源状态未知枚举', row => { row.source.state = 'LATEST' as never; }],
  ['网络身份缺失', row => { row.network.id = ''; }],
  ['快照身份缺失', row => { row.network.snapshotId = ''; }],
  ['网络节点清单与快照不符', row => { row.network.stationIds.pop(); }],
  ['节点重复', row => { row.network.inputSnapshot.stations.push(structuredClone(row.network.inputSnapshot.stations[0])); }],
  ['设备重复', row => { row.network.inputSnapshot.devices.push(structuredClone(row.network.inputSnapshot.devices[0])); }],
  ['链路重复', row => { row.network.links.push(structuredClone(row.network.links[0])); }],
  ['设备丢失所属节点', row => { row.network.inputSnapshot.devices[0].stationId = 'missing'; }],
  ['链路丢失端点', row => { row.network.links[0].a = 'missing'; }],
  ['链路设备缺失', row => { row.network.links[0].deviceA = 'missing'; }],
  ['链路设备归属错配', row => { row.network.links[0].deviceA = row.network.links[0].deviceB; }],
  ['节点经度越界', row => { row.network.inputSnapshot.stations[0].coordinate = [180.1, 30]; }],
  ['节点纬度越界', row => { row.network.inputSnapshot.stations[0].coordinate = [110, -90.1]; }],
  ['节点非有限坐标', row => { row.network.inputSnapshot.stations[0].coordinate = [NaN, 30]; }],
  ['部署引用不存在', row => { row.network.workflow!.configuration.deployment[0].stationId = 'missing'; }],
  ['部署节点重复', row => { row.network.workflow!.configuration.deployment.push(structuredClone(row.network.workflow!.configuration.deployment[0])); }],
  ['部署设备归属错配', row => { row.network.workflow!.configuration.deployment[0].deviceIds.push('missing'); }],
  ['输出坐标无效', row => { row.network.workflow!.configuration.deployment[0].plannedCoordinate = [Infinity, 30]; }],
  ['故障对象不属于网络', row => { row.faults[0].objectId = 'missing'; }],
  ['故障类型无效', row => { row.faults[0].faultType = 'UNKNOWN' as never; }],
  ['故障对象重复', row => { row.faults.push(structuredClone(row.faults[0])); }],
  ['节点影响错配', row => { row.result.nodes[0].nodeId = 'missing'; }],
  ['节点影响重复', row => { row.result.nodes.push(structuredClone(row.result.nodes[0])); }],
  ['绕行节点缺失', row => { row.result.nodes[0].detourRoute = ['missing']; }],
  ['等级不是 null 或合法枚举', row => { row.result.nodes[0].level = 'UNKNOWN' as never; }],
  ['状态不是 null 或合法枚举', row => { row.result.nodes[0].state = 'FAULT' as never; }],
  ['直接间接枚举错误', row => { row.result.nodes[0].affectType = 'OTHER' as never; }],
  ['链路影响错配', row => { row.result.links[0].linkId = 'missing'; }],
  ['链路影响重复', row => { row.result.links.push(structuredClone(row.result.links[0])); }],
  ['显式链路故障键无对应输入', row => { row.result.links[0].faultKey = 'NODE:missing'; }],
  ['带宽损失非有限', row => { row.result.links[0].bandwidthLossKbps = NaN; }],
  ['区域重复', row => { row.result.regions.push(structuredClone(row.result.regions[0])); }],
  ['显式区域故障键无对应输入', row => { row.result.regions[0].faultKey = 'DEVICE:missing'; }],
  ['区域未闭合', row => { row.result.regions[0].rings[0].pop(); }],
  ['区域无外环', row => { row.result.regions[0].rings = []; }],
  ['区域环不足四点', row => { row.result.regions[0].rings = [[[110, 30], [111, 30], [110, 30]]]; }],
  ['区域孔洞无效', row => { row.result.regions[0].rings.push([[0, 0], [1, 0], [1, 91], [0, 0]]); }],
  ['区域无限坐标', row => { row.result.regions[0].rings[0][1][0] = Infinity; }],
  ['区域等级非法', row => { row.result.regions[0].level = '' as never; }],
  ['统计字段缺失', row => { row.result.summary = undefined as never; }],
  ['统计字段非法', row => { row.result.summary!.affectedNodeCount = -1; }],
];
describe('拒绝损坏报告而不静默裁剪或拼接当前台账', () => {
  it.each(invalidCases)('%s', (_label, edit) => {
    const report = structuredClone(current); edit(report); const before = JSON.stringify(report);
    expect(() => projectGisDiagnosisReport(report, current.id)).toThrow('诊断快照关联错误');
    expect(JSON.stringify(report)).toBe(before);
  });
  it.each([null, undefined, {}, [], 'report'])('无效响应 %j', value => {
    expect(() => projectGisDiagnosisReport(value, current.id)).toThrow('响应报告与请求 ID 不一致');
  });
  it('历史没有 faults 时显式 faultKey 不能冒用节点或案例名', () => {
    const report = structuredClone(historical[0]); report.result.regions[0].faultKey = `NODE:${report.network.stationIds[0]}`;
    expect(() => projectGisDiagnosisReport(report, report.id)).toThrow('关联');
  });
});
