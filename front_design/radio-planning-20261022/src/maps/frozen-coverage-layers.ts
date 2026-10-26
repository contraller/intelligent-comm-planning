import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle,Fill,Stroke,Style } from 'ol/style';
import type { FrozenCoverageOverlay,FrozenCoverageFeature } from '../types/frozen-coverage';

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
export function frozenCoverageLayer(overlay:FrozenCoverageOverlay,snapshotId:string,planId?:string) {
  const provenance=overlay.result.provenance,selection=overlay.bandwidthSelection;
  const modern=overlay.anchor.engine_version==='V01-5';
  const selectionMatches=['V01-3','V01-4','V01-5'].includes(overlay.anchor.engine_version)
    ?provenance.bandwidth_selection_id===(selection?.selectionId??null)&&provenance.bandwidth_selection_hash===(selection?.selectionHash??null)
    :!selection;
  const features=overlay.anchor.snapshot_id===snapshotId&&(!planId||overlay.anchor.plan_id===planId)
    &&overlay.result.solution_id===snapshotId.slice(4)&&provenance.engine_version===overlay.anchor.engine_version
    &&overlay.result.schema_version===(['V01-4','V01-5'].includes(overlay.anchor.engine_version)?2:1)&&selectionMatches
    ?overlay.result.devices.find(row=>row.device_id===overlay.deviceId&&row.status==='COMPLETE')?.computations.flatMap(part=>part.geojson.features.filter(feature=>feature.geometry&&feature.properties.is_coverage))??[]:[];
  const drawable=modern&&overlay.display==='boundary'?coverageOutline(features):features;
  const source=new VectorSource({features:new GeoJSON().readFeatures({type:'FeatureCollection',features:drawable},{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'})});
  let fieldMin=Infinity,fieldMax=-Infinity;
  for(const feature of features){const value=feature.properties.field_strength_dbuvm;if(typeof value==='number'&&Number.isFinite(value)){fieldMin=Math.min(fieldMin,value);fieldMax=Math.max(fieldMax,value);}}
  const styles=new Map<string,Style>();
  const layer=new VectorLayer({source,zIndex:25,style:feature=>{
    if(modern){
      const mode=overlay.display??'strength',grade=String(feature.get('strength_class'));
      const field=feature.get('field_strength_dbuvm');
      // 热力图按绝对预测场强的本设备显示范围着色，与余量分级视图区分。
      const ramp=typeof field==='number'&&fieldMax>fieldMin?Math.max(0,Math.min(1,(field-fieldMin)/(fieldMax-fieldMin))):0.5;
      const color=mode==='field'?`hsla(${Math.round(50+90*ramp)},75%,${Math.round(62-30*ramp)}%,0.65)`
        :({STRONG:'#176b3b',MEDIUM:'#84cc7a',WEAK:'#f0c541'}[grade]??'#f0c541');
      const key=`${mode}:${color}`;let style=styles.get(key);
      if(!style){style=new Style({fill:mode==='boundary'?undefined:new Fill({color:color.startsWith('#')?color+'99':color}),
        stroke:mode==='boundary'||feature.get('surface_kind')!=='TERRAIN_CELL'?new Stroke({color:mode==='boundary'?'#9be5af':color,width:mode==='boundary'?1.5:0.6}):undefined});styles.set(key,style);}
      return style;
    }
    const margin=feature.get('margin_db'),bucket=typeof margin==='number'?Math.max(0,Math.min(3,Math.floor(margin/10))):-1;
    const key=String(bucket);let style=styles.get(key);
    if(!style){const colors=['#e4b55b','#79cbb4','#48b9cd','#559ee0'],color=bucket<0?'#67bed0':colors[bucket];
      style=new Style({image:new Circle({radius:3,fill:new Fill({color}),stroke:new Stroke({color:'#102538',width:0.5})}),fill:new Fill({color:bucket<0?'#67bed026':'#67bed03a'}),stroke:new Stroke({color,width:1})});styles.set(key,style);
    }return style;
  }});
  layer.set('frozenCoverageSnapshot',snapshotId);return layer;
}
