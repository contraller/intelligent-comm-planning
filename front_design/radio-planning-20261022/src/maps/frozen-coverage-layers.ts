import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle,Fill,Stroke,Style } from 'ol/style';
import type { FrozenCoverageOverlay } from '../types/frozen-coverage';

// 原生采样点不是等值面；HF静区和不可显示几何均不当成覆盖填色。
export function frozenCoverageLayer(overlay:FrozenCoverageOverlay,snapshotId:string,planId?:string) {
  const provenance=overlay.result.provenance,selection=overlay.bandwidthSelection;
  const selectionMatches=['V01-3','V01-4'].includes(overlay.anchor.engine_version)
    ?provenance.bandwidth_selection_id===(selection?.selectionId??null)&&provenance.bandwidth_selection_hash===(selection?.selectionHash??null)
    :!selection;
  const features=overlay.anchor.snapshot_id===snapshotId&&(!planId||overlay.anchor.plan_id===planId)
    &&overlay.result.solution_id===snapshotId.slice(4)&&provenance.engine_version===overlay.anchor.engine_version
    &&overlay.result.schema_version===(overlay.anchor.engine_version==='V01-4'?2:1)&&selectionMatches
    ?overlay.result.devices.find(row=>row.device_id===overlay.deviceId&&row.status==='COMPLETE')?.computations.flatMap(part=>part.geojson.features.filter(feature=>feature.geometry&&feature.properties.is_coverage))??[]:[];
  const source=new VectorSource({features:new GeoJSON().readFeatures({type:'FeatureCollection',features},{dataProjection:'EPSG:4326',featureProjection:'EPSG:3857'})});
  const styles=new Map<string,Style>();
  const layer=new VectorLayer({source,zIndex:25,style:feature=>{
    const margin=feature.get('margin_db'),bucket=typeof margin==='number'?Math.max(0,Math.min(3,Math.floor(margin/10))):-1;
    const key=String(bucket);let style=styles.get(key);
    if(!style){const colors=['#e4b55b','#79cbb4','#48b9cd','#559ee0'],color=bucket<0?'#67bed0':colors[bucket];
      style=new Style({image:new Circle({radius:3,fill:new Fill({color}),stroke:new Stroke({color:'#102538',width:0.5})}),fill:new Fill({color:bucket<0?'#67bed026':'#67bed03a'}),stroke:new Stroke({color,width:1})});styles.set(key,style);
    }return style;
  }});
  layer.set('frozenCoverageSnapshot',snapshotId);return layer;
}
