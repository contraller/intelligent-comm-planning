import { onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useResourceLedgerEditStore } from '../stores/resource-ledger-edit';

export interface ResourceLedgerLeaveCheck {
  dirty: () => boolean;
  busy: () => boolean;
  leave: () => boolean | Promise<boolean>;
  clear?: () => void;
}

// 先完成全部决定，退出成功或实际离页后才清理；退出失败保留所有输入。
export function useResourceLedgerLeaveGuard(checks: () => readonly ResourceLedgerLeaveCheck[] = () => []) {
  const auth = useAuthStore(),
    editor = useResourceLedgerEditStore();
  const router = useRouter();
  let leaving = false;
  const dirty = () => editor.dirty || checks().some(check => check.dirty());
  const busy = () => editor.busy || checks().some(check => check.busy());
  function clear() {
    editor.clearForSession();
    checks().forEach(check => check.clear?.());
  }
  async function leave(defer = false) {
    const session = auth.generation;
    if (busy()) return false;
    for (const check of checks()) {
      if (!(await check.leave()) || session !== auth.generation || auth.blocked) return false;
    }
    if (!(await editor.leave(true))) return false;
    if (session !== auth.generation || auth.blocked) return false;
    if (!defer) clear();
    return true;
  }
  const release = auth.registerLeave(() => leave(true), dirty);
  const releaseCleaner = auth.registerCleaner(clear);
  const releaseNavigation = router.afterEach((to, from, failure) => {
    if (!leaving) return;
    leaving = false;
    if (!failure && from.path === '/resources' && to.path !== '/resources') {
      clear();
    }
  });
  const unload = (event: BeforeUnloadEvent) => {
    if (!dirty() && !busy()) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', unload);
  onBeforeUnmount(() => {
    release();
    releaseCleaner();
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
