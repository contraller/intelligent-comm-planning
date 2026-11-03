import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle,Fill,Stroke,Style,Text } from 'ol/style';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { projectCoordinate } from './layers';
import { isLocalTerrainCell } from '../services/frozen-coverage-decode';
import { coverageIsolines } from './frozen-coverage-contours';
import type { FrozenCoverageOverlay,FrozenCoverageFeature,FrozenCoverageDevice,FrozenCoverageGrid } from '../types/frozen-coverage';

export const coverageFieldRamp='linear-gradient(to right,#76a6bb,#11425d)';
// 场强数值由等值线标注表达；图例和地图共用线色，底图不随覆盖模式变色。
export const coverageLineColors={field:'#62d3e5',threshold:'#ffad66'} as const;
export function coverageFrequencies(device:FrozenCoverageDevice|undefined){return [...new Set(device?.computations.map(p=>p.freq_khz)??[])].sort((a,b)=>a-b);}
export function coverageFrequency(device:FrozenCoverageDevice|undefined,preferred?:number|null){const values=coverageFrequencies(device);return preferred!=null&&values.includes(preferred)?preferred:values[0];}
export function coverageTerrainMark(feature:FrozenCoverageFeature,band:string|null){
  // 非通视仍可能达标；短波天波不能用直线LOS代替地形增量。
  return band==='HF'?(typeof feature.properties.terrain_loss_db==='number'&&feature.properties.terrain_loss_db>0?'地形附加损耗':null)
    :band==='VUHF'&&feature.properties.los===false?'非通视':null;
}
export function coverageFieldColor(value:number,min:number,max:number){const t=max>min?Math.max(0,Math.min(1,(value-min)/(max-min))):0.5;return `rgb(${Math.round(118-101*t)},${Math.round(166-100*t)},${Math.round(187-94*t)})`;}
const scaleCache=new WeakMap<FrozenCoverageOverlay['result'],{min:number;max:number;levels:number[]}>();
export function coverageFieldScale(result:FrozenCoverageOverlay['result']){
  const cached=scaleCache.get(result);if(cached)return cached;
  let min=Infinity,max=-Infinity;
  for(const device of result.devices)for(const part of device.computations){
    const values=part.sampling_grid?.samples.map(s=>s[2])??part.geojson.features.filter(f=>f.geometry&&f.properties.is_coverage).map(f=>f.properties.field_strength_dbuvm);
    for(const value of values)if(typeof value==='number'&&Number.isFinite(value)){min=Math.min(min,value);max=Math.max(max,value);}
  }
  if(!Number.isFinite(min)){min=0;max=100;}
  const step=20*Math.max(1,Math.ceil((max-min)/200));min=Math.floor(min/step)*step;max=Math.max(min+step,Math.ceil(max/step)*step);
  const scale={min,max,levels:Array.from({length:Math.round((max-min)/step)+1},(_,i)=>min+i*step)};scaleCache.set(result,scale);return scale;
}

// 消去相邻格/色带的共享边，保留盲区内孔；不使用凸包或圆形补面。
export function coverageOutline(features:readonly FrozenCoverageFeature[]){
  const edges=new Map<string,{coordinates:number[][];properties:FrozenCoverageFeature['properties'];count:number}>();
  const polygons=new Set<string>();
  const pointKey=(point:number[])=>point.map(v=>v.toFixed(9)).join(',');
  for(const feature of features){
    if(feature.geometry?.type!=='Polygon')continue;
    const polygonKey=JSON.stringify(feature.geometry.coordinates.map(ring=>ring.map(pointKey)));
    if(polygons.has(polygonKey))continue;polygons.add(polygonKey);
    for(const ring of feature.geometry.coordinates){
      for(let i=1;i<ring.length;i++){
        const a=ring[i-1]!,b=ring[i]!,key=[pointKey(a),pointKey(b)].sort().join('|');
        const existing=edges.get(key);
        if(existing)existing.count++;else edges.set(key,{coordinates:[a,b],properties:feature.properties,count:1});
      }
    }
  }
  return [...edges.values()].filter(edge=>edge.count===1).map(edge=>({type:'Feature',properties:edge.properties,
    geometry:{type:'LineString',coordinates:edge.coordinates}}));
}

