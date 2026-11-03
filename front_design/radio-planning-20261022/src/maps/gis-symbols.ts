import Icon from 'ol/style/Icon';
export type GisSymbol = 'fixed-station'|'communication-vehicle'|'manpack'|'radio'|'interference-source'|'node-generic';
export function gisNodeSymbol(node: {mobility?:string|null;node_role?:string|null;node_subtype?:string|null}): GisSymbol {
  if(node.mobility==='VEHICLE')return 'communication-vehicle';
  if(node.mobility==='MANPACK')return 'manpack';
  if(node.mobility==='FIXED')return 'fixed-station';
  return 'node-generic';
}
export function gisSymbol(kind:GisSymbol,active=false,color='#64cabb'){return new Icon({src:`${import.meta.env.BASE_URL}icons/gis/${kind}.svg`,size:[40,40],scale:active?0.8:0.65,color,declutterMode:'none'});}
