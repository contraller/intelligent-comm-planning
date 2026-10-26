import { describe,it,expect } from 'vitest';
import { reactive } from 'vue';
import { monitoringPresets } from '../src/mocks/monitoring-presets';
import { monitoringMap } from '../src/maps/monitoring-view';
import { linkLayer,projectCoordinate } from '../src/maps/layers';

// 对实际展示副本和 OpenLayers 要素验证身份、位置，原快照始终不变。
describe('监控地图冻结网络',()=>{
  it.each(monitoringPresets.map(row=>[row.id,row] as const))('%s 图层链路身份及端点一致',(_id,preset)=>{
    const before=JSON.stringify(preset.network),network=reactive(preset.network),frame=preset.frames[2];
    const map=monitoringMap(network,frame),features=linkLayer(map.links,map.stations).getSource()!.getFeatures();
    expect(features).toHaveLength(frame.links.length);
    for(const feature of features){
      const link=map.links.find(row=>row.id===feature.get('objectId'))!;
      expect(link.state).toBe(frame.links.find(row=>row.linkId===link.id)!.state);
      expect(feature.getGeometry()!.getCoordinates()).toEqual([link.a,link.b].map(id=>projectCoordinate(map.stations.find(row=>row.id===id)!.coordinate)));
    }
    expect(JSON.stringify(preset.network)).toBe(before);
  });
  it('重部署使用方案输出坐标；节点状态不被设备故障覆盖',()=>{
    const preset=monitoringPresets.find(row=>row.id==='balanced:NODE_REDEPLOY')!,before=JSON.stringify(preset.network);
    const map=monitoringMap(preset.network,preset.frames[2]);
    expect(map.stations.find(row=>row.id==='ND-0004')!.coordinate).toEqual([114.31,37.26]);
    expect(map.stations.map(row=>row.status)).toEqual(preset.network.stations.map(row=>row.status));
    expect(JSON.stringify(preset.network)).toBe(before);
  });
});