// 原生采样点不是等值面；HF静区和不可显示几何均不当成覆盖填色。
function selectedCoverageDevice(overlay:FrozenCoverageOverlay,snapshotId:string,planId?:string) {
  const provenance=overlay.result.provenance,selection=overlay.bandwidthSelection;
  const selectionMatches=['V01-3','V01-4','V01-5','V01-6'].includes(overlay.anchor.engine_version)
    ?provenance.bandwidth_selection_id===(selection?.selectionId??null)&&provenance.bandwidth_selection_hash===(selection?.selectionHash??null)
    :!selection;
  return overlay.anchor.snapshot_id===snapshotId&&(!planId||overlay.anchor.plan_id===planId)
    &&overlay.result.solution_id===snapshotId.slice(4)&&provenance.engine_version===overlay.anchor.engine_version
    &&overlay.result.schema_version===(['V01-4','V01-5','V01-6'].includes(overlay.anchor.engine_version)?2:1)&&selectionMatches
    ?overlay.result.devices.find(row=>row.device_id===overlay.deviceId&&row.status==='COMPLETE'):undefined;
}

// 查看和绘图共用频点、DEM及半径筛选，不把不同频点合并成一个结果。
export function frozenCoverageView(overlay:FrozenCoverageOverlay){
  const device=selectedCoverageDevice(overlay,overlay.anchor.snapshot_id,overlay.anchor.plan_id);
  const parts=device?.computations.filter(p=>overlay.frequencyKhz===undefined||p.freq_khz===overlay.frequencyKhz)??[];
  const features=parts.flatMap(p=>p.geojson.features.filter(f=>f.geometry&&f.properties.is_coverage
    &&(overlay.anchor.engine_version!=='V01-6'||p.shape==='CELLS'&&isLocalTerrainCell(f,device!,overlay.result.provenance.parameters,overlay.result.provenance.dem_bbox))));
  const grid=parts.length===1?parts[0]!.sampling_grid:undefined;
  let min=Infinity,max=-Infinity;for(const value of grid?grid.samples.map(s=>s[2]):features.map(f=>f.properties.field_strength_dbuvm)){if(typeof value==='number'&&Number.isFinite(value)){min=Math.min(min,value);max=Math.max(max,value);}}
  const evaluated=parts.length&&parts.every(p=>Number.isSafeInteger(p.evaluated_samples))?parts.reduce((n,p)=>n+p.evaluated_samples!,0):undefined;
  const threshold=overlay.result.provenance.parameters.margin_min_db;
  const boundaryStatus=!grid?'完整采样未提供，请刷新覆盖结果':!grid.samples.length?'本次无有效采样':grid.samples.every(s=>s[3]>=threshold)?'本次采样内未出现覆盖边界':grid.samples.every(s=>s[3]<threshold)?'本次采样均未达标':'';
  return {device,features,min,max,evaluated,grid,boundaryStatus};
}

let referencePattern:CanvasPattern|undefined;
function terrainPattern(){
  if(referencePattern)return referencePattern;
  if(typeof document==='undefined'||typeof document.createElement!=='function')return;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
  const context=canvas.getContext?.('2d');if(!context)return;
  context.strokeStyle='rgba(244,249,255,0.65)';context.lineWidth=1.2;
  context.beginPath();context.moveTo(-4,16);context.lineTo(16,-4);context.moveTo(8,20);context.lineTo(20,8);context.stroke();
  referencePattern=context.createPattern(canvas,'repeat')??undefined;return referencePattern;
}

export function frozenCoverageDeviceLayer(overlay:FrozenCoverageOverlay,snapshotId:string,planId?:string) {
  const device=selectedCoverageDevice(overlay,snapshotId,planId);
  const features:Feature[]=[];
  if(device&&Number.isFinite(device.lon)&&Number.isFinite(device.lat)) {
    const marker=new Feature({geometry:new Point(projectCoordinate([device.lon,device.lat])),kind:'frozen-coverage-device',objectId:device.node_id,deviceId:device.device_id});
    marker.setStyle(new Style({image:new Circle({radius:6,fill:new Fill({color:'#173e4d'}),stroke:new Stroke({color:'#fff',width:2})}),
      text:new Text({text:device.device_id,offsetX:15,offsetY:-14,textAlign:'left',font:'12px Microsoft YaHei',fill:new Fill({color:'#173e4d'}),backgroundFill:new Fill({color:'#f6fafcee'}),padding:[3,5,3,5]})}));
    features.push(marker);
  }
  return new VectorLayer({source:new VectorSource({features}),zIndex:75});
}

