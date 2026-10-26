import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { DeviceMaintenanceServices, MaintenanceQuery } from '../types/device-maintenance';
import { mockResourceRevision } from './mock-resource-revision';
import { assertReading, pageItems } from './data-access';
import { maintenanceModes, restoreDevice } from './device-maintenance';
import { maintenanceSource, portObservations } from '../mocks/device-maintenance-presets';
import { ApiError } from './types';

// 按设备和资源版本读取，完整端口及历史不进入目录和地图。
export function createDeviceMaintenanceMock(read:()=>{resources:ResourcesData;meta:ResourceMeta}):DeviceMaintenanceServices {
  function context(q:MaintenanceQuery) {
    assertReading(q);
    if(!['gis','ledger'].includes(q.context)||!q.deviceId)throw new ApiError('维护上下文无效','INVALID_MAINTENANCE_QUERY');
    const saved=read();
    if(mockResourceRevision(saved)!==q.revision)throw new ApiError('资源版本已变化，请重新读取设备','RESOURCE_VERSION_CHANGED');
    const device=saved.resources.devices.find(d=>d.id===q.deviceId),model=saved.resources.models.find(m=>m.id===device?.modelId);
    if(!device||!model)throw new ApiError('维护设备不存在','RESOURCE_NOT_FOUND');
    return {saved,device,model};
  }
  function history(q:MaintenanceQuery & {historyId:string}) {
    const data=context(q),record=data.saved.meta.deviceHistory?.find(h=>h.deviceId===q.deviceId&&h.id===q.historyId);
    if(!record)throw new ApiError('历史记录不存在或不属于当前设备','HISTORY_NOT_FOUND');
    return {...data,record};
  }
  return {
    async getDeviceMaintenance(q){const {device,model}=context(q);return structuredClone({revision:q.revision,device,model,modeOptions:maintenanceModes,observations:portObservations(q.deviceId),source:maintenanceSource});},
    async queryDeviceHistory(q){const {saved}=context(q);return pageItems([...(saved.meta.deviceHistory??[])].filter(h=>h.deviceId===q.deviceId).reverse().map(({before:_before,after:_after,changes,...summary})=>({...summary,fields:changes.map(c=>c.field)})),q);},
    async getDeviceHistory(q){return structuredClone(history(q).record);},
    async previewDeviceRestore(q){const {saved,device,model,record}=history(q);return restoreDevice(record,device,q.revision,saved.meta.resourceEpoch,model);},
  };
}
