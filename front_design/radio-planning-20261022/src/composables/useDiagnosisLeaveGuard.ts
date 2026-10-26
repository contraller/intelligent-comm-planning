import { onBeforeUnmount, onMounted } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useDiagnosisStore } from '../stores/diagnosis';

export function useDiagnosisLeaveGuard() {
  const diagnosis = useDiagnosisStore();
  const auth=useAuthStore(),release=auth.registerLeave(()=>diagnosis.allowDiscard(true),()=>diagnosis.dirty);
  onBeforeUnmount(release);
  // 已提交记录已持久化，离页只停止轮询；未保存输入必须明确处理。
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!diagnosis.dirty && !diagnosis.locked) return;
    event.preventDefault(); event.returnValue = '';
  };
  const focus = () => { void diagnosis.refreshSources(); };
  onMounted(() => { window.addEventListener('beforeunload',beforeUnload); window.addEventListener('focus',focus); void diagnosis.load(); });
  // 正常离开沿用原提示；失效时留在原组件，由统一对话框处理。
  onBeforeRouteLeave(async(to)=>{if(auth.bypassLeave)return true;await auth.check();if(auth.blocked)return false;
    // 只有页面事先登记且内容未变的 GIS 接力保留草稿，其余导航仍需明确处理输入。
    if(to.path==='/situation'&&diagnosis.allowsGisTransfer(to.query))return true;
    diagnosis.clearGisTransfer();return diagnosis.allowDiscard();});
  onBeforeUnmount(() => { diagnosis.stopPolling(); diagnosis.answer('cancel'); window.removeEventListener('beforeunload',beforeUnload); window.removeEventListener('focus',focus); });
}
