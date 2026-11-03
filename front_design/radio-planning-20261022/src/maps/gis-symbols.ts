import { Icon } from 'ol/style';
export type GisSymbol='node-generic'|'radio'|'fixed-station'|'communication-vehicle'|'manpack'|'interference-source';
export function stationSymbol(station:{mobility?:string;subtype?:string}):GisSymbol{
  if(station.mobility==='VEHICLE')return 'communication-vehicle';
  if(station.mobility==='MANPACK')return 'manpack';
  if(station.mobility==='FIXED')return 'fixed-station';
  return 'node-generic';
}
// 对象类型由符号表达，颜色留给状态；缺失类型不从名称或型号猜测。
export function gisSymbol(kind:GisSymbol,color:string,selected=false,opacity=1){
  return new Icon({src:`${import.meta.env.BASE_URL}icons/gis/${kind}.svg`,color,size:[40,40],scale:selected?0.85:0.675,opacity,declutterMode:'none'});
}
