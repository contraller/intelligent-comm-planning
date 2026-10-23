import { useInterferenceStore } from '../stores/interference';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import { onMounted,onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave, useRouter, type RouteLocationNormalized } from 'vue-router';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useAuthStore } from '../stores/auth';
import { useResourceEditStore } from '../stores/resource-edit';
interface GisLeaveOptions {
  fault: {
    active: () => boolean; dirty: () => boolean; busy: () => boolean;
    leave: (defer?: boolean) => Promise<boolean>;
    isReturnTarget: (to: RouteLocationNormalized) => boolean;
  };
}
// 沿用文件名；页面必须明确提供资源模式与独立故障场景的离开保护。
export function useGisTaskLeaveGuard(options: GisLeaveOptions){
  const gis=useGisWorkspaceStore(),auth=useAuthStore(),interference=useInterferenceStore();
  const configuration=useDeviceConfigurationStore();
  const router=useRouter(),editor=useResourceEditStore();
  let leaving=false;
  // 进入标绘前已处理资源和配置，两种保存范围不会混入同一离开事务。
  async function leave(defer=false){
    if(options.fault.active())return options.fault.leave(defer);
    if(!await configuration.leave(true)||!await gis.leave(defer))return false;
    if(!defer)configuration.clearForSession();return true;
  }
  const hasPending=()=>options.fault.active()?options.fault.dirty():(gis.dirty||configuration.dirty||!!configuration.pending);
  const release=auth.registerLeave(()=>leave(true),hasPending);
  // 其他守卫拒绝导航时仍保留输入，实际离页后才提交放弃决定。
  const releaseNavigation=router.afterEach((to,from,failure)=>{
    if(!leaving)return;leaving=false;
    if(!failure&&from.path==='/situation'&&to.path!=='/situation'){
      configuration.clearForSession();editor.clearSession();gis.clearHistory();
    }
  });
  function unload(e:BeforeUnloadEvent){if(hasPending()||options.fault.active()&&options.fault.busy()||(gis.busy||configuration.busy)){e.preventDefault();e.returnValue='';}}
  // 两种来源启动同一控制器；各区域独立保留读取错误。
  onMounted(()=>{gis.start();interference.start();window.addEventListener('beforeunload',unload);});
  onBeforeRouteLeave(async(to)=>{if(auth.bypassLeave)return true;await auth.check();if(auth.blocked)return false;if(options.fault.active()&&options.fault.isReturnTarget(to))return true;leaving=await leave(true);return leaving;});
  onBeforeUnmount(()=>{release();releaseNavigation();gis.stop();interference.stop();window.removeEventListener('beforeunload',unload);});
}