const contourCache=new WeakMap<FrozenCoverageOverlay['result'],Map<string,{grid:FrozenCoverageGrid;lines:ReturnType<typeof coverageIsolines>;boundary:ReturnType<typeof coverageIsolines>}>>();
function displayContours(overlay:FrozenCoverageOverlay,grid:FrozenCoverageGrid){
  let cache=contourCache.get(overlay.result);if(!cache){cache=new Map();contourCache.set(overlay.result,cache);}
  const key=JSON.stringify([overlay.deviceId,overlay.frequencyKhz]),previous=cache.get(key);
  // 同一冻结结果使用统一绝对刻度；切设备不重新拉伸色标，悬停不重建等值线。
  if(previous?.grid===grid)return previous;
  const contours={grid,lines:coverageIsolines(grid,coverageFieldScale(overlay.result).levels,2),boundary:coverageIsolines(grid,[overlay.result.provenance.parameters.margin_min_db],3)};cache.set(key,contours);
  if(cache.size>16)cache.delete(cache.keys().next().value!);
  return contours;
}
export function frozenCoverageSamples(layer:ReturnType<typeof frozenCoverageLayer>):VectorSource {
  return layer.get('coverageSamples') as VectorSource;
}
function gridFeatures(grid:FrozenCoverageGrid,device:FrozenCoverageDevice,frequency:number,threshold:number):FrozenCoverageFeature[]{
  const dx=grid.cell_m/(111320*Math.cos(grid.origin[1]*Math.PI/180)),dy=grid.cell_m/111320;
  return grid.samples.map(([gx,gy,field,margin,loss,clearance,los])=>{
    const x=grid.origin[0]+gx*dx,y=grid.origin[1]+gy*dy;
    return {type:'Feature',geometry:{type:'Polygon',coordinates:[[[x-dx/2,y-dy/2],[x+dx/2,y-dy/2],[x+dx/2,y+dy/2],[x-dx/2,y+dy/2],[x-dx/2,y-dy/2]]]},properties:{device_id:device.device_id,node_id:device.node_id,freq_khz:frequency,gx,gy,surface_kind:'TERRAIN_CELL',field_strength_dbuvm:field,margin_db:margin,is_coverage:margin>=threshold,strength_class:margin>=20?'STRONG':margin>=10?'MEDIUM':'WEAK',...(loss!==null?{terrain_loss_db:loss}:{}),...(clearance!==null?{clearance_m:clearance}:{}),...(los!==null?{los}: {})}};
  });
}

