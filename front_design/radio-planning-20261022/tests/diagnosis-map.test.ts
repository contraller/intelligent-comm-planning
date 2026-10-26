import { createSSRApp, reactive } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia, disposePinia } from 'pinia';
import MapCanvas from '../src/components/MapCanvas.vue';
import { configuredStations } from '../src/services/planning-snapshot';
import { interferenceVariants } from '../src/mocks/interference-presets';
import { describe, expect, it } from 'vitest';
import { Style } from 'ol/style';
import { diagnosisFaultLayer, diagnosisObjectCoordinate, diagnosisRegionLayer, diagnosisPropagationLayer } from '../src/maps/diagnosis-layers';
import { diagnosisPresetResult } from '../src/mocks/diagnosis-result-presets';
import { nodeLayer, linkLayer, projectCoordinate } from '../src/maps/layers';
import { planningPresets } from '../src/mocks/planning-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
// 数据层断言与实际浏览器点击/视觉验收分开记录。
describe('诊断地图图层', () => {
  it('传播方向来自有序步骤，零长度锚点不绘线，空输入兼容其他地图', () => {
    const preset=diagnosisPresets[0],paths=diagnosisPresetResult(preset,'diagnosis-demo-2','normal').propagationPaths!,network=planningPresets[0];
    const layer=diagnosisPropagationLayer(paths,network.baseline.stations,network.baseline.devices,network.result!.links),features=layer.getSource()!.getFeatures();
    expect(features).toHaveLength(2);expect(features.every(f=>f.get('pathId')===paths[0].id&&f.get('faultKey')==='DEVICE:DV-0027')).toBe(true);
    const styles=layer.getStyleFunction()!(features[0],1) as Style[];expect(styles).toHaveLength(2);expect(styles[1].getImage()).toBeDefined();
    expect(diagnosisPropagationLayer([],network.baseline.stations,network.baseline.devices,network.result!.links).getSource()!.getFeatures()).toEqual([]);
  });
  const network = planningPresets[0], preset = diagnosisPresets[0];
  it('设备映射到归属节点，链路定位来自真实两端', () => {
    const {stations,devices} = network.baseline; const links = network.result!.links;
    expect(diagnosisObjectCoordinate(preset.faults[0],stations,devices,links)).toEqual(stations.find(n => n.id === 'ND-0003')!.coordinate);
    const link = links[0], a = stations.find(n => n.id === link.a)!, b = stations.find(n => n.id === link.b)!;
    expect(diagnosisObjectCoordinate({objectType:'LINK',objectId:link.id},stations,devices,links)).toEqual([(a.coordinate[0]+b.coordinate[0])/2,(a.coordinate[1]+b.coordinate[1])/2]);
    expect(diagnosisObjectCoordinate({objectType:'DEVICE',objectId:'missing'},stations,devices,links)).toBeNull();
  });
  it('注入符号保留对象类型与稳定 ID，不覆盖真实节点状态', () => {
    const original = structuredClone(network.baseline);
    const layer = diagnosisFaultLayer(preset.faults,network.baseline.stations,network.baseline.devices,network.result!.links);
    const feature = layer.getSource()!.getFeatures()[0]; expect(feature.get('kind')).toBe('diagnosis-fault'); expect(feature.get('objectType')).toBe('DEVICE');
    expect(feature.getGeometry()!.getCoordinates()).toEqual(projectCoordinate(network.baseline.stations.find(n => n.id === 'ND-0003')!.coordinate));
    expect(network.baseline).toEqual(original);
    expect(nodeLayer(original.stations).getSource()!.getSource()!.getFeatures()).toHaveLength(3);
    // 诊断注入标记独立于底层链路；优秀链路沿用共用的 3 px 线宽。
    const links = linkLayer(network.result!.links,original.stations); expect((links.getStyleFunction()!(links.getSource()!.getFeatures()[0],1) as Style).getStroke()!.getWidth()).toBe(3);
  });
  it('影响区域沿用预设环与关联故障，可区分等级', () => {
    const multiple = diagnosisPresets.find(p => p.id === 'balanced:multiple')!;
    const layer = diagnosisRegionLayer(multiple.result.regions); const features = layer.getSource()!.getFeatures();
    expect(features).toHaveLength(2); expect(features[0].getGeometry()!.getCoordinates()[0]).toEqual(multiple.result.regions[0].rings[0].map(projectCoordinate));
    expect(features[0].get('region').faultKey).not.toBe(features[1].get('region').faultKey);
    expect((layer.getStyleFunction()!(features[0],1) as Style).getFill()!.getColor()).not.toBe((layer.getStyleFunction()!(features[1],1) as Style).getFill()!.getColor());
  });
});

