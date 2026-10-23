import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { loadTerrainBasemap, type TerrainBasemap } from '../services/terrain-basemap';
import type { ResourceTerrain } from '../types/resource-read';

// 只以 DEM 的内容身份加载，资源分页、轮询和同值对象替换不重复卸载地形。
export function useTerrainBasemap(expected: () => ResourceTerrain | null | undefined,
  options: { enabled?: () => boolean; unavailableReason?: () => string } = {}) {
  const basemap = shallowRef<TerrainBasemap | null>(null), message = ref('');
  let alive = true, ticket = 0, controller: AbortController | undefined;
  const key = computed(() => JSON.stringify([options.enabled?.() ?? true, expected() ?? null, options.unavailableReason?.() ?? '']));
  function reset() {
    ticket++; controller?.abort(); controller = undefined;
    basemap.value?.dispose(); basemap.value = null;
  }
  watch(key, async () => {
    reset(); message.value = '';
    if (options.enabled && !options.enabled()) return;
    const source = expected();
    if (!source) { message.value = options.unavailableReason?.() || '未提供可核验的 DEM 版本，未显示地形底图。'; return; }
    const owner = ticket, abort = new AbortController(); controller = abort;
    try {
      const image = await loadTerrainBasemap(source, globalThis.fetch, import.meta.env.BASE_URL, abort.signal);
      if (!alive || owner !== ticket) { image.dispose(); return; }
      basemap.value = image;
    } catch (error) {
      if (alive && owner === ticket && !abort.signal.aborted) message.value = error instanceof Error ? error.message : '地形底图加载失败。';
    }
  }, { immediate: true });
  onBeforeUnmount(() => { alive = false; reset(); });
  return { basemap, message };
}
