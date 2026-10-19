import { describe, expect, it } from 'vitest';
import { initialResources } from '../src/mocks/resource-presets';
import situation from '../src/mocks/situation.json';
import type { NetworkLink } from '../src/types/domain';
import { buildGisResourceTree, gisCandidateExportIds, gisResourceExportIds, gisSelectedCandidateExportIds } from '../src/services/gis-resource-tree';
import type { CandidateLink } from '../src/types/candidate-link';

// 使用同一演示网络核对资源身份，不自行生成链路结果。
const links = situation.links as NetworkLink[];
describe('GIS 统一资源目录检索', () => {
  it('空搜索保留完整资源和七条规划链路，首尾空白等同空搜索', () => {
    const resources = initialResources(), tree = buildGisResourceTree(resources, links, '  ');
    expect(tree.stations).toEqual(resources.stations); expect(tree.devices).toEqual(resources.devices);
    expect(tree.links).toEqual(links); expect(tree.linkRows.every(row => row.available)).toBe(true);
    expect(tree.stationRows.some(row => row.expanded)).toBe(false);
    expect(tree.linkRows.some(row => row.link.id.startsWith('CL-'))).toBe(false);
  });
  it.each(['id', 'name'] as const)('节点 %s 命中保留所属设备，不扩到相邻站点', key => {
    const resources = initialResources(), target = resources.stations[0];
    const tree = buildGisResourceTree(resources, links, '  ' + target[key].toLowerCase() + '  ');
    expect(tree.stationIds).toEqual([target.id]); expect(tree.devices).toEqual(resources.devices.filter(row => row.stationId === target.id));
    expect(tree.links).toEqual([]); expect(tree.stationRows[0].direct).toBe(true);
  });
  it('设备自身命中只保留本人及父节点，展开不等于父节点直接命中', () => {
    const tree = buildGisResourceTree(initialResources(), links, ' dv-0027 ');
    expect(tree.stationIds).toEqual(['ND-0003']); expect(tree.deviceIds).toEqual(['DV-0027']);
    expect(tree.stationRows[0]).toMatchObject({ direct: false, expanded: true });
    expect(tree.directDeviceIds).toEqual(['DV-0027']); expect(tree.links).toEqual([]);
  });
  it.each(['id', 'name'] as const)('设备型号 %s 匹配每台实例，保持实际归属', key => {
    const resources = initialResources(), model = resources.models[0];
    const tree = buildGisResourceTree(resources, links, model[key]);
    const expected = resources.devices.filter(row => {
      const record = resources.models.find(model => model.id === row.modelId);
      return [row.id, row.modelId, record?.name ?? ''].some(value => value.toLowerCase().includes(model[key].toLowerCase()));
    });
    expect(tree.deviceIds).toEqual(expected.map(row => row.id));
    expect(new Set(tree.stationIds)).toEqual(new Set(expected.map(row => row.stationId)));
    expect(tree.stationRows.every(row => row.expanded)).toBe(true);
  });
  it('链路编号只保留两端必要设备，既不包含邻接链路也不扩为同站全部设备', () => {
    const resources = initialResources(), target = links[0];
    const tree = buildGisResourceTree(resources, links, ' pl-001 ');
    expect(tree.stationIds).toEqual([target.a, target.b]); expect(tree.deviceIds).toEqual([target.deviceA, target.deviceB]);
    expect(tree.links).toEqual([target]); expect(tree.stationRows.every(row => row.expanded && !row.direct)).toBe(true);
    expect(tree.linkRows[0].endpointLabel).toContain(resources.stations.find(row => row.id === target.a)!.name);
    expect(gisResourceExportIds(tree, resources)).toEqual({ nodes: [target.a, target.b], devices: [target.deviceA, target.deviceB], interference_sources: [] });
  });
  it('多类命中合并去重，节点命中允许展示其全部设备', () => {
    const resources = initialResources();
    resources.stations[0].name = '统一命中'; resources.models[0].name = '统一命中'; resources.interferences![0].name = '统一命中';
    const tree = buildGisResourceTree(resources, links, '统一命中');
    expect(new Set(tree.stationIds).size).toBe(tree.stationIds.length); expect(new Set(tree.deviceIds).size).toBe(tree.deviceIds.length);
    expect(resources.devices.filter(row => row.stationId === resources.stations[0].id).every(row => tree.deviceIds.includes(row.id))).toBe(true);
    expect(tree.interferences[0].id).toBe(resources.interferences![0].id);
  });
  it.each(['id', 'name'] as const)('干扰源 %s 匹配不受节点类别和告警限制', key => {
    const resources = initialResources(), source = resources.interferences![0];
    const tree = buildGisResourceTree(resources, links, source[key], '告警');
    expect(tree.interferences).toEqual([source]); expect(tree.stations).toEqual([]); expect(tree.links).toEqual([]);
  });
  it('节点能力和节点告警仍独立于设备类别、设备告警；链路要求两端通过节点条件', () => {
    const resources = initialResources(), target = resources.devices[0], parent = resources.stations.find(row => row.id === target.stationId)!;
    parent.classes = ['VUHF']; parent.alert = false; target.alert = true;
    expect(buildGisResourceTree(resources, links, target.id, 'HF').devices).toEqual([]);
    expect(buildGisResourceTree(resources, links, target.id, '告警').devices).toEqual([]);
    expect(buildGisResourceTree(resources, links, target.id, 'VUHF').devices).toEqual([target]);
    expect(buildGisResourceTree(resources, links, links[0].id, 'HF').links).toEqual([]);
  });
  it('失效链路只读且不可恢复地图结果，错配设备不补入错误端点', () => {
    const resources = initialResources(), stale = buildGisResourceTree(resources, links, 'PL-001', '全部', false);
    expect(stale.links).toEqual([]); expect(stale.linkRows[0]).toMatchObject({ available: false, reason: '资源已有修改，旧链路暂不可用' });
    const broken = { ...links[0], deviceA: links[0].deviceB };
    const invalid = buildGisResourceTree(resources, [broken], broken.id);
    expect(invalid.stationIds).toEqual([]); expect(invalid.deviceIds).toEqual([]); expect(invalid.links).toEqual([]);
    expect(invalid.linkRows[0].available).toBe(false);
    expect(buildGisResourceTree(resources, [{ ...broken, a: 'MISSING' }]).links).toEqual([]);
  });
  it('无匹配为空，不返回默认节点或链路', () => {
    const tree = buildGisResourceTree(initialResources(), links, '完全不存在');
    expect([tree.stations, tree.devices, tree.links, tree.interferences, tree.linkRows]).toEqual([[], [], [], [], []]);
  });
  it('筛选导出只包含已保存对象，新增草稿不会混入且单设备搜索不扩大范围', () => {
    const saved = initialResources(), draft = structuredClone(saved);
    draft.devices.push({ ...draft.devices[0], id: 'DV-NEW' });
    const selected = buildGisResourceTree(draft, links, 'DV-0001');
    expect(gisResourceExportIds(selected, saved)).toEqual({ nodes: ['ND-0001'], devices: ['DV-0001'], interference_sources: [] });
    expect(gisResourceExportIds(buildGisResourceTree(draft, links, 'DV-NEW'), saved).devices).toEqual([]);
    saved.devices[0].stationId = 'ND-0003';
    expect(gisResourceExportIds(selected, saved).devices).toEqual([]);
  });
  it('检索、关联保留和导出均不修改源资源或链路', () => {
    const resources = initialResources(), before = JSON.stringify([resources, links]);
    for (const query of ['', 'ND-0001', 'DV-0001', 'PL-00', '不存在']) {
      gisResourceExportIds(buildGisResourceTree(resources, links, query), resources);
    }
    expect(JSON.stringify([resources, links])).toBe(before);
  });
});

