import type { DeviceNetworkDetailServices } from '../types/device-network';
import type { PreviewData } from '../types/domain';
import { createDeviceNetworkContext, selectDeviceNetwork } from './device-network';
import { createLinkDetailContext } from './link-detail';
import { gisResourceIndex } from './gis-workspace';
import { assertReading } from './data-access';
import { mockResourceRevision } from './mock-resource-revision';
import { ApiError } from './types';

// 只投影选中对象的冻结资料，不返回全库和无关链路历史。
export function createDeviceNetworkDetailMock(read:()=>PreviewData):DeviceNetworkDetailServices {
  return {async getDeviceNetworkDetail(q){
    assertReading(q);const data=read();
    if(!['gis','ledger'].includes(q.context)||mockResourceRevision({resources:data.resources,meta:data.resourceMeta})!==q.revision)throw new ApiError('资源版本已变化','RESOURCE_VERSION_CHANGED');
    const network=createDeviceNetworkContext(data.situation,data.resources,data.resourceMeta);
    if(network.state!=='ready'||network.snapshotId!==q.snapshotId)throw new ApiError('关联网络已过期或快照不匹配','NETWORK_SOURCE_CHANGED');
    const selected=selectDeviceNetwork(network,q.deviceId),link=q.kind==='link'?selected.links.find(l=>l.id===q.id)??null:null,entry=q.kind==='service'?selected.services.find(s=>s.service.id===q.id):undefined;
    if(!link&&!entry)throw new ApiError('下钻目标不属于当前设备网络','NETWORK_OBJECT_MISSING');
    const routes=entry?.routes.map(r=>r.route)??[],ids=new Set(link?[link.id]:routes.flatMap(r=>r.linkIds)),links=network.links.filter(l=>ids.has(l.id));
    const nodes=new Set([...links.flatMap(l=>[l.a,l.b]),...routes.flatMap(r=>r.nodeIds)]),devices=new Set(links.flatMap(l=>[l.deviceA,l.deviceB]));
    if(entry){devices.add(entry.service.sourceDeviceId);devices.add(entry.service.targetDeviceId);}
    const resources={...data.resources,stations:data.resources.stations.filter(s=>nodes.has(s.id)),devices:data.resources.devices.filter(d=>devices.has(d.id))};
    const context=createLinkDetailContext(data.situation,data.resources,data.resourceMeta);
    return structuredClone({snapshotId:network.snapshotId,source:network.source,kind:q.kind,link,service:entry?.service??null,routes,links,stations:resources.stations,resources:gisResourceIndex(resources),linkDetails:{...context,records:context.records.filter(r=>ids.has(r.linkId))}});
  }};
}
