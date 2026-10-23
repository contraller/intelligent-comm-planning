import { onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import type { DeviceCoverageCatalog } from '../types/device-coverage';

// 覆盖目录与基础绘制分开，未使用设备覆盖时不读取其输入与几何资料。
export function useGisCoverageCatalog(
  getRevision: () => string | undefined,
  invalidateIntent: () => void,
) {
  const auth = useAuthStore();
  const coverageCatalog = ref<DeviceCoverageCatalog | null>(null),
    coverageError = ref('');
  let coverageSerial = 0,
    coverageRevision = '',
    coverageFlight: Promise<void> | null = null,
    coverageAbort: AbortController | undefined;
  async function loadCoverage() {
    const revision = getRevision();
    if (
      !revision ||
      !auth.can('situation.view') ||
      (coverageRevision === revision && coverageCatalog.value)
    )
      return;
    if (coverageFlight) return coverageFlight;
    const serial = ++coverageSerial,
      session = auth.generation;
    coverageAbort?.abort();
    const controller = new AbortController();
    coverageAbort = controller;
    coverageError.value = '';
    // 成功与失败使用同一归属检查，旧请求不能改写新目录或错误。
    function ownsRequest() {
      return (
        serial === coverageSerial &&
        session === auth.generation &&
        auth.can('situation.view') &&
        !auth.blocked &&
        !controller.signal.aborted &&
        revision === getRevision()
      );
    }
    coverageFlight = (async () => {
      try {
        const value = await previewService.getGisCoverageCatalog({
          context: 'gis',
          revision,
          signal: controller.signal,
        });
        if (ownsRequest()) {
          coverageCatalog.value = value;
          coverageRevision = revision;
        }
      } catch (e) {
        if (ownsRequest())
          coverageError.value = e instanceof Error ? e.message : '覆盖资料读取失败';
      } finally {
        // 旧请求收尾不能清空新版本的进行中读取。
        if (serial === coverageSerial) coverageFlight = null;
      }
    })();
    return coverageFlight;
  }
  // 同步失效目录与页面显示意图，保留原有选择和图层偏好。
  watch(
    [() => auth.generation, getRevision],
    () => {
      coverageSerial++;
      invalidateIntent();
      coverageAbort?.abort();
      coverageCatalog.value = null;
      coverageFlight = null;
      coverageRevision = '';
      coverageError.value = '';
    },
    { flush: 'sync' },
  );
  onBeforeUnmount(() => {
    coverageSerial++;
    invalidateIntent();
    coverageAbort?.abort();
  });
  return { catalog: coverageCatalog, error: coverageError, load: loadCoverage };
}
