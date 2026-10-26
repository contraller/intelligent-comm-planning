import { describe, expect, it } from 'vitest';
import { authFixture } from './helpers/auth';
import { createResourceReadMock } from '../src/services/resource-read-mock';

// 同一读取契约使用现有 Mock 资源，原维护事务和存储不发生变化。
async function fixture() {
  const s=authFixture(), preview=await s.raw.loadPreview();
  return { ...s, preview, api:createResourceReadMock(()=>({resources:preview.resources,meta:preview.resourceMeta})) };
}
describe('资源读取 Mock 契约',()=>{
  it('全库统计、筛选总数、分页条数分离，排序稳定且无存储写入',async()=>{
    const s=await fixture(), before=s.storage.writes, context=await s.api.loadResourceReadContext({context:'ledger'});
    const q={context:'ledger' as const,revision:context.revision,pageNum:1,pageSize:5,deviceClass:'HF' as const,sort:'id' as const,order:'desc' as const};
    const first=await s.api.queryResourceDevices(q),second=await s.api.queryResourceDevices({...q,pageNum:2});
    expect(first.total).toBe(context.stats.hf);expect(first.items).toHaveLength(5);expect(first.items.every(d=>d.deviceClass==='HF')).toBe(true);
    expect(new Set([...first.items,...second.items].map(d=>d.id)).size).toBe(10);
    expect(first.items[0].id.localeCompare(first.items[1].id)).toBeGreaterThan(0);expect(s.storage.writes).toBe(before);
  });
  it('父子节点、节点设备和详情关联一致，未知补充字段不改写来源',async()=>{
    const s=await fixture(), context=await s.api.loadResourceReadContext({context:'gis'});
    const q={context:'gis' as const,revision:context.revision,pageNum:1,pageSize:10};
    const roots=await s.api.queryResourceNodes({...q,parentId:null});expect(roots.items.length).toBeGreaterThan(0);
    for(const n of roots.items){expect(n.parentIds).toEqual([]);const children=await s.api.queryResourceNodes({...q,parentId:n.id});expect(children.items.every(c=>c.parentIds.includes(n.id))).toBe(true);}
    const device=s.preview.resources.devices[0];delete device.availability;delete device.origin;
    const detail=await s.api.getResourceObject({...q,kind:'device',id:device.id});
    expect(detail.object).toMatchObject({stationId:device.stationId,modelId:detail.model?.id,antennaId:detail.antenna?.id,availability:null,origin:null});
    const list=await s.api.queryResourceDevices({...q,nodeId:device.stationId});expect(list.items.every(d=>d.stationId===device.stationId)).toBe(true);
    expect(device.availability).toBeUndefined();
  });
  it('缩放只改变展示聚合，同坐标到最大级别仍能分页查看全部成员',async()=>{
    const s=await fixture();for(const node of s.preview.resources.stations)node.coordinate=[114,37];
    const context=await s.api.loadResourceReadContext({context:'gis'});
    const q={context:'gis' as const,revision:context.revision,bbox:context.bounds,zoom:17,showNodes:true,showInterferences:false};
    const frame=await s.api.queryResourceMap(q),cluster=frame.clusters[0];
    expect(cluster.count).toBe(context.stats.nodes);expect(cluster.expansionZoom).toBeNull();expect(frame.points).toEqual([]);
    const ids:string[]=[];
    for(let page=1;ids.length<cluster.count;page++){
      const result=await s.api.queryResourceNodes({context:'gis',revision:context.revision,pageNum:page,pageSize:10,clusterId:cluster.id});
      expect(result.total).toBe(cluster.count);ids.push(...result.items.map(n=>n.id));
    }
    expect(new Set(ids).size).toBe(context.stats.nodes);
    const hidden=await s.api.queryResourceMap({...q,showNodes:false});expect(hidden.totalNodes).toBe(0);
    expect((await s.api.queryResourceNodes({context:'gis',revision:context.revision,pageNum:1,pageSize:10,clusterId:cluster.id})).total).toBe(cluster.count);
  });
  it('视野和层开关不写业务状态；资源版本变化使旧查询和聚合失效',async()=>{
    const s=await fixture(),context=await s.api.loadResourceReadContext({context:'gis'}),before=JSON.stringify(s.preview);
    const frame=await s.api.queryResourceMap({context:'gis',revision:context.revision,bbox:[0,0,1,1],zoom:5,showNodes:true,showInterferences:true});
    expect(frame.totalNodes+frame.totalInterferences).toBe(0);expect(JSON.stringify(s.preview)).toBe(before);
    s.preview.resourceMeta.revision='new';
    await expect(s.api.queryResourceDevices({context:'ledger',revision:context.revision,pageNum:1,pageSize:10})).rejects.toMatchObject({code:'RESOURCE_VERSION_CHANGED'});
    await expect(s.api.getResourceObject({context:'gis',revision:(await s.api.loadResourceReadContext({context:'gis'})).revision,kind:'node',id:'missing'})).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
  });
});
