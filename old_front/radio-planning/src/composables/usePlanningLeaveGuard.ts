import { onBeforeUnmount, onMounted } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { usePlanningStore } from '../stores/planning';

export function usePlanningLeaveGuard() {
  const planning = usePlanningStore();
  const auth=useAuthStore(),release=auth.registerLeave(()=>planning.allowDiscard(true),()=>planning.dirty);
  onBeforeUnmount(release);
  // 任务输入可独立保存；已提交任务已持久化，可以离页后恢复。
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!planning.dirty && !planning.busy && !planning.importing && !planning.adjustmentPending) return;
    event.preventDefault();
    event.returnValue = '';
  };
  onMounted(() => {
    window.addEventListener('beforeunload', beforeUnload);
    void planning.startPolling();
  });
  // 正常离开沿用原提示；失效时留在原组件，由统一对话框处理。
  // 独立方案调整不能借 GIS 共用任务草稿的快捷通道绕过离开保护。
  onBeforeRouteLeave(async(to)=>{if(auth.bypassLeave)return true;await auth.check();if(auth.blocked)return false;if(to.path==='/situation'&&!planning.formDirty&&!planning.auxiliaryDirty&&!planning.importRequest&&!planning.adjustmentDirty&&!planning.adjustmentPending&&!(planning.adjustmentParent&&planning.running))return true;return planning.allowDiscard();});
  onBeforeUnmount(() => {
    planning.stopPolling();
    planning.answer('cancel');
    planning.formDirty = false;
    planning.auxiliaryDirty = false;
    window.removeEventListener('beforeunload', beforeUnload);
  });
}
