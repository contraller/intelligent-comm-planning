import { onMounted, onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useResourceEditStore } from '../stores/resource-edit';
import { useSpectrumStore } from '../stores/spectrum';
import { useDeviceConfigurationStore } from '../stores/device-configuration';

export function useUnsavedChangesGuard(includeSpectrum=false) {
  const editor = useResourceEditStore();
  const spectrum=useSpectrumStore();
  const configuration=useDeviceConfigurationStore();
  async function leave(defer=false){
    if(editor.busy||includeSpectrum&&spectrum.busy||!await configuration.leave(true))return false;
    if(!(await editor.leave(true))||includeSpectrum&&!(await spectrum.leave(true)))return false;
    // 两处均确认后再清理，避免后一处取消导致前一处输入丢失。
    if(!defer){editor.clearSession();if(includeSpectrum)spectrum.form=null;configuration.clearForSession();}return true;
  }
  // 全部决策通过才清理配置；明确退出由统一 cleaner 保留持久化请求。
  const auth=useAuthStore(),release=auth.registerLeave(()=>leave(true),()=>editor.dirty||includeSpectrum&&spectrum.dirty||configuration.dirty||!!configuration.pending);
  onBeforeUnmount(release);
  // 正常离开沿用原提示；失效时留在原组件，由统一对话框处理。
  onBeforeRouteLeave(async()=>{if(auth.bypassLeave)return true;await auth.check();return !auth.blocked&&leave();});
  // 浏览器刷新只能请求原生提示，不在卸载时异步保存或持久化草稿。
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!editor.dirty && !editor.busy && !(includeSpectrum&&(spectrum.dirty||spectrum.busy)) && !configuration.dirty && !configuration.pending && !configuration.busy) return;
    event.preventDefault();
    event.returnValue = '';
  }
  onMounted(() => window.addEventListener('beforeunload', beforeUnload));
  onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
}