it('响应式网络的设备定位跟随规划部署输出，不写回输入', () => {
  const baseline=reactive(structuredClone(planningPresets[0].baseline)), before=JSON.stringify(baseline);
  const config=reactive(interferenceVariants.find(row=>row.id==='balanced:NODE_REDEPLOY')!.result.configuration);
  const stations=configuredStations(baseline.stations,config);
  expect(diagnosisObjectCoordinate({objectType:'DEVICE',objectId:'DV-0037'},stations,baseline.devices,planningPresets[0].result!.links)).toEqual([114.31,37.26]);
  expect(JSON.stringify(baseline)).toBe(before);
});

describe('四类故障注入标记', () => {
  const network = planningPresets[0];
  it('实际地图图例区分四类注入，未传诊断输入时不污染其他页面', async () => {
    // SSR 仅检查真实模板文字；实际画布和鼠标命中仍须浏览器验证。
    const props = {stations:network.baseline.stations,links:network.result!.links};
    const render = async (faults = diagnosisPresets[0].faults) => {
      const pinia = createPinia(), app = createSSRApp(MapCanvas,{...props,diagnosisFaults:faults}); app.use(pinia);
      try { return await renderToString(app); } finally { disposePinia(pinia); }
    };
    const html = await render();
    for (const label of ['硬件故障','链路中断','软件配置异常','电磁干扰']) expect(html).toContain('场景注入 · '+label);
    expect(await render([])).not.toContain('场景注入');
  });
  it.each(['HW_FAILURE','LINK_DOWN','SW_CONFIG','EMI'] as const)('%s 保留精确对象身份和注入文字', type => {
    const input = structuredClone(diagnosisPresets.find(p => p.faults[0].faultType === type)!.faults[0]);
    const layer = diagnosisFaultLayer([input],network.baseline.stations,network.baseline.devices,network.result!.links);
    const f = layer.getSource()!.getFeatures()[0], style = layer.getStyleFunction()!(f,1) as Style;
    expect(f.get('faultType')).toBe(type); expect(f.get('objectId')).toBe(input.objectId); expect(f.get('objectType')).toBe(input.objectType);
    expect(style.getText()!.getText()).toContain('场景注入'); expect(style.getText()!.getText()).toContain(input.objectId);
  });
  it('四类采用不同轮廓和配色，不改变底层网络和影响区域', () => {
    const before = JSON.stringify(network), styles = (['HW_FAILURE','LINK_DOWN','SW_CONFIG','EMI'] as const).map(type => {
      const input = {...diagnosisPresets[0].faults[0],faultType:type};
      const layer = diagnosisFaultLayer([input],network.baseline.stations,network.baseline.devices,network.result!.links);
      return layer.getStyleFunction()!(layer.getSource()!.getFeatures()[0],1) as Style;
    });
    const icons = styles.map(style => style.getImage() as import('ol/style/RegularShape').default);
    expect(new Set(icons.map(icon => [icon.getPoints(),icon.getAngle(),icon.getRadius2()].join('/'))).size).toBe(4);
    expect(new Set(icons.map(icon => icon.getStroke()!.getColor())).size).toBe(4);
    expect(JSON.stringify(network)).toBe(before);
  });
  it('无效归属不伪造位置，空故障层兼容其他地图', () => {
    const f = {...diagnosisPresets[0].faults[0],objectId:'NOT-IN-SNAPSHOT'};
    expect(diagnosisFaultLayer([f],network.baseline.stations,network.baseline.devices,network.result!.links).getSource()!.getFeatures()).toEqual([]);
    expect(diagnosisFaultLayer([],network.baseline.stations,network.baseline.devices,network.result!.links).getSource()!.getFeatures()).toEqual([]);
  });
});
