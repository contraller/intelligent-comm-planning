import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import type { Coordinate, Device, NetworkLink, Station } from '../types/domain';
import type { DiagnosisPropagationPath, DiagnosisRegion, FaultInput } from '../types/diagnosis';
import { projectCoordinate } from './layers';
import { diagnosisFaultVisual } from '../services/diagnosis-display';
import { propagationObjectCoordinate } from '../services/diagnosis-propagation';

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

// 箭头仅连接服务提供的相邻步骤；零长度锚点保留在清单但不绘线。
export function diagnosisPropagationLayer(paths: DiagnosisPropagationPath[], stations: Station[], devices: Device[], links: NetworkLink[]) {
  const features=paths.flatMap(path => {
    const points=path.steps.map(step => propagationObjectCoordinate(step,stations,devices,links)).map(point => point && projectCoordinate(point));
    return points.slice(1).flatMap((b,i) => {
      const a=points[i];if(!a||!b||(a[0]===b[0]&&a[1]===b[1]))return [];
      return [new Feature({geometry:new LineString([a,b]),kind:'diagnosis-propagation',pathId:path.id,faultKey:path.faultKey})];
    });
  });
  return new VectorLayer({source:new VectorSource({features}),style:feature => {
    const [a,b]=(feature.getGeometry() as LineString).getCoordinates(),rotation=Math.atan2(b[1]-a[1],b[0]-a[0]);
    return [new Style({stroke:new Stroke({color:'#8ce4ee',width:3,lineDash:[8,5]}),zIndex:21}),
      new Style({geometry:new Point([a[0]+(b[0]-a[0])*0.7,a[1]+(b[1]-a[1])*0.7]),image:new RegularShape({points:3,radius:7,rotation:Math.PI/2-rotation,fill:new Fill({color:'#8ce4ee'}),stroke:new Stroke({color:'#153a51',width:1})}),zIndex:22})];
  }});
}
