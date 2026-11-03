import { describe,expect,it } from 'vitest';
import Feature from 'ol/Feature';
import { getDistance } from 'ol/sphere';
import example from '../src/config/gis-situation-example.json';
import { readGisNetwork } from '../src/services/gis-plan-validation';
import { gisHoverSummary } from '../src/maps/gis-hover';
import { gisNodeSymbol } from '../src/maps/gis-symbols';
import { SITUATION_AREA_BOUNDS } from '../src/maps/situation-area';
import { LINK_STATUS_STYLES } from '../src/config/link-status';

describe('便携基线只读态势地图',()=>{
  it('冻结节点悬浮只显示本快照参数，旧快照同名点不能借用新资料',()=>{
    const network=readGisNetwork(example.network,{planId:example.network.identity.plan_id,taskId:example.network.identity.task_id});
    const node=network.nodes.find(n=>network.devices.some(d=>d.station_id===n.id))!;
    const input={context:{key:network.identity.snapshot_id,source:'受控示例',models:example.models},stations:[],frozenNetwork:network};
    const feature=new Feature({kind:'frozen-plan-node',objectId:node.id,snapshot:network.identity.snapshot_id});
    const summary=gisHoverSummary(feature,input)!;
    expect(summary.rows.find(r=>r.label==='节点编号')?.value).toBe(node.id);
    expect(summary.rows.some(r=>r.value.includes('kHz')&&r.value.includes('dBm'))).toBe(true);
    expect(summary.deviceIds).toEqual(network.devices.filter(d=>d.station_id===node.id).map(d=>d.id));
    feature.set('snapshot','SNP-OTHER');expect(gisHoverSummary(feature,input)).toBeNull();
    expect(network.nodes.every(n=>n.status===null)).toBe(true);
  });
  it('分类符号只取明确平台信息，未知平台不当作车辆',()=>{
    expect(gisNodeSymbol({mobility:'VEHICLE'})).toBe('communication-vehicle');
    expect(gisNodeSymbol({mobility:'MANPACK'})).toBe('manpack');
    expect(gisNodeSymbol({mobility:'FIXED'})).toBe('fixed-station');
    expect(gisNodeSymbol({node_subtype:'UNKNOWN'})).toBe('node-generic');
  });
  it('范围标注对应地理距离120km，链路线宽差异明显且颜色不合并',()=>{
    const [w,s,e,n]=SITUATION_AREA_BOUNDS,cx=(w+e)/2,cy=(s+n)/2;
    expect(getDistance([w,cy],[e,cy])).toBeCloseTo(120000,3);
    expect(getDistance([cx,s],[cx,n])).toBeCloseTo(120000,3);
    const widths=Object.values(LINK_STATUS_STYLES).map(s=>s.width).sort((a,b)=>a-b);
    for(let i=1;i<widths.length;i++)expect(widths[i]-widths[i-1]).toBeGreaterThanOrEqual(1);
    expect(new Set(Object.values(LINK_STATUS_STYLES).map(s=>s.color)).size).toBe(4);
  });
});
