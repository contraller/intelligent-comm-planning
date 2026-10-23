import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useMonitoringStore } from '../stores/monitoring';
import { usePlanningStore } from '../stores/planning';
import { useResourceReadStore } from '../stores/resource-read';
import { useSpectrumStore } from '../stores/spectrum';
import { useSystemStore } from '../stores/system';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useAuthStore } from '../stores/auth';
import { monitoringMap } from '../maps/monitoring-view';
import { RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, SPECTRUM_STORAGE_KEY, SYSTEM_STORAGE_KEY } from '../config/demo';

// 页面生命周期与领域状态分离：离页保留帧，退出账号才清空。
export function useSituationMonitoring(locate:()=>void,enabled:()=>boolean=()=>true,suspended:()=>boolean=()=>false) {
  const monitor=useMonitoringStore(),planning=usePlanningStore(),preview=useResourceReadStore(),spectrum=useSpectrumStore();
  const gis=useGisWorkspaceStore(),auth=useAuthStore(),system=useSystemStore();
  let attached=false;
  const mode=computed(()=>enabled()&&!suspended()&&gis.mapMode==='monitoring'&&monitor.networkReadable&&!!monitor.network);
  const map=computed(()=>monitor.network?monitoringMap(monitor.network,monitor.networkResult?.frame??null):null);
  async function refreshSources(){
    if(!enabled()||suspended()||!attached||document.hidden)return;
    await Promise.allSettled([monitor.loadNetwork(planning.taskId),monitor.loadSpectrum()]);
  }
  const focus=()=>{void refreshSources();};
  const visibility=()=>{
    monitor.visible=attached&&!document.hidden&&!suspended();
    if(monitor.visible)void refreshSources();
  };
  const storage=(event:StorageEvent)=>{
    if(!event.key||[RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,SPECTRUM_STORAGE_KEY,SYSTEM_STORAGE_KEY].includes(event.key))focus();
  };
  watch(()=>[planning.taskId,planning.readRevision||planning.workspace?.revision,preview.workspace?.revision],()=>{
    if(attached&&!suspended()&&!document.hidden)void monitor.loadNetwork(planning.taskId);
  });
  watch(()=>spectrum.workspace?.revision,()=>{if(attached&&!suspended()&&!document.hidden)void monitor.loadSpectrum();});
  watch(()=>auth.generation,()=>{if(attached&&!document.hidden){monitor.visible=!suspended();focus();}});
  // 标绘独占地图时暂停回放，退出后按原展开状态恢复。
  watch(suspended,()=>{if(attached){monitor.visible=!document.hidden&&!suspended();if(monitor.visible)focus();}},{flush:'sync'});
  watch(()=>[mode.value,monitor.network?.key,monitor.selectedStationId,monitor.selectedLinkId,monitor.selectedDeviceId],
    async()=>{if(mode.value){await nextTick();locate();}});
  // 同标签页保存参数没有 storage 事件；只订阅 PAR-01 的保存完成，不影响其他参数。
  const release=system.$onAction(({name,after})=>{
    if(name==='save'&&system.parameterForm?.id==='PAR-01')after(()=>{if(attached&&!suspended()&&!document.hidden)void monitor.loadNetwork(planning.taskId);});
  });
  onMounted(()=>{
    // 缺能力时既不发请求，也不接管当前地图模式。
    if(!enabled())return;
    attached=true;
    // 观测只更新抽屉；地图来源由用户的查看或定位操作切换。
    monitor.visible=!document.hidden&&!suspended();void refreshSources();
    window.addEventListener('focus',focus);window.addEventListener('storage',storage);document.addEventListener('visibilitychange',visibility);
  });
  onBeforeUnmount(()=>{
    attached=false;monitor.stop();release();
    window.removeEventListener('focus',focus);window.removeEventListener('storage',storage);document.removeEventListener('visibilitychange',visibility);
  });
  return {monitor,mode,map};
}
