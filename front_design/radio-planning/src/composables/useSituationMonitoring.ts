import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useMonitoringStore } from '../stores/monitoring';
import { usePlanningStore } from '../stores/planning';
import { usePreviewStore } from '../stores/preview';
import { useSpectrumStore } from '../stores/spectrum';
import { useSystemStore } from '../stores/system';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useResourceEditStore } from '../stores/resource-edit';
import { useAuthStore } from '../stores/auth';
import { monitoringMap } from '../maps/monitoring-view';
import { RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, SPECTRUM_STORAGE_KEY, SYSTEM_STORAGE_KEY } from '../config/demo';

// 页面生命周期与领域状态分离：离页保留帧，退出账号才清空。
export function useSituationMonitoring(locate:()=>void,hasResourceTarget:()=>boolean) {
  const monitor=useMonitoringStore(),planning=usePlanningStore(),preview=usePreviewStore(),spectrum=useSpectrumStore();
  const gis=useGisWorkspaceStore(),editor=useResourceEditStore(),auth=useAuthStore(),system=useSystemStore();
  let attached=false;
  const mode=computed(()=>gis.mapMode==='monitoring'&&monitor.networkReadable&&!!monitor.network);
  const map=computed(()=>monitor.network?monitoringMap(monitor.network,monitor.networkResult?.frame??null):null);
  async function refreshSources(){
    if(!attached||document.hidden)return;
    await Promise.allSettled([monitor.loadNetwork(planning.taskId),monitor.loadSpectrum()]);
  }
  const focus=()=>{void refreshSources();};
  const visibility=()=>{
    monitor.visible=attached&&!document.hidden;
    if(monitor.visible)void refreshSources();
  };
  const storage=(event:StorageEvent)=>{
    if(!event.key||[RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,SPECTRUM_STORAGE_KEY,SYSTEM_STORAGE_KEY].includes(event.key))focus();
  };
  watch(()=>[planning.taskId,planning.workspace?.revision,preview.data?.resourceMeta.revision],()=>{
    if(attached&&!document.hidden)void monitor.loadNetwork(planning.taskId);
  });
  watch(()=>spectrum.workspace?.revision,()=>{if(attached&&!document.hidden)void monitor.loadSpectrum();});
  watch(()=>auth.generation,()=>{if(attached&&!document.hidden){monitor.visible=true;focus();}});
  watch(()=>[mode.value,monitor.network?.key,monitor.selectedStationId,monitor.selectedLinkId,monitor.selectedDeviceId],
    async()=>{if(mode.value){await nextTick();locate();}});
  // 同标签页保存参数没有 storage 事件；只订阅 PAR-01 的保存完成，不影响其他参数。
  const release=system.$onAction(({name,after})=>{
    if(name==='save'&&system.parameterForm?.id==='PAR-01')after(()=>{if(attached&&!document.hidden)void monitor.loadNetwork(planning.taskId);});
  });
  onMounted(()=>{
    attached=true;
    // 显式资源定位及其错误提示优先，只有普通入口才自动进入监控。
    if(!hasResourceTarget()&&gis.mapMode==='resource'&&editor.context!=='gis'&&monitor.networkReadable)gis.mapMode='monitoring';
    monitor.visible=!document.hidden;void refreshSources();
    window.addEventListener('focus',focus);window.addEventListener('storage',storage);document.addEventListener('visibilitychange',visibility);
  });
  onBeforeUnmount(()=>{
    attached=false;monitor.stop();release();
    window.removeEventListener('focus',focus);window.removeEventListener('storage',storage);document.removeEventListener('visibilitychange',visibility);
  });
  return {monitor,mode,map};
}
