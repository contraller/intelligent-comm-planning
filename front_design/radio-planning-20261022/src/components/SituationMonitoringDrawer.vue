<template>
  <section
    ref="root"
    class="monitor-drawer panel"
    :class="{ collapsed: !store.open }"
    :style="{ '--monitor-height': availableHeight ? height + 'px' : '45%' }"
  >
    <div
      v-show="store.open"
      class="resize-handle"
      role="separator"
      tabindex="0"
      aria-label="调整态势抽屉高度"
      aria-orientation="horizontal"
      :aria-valuenow="height"
      :aria-valuemin="minimum"
      :aria-valuemax="maximum"
      @pointerdown="begin"
      @pointermove="move"
      @pointerup="drag = null"
      @pointercancel="drag = null"
      @lostpointercapture="drag = null"
      @keydown="key"
      ><span
    /></div>
    <div class="monitor-header"
      ><div class="tabs"
        ><button
          v-for="tab in tabs"
          :key="tab.id"
          :class="{ active: store.tab === tab.id }"
          @click="selectTab(tab.id)"
          >{{ tab.label }}</button
        ></div
      ><button
        class="icon-btn"
        :aria-label="store.open ? '收起态势抽屉' : '展开态势抽屉'"
        @click="store.open = !store.open"
        ><i
          class="pi"
          :class="store.open ? 'pi-angle-down' : 'pi-angle-up'" /></button
    ></div>
    <div
      v-show="store.open"
      class="monitor-body"
    >
      <p
        v-if="!readable"
        class="notice"
        >查看此态势需要 GIS 及{{ spectrum ? '资源' : '规划' }}查看权限。</p
      >
      <template v-else>
        <div class="playback-bar">
          <!-- 地图入口与回放操作同排，避免在纵向容器中被拉满整行。 -->
          <button
            v-if="!spectrum && gis.mapMode !== 'monitoring'"
            class="btn small network-map-action"
            title="在地图查看监控网络"
            aria-label="在地图查看监控网络"
            @click="store.showNetwork()"
            ><i
              class="pi pi-map"
              aria-hidden="true"
            />查看网络</button
          >
          <span class="chip blue">网络观测</span
          ><span
            >{{ state.finished ? '已到最后一帧' : state.active ? '观测回放' : '已暂停' }} ·
            {{ Math.max(0, state.index + 1) }} / {{ state.count }} 帧 ·
            {{ state.intervalSeconds }} 秒</span
          >
          <button
            class="btn small"
            :disabled="loading || state.busy"
            @click="refresh"
            >{{ loading || state.busy ? '读取中…' : '刷新' }}</button
          >
          <button
            class="btn small"
            :disabled="!state.active || state.busy || state.count === 0"
            @click="restart"
            >重新播放</button
          >
        </div>
        <p class="time-line"
          >采集时间 {{ observedAt ?? '暂无' }}<span v-if="readAt"> · 页面读取 {{ readAt }}</span></p
        >
        <p
          v-if="error"
          class="error"
          role="alert"
          >{{ error }}；最后有效观测保留，重试不会推进失败帧。</p
        >
        <template v-if="!spectrum">
          <p class="source-line"
            >{{ store.network?.name ?? '尚未加载网络' }} · {{ store.network?.version }} ·
            {{ store.context?.message }}</p
          >
          <p
            v-if="store.context?.source.state !== 'CURRENT'"
            class="notice"
            >历史 / 待核实监控快照：{{ store.context?.source.reasons.join('；') }}。刷新已暂停。</p
          >
          <template v-if="store.network && store.networkResult">
            <DeviceMonitoringPanel
              v-show="store.tab === 'devices'"
              :network="store.network"
              :frame="store.networkResult.frame"
              :selected-id="store.selectedDeviceId"
              @select="store.selectDevice"
            />
            <LinkMonitoringPanel
              v-show="store.tab === 'links'"
              :network="store.network"
              :frame="store.networkResult.frame"
              :selected-id="store.selectedLinkId"
              @select="store.selectLink"
              @select-station="store.selectStation"
            />
          </template>
          <p
            v-else
            class="notice"
            >{{
              loading
                ? '正在核实监控来源…'
                : store.context?.errorCode === 'NO_PRESET'
                  ? '当前网络暂无预生成监控数据'
                  : '暂无观测；请查看来源提示或点击刷新。'
            }}</p
          >
        </template>
        <SpectrumMonitoringPanel
          v-else-if="observations"
          :services="observations.services"
          :can-view="observations.canView"
          :can-import="observations.canImport"
          :session-generation="observations.sessionGeneration"
          :resource-revision="observations.resourceRevision"
        />
        <p
          v-else
          class="notice"
          >未提供观测读取上下文。</p
        >
      </template>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { useMonitoringStore } from '../stores/monitoring';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import DeviceMonitoringPanel from './DeviceMonitoringPanel.vue';
