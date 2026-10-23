import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle,Fill,Stroke,Style,Text } from 'ol/style';
import type { Coordinate,InterferenceSource } from '../types/domain';
import { projectCoordinate } from './layers';

// 仅显示资源点位和取点预览，绝不推算干扰影响范围。
export function interferenceLayer(rows:InterferenceSource[],selectedId=''){
  return new VectorLayer({source:new VectorSource({features:rows.map(row=>new Feature({geometry:new Point(projectCoordinate(row.coordinate)),kind:'interference-source',objectId:row.id,source:row}))}),
    style:feature=>{const row=feature.get('source') as InterferenceSource;return new Style({
      image:new Circle({radius:row.id===selectedId?9:6,fill:new Fill({color:row.active?'#e4a859':'#6b7c91'}),stroke:new Stroke({color:row.id===selectedId?'#ffffff':'#462e24',width:2})}),
      text:row.id===selectedId?new Text({text:row.name+' · 干扰源',offsetY:-20,fill:new Fill({color:'#ffda9d'}),backgroundFill:new Fill({color:'#162238'}),padding:[4,4,4,4]}):undefined,zIndex:20,
    });}});
}
export function resourcePickLayer(point?:Coordinate){
  return new VectorLayer({source:new VectorSource({features:point?[new Feature({geometry:new Point(projectCoordinate(point)),kind:'resource-pick'})]:[]}),
    style:new Style({image:new Circle({radius:10,stroke:new Stroke({color:'#fff',width:2,lineDash:[3,3]}),fill:new Fill({color:'#ffffff22'})}),text:new Text({text:'未应用位置',offsetY:20,fill:new Fill({color:'#ffffff'})}),zIndex:30})});
}