describe('GIS 候选目录与正式网络分离', () => {
  const candidate = (link: NetworkLink, id = link.id): CandidateLink => ({
    id, nodeAId: link.a, nodeBId: link.b, deviceAId: link.deviceA, deviceBId: link.deviceB,
    deviceClass: link.deviceClass, freqKhz: link.frequencyKhz, bandwidthKhz: null, isBackup: false,
    distanceM: null, pathLossDb: null, rxPowerDbm: null, linkMarginDb: null, isAvailable: null, linkState: null,
    assessmentState: 'PENDING', reference: null, source: { kind: 'MANUAL', file: null, row: null },
  });
  it('同编号候选保持独立行与身份，旧结果暂停不暂停候选', () => {
    const resources = initialResources(); resources.candidateLinks = [candidate(links[0])];
    const tree = buildGisResourceTree(resources, links, links[0].id, '全部', false);
    expect(tree.links).toEqual([]); expect(tree.linkRows[0].available).toBe(false);
    expect(tree.candidateLinkIds).toEqual([links[0].id]); expect(tree.candidateLinks).toEqual(resources.candidateLinks);
    expect(tree.candidateRows[0].reason).toBe('');
  });
  it('按编号、端点节点名称和设备检索，候选不扩大旧资源搜索导出范围', () => {
    const resources = initialResources(), row = candidate(links[0], 'CAND-ONLY'); resources.candidateLinks = [row];
    for (const query of [row.id, row.nodeAId, row.nodeBId, row.deviceAId, row.deviceBId,
      resources.stations.find(station => station.id === row.nodeAId)!.name]) {
      expect(buildGisResourceTree(resources, links, ` ${query.toLowerCase()} `).candidateLinks).toEqual([row]);
    }
    const tree = buildGisResourceTree(resources, links, row.id);
    expect(tree.stations).toEqual([]); expect(tree.devices).toEqual([]); expect(tree.links).toEqual([]);
    expect(gisResourceExportIds(tree, resources)).toEqual({ nodes: [], devices: [], interference_sources: [] });
    expect(gisCandidateExportIds(tree, resources)).toEqual({ topology_links: [row.id] });
  });
  it('类别只筛选候选本身，FAULT 参考不进入运行告警筛选', () => {
    const resources = initialResources(), row = candidate(links[0], 'CAND-FAULT');
    row.linkState = 'FAULT'; row.isAvailable = true; resources.candidateLinks = [row];
    expect(buildGisResourceTree(resources, links, '', row.deviceClass).candidateLinks).toEqual([row]);
    expect(buildGisResourceTree(resources, links, '', row.deviceClass === 'HF' ? 'VUHF' : 'HF').candidateRows).toEqual([]);
    expect(buildGisResourceTree(resources, links, '', '告警').candidateRows).toEqual([]);
  });
  it('相同站点的不同设备候选不合并，引用错误仍能查看但不画线', () => {
    const resources = initialResources(), first = candidate(links[0], 'CAND-A'), other = { ...first, id: 'CAND-B',
      deviceAId: resources.devices.find(row => row.stationId === first.nodeAId && row.id !== first.deviceAId
        && resources.models.find(model => model.id === row.modelId)?.deviceClass === first.deviceClass)!.id };
    resources.candidateLinks = [first, other, { ...first, id: 'CAND-BROKEN', deviceAId: 'UNKNOWN' }];
    const tree = buildGisResourceTree(resources, links, 'cand-');
    expect(tree.candidateRows).toHaveLength(3); expect(tree.candidateLinks.map(row => row.id)).toEqual(['CAND-A', 'CAND-B']);
    expect(tree.candidateRows[2]).toMatchObject({ valid: false, reason: '端点或设备归属不完整，请查看并修正配置' });
  });
  it('候选导出范围只含已保存 ID，独立于节点导出且不修改任何输入', () => {
    const saved = initialResources(); saved.candidateLinks = [candidate(links[0], 'CAND-SAVED')];
    const draft = structuredClone(saved); draft.candidateLinks!.push(candidate(links[1], 'CAND-NEW'));
    const before = JSON.stringify([saved, draft]); const tree = buildGisResourceTree(draft, links, 'CAND-');
    expect(gisCandidateExportIds(tree, saved)).toEqual({ topology_links: ['CAND-SAVED'] });
    expect(gisSelectedCandidateExportIds('CAND-NEW', saved)).toEqual({ topology_links: [] });
    expect(gisSelectedCandidateExportIds('CAND-SAVED', saved)).toEqual({ topology_links: ['CAND-SAVED'] });
    expect(Object.keys(gisResourceExportIds(tree, saved))).toEqual(['nodes', 'devices', 'interference_sources']);
    expect(JSON.stringify([saved, draft])).toBe(before);
  });
});

