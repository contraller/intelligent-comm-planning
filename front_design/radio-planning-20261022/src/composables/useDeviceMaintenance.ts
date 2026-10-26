import { ref, watch, onBeforeUnmount } from 'vue';
import { previewService } from '../services';
import { useAuthStore } from '../stores/auth';
import { isDeviceBaseline } from '../services/device-maintenance-display';
import type { MaintenanceQuery, DeviceMaintenanceContext, DeviceHistory, DeviceHistorySummary, DeviceRestorePreview } from '../types/device-maintenance';
import type { PageResult } from '../types/data-access';
import type { ConfigurationHistoryItem, ConfigurationOperationResult } from '../types/device-configuration';

// 只读状态绑定设备、版本及账号；写入仍交给现有资源编辑所有者。
export function useDeviceMaintenance(query:()=>MaintenanceQuery|null) {
  const auth=useAuthStore(),data=ref<DeviceMaintenanceContext|null>(null),history=ref<PageResult<DeviceHistorySummary>|null>(null);
  const record=ref<DeviceHistory|null>(null),restore=ref<DeviceRestorePreview|null>(null),configurations=ref<PageResult<ConfigurationHistoryItem>|null>(null),configuration=ref<ConfigurationOperationResult|null>(null);
  const busy=ref(false),error=ref('');let serial=0,controller:AbortController|undefined;
  function cancel(){serial++;controller?.abort();busy.value=false;}
  function reset(){cancel();data.value=null;history.value=null;record.value=null;restore.value=null;configurations.value=null;configuration.value=null;error.value='';}
  watch([()=>query()?.deviceId,()=>query()?.revision,()=>query()?.context,()=>auth.generation],reset);
  onBeforeUnmount(reset);
  async function run<T>(read:(q:MaintenanceQuery)=>Promise<T>,accept:(value:T)=>void){
    const input=query();if(!input||auth.blocked)return;
    controller?.abort();controller=new AbortController();const token=++serial,owner=auth.generation;
    busy.value=true;error.value='';
    try{const value=await read({...input,signal:controller.signal});if(token===serial&&owner===auth.generation&&!auth.blocked){accept(value);return true;}}
    catch(e){if(token===serial&&owner===auth.generation)error.value=e instanceof Error?e.message:'设备资料读取失败';}
    finally{if(token===serial)busy.value=false;}
    return false;
  }
  const load=()=>run(q=>previewService.getDeviceMaintenance(q),value=>{data.value=value;});
  const loadHistory=(pageNum=1)=>run(q=>previewService.queryDeviceHistory({...q,pageNum,pageSize:20}),value=>{history.value=value;record.value=null;restore.value=null;});
  const selectHistory=(historyId:string)=>run(q=>previewService.getDeviceHistory({...q,historyId}),value=>{record.value=value;restore.value=null;configuration.value=null;});
  const previewRestore=()=>record.value&&run(q=>previewService.previewDeviceRestore({...q,historyId:record.value!.id}),value=>{restore.value=value;});
  const loadConfigurations=(pageNum=1)=>run(q=>previewService.queryDeviceConfigurationHistory({context:q.context,deviceId:q.deviceId,pageNum,pageSize:20}),value=>{configurations.value=value;});
  const selectConfiguration=(requestId:string)=>run(q=>previewService.getDeviceConfigurationOperation({context:q.context,deviceId:q.deviceId,requestId}),value=>{configuration.value=value;record.value=null;restore.value=null;});
  // 关闭或换对象后，不允许旧的首段查询继续读取新对象的配置历史。
  async function openHistory(){
    let token=serial;const owner=auth.generation;
    if(!await loadHistory()||serial!==token+1||owner!==auth.generation)return;
    token=serial;
    await loadConfigurations();
    if(serial!==token+1||owner!==auth.generation)return;
    const configurationError=error.value;
    // 只按需读取最近真实变更；仅有基线时展示基线，翻页仍保留手动选择。
    const selected=history.value?.items.find(item=>!isDeviceBaseline(item))??history.value?.items[0];
    if(selected){
      token=serial;await selectHistory(selected.id);
      if(serial===token+1&&owner===auth.generation&&configurationError)error.value=[configurationError,error.value].filter(Boolean).join('；');
    }
  }
  return {data,history,record,restore,configurations,configuration,busy,error,load,loadHistory,selectHistory,previewRestore,loadConfigurations,selectConfiguration,openHistory,cancel};
}
