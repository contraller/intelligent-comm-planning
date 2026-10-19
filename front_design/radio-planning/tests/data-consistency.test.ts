import { describe, expect, it } from 'vitest';
import { initialSystemWorkspace } from '../src/mocks/system-presets';
import { validateSystem } from '../src/services/system-validation';
import { knowledgeIdentityReferences } from '../src/services/knowledge-identity';
import { createHash } from 'node:crypto';
import supplement from '../src/mocks/resource-supplement.json';
import { readFileSync } from 'node:fs';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { planningPresets } from '../src/mocks/planning-presets';
import { diagnosisPresets, diagnosisSymptoms } from '../src/mocks/diagnosis-presets';
import { initialKnowledgeWorkspace, knowledgeActors, knowledgeModels, knowledgeTypes } from '../src/mocks/knowledge-presets';
import { validateKnowledgeWorkspace } from '../src/services/knowledge-storage';

const storage = new TestStorage();
const mockService = createMockService(() => storage);
const data = await mockService.loadPreview();
const stations = new Map(data.resources.stations.map((item) => [item.id, item]));
const devices = new Map(data.resources.devices.map((item) => [item.id, item]));
const models = new Map(data.resources.models.map((item) => [item.id, item]));

describe('演示数据契约与关联', () => {
  // 新目录关联旧知识身份，原六份样例内容保持不变。
  it('系统初始角色/参数合法且知识身份逐记录完整',()=>{const system=initialSystemWorkspace();expect(()=>validateSystem(system)).not.toThrow();expect(system.accounts.filter(a=>a.id.startsWith('KG-')).map(a=>a.id)).toEqual(['KG-EDITOR','KG-REVIEWER']);const knowledge=initialKnowledgeWorkspace();expect(knowledge.identitySnapshots?.map(s=>s.key).sort()).toEqual(knowledgeIdentityReferences(knowledge).map(r=>r.key).sort());});
  it('独立知识发布基线、审核身份和型号引用一致，旧预览数据仍保留', () => {
    const workspace = initialKnowledgeWorkspace();
    expect(() => validateKnowledgeWorkspace(workspace)).not.toThrow();
    expect(new Set(knowledgeActors.map(a => a.id)).size).toBe(2);
    expect(workspace.versions).toHaveLength(2);
    for (const version of workspace.versions) for (const entity of version.entities) {
      expect(knowledgeTypes.some(t => t.id === entity.type && t.category === entity.category)).toBe(true);
      expect(entity.modelIds.every(id => models.has(id) && knowledgeModels.some(m => m.id === id))).toBe(true);
    }
    expect(data.knowledge.entities).toHaveLength(9);
    expect(data.knowledge.entities.some(e => e.state === '草稿')).toBe(true);
  });
  it('新诊断预设仅引用对应有效网络，影响清单及预设统计一致', () => {
    // 此处只校验静态数据一致性，页面直接读取预设统计。
    for (const preset of diagnosisPresets) {
      const network = planningPresets.find((p) => p.id === preset.networkPresetId)!;
      for (const fault of preset.faults) {
        const objects = fault.objectType === 'DEVICE' ? network.baseline.devices : fault.objectType === 'NODE' ? network.baseline.stations : network.result!.links;
        expect(objects.some((o) => o.id === fault.objectId)).toBe(true);
        expect(fault.symptomIds.every((id) => diagnosisSymptoms.some((s) => s.id === id))).toBe(true);
      }
      const result = preset.result, summary = result.summary!;
      expect(summary.affectedNodeCount).toBe(result.nodes.length);
      expect(summary.directCount).toBe(result.nodes.filter((n) => n.affectType === 'DIRECT').length);
      expect(summary.indirectCount).toBe(result.nodes.filter((n) => n.affectType === 'INDIRECT').length);
      expect(summary.interruptedNodeCount).toBe(result.nodes.filter((n) => n.state === 'INTERRUPTED').length);
      expect(summary.degradedNodeCount).toBe(result.nodes.filter((n) => n.state === 'DEGRADED').length);
      expect(summary.affectedLinkCount).toBe(result.links.length);
      expect(summary.totalBandwidthLossKbps).toBe(result.links.reduce((sum,l) => sum + l.bandwidthLossKbps!,0));
      expect(result.regions.every((r) => r.faultKey && preset.faults.some((f) => r.faultKey === f.objectType + ':' + f.objectId))).toBe(true);
      expect(result.conclusions.every((c) => c.branches.some((b) => b.source === 'ML' && b.confidence === null && !!b.disabledReason))).toBe(true);
    }
  });
  it('独立规划预设的资源、主备路由和设备配置一致，正常路径不含故障设备', () => {
    for (const preset of planningPresets) {
      expect(preset.baseline.stations.every((s) => s.status === 'NORMAL')).toBe(true);
      expect(preset.baseline.devices.every((d) => d.status === 'NORMAL')).toBe(true);
      if (!preset.result) continue;
      const config = preset.result.configuration;
      for (const device of config.devices) {
        const source = devices.get(device.deviceId)!;
        const model = models.get(source.modelId)!;
        expect(device.stationId).toBe(source.stationId);
        expect(device.txPowerDbm).toBeLessThanOrEqual(model.txPowerMaxDbm);
        expect(device.frequencyKhz).toBeGreaterThanOrEqual(model.freqMinKhz);
        expect(device.frequencyKhz).toBeLessThanOrEqual(model.freqMaxKhz);
        expect(config.frequencies.flatMap((f) => f.allocatedKhz)).toContain(device.frequencyKhz);
      }
      for (const link of preset.result.links)
        for (const id of [link.deviceA, link.deviceB])
          expect(config.devices.find((d) => d.deviceId === id)!.frequencyKhz).toBe(
            link.frequencyKhz,
          );
      for (const demand of preset.input.demands)
        expect(config.routes.some((r) => r.demandId === demand.id && !r.backup)).toBe(true);
    }
    expect(data.planning.plans.map((p) => p.metrics.connectivityPercent)).toEqual([86.4, 90.8]);
  });
  it('资源身份唯一，节点/设备/型号/天线关系完整', () => {
    expect(stations.size).toBe(132);
    expect(devices.size).toBe(414);
    expect(stations.size).toBe(data.resources.stations.length);
    expect(devices.size).toBe(data.resources.devices.length);
    for (const station of stations.values()) {
      // 原字段允许多个上级，不能把分号连接的 ID 当作单一节点。
      expect(station.parentIds.every((id) => stations.has(id))).toBe(true);
      expect(station.classes.every((value) => ['HF', 'VUHF'].includes(value))).toBe(true);
      expect(typeof station.relayCapable).toBe('boolean');
      expect(station.coordinate[0]).toBeGreaterThan(114);
      expect(station.coordinate[1]).toBeLessThan(39);
    }
    for (const device of devices.values()) {
      expect(stations.has(device.stationId)).toBe(true);
      expect(models.has(device.modelId)).toBe(true);
      expect(data.resources.antennas.some((item) => item.id === device.antennaId)).toBe(true);
      expect(stations.get(device.stationId)!.classes).toContain(
        models.get(device.modelId)!.deviceClass,
      );
    }
  });
  it('保留空频点；双频节点不产生虚构的混合型号', () => {
    expect(devices.get('DV-0001')!.workFreqKhz).toBeNull();
    expect(stations.get('ND-0003')!.classes).toEqual(['HF', 'VUHF']);
    expect(data.resources.models.every((model) => ['HF', 'VUHF'].includes(model.deviceClass))).toBe(
      true,
    );
  });
  it('告警可附加于正常、故障、离线三类状态', () => {
    const alerted = data.resources.stations.filter((item) => item.alert);
    expect(new Set(alerted.map((item) => item.status))).toEqual(
      new Set(['NORMAL', 'FAULT', 'OFFLINE']),
    );
    expect(data.situation.alerts.every((alert) => stations.get(alert.stationId)?.alert)).toBe(true);
  });
  it('规划链路端点设备与节点一致，候选链路独立', () => {
    for (const link of [
      ...data.situation.links,
      ...data.situation.candidateLinks,
      ...data.planning.plans.flatMap((plan) => plan.links),
    ]) {
      expect(devices.get(link.deviceA)?.stationId).toBe(link.a);
      expect(devices.get(link.deviceB)?.stationId).toBe(link.b);
      for (const deviceId of [link.deviceA, link.deviceB]) {
        const model = models.get(devices.get(deviceId)!.modelId)!;
        expect(model.deviceClass).toBe(link.deviceClass);
        expect(link.frequencyKhz).toBeGreaterThanOrEqual(model.freqMinKhz);
        expect(link.frequencyKhz).toBeLessThanOrEqual(model.freqMaxKhz);
      }
    }
    expect(
      data.situation.candidateLinks.every(
        (candidate) => !data.situation.links.some((link) => link.id === candidate.id),
      ),
    ).toBe(true);
  });
  it('区分任务、异步任务、方案版本、快照；诊断引用有效版本', () => {
    for (const plan of data.planning.plans) {
      expect(plan.taskId).toBe(data.planning.task.id);
      expect(new Set([plan.id, plan.taskId, plan.jobId, plan.snapshotId]).size).toBe(4);
      expect(plan.stationIds.every((id) => stations.has(id))).toBe(true);
      expect(plan.inputSnapshot.stations.map((item) => item.id)).toEqual(plan.stationIds);
      expect(plan.metrics.connectivityPercent).toBeGreaterThan(0);
      expect(plan.metrics.survivabilityPercent).toBeLessThanOrEqual(100);
      expect(plan.metrics.totalRadiatedPowerW).toBeGreaterThan(0);
      for (const link of plan.links) {
        expect(plan.inputSnapshot.devices.find((d) => d.id === link.deviceA)?.stationId).toBe(
          link.a,
        );
        expect(plan.inputSnapshot.devices.find((d) => d.id === link.deviceB)?.stationId).toBe(
          link.b,
        );
      }
      expect(
        plan.links.every(
          (link) => plan.stationIds.includes(link.a) && plan.stationIds.includes(link.b),
        ),
      ).toBe(true);
    }
    expect(new Set(data.diagnosis.cases.map((item) => item.type))).toEqual(
      new Set(['HW_FAILURE', 'LINK_DOWN', 'SW_CONFIG', 'EMI']),
    );
    for (const item of data.diagnosis.cases) {
      const plan = data.planning.plans.find((plan) => plan.id === item.planVersionId)!;
      expect(plan.snapshotId).toBe(item.snapshotId);
      expect(item.branches).toHaveLength(3);
      expect(item.branches.find((branch) => branch.name === '机器学习推理')?.confidence).toBeNull();
      expect(item.stationIds.every((id) => plan.stationIds.includes(id))).toBe(true);
      expect(
        item.deviceIds.every((id) => item.stationIds.includes(devices.get(id)!.stationId)),
      ).toBe(true);
      expect(item.linkIds.every((id) => plan.links.some((link) => link.id === id))).toBe(true);
    }
  });
  it('覆盖保留孔洞，闭合多边形且区分盲区与未计算区', () => {
    const regions = [
      ...data.situation.regions,
      ...data.planning.plans.flatMap((p) => p.regions),
      ...data.diagnosis.cases.flatMap((d) => d.regions),
    ];
    expect(regions.some((region) => region.kind === 'coverage' && region.rings.length > 1)).toBe(
      true,
    );
    expect(regions.some((region) => region.kind === 'blind')).toBe(true);
    expect(regions.some((region) => region.kind === 'uncalculated')).toBe(true);
    for (const region of regions)
      for (const ring of region.rings) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring.at(-1));
        expect(
          ring.every((point) => point[0] > 114 && point[0] < 116 && point[1] > 36 && point[1] < 39),
        ).toBe(true);
      }
  });
  it('知识关系引用存在的实体，账号角色具有对应记录', () => {
    expect(new Set(data.knowledge.entities.map((entity) => entity.category))).toEqual(
      new Set(['设备知识', '网络态势知识', '故障运维知识']),
    );
    for (const relation of data.knowledge.relations) {
      expect(data.knowledge.entities.some((e) => e.id === relation.source)).toBe(true);
      expect(data.knowledge.entities.some((e) => e.id === relation.target)).toBe(true);
    }
    expect(
      data.system.accounts.every((account) =>
        data.system.roles.some((role) => role.name === account.role),
      ),
    ).toBe(true);
  });
  it('重复加载不共享可变数据，不改变原始快照', async () => {
    const copy = await mockService.loadPreview();
    copy.planning.plans[0].name = '临时修改';
    const savedName = copy.planning.plans[0].inputSnapshot.stations[0].name;
    copy.resources.stations[0].name = '上游名称变更';
    expect(copy.planning.plans[0].inputSnapshot.stations[0].name).toBe(savedName);
    expect((await mockService.loadPreview()).planning.plans[0].name).toBe('区域保障方案 A');
  });
  it('演示道路为本地 GeoJSON，包含真实坐标线段', () => {
    const roads = JSON.parse(
      readFileSync(new URL('../public/maps/demo-roads.geojson', import.meta.url), 'utf8'),
    );
    expect(roads.type).toBe('FeatureCollection');
    expect(roads.features.length).toBeGreaterThan(1000);
    expect(roads.features[0].geometry.type).toBe('LineString');
  });
});

// 补充文件保留来源哈希；旧规划快照不会被补齐成当前资源。
describe('第七批来源补充',()=>{
  it('132 节点、414 设备、16 干扰源逐 ID 关联原件，读取不回填历史',()=>{
    for(const [path,hash] of Object.entries(supplement.hashes))expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(hash);
    expect(supplement.stations).toHaveLength(132);expect(supplement.devices).toHaveLength(414);expect(supplement.interferences).toHaveLength(16);
    expect(supplement.stations.every(s=>stations.get(s.id)?.subtype===s.subtype)).toBe(true);
    expect(supplement.devices.every(d=>devices.get(d.id)?.availability==='ACTIVE'&&devices.get(d.id)?.tiltDeg===d.tiltDeg)).toBe(true);
    expect(data.resources.interferences?.map(i=>i.id)).toEqual(supplement.interferences.map(i=>i.id));
    const historical=JSON.parse(readFileSync('src/mocks/planning.json','utf8'));
    expect(data.planning.plans[0].inputSnapshot).toEqual(historical.plans[0].inputSnapshot);
  });
});