import LinkMonitoringPanel from './LinkMonitoringPanel.vue';
import SpectrumMonitoringPanel from './SpectrumMonitoringPanel.vue';
import type { ObservationServices } from '../types/observation';
// 旧包装不创建客户端；实际HTTP宿主已由独立冻结方案工作区单点提供上下文。
defineProps<{
  observations?: {
    services: ObservationServices;
    canView: boolean;
    canImport: boolean;
    sessionGeneration: string;
    resourceRevision?: string;
  };
}>();
const store = useMonitoringStore(),
  gis = useGisWorkspaceStore(),
  // 高度随中间容器计算；窗口变化保留比例，不写入业务工作区。
  share = ref(0.45);
const root = ref<HTMLElement | null>(null),
  availableHeight = ref(0);
const minimum = computed(() => Math.min(190, Math.max(100, availableHeight.value * 0.25)));
const maximum = computed(() =>
  Math.max(minimum.value, availableHeight.value - 12 - Math.min(240, availableHeight.value * 0.35)),
);
const clamp = (value: number) =>
  Math.round(Math.max(minimum.value, Math.min(maximum.value, value)));
const height = computed(() => clamp(availableHeight.value * share.value));
let observer: ResizeObserver | undefined;
onMounted(() => {
  const container = root.value?.parentElement;
  if (!container) return;
  const measure = () => {
    availableHeight.value = container.clientHeight;
  };
  measure();
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure);
    observer.observe(container);
  }
});
onBeforeUnmount(() => observer?.disconnect());
const tabs = [
  { id: 'devices', label: '设备监控态势' },
  { id: 'links', label: '通信链路态势' },
  { id: 'spectrum', label: '频谱态势' },
] as const;
const spectrum = computed(() => store.tab === 'spectrum');
const state = computed(() => (spectrum.value ? store.spectrumState : store.networkState));
const error = computed(() => (spectrum.value ? store.spectrumError : store.networkError));
const readable = computed(() => (spectrum.value ? store.spectrumReadable : store.networkReadable));
const observedAt = computed(() =>
  spectrum.value ? store.spectrumResult?.frame.observedAt : store.networkResult?.frame.observedAt,
);
const readAt = computed(() => (spectrum.value ? store.spectrumReadAt : store.networkReadAt));
const loading = computed(() => (spectrum.value ? store.spectrumLoading : store.networkLoading));
const refresh = () => (spectrum.value ? store.refreshSpectrum() : store.refreshNetwork());
const restart = () => (spectrum.value ? store.restartSpectrum() : store.restartNetwork());
function selectTab(id: typeof store.tab) {
  store.tab = id;
  store.open = true;
  // 切换统计页签不接管地图，查看网络仍走显式入口。
}
let drag: { y: number; height: number } | null = null;
// 分隔条支持鼠标/触控与方向键；不把高度写入业务工作区。
function begin(event: PointerEvent) {
  if (!store.open) return;
  drag = { y: event.clientY, height: height.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (drag && availableHeight.value)
    share.value = clamp(drag.height + drag.y - event.clientY) / availableHeight.value;
}
function key(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (availableHeight.value)
    share.value =
      (event.key === 'Home'
        ? minimum.value
        : event.key === 'End'
          ? maximum.value
          : clamp(height.value + (event.key === 'ArrowUp' ? 20 : -20))) / availableHeight.value;
}
</script>
<style scoped>
.monitor-drawer {
  position: relative;
  flex: 0 0 var(--monitor-height);
  height: var(--monitor-height);
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.monitor-drawer.collapsed {
  flex-basis: 44px;
  height: 44px;
  min-height: 44px;
}
.resize-handle {
  height: 8px;
  flex-shrink: 0;
  cursor: ns-resize;
  touch-action: none;
  display: flex;
  justify-content: center;
  align-items: center;
}
.resize-handle span {
  width: 52px;
  height: 3px;
  border-radius: 3px;
  background: #3b6687;
}
.resize-handle:focus-visible {
  outline: 2px solid #6bbfee;
  outline-offset: -2px;
}
.monitor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  min-height: 40px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
}
.tabs {
  gap: 16px;
  min-width: 0;
}
.tabs button {
  font-size: 12px;
  white-space: nowrap;
}
.monitor-body {
  flex: 1;
  padding: 12px 14px;
  overflow: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.playback-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #b5cee3;
}
.network-map-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  white-space: nowrap;
}
.time-line,
.source-line {
  font-size: 11px;
  color: #91acc5;
  overflow-wrap: anywhere;
  margin: 0;
}
.notice,
.error {
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
  padding: 8px;
}
.error {
  background: #392333;
  color: #ffb4b4;
}
.monitor-header .icon-btn {
  flex-shrink: 0;
}
@media (max-width: 1200px) {
  .tabs {
    gap: 8px;
  }
  .tabs button {
    font-size: 11px;
  }
  .monitor-body {
    padding: 10px;
  }
}
</style>
