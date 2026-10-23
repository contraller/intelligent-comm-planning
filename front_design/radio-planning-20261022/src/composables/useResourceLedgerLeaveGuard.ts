import { onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useResourceLedgerEditStore } from '../stores/resource-ledger-edit';
import { useSpectrumStore } from '../stores/spectrum';
import { useDeviceConfigurationStore } from '../stores/device-configuration';

// 先完成全部决定，退出成功或实际离页后才清理；退出失败保留所有输入。
export function useResourceLedgerLeaveGuard() {
  const auth = useAuthStore(),
    editor = useResourceLedgerEditStore(),
    spectrum = useSpectrumStore(),
    configuration = useDeviceConfigurationStore();
  const router = useRouter();
  let leaving = false;
  const dirty = () =>
    editor.dirty || spectrum.dirty || configuration.dirty || !!configuration.pending;
  async function leave(defer = false) {
    const session = auth.generation;
    if (
      editor.busy ||
      spectrum.busy ||
      !(await configuration.leave(true)) ||
      !(await editor.leave(true)) ||
      !(await spectrum.leave(true))
    )
      return false;
    if (session !== auth.generation || auth.blocked) return false;
    if (!defer) {
      editor.clearForSession();
      spectrum.form = null;
      configuration.clearForSession();
    }
    return true;
  }
  const release = auth.registerLeave(() => leave(true), dirty);
  const releaseNavigation = router.afterEach((to, from, failure) => {
    if (!leaving) return;
    leaving = false;
    if (!failure && from.path === '/resources' && to.path !== '/resources') {
      editor.clearForSession();
      spectrum.form = null;
      configuration.clearForSession();
    }
  });
  const unload = (event: BeforeUnloadEvent) => {
    if (!dirty() && !editor.busy && !spectrum.busy && !configuration.busy) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', unload);
  onBeforeUnmount(() => {
    release();
    releaseNavigation();
    window.removeEventListener('beforeunload', unload);
  });
  onBeforeRouteLeave(async () => {
    if (auth.bypassLeave) return true;
    await auth.check();
    leaving = !auth.blocked && (await leave(true));
    return leaving;
  });
  return { leave };
}
