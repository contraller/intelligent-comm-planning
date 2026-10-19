import { onMounted, onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useTaskInputStore } from '../stores/task-input';
import { usePlanningApiStore } from '../stores/planning-api';

// GIS/规划共用内存草稿；离开整个任务工作区才询问保存或放弃。
export function useTaskPlanningLeaveGuard() {
  const auth = useAuthStore(), task = useTaskInputStore(), planning = usePlanningApiStore();
  const allow = async () => !planning.busy && !planning.pending && await planning.allowAdjustmentLeave() && await task.allowLeave();
  const release = auth.registerLeave(allow, () => task.dirty || !!task.pendingSave || !!planning.pending);
  const beforeUnload = (event: BeforeUnloadEvent) => { if (task.dirty || task.busy || planning.busy || task.pendingSave || planning.pending) { event.preventDefault(); event.returnValue = ''; } };
  onMounted(() => window.addEventListener('beforeunload', beforeUnload));
  onBeforeRouteLeave(async to => {
    if (auth.bypassLeave) return true; await auth.check(); if (auth.blocked || task.busy || planning.busy || task.pendingSave || planning.pending) return false;
    if (['/situation','/planning'].includes(to.path) && !Object.values(task.auxiliary).some(Boolean)) return true;
    return allow();
  });
  onBeforeUnmount(() => { release(); task.stop(); planning.stop(); task.answer('cancel'); window.removeEventListener('beforeunload', beforeUnload); });
}
