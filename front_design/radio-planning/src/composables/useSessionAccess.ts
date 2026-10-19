import { useMonitoringStore } from '../stores/monitoring';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import { useResourceReadStore } from '../stores/resource-read';
import { useTaskInputStore } from '../stores/task-input';
import { usePlanningApiStore } from '../stores/planning-api';
import { useInterferenceStore } from '../stores/interference';
import { onMounted, onBeforeUnmount, watch, ref } from 'vue';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useAuthStore } from '../stores/auth';
import { usePreviewStore } from '../stores/preview';
import { useResourceEditStore } from '../stores/resource-edit';
import { usePlanningStore } from '../stores/planning';
import { useDiagnosisStore } from '../stores/diagnosis';
import { useKnowledgeStore } from '../stores/knowledge';
import { useSystemStore } from '../stores/system';
import { useSpectrumStore } from '../stores/spectrum';
import { SYSTEM_STORAGE_KEY, SESSION_STORAGE_KEY } from '../config/demo';
export function useSessionAccess(){
  const auth=useAuthStore(),preview=usePreviewStore(),resources=useResourceEditStore(),planning=usePlanningStore(),diagnosis=useDiagnosisStore(),knowledge=useKnowledgeStore(),system=useSystemStore(),spectrum=useSpectrumStore(),viewGeneration=ref(0);
  const gis=useGisWorkspaceStore(),interference=useInterferenceStore(),monitoring=useMonitoringStore();
  const resourceRead=useResourceReadStore();
  const configuration=useDeviceConfigurationStore();
  const taskInput=useTaskInputStore(),planningApi=usePlanningApiStore();
  const release=auth.registerCleaner(()=>{
    // 只清内存，独立回执和待核实请求可在下次进入时恢复。
    configuration.clearForSession();
    resourceRead.clearForSession();
    planningApi.clearForSession();taskInput.clearForSession();
    monitoring.clearForSession();interference.clearForSession();gis.clearForSession();resources.clearSession();spectrum.clearForSession();planning.clearForSession();diagnosis.clearForSession();knowledge.clearForSession();system.clearForSession();preview.clearForSession();viewGeneration.value++;
  });
  const check=()=>{void auth.check();};
  const storage=(event:StorageEvent)=>{if(!event.key||[SYSTEM_STORAGE_KEY,SESSION_STORAGE_KEY].includes(event.key))check();};
  // 失效只停止异步工作，保留本地抽屉和未保存输入，待用户明确处理。
  watch(()=>auth.generation,()=>{
    configuration.stop();
    // 只停止读取；明确退出/丢弃时才清除已显示的资源现场。
    if(!resourceRead.readable)resourceRead.stop();
    taskInput.answer('cancel');
    if(!taskInput.readable){taskInput.stop();planningApi.stop();}
    resources.answer('cancel');spectrum.answer('cancel');planning.answer('cancel');diagnosis.answer('cancel');knowledge.answer('cancel');system.answer('cancel');
    // 监控只读帧在失权时冻结，成功退出或明确清理时才丢弃。
    if(!monitoring.networkReadable&&!monitoring.spectrumReadable)monitoring.stop();
    if(!interference.readable)interference.stop();
    if(!auth.can('planning.view'))planning.stopPolling();
    if(!auth.can('diagnosis.view'))diagnosis.stopPolling();
    if(!auth.can('knowledge.view'))knowledge.stopQueries();
    if(!auth.can('system.view'))system.stopQueries();
  },{flush:'sync'});
  onMounted(()=>{window.addEventListener('focus',check);window.addEventListener('storage',storage);});
  onBeforeUnmount(()=>{release();window.removeEventListener('focus',check);window.removeEventListener('storage',storage);});
  return {viewGeneration};
}
