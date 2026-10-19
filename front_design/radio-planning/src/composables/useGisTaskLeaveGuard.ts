import { useInterferenceStore } from '../stores/interference';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import { onMounted,onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useAuthStore } from '../stores/auth';
// 页内联合编辑共用离开与会话确认，最后一步才清理内存。
export function useGisTaskLeaveGuard(){
  const gis=useGisWorkspaceStore(),auth=useAuthStore(),interference=useInterferenceStore();
  const configuration=useDeviceConfigurationStore();
  // 配置先确认，旧工作区取消时仍保留输入；不改变原任务转入逻辑。
  async function leave(defer=false,transfer=false){if(!await configuration.leave(true)||!await gis.leave(defer,transfer))return false;if(!defer)configuration.clearForSession();return true;}
  const release=auth.registerLeave(()=>leave(true),()=>gis.dirty||configuration.dirty||!!configuration.pending);
  function unload(e:BeforeUnloadEvent){if(gis.dirty||gis.busy||configuration.dirty||configuration.pending||configuration.busy){e.preventDefault();e.returnValue='';}}
  onMounted(()=>{gis.start();interference.start();window.addEventListener('beforeunload',unload);});
  onBeforeRouteLeave(async(to)=>{if(auth.bypassLeave)return true;await auth.check();return !auth.blocked&&leave(false,to.path==='/planning');});
  onBeforeUnmount(()=>{release();gis.stop();interference.stop();window.removeEventListener('beforeunload',unload);});
}