export function frozenCoverageLayer(overlay:FrozenCoverageOverlay,snapshotId:string,planId?:string) {
  const modern=['V01-5','V01-6'].includes(overlay.anchor.engine_version),local=overlay.anchor.engine_version==='V01-6';
  const device=selectedCoverageDevice(overlay,snapshotId,planId);
  const view=frozenCoverageView(overlay),features=device?view.features:[],grid=device?view.grid:undefined;
  const read=(items:unknown[])=>new GeoJSON().readFeatures({type:'FeatureCollection',features:items},{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'});
  const raw=grid?gridFeatures(grid,device!,overlay.frequencyKhz??device!.computations[0]!.freq_khz,overlay.result.provenance.parameters.margin_min_db):features;
  const samples=new VectorSource({features:read(raw)});
  const isolineMode=local&&['field','boundary'].includes(overlay.display??'');
  const contours=isolineMode&&grid?displayContours(overlay,grid):null;
  const drawable=isolineMode?[
    ...overlay.display==='field'?(contours?.lines??[]).map(line=>({type:'Feature',properties:{kind:'frozen-coverage-isoline',display_field:line.value},geometry:{type:'LineString',coordinates:line.coordinates}})):[],
    ...(contours?.boundary??[]).map(line=>({type:'Feature',properties:{kind:'frozen-coverage-threshold'},geometry:{type:'LineString',coordinates:line.coordinates}})),
    ...overlay.display==='field'&&overlay.terrainReference?raw.flatMap(feature=>coverageTerrainMark(feature,device?.band??null)?[{type:'Feature',properties:{kind:'frozen-coverage-terrain'},geometry:feature.geometry}]:[]):[],
  ]:modern&&overlay.display==='boundary'?coverageOutline(features):grid?features:null;
  const source=drawable?new VectorSource({features:read(drawable)}):samples;
  // 每个格面的命中身份来自本次实际图层；边界线不冒充格面中心。
  if(local)samples.getFeatures().forEach(feature=>feature.setProperties({kind:'frozen-coverage-cell',snapshot:snapshotId,planId:overlay.anchor.plan_id,deviceId:overlay.deviceId}));
  let fieldMin=Infinity,fieldMax=-Infinity;
  for(const feature of features){const value=feature.properties.field_strength_dbuvm;if(typeof value==='number'&&Number.isFinite(value)){fieldMin=Math.min(fieldMin,value);fieldMax=Math.max(fieldMax,value);}}
  const styles=new Map<string,Style|Style[]>();
  const layer=new VectorLayer({source,zIndex:25,style:feature=>{
    if(isolineMode){
      const kind=feature.get('kind'),field=feature.get('display_field'),key=`${kind}:${field??''}`;
      let style=styles.get(key);
      if(!style){
        if(kind==='frozen-coverage-threshold')style=new Style({stroke:new Stroke({color:coverageLineColors.threshold,width:2.6})});
        else if(kind==='frozen-coverage-terrain'){const pattern=terrainPattern();style=pattern?new Style({fill:new Fill({color:pattern})}):[];}
        else style=new Style({stroke:new Stroke({color:coverageLineColors.field,width:1.8}),text:new Text({text:String(field),placement:'line',font:'11px Microsoft YaHei',fill:new Fill({color:'#d9faff'}),stroke:new Stroke({color:'#183841',width:3})})});
        styles.set(key,style);
      }
      return style;
    }
    if(modern){
      const mode=overlay.display??'strength',grade=String(feature.get('strength_class'));
      const field=feature.get('field_strength_dbuvm');
      // 热力图按绝对预测场强的本设备显示范围着色，与余量分级视图区分。
      const ramp=typeof field==='number'&&fieldMax>fieldMin?Math.max(0,Math.min(1,(field-fieldMin)/(fieldMax-fieldMin))):0.5;
      const color=mode==='field'?(overlay.frequencyKhz!==undefined?coverageFieldColor(field,fieldMin,fieldMax):`hsla(${Math.round(28+112*ramp)},75%,${Math.round(62-30*ramp)}%,0.65)`)
        :({STRONG:'#22a05a',MEDIUM:'#f0c541',WEAK:'#ee8735'}[grade]??'#ee8735');
      const mark=local&&overlay.terrainReference&&mode!=='boundary'&&device?coverageTerrainMark({properties:feature.getProperties()} as FrozenCoverageFeature,device.band):null;
      const key=`${mode}:${color}:${mark??''}`;let style=styles.get(key);
      if(!style){style=new Style({fill:mode==='boundary'?undefined:new Fill({color:color.startsWith('#')?color+'99':color}),
        stroke:mode==='boundary'||feature.get('surface_kind')!=='TERRAIN_CELL'?new Stroke({color:mode==='boundary'?'#9be5af':color,width:mode==='boundary'?1.5:0.6}):undefined});
        const pattern=mark?terrainPattern():undefined;if(pattern)style=[style,new Style({fill:new Fill({color:pattern})})];styles.set(key,style);}
      return style;
    }
    const margin=feature.get('margin_db'),bucket=typeof margin==='number'?Math.max(0,Math.min(3,Math.floor(margin/10))):-1;
    const key=String(bucket);let style=styles.get(key);
    if(!style){const colors=['#e4b55b','#79cbb4','#48b9cd','#559ee0'],color=bucket<0?'#67bed0':colors[bucket];
      style=new Style({image:new Circle({radius:3,fill:new Fill({color}),stroke:new Stroke({color:'#102538',width:0.5})}),fill:new Fill({color:bucket<0?'#67bed026':'#67bed03a'}),stroke:new Stroke({color,width:1})});styles.set(key,style);
    }return style;
  }});
  layer.set('frozenCoverageSnapshot',snapshotId);layer.set('coverageSamples',samples);return layer;
}
