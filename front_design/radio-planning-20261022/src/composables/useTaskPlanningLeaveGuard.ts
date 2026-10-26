import { onMounted, onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useTaskInputStore } from '../stores/task-input';
import { usePlanningApiStore } from '../stores/planning-api';

// 任务编辑归规划页；前往 GIS 也必须先处理未保存输入。
export function useTaskPlanningLeaveGuard() {
  const auth = useAuthStore(), task = useTaskInputStore(), planning = usePlanningApiStore();
  const router = useRouter();
  let leaving = false;
  // 先收集全部决定；实际离页或退出成功后才丢弃，失败保留原输入。
  const allow = async (navigation = false) => {
    // 询问期间不发出新的预览作业；导航失败后恢复原输入的等待预览。
    planning.pauseAutomaticPreview();
    const session = auth.generation;
    const accepted = !planning.busy && !planning.pending && await planning.allowAdjustmentLeave(true) && await task.allowLeave(true, ['planningAdjustment']) && session === auth.generation && !auth.blocked;
    if (!navigation || !accepted) planning.resumeAutomaticPreview();
    return accepted;
  };
  const release = auth.registerLeave(() => allow(), () => task.dirty || !!task.pendingSave || !!planning.pending);
  const releaseNavigation = router.afterEach((to, from, failure) => {
    if (!leaving) return;
    leaving = false;
    if (!failure && from.path === '/planning' && to.path !== '/planning') { planning.discardAdjustment(); task.discardDraft(); }
    else planning.resumeAutomaticPreview();
  });
  const beforeUnload = (event: BeforeUnloadEvent) => { if (task.dirty || task.busy || planning.busy || task.pendingSave || planning.pending) { event.preventDefault(); event.returnValue = ''; } };
  onMounted(() => window.addEventListener('beforeunload', beforeUnload));
  onBeforeRouteLeave(async () => {
    if (auth.bypassLeave) return true; await auth.check(); if (auth.blocked || task.busy || planning.busy || task.pendingSave || planning.pending) return false;
    leaving = await allow(true); return leaving;
  });
  onBeforeUnmount(() => { release(); releaseNavigation(); task.stop(); planning.stop(); task.answer('cancel'); window.removeEventListener('beforeunload', beforeUnload); });
}
