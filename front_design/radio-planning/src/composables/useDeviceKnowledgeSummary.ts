import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { previewService } from '../services';
import { projectDeviceKnowledgeSummary } from '../services/device-knowledge-summary';
import { useAuthStore } from '../stores/auth';
import { useKnowledgeStore } from '../stores/knowledge';
import type { DeviceKnowledgeSummaryStatus, DeviceModelKnowledgeSummary } from '../types/device-knowledge-summary';

/** 只读当前发布版型号知识；设备草稿、运维检索和业务结果不参与摘要。 */
export function useDeviceKnowledgeSummary(device: () => { id: string; modelId: string }) {
  const auth = useAuthStore(), store = useKnowledgeStore();
  const summary = ref<DeviceModelKnowledgeSummary | null>(null);
  const status = ref<DeviceKnowledgeSummaryStatus>('loading'), error = ref('');
  let generation = 0, active = true, mounted = false, pending: Promise<void> = Promise.resolve();
  const owner = () => JSON.stringify([device().id, device().modelId, store.current?.id,
    auth.generation, auth.can('knowledge.view'), store.loadError]);

  async function read() {
    const token = ++generation, identity = owner();
    summary.value = null; error.value = '';
    if (!active || !auth.can('knowledge.view')) { status.value = 'forbidden'; return; }
    if (store.loadError || !store.current) {
      status.value = !store.loadError && store.loading ? 'loading' : 'workspace-error';
      error.value = store.loadError || (store.loading ? '' : '知识工作区不可用，请重试');
      return;
    }
    const modelId = device().modelId, versionId = store.current.id;
    const ownsRequest = () => active && token === generation && identity === owner();
    status.value = 'loading';
    // 同步清旧值，合并同一轮设备／会话变更，避免向中间归属发起查询。
    await Promise.resolve();
    if (!ownsRequest()) return;
    try {
      const result = await previewService.getDeviceKnowledge({ versionId, modelId });
      if (!ownsRequest()) return;
      summary.value = projectDeviceKnowledgeSummary(result, { modelId, versionId });
      status.value = 'ready';
    } catch (reason) {
      if (!ownsRequest()) return;
      error.value = reason instanceof Error ? reason.message : '型号知识摘要读取失败';
      status.value = 'error';
    }
  }
  function refresh() { pending = read(); return pending; }
  async function ensureWorkspace() {
    // 初次进入或重新获得权限才自动加载；失败保留给显式重试，不循环请求。
    if (active && mounted && auth.can('knowledge.view') && !store.workspace && !store.loadError)
      await store.load();
  }
  async function retry() {
    if (!active) return;
    if (!auth.can('knowledge.view')) { await refresh(); return; }
    if (!store.current || store.loadError) {
      const token = generation;
      await store.load();
      if (!active) return;
      // 加载造成版本／状态变化时，观察器已读取当前归属；不再重复发送。
      if (token !== generation) { await pending; return; }
    }
    await refresh();
  }
  // 逐项比较实际归属，避免服务校验返回同身份的新对象时循环查询。
  watch([() => device().id, () => device().modelId, () => store.current?.id, () => auth.generation,
    () => auth.can('knowledge.view'), () => store.loadError, () => !store.current && store.loading],
  refresh, { immediate: true, flush: 'sync' });
  watch([() => auth.generation, () => auth.can('knowledge.view')], ensureWorkspace, { flush: 'sync' });
  onMounted(() => { mounted = true; void ensureWorkspace(); });
  onBeforeUnmount(() => { active = false; mounted = false; generation++; summary.value = null; });
  return { summary, status, error, retry };
}
