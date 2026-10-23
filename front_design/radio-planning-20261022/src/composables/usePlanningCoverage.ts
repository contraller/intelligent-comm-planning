import { onBeforeUnmount, ref, watch } from 'vue';
import type { PlanningCoverage } from '../types/coverage';
import type { TaskApiOptions } from '../types/task-api';
import { previewService } from '../services';
import { useAuthStore } from '../stores/auth';

// 图片只属于当前快照与当前身份，切换后立即释放旧对象 URL。
export function usePlanningCoverage(getCoverage: () => PlanningCoverage | null | undefined, getSnapshotId: () => string | undefined, getContext: () => TaskApiOptions['context']) {
  const auth = useAuthStore(), url = ref(''), error = ref(''), loading = ref(false);
  let controller: AbortController | undefined, ticket = 0;
  function clear() { ticket++; controller?.abort(); controller = undefined; if (url.value) URL.revokeObjectURL(url.value); url.value = ''; loading.value = false; }
  async function load() {
    clear(); error.value = ''; const raster = getCoverage()?.rasterPng, snapshotId = getSnapshotId();
    if (!raster || !snapshotId || !auth.can('planning.view') || getContext() === 'gis' && !auth.can('situation.view')) return;
    const token = ticket, session = auth.generation; controller = new AbortController(); const signal = controller.signal; loading.value = true;
    try {
      const blob = await previewService.getPlanningCoverageImage({ context: getContext(), snapshotId, raster, signal });
      if (token !== ticket || session !== auth.generation || signal.aborted) return;
      url.value = URL.createObjectURL(blob);
    } catch (e) { if (token === ticket && session === auth.generation && !signal.aborted) error.value = e instanceof Error ? e.message : '覆盖图片读取失败'; }
    finally { if (token === ticket) loading.value = false; }
  }
  watch(() => [getCoverage()?.rasterPng, getSnapshotId(), getContext(), auth.generation], () => void load(), { immediate: true, deep: true });
  onBeforeUnmount(clear);
  return { url, error, loading, retry: load };
}
