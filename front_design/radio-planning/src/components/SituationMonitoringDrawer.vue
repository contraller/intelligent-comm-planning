<template>
  <section
    class="monitor-drawer panel"
    :class="{ collapsed: !store.open }"
    :style="{ '--monitor-height': height + 'px' }"
  >
    <div
      v-show="store.open"
      class="resize-handle"
      role="separator"
      tabindex="0"
      aria-label="调整态势抽屉高度"
      aria-orientation="horizontal"
      :aria-valuenow="height"
      :aria-valuemin="190"
      :aria-valuemax="500"
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
          <span class="chip blue">Mock 有限观测</span
          ><span
            >{{ state.finished ? '演示结束' : state.active ? '按序播放' : '已暂停' }} ·
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
          >预设采集时间 {{ observedAt ?? '暂无'
          }}<span v-if="readAt"> · 页面读取 {{ readAt }}</span></p
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
          <button
            v-if="gis.mapMode !== 'monitoring'"
            class="btn small"
            @click="store.showNetwork()"
            >在地图查看监控网络</button
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
        <SpectrumMonitoringPanel v-else />
      </template>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useMonitoringStore } from '../stores/monitoring';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import DeviceMonitoringPanel from './DeviceMonitoringPanel.vue';
import LinkMonitoringPanel from './LinkMonitoringPanel.vue';
import SpectrumMonitoringPanel from './SpectrumMonitoringPanel.vue';
const store = useMonitoringStore(),
  gis = useGisWorkspaceStore(),
  // 默认保留展开的监控内容，同时给地图留出更多高度。
  height = ref(220);
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
  if (id !== 'spectrum' && store.networkReadable) gis.mapMode = 'monitoring';
}
const clamp = (value: number) => Math.max(190, Math.min(500, value));
let drag: { y: number; height: number } | null = null;
// 分隔条支持鼠标/触控与方向键；不把高度写入业务工作区。
function begin(event: PointerEvent) {
  if (!store.open) return;
  drag = { y: event.clientY, height: height.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (drag) height.value = clamp(drag.height + drag.y - event.clientY);
}
function key(event: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  height.value =
    event.key === 'Home'
      ? 190
      : event.key === 'End'
        ? 500
        : clamp(height.value + (event.key === 'ArrowUp' ? 20 : -20));
}
</script>
<style scoped>
.monitor-drawer {
  position: relative;
  flex: 0 0 var(--monitor-height);
  height: var(--monitor-height);
  max-height: 60%;
  min-height: 190px;
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
