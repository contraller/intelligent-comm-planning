import { computed, ref, watch } from 'vue';
import type { DeviceClass, ResourcesData } from '../types/domain';
import { defaultGisDeviceSettings, gisDevicePoints, GIS_DEVICE_FILTERS, GIS_DEVICE_TYPES, matchesGisDeviceState, sortGisDevices, visibleGisDevices } from '../maps/gis-device-display';
import type { GisDeviceLayerSetting, GisDeviceMapFrame, GisDeviceStateFilter, GisDeviceMapPoint } from '../maps/gis-device-display';

import { emptyDeviceFrequencyInput, emptyDeviceFrequencyFilter, parseDeviceFrequency, matchesDeviceFrequency } from '../services/device-frequency-filter';
import type { DeviceFrequencyInput } from '../services/device-frequency-filter';

interface DeviceDisplayContext {
  resources?: ResourcesData; map?: { points: GisDeviceMapPoint[]; missingCount: number }; stationIds: string[]; deviceIds?: string[]; enabled: boolean; readable: boolean;
  generation: number; sourceKey: string; selectedDeviceId: string;
}
export function useGisDeviceDisplay(context: () => DeviceDisplayContext) {
  const settings = ref(defaultGisDeviceSettings()), state = ref<GisDeviceStateFilter>('ALL');
  const frequencyInput = ref(emptyDeviceFrequencyInput()), frequency = ref(emptyDeviceFrequencyFilter());
  const frequencyError = ref(''), frequencyNotice = ref('');
  const parsedFrequency = computed(() => parseDeviceFrequency(frequencyInput.value));
  const frequencyPending = computed(() => !parsedFrequency.value.ok
    || JSON.stringify(parsedFrequency.value.value) !== JSON.stringify(frequency.value));
  function resetFrequency() {
    frequencyInput.value = emptyDeviceFrequencyInput(); frequency.value = emptyDeviceFrequencyFilter();
    frequencyError.value = ''; frequencyNotice.value = '';
  }
  const clusterIds = ref<string[]>([]), clusterRevision = ref(0), version = ref(0), epoch = ref(0);
  const available = computed(() => context().enabled && context().readable);
  const resources = computed(() => context().resources);
  // 稳定筛选键避免仅切换选中设备时重新生成整批点位和显示版本。
  const stationKey = computed(() => context().stationIds.join('\0'));
  // 未指定设备范围表示全部设备；空范围表示检索无匹配。
  const deviceKey = computed(() => context().deviceIds?.join('\0'));
  const mapInput = computed(() => context().map);
  // 浏览直接使用地图 DTO；只有编辑草稿才从完整资源投影。
  const catalog = computed(() => mapInput.value ?? (resources.value ? gisDevicePoints(resources.value) : { points: [], missingCount: 0 }));
  // 与地图共用资源上下文：编辑态是已应用草稿，未应用的表单输入不参与。
  const frequencySources = computed(() => new Map(catalog.value.points.map(point => [point.id, point])));
  const points = computed(() => {
    if (!available.value) return [];
    const ids = deviceKey.value === undefined ? null : new Set(deviceKey.value.split('\0'));
    return visibleGisDevices(catalog.value.points, stationKey.value.split('\0'), settings.value, state.value)
      .filter(row => (!ids || ids.has(row.id)) && matchesDeviceFrequency(frequencySources.value.get(row.id)!, frequency.value));
  });
  const frame = computed<GisDeviceMapFrame | undefined>(() => available.value ? {
    points: points.value, settings: settings.value, version: version.value, selectedDeviceId: context().selectedDeviceId,
  } : undefined);
  const members = computed(() => sortGisDevices(points.value.filter(row => clusterIds.value.includes(row.id))));
  const hiddenSelection = computed(() => available.value && !!context().selectedDeviceId
    && !points.value.some(row => row.id === context().selectedDeviceId));
  function close() { clusterIds.value = []; clusterRevision.value++; }
  // 模式往返只关闭清单，身份变化才复位偏好；不写浏览器存储。
  watch([() => context().enabled, () => context().readable, () => context().generation, () => context().sourceKey], () => { epoch.value++; close(); }, { flush: 'sync' });
  watch(() => context().generation, () => { settings.value = defaultGisDeviceSettings(); state.value = 'ALL'; resetFrequency(); }, { flush: 'sync' });
  watch([points, settings], () => {
    version.value++;
    const valid = new Set(points.value.map(row => row.id));
    clusterIds.value = clusterIds.value.filter(id => valid.has(id));
  }, { deep: true, flush: 'sync' });
  const configure = computed(() => {
    const token = epoch.value;
    return (type: DeviceClass, patch: Partial<GisDeviceLayerSetting>) => {
      if (token !== epoch.value || !available.value || !GIS_DEVICE_TYPES.includes(type)) return;
      if (patch.visible !== undefined && typeof patch.visible !== 'boolean') return;
      if (patch.opacity !== undefined && (!Number.isFinite(patch.opacity) || patch.opacity < 0 || patch.opacity > 1)) return;
      settings.value[type] = { visible: patch.visible ?? settings.value[type].visible, opacity: patch.opacity ?? settings.value[type].opacity };
    };
  });
  const filter = computed(() => {
    const token = epoch.value;
    return (value: GisDeviceStateFilter) => {
      if (token === epoch.value && available.value && GIS_DEVICE_FILTERS.some(row => row.value === value)
        && !['UNKNOWN', 'UNKNOWN_ALERT'].includes(value)) state.value = value;
    };
  });
  // 和原图层操作一样校验上下文代次，拒绝模式/身份切换前留下的事件。
  const frequencyActions = computed(() => {
    const token = epoch.value;
    const current = () => token === epoch.value && available.value;
    return {
      update(value: DeviceFrequencyInput) {
        if (!current()) return;
        frequencyInput.value = { ...value }; frequencyError.value = ''; frequencyNotice.value = '';
      },
      apply() {
        if (!current()) return;
        const parsed = parsedFrequency.value;
        if (!parsed.ok) { frequencyError.value = parsed.error; return; }
        frequency.value = parsed.value; frequencyError.value = ''; frequencyNotice.value = '';
      },
      clear() { if (current()) resetFrequency(); },
    };
  });
  function open(ids: string[], revision: number) {
    if (!available.value || revision !== version.value) return false;
    const valid = new Set(points.value.map(row => row.id)), unique = [...new Set(ids)];
    if (unique.length < 2 || unique.some(id => !valid.has(id))) return false;
    clusterIds.value = unique; clusterRevision.value++; return true;
  }
  function capture(id: string, revision: number, listRevision?: number) {
    const token = epoch.value, original = points.value.find(row => row.id === id);
    if (!available.value || revision !== version.value || !original) return;
    // 地图 DTO 可原位更新，确认前必须冻结原归属值，不能持有可变对象作比较。
    const stationId = original.stationId, modelId = original.modelId;
    // 确认编辑后允许读取更新后的有效草稿，但不能跨身份、模式、来源或设备归属。
    const current = () => {
      if (token !== epoch.value || !available.value || (listRevision !== undefined
        && (listRevision !== clusterRevision.value || !clusterIds.value.includes(id)))) return;
      return points.value.find(row => row.id === id && row.stationId === stationId && row.modelId === modelId);
    };
    return current() ? current : undefined;
  }
  function reveal(id: string) {
    const point = catalog.value.points.find(row => row.id === id);
    if (!available.value || !point) return;
    const setting = settings.value[point.deviceClass];
    setting.visible = true; if (setting.opacity === 0) setting.opacity = 1;
    if (!matchesGisDeviceState(point, state.value)) state.value = 'ALL';
    // 仅明确定位解除阻挡；保留输入供重新应用，不让普通筛选自动恢复目标。
    if (!matchesDeviceFrequency(frequencySources.value.get(id)!, frequency.value)) {
      frequency.value = emptyDeviceFrequencyFilter();
      frequencyNotice.value = '已为定位目标解除频率限制，原频率输入已保留，可重新应用。';
    }
  }
  return { settings, state, available, catalog, points, frame, members, clusterRevision, hiddenSelection,
    configure, filter, open, close, capture, reveal, frequencyInput, frequency, frequencyPending,
    frequencyError, frequencyNotice, frequencyActions };
}
