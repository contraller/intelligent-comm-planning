import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import type { Coordinate, Device, NetworkLink, Station } from '../types/domain';
import type { DiagnosisRegion, FaultInput } from '../types/diagnosis';
import { projectCoordinate } from './layers';
import { diagnosisFaultVisual } from '../services/diagnosis-display';

// 链路中点仅用于图标定位，不代表计算得到的故障位置或影响范围。
export function diagnosisObjectCoordinate(target: Pick<FaultInput,'objectType'|'objectId'>, stations: Station[], devices: Device[], links: NetworkLink[]): Coordinate | null {
  if (target.objectType === 'NODE') return stations.find((n) => n.id === target.objectId)?.coordinate ?? null;
  if (target.objectType === 'DEVICE') return stations.find((n) => n.id === devices.find((d) => d.id === target.objectId)?.stationId)?.coordinate ?? null;
  const link = links.find((l) => l.id === target.objectId);
  const a = stations.find((n) => n.id === link?.a), b = stations.find((n) => n.id === link?.b);
  return a && b ? [(a.coordinate[0]+b.coordinate[0])/2,(a.coordinate[1]+b.coordinate[1])/2] : null;
}
export function diagnosisFaultLayer(faults: FaultInput[], stations: Station[], devices: Device[], links: NetworkLink[]) {
  return new VectorLayer({
    source:new VectorSource({features:faults.flatMap((fault) => {
      const coordinate = diagnosisObjectCoordinate(fault,stations,devices,links);
      return coordinate ? [new Feature({geometry:new Point(projectCoordinate(coordinate)),kind:'diagnosis-fault',objectType:fault.objectType,objectId:fault.objectId,faultType:fault.faultType})] : [];
    })}),
    // 标记沿用原位置和点击身份，只以独立轮廓、文字及配色区分注入类型。
    style:(feature) => {
      const visual = diagnosisFaultVisual(feature.get('faultType'));
      return new Style({ image:new RegularShape({points:visual.points,angle:visual.angle,radius2:visual.radius2,radius:12,
        fill:new Fill({color:'#211b37'}),stroke:new Stroke({color:visual.color,width:2})}),
        text:new Text({text:`场景注入 · ${visual.glyph} ${visual.label}\n${feature.get('objectId')}`,offsetY:29,font:'11px Microsoft YaHei',
          fill:new Fill({color:visual.color}),backgroundFill:new Fill({color:'#201433ee'}),padding:[3,5,3,5]}),zIndex:30 });
    },
  });
}
export function diagnosisRegionLayer(regions: DiagnosisRegion[]) {
  const colors = {SEVERE:['#e770854d','#ef8799'],MODERATE:['#eeb44f4d','#efc16b'],MINOR:['#58a9ca40','#72c5df']};
  return new VectorLayer({source:new VectorSource({features:regions.map((r) => new Feature({geometry:new Polygon(r.rings.map((ring) => ring.map(projectCoordinate))),region:r,kind:'diagnosis-impact',objectId:r.id}))}),style:(feature) => {
    const region = feature.get('region') as DiagnosisRegion;
    const [fill,stroke] = region.level ? colors[region.level] : ['#93a0b340','#b8c4d5'];
    return new Style({fill:new Fill({color:fill}),stroke:new Stroke({color:stroke,width:1.5,lineDash:[7,4]})});
  }});
}
