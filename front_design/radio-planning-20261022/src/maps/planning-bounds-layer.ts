import Feature from 'ol/Feature';
import Polygon from 'ol/geom/Polygon';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style, Text } from 'ol/style';
import { fromLonLat } from 'ol/proj';
import { getDistance } from 'ol/sphere';

// 沿用 data/raw/dem/dem_current.json 的 planning_bbox（约 120 km × 120 km）。
// 只约束前端地图显示，不改变任务范围、资源坐标或后端计算范围。
export const MAP_DISPLAY_BOUNDS = [
  113.37497663855423, 36.461013295002346, 114.72474558374593, 37.53898670499157,
] as const;

export function planningBounds(value:readonly number[]|null|undefined) {
  if(!value||value.length!==4||!value.every(Number.isFinite))return null;
  const [w,s,e,n]=value;if(w < -180||e > 180||s < -90||n > 90||w>=e||s>=n)return null;
  // 尺寸采用地理距离，不把墨卡托平面距离当作地面公里数。
  const widthKm=getDistance([w,(s+n)/2],[e,(s+n)/2])/1000;
  const heightKm=getDistance([(w+e)/2,s],[(w+e)/2,n])/1000;
  if(!Number.isFinite(widthKm)||!Number.isFinite(heightKm)||widthKm<=0||heightKm<=0)return null;
  // 主标注采用地图尺度适合的有效位数；细值保留，不能给其他范围硬贴120km。
  const dimension=(km:number)=>km>=10?String(Math.round(km)):km.toFixed(1);
  const target=Math.max(widthKm,heightKm)/6,power=10**Math.floor(Math.log10(target));
  const gridStepKm=[1,2,5,10].map(value=>value*power).find(value=>value>=target)!;
  return {bbox:[w,s,e,n] as [number,number,number,number],widthKm,heightKm,gridStepKm,
    widthLabel:`约 ${dimension(widthKm)} km`,heightLabel:`约 ${dimension(heightKm)} km`,
    label:`规划区域约 ${dimension(widthKm)} km × ${dimension(heightKm)} km`,detailLabel:`地理距离估算 ${widthKm.toFixed(1)} km × ${heightKm.toFixed(1)} km`};
}
/** @deprecated 地图已直接限制展示范围，页面不再使用尺寸线、边框和参考网格。 */
export function planningBoundsLayer(value:readonly number[]|null|undefined){
  const bounds=planningBounds(value);const features:Feature[]=[];
  if(bounds){
    const [w,s,e,n]=bounds.bbox,dx=(e-w)*0.04,dy=(n-s)*0.04;
    const feature=new Feature({geometry:new Polygon([[[w,s],[e,s],[e,n],[w,n],[w,s]].map(p=>fromLonLat(p))]),kind:'planning-bounds'});
    feature.setStyle(new Style({stroke:new Stroke({color:'#66cee6',width:1.5,lineDash:[10,6]}),fill:new Fill({color:'#3294c306'})}));features.push(feature);
    const line=(coordinates:number[][],kind:string,color:string,width=1,extra:Record<string,unknown>={})=>{
      const item=new Feature({geometry:new LineString(coordinates.map(p=>fromLonLat(p))),kind,...extra});
      item.setStyle(new Style({stroke:new Stroke({color,width})}));features.push(item);
    };
    const label=(coordinate:number[],text:string,extra:Record<string,unknown>={},rotation=0,offsetY=0)=>{
      const item=new Feature({geometry:new Point(fromLonLat(coordinate)),kind:'planning-dimension-label',...extra});
      item.setStyle(new Style({text:new Text({text,font:'12px Microsoft YaHei',rotation,offsetY,fill:new Fill({color:'#c7f1ff'}),backgroundFill:new Fill({color:'#0c1b2de8'}),padding:[3,6,3,6],overflow:true})}));features.push(item);
    };
    // 尺寸线和刻度始终绑定冻结地理范围，不用屏幕宽高或缩放级别冒充公里数。
    line([[w,n+dy],[e,n+dy]],'planning-dimension','#8bd8ec',1.3,{axis:'east-west',distanceKm:bounds.widthKm});
    line([[w-dx,s],[w-dx,n]],'planning-dimension','#8bd8ec',1.3,{axis:'north-south',distanceKm:bounds.heightKm});
    for(const x of [w,e])line([[x,n+dy*0.5],[x,n+dy*1.5]],'planning-dimension-tick','#8bd8ec');
    for(const y of [s,n])line([[w-dx*1.5,y],[w-dx*0.5,y]],'planning-dimension-tick','#8bd8ec');
    label([(w+e)/2,n+dy],`东西 ${bounds.widthLabel}`,{axis:'east-west'},0,-13);
    label([w-dx,(s+n)/2],`南北 ${bounds.heightLabel}`,{axis:'north-south'},-Math.PI/2,-14);
    for(let km=bounds.gridStepKm;km<bounds.widthKm;km+=bounds.gridStepKm){
      const x=w+(e-w)*km/bounds.widthKm;
      line([[x,s],[x,n]],'planning-grid','#91d5e32b',0.8,{axis:'east-west',distanceKm:km});
      label([x,s],`${Number(km.toPrecision(3))}`,{axis:'east-west',distanceKm:km},0,13);
    }
    for(let km=bounds.gridStepKm;km<bounds.heightKm;km+=bounds.gridStepKm){
      const y=s+(n-s)*km/bounds.heightKm;
      line([[w,y],[e,y]],'planning-grid','#91d5e32b',0.8,{axis:'north-south',distanceKm:km});
    }
  }
  return new VectorLayer({source:new VectorSource({features}),zIndex:8});
}
