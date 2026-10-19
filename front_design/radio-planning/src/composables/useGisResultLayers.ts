import { computed, onScopeDispose, ref, watch } from 'vue';
import { defaultGisResultLayers, gisResultLayerRows, GIS_RESULT_LAYERS } from '../maps/gis-result-layers';
import type { GisResultLayerContext, GisResultLayerId, GisResultLayerSetting, GisResultLayerSettings } from '../maps/gis-result-layers';

export function useGisResultLayers(context: () => GisResultLayerContext, generation: () => number) {
  const settings = ref(defaultGisResultLayers()), epoch = ref(0);
  let disposed = false;
  const rows = computed(() => gisResultLayerRows(context(), settings.value));
  const rendered = computed<GisResultLayerSettings>(() => Object.fromEntries(rows.value.map(row =>
    [row.id, { visible: row.available && row.visible, opacity: row.opacity }])) as GisResultLayerSettings);
  // 模式暂停只屏蔽渲染，保留偏好；换身份才恢复默认，不读写浏览器存储。
  watch(generation, () => { settings.value = defaultGisResultLayers(); epoch.value++; }, { flush: 'sync' });
  watch(() => [context().mode, context().readable, context().paused, context().contextId], () => { epoch.value++; }, { flush: 'sync' });
  // 卸载后的控件闭包不再有资格修改本页显示偏好。
  onScopeDispose(() => { disposed = true; epoch.value++; });
  const change = computed(() => {
    const current = epoch.value;
    return (id: GisResultLayerId, patch: Partial<GisResultLayerSetting>) => {
      if (disposed || current !== epoch.value || !GIS_RESULT_LAYERS.some(row => row.id === id) || !rows.value.find(row => row.id === id)?.available) return;
      if (patch.visible !== undefined && typeof patch.visible !== 'boolean') return;
      if (patch.opacity !== undefined && (!Number.isFinite(patch.opacity) || patch.opacity < 0 || patch.opacity > 1)) return;
      settings.value[id] = { ...settings.value[id], ...patch };
    };
  });
  function enableCoverage() {
    const current = context();
    // 设备入口允许保留“暂无样例”的设备选择，仍由可用状态决定是否渲染。
    if (current.readable && current.mode === 'resource' && !current.paused) settings.value.coverage.visible = true;
  }
  return { rows, rendered, change, enableCoverage };
}
