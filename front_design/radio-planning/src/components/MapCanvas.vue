<template>
  <div
    class="map-wrap"
    :class="{ compact, picking }"
  >
    <!-- 地图本体可直接获得键盘焦点，沿用 OpenLayers 的平移和缩放，不自动抢焦点。 -->
    <div
      ref="host"
      class="map-host"
      tabindex="0"
      role="region"
      @pointerdown.capture="startPick"
      @pointerleave="clearPickHover"
      :aria-label="
        resourceRead
          ? '资源地图，可拖动、缩放并选择资源或聚合点；方向键平移，加减键缩放'
          : '太行山地区域地图，可拖动、缩放并选择节点；方向键平移，加减键缩放'
      "
    />
    <div
      v-if="picking"
      :key="gisPick?.key"
      class="pick-notice"
      >标绘模式：{{ pickLabel ?? '资源' }}：点击地图选择位置
      <!-- 对象形式绑定保留当次控件闭包，旧 DOM 事件不能转调新会话。 -->
      <label v-if="gisPick"
        ><input
          type="checkbox"
          :checked="gisPick.enabled"
          :disabled="!pickActive"
          v-on="{ change: pickControls.toggle }"
        />位置吸附</label
      >
      <span
        v-if="gisPick && !pickActive"
        role="status"
        >当前不可取点，原输入已保留。</span
      >
      <span
        v-else-if="pickHover"
        role="status"
        >{{ pickTargetLabel(pickHover) }} · 点击使用该位置</span
      >
      <span v-else-if="gisPick?.enabled && pickClustered"
        >聚合站点请放大后吸附，也可直接自由取点。</span
      >
      <button
        class="btn small"
        :disabled="!!gisPick && !pickActive"
        v-on="{ click: pickControls.cancel }"
        >取消取点并返回表单（Esc）</button
      >
    </div>
    <div class="map-caption"
      ><span class="map-dot" /> WGS84
      <span>{{ resourceRead ? terrainBasemap ? 'DEM 地形与本地道路' : '本地道路底图' : '本地演示地图' }}</span></div
    >
    <div
      v-if="planningCandidates?.visible && planningCandidates.points.some((row) => row.coordinate)"
      class="candidate-map-legend"
      >候选筛选结论：◇可 可部署 · ◇× 不可部署 · ◇? 未提供</div
    >
    <div
      v-if="deploymentConstraints?.constraints"
      class="deployment-map-legend"
      >输入约束 · {{ deploymentConstraints.label }} · 青色点 / 粉色禁区
      <button
        class="btn small"
        :disabled="!deploymentDrawable"
        @click="fitDeployment"
        >查看部署约束</button
      ></div
    >
    <button
      class="map-reset btn small"
      :title="resourceRead ? '返回资源范围' : '显示全部节点'"
      @click="fit"
    >
      <i class="pi pi-expand" />全域
    </button>
    <div
      v-if="!resourceRead"
      class="map-watermark"
      >太 行 山 地 区<span>TAIHANG REGION · DEMO</span></div
    >
    <div
      v-if="roadError"
      class="map-error"
      >本地道路加载失败；节点仍可浏览，请检查 maps 资源。</div
    >
    <div v-if="terrainRenderError" class="map-error terrain-render-error" role="status"
      >DEM 地形图像加载失败；站点和链路仍可浏览。</div
    >
    <div
      v-if="mockCoverage && coverageShown && ['loading', 'error'].includes(mockCoverageState)"
      class="mock-coverage-notice"
      role="status"
    >
      {{ mockCoverageState === 'loading' ? '教学场强图加载中…' : '教学场强图加载失败。' }}
      {{ mockCoverage.contour?.features.length ? '已保留覆盖轮廓。' : '此结果未提供覆盖轮廓。' }}
      <button
        v-if="mockCoverageState === 'error'"
        class="text-link"
        @click="retryMockCoverage"
        >重试场强图</button
      >
    </div>
    <div
      v-if="
        resourceRead &&
        planningOverlay?.coverage &&
        showCoverage &&
        coverageDisplay !== 'contour' &&
        (coverageImage.loading.value ||
          coverageImage.error.value ||
          rasterRenderState === 'loading' ||
          rasterRenderError)
      "
      class="map-error"
      >{{
        coverageImage.loading.value || rasterRenderState === 'loading'
          ? '覆盖图层加载中…'
          : coverageImage.error.value || '覆盖 PNG 显示失败'
      }}{{
        planningOverlay.coverage.contour?.features.length
          ? ' 已保留覆盖轮廓。'
          : ' 未提供覆盖轮廓。'
      }}<button
        v-if="!coverageImage.loading.value && rasterRenderState !== 'loading'"
        class="text-link"
        @click="coverageImage.retry()"
        >重试覆盖图片</button
      ></div
    >
    <div
      v-if="planningOverlay?.coverage?.rasterPng"
      class="coverage-legend"
      ><span>场强 / dBμV/m</span
      ><span
        v-for="c in planningOverlay.coverage.rasterPng.colormap"
        :key="c.value_dbuvm"
        ><b
          :style="{ background: `rgba(${c.rgba[0]},${c.rgba[1]},${c.rgba[2]},${c.rgba[3] / 255})` }"
        />{{ c.value_dbuvm }}</span
      ></div
    >
    <!-- 仅态势页启用折叠入口；展开只改变说明显示，不操作地图或业务图层。 -->
    <button
      v-if="collapsibleLegend && !resourceRead"
      class="map-legend-toggle btn small"
      :aria-expanded="legendOpen"
      :aria-label="legendOpen ? '收起地图图例' : '展开地图图例'"
      @click="legendOpen = !legendOpen"
      ><i class="pi pi-list" />图例<i
        class="pi"
        :class="legendOpen ? 'pi-angle-down' : 'pi-angle-up'"
    /></button>
    <div
      v-if="resourceRead"
      class="map-legend"
      ><span>数字圆点：资源聚合</span><span><b class="normal" />正常</span
      ><span><b class="warn" />告警 / 生效干扰源</span><span><b class="fault" />故障</span
      ><span><b class="offline" />离线 / 未生效</span><span>？告警未提供</span></div
    >
    <div
      v-else-if="!collapsibleLegend || legendOpen"
      class="map-legend mock-legend"
      :class="{ 'collapsible-legend': collapsibleLegend }"
    >
      <template
        v-if="deviceCoverageActive && coverageShown && (!gisLayers || visibleDevices.length)"
      >
        <span>设备覆盖 · Mock 教学示意</span>
        <span
          v-for="row in visibleDevices"
          :key="row.sample.snapshotId"
          ><i
            class="link-key"
            :style="{ borderTopColor: row.sample.color }"
          />{{ row.sample.deviceId }}</span
        >
        <span
          v-for="(color, index) in (gisLayers ? visibleDevices[0] : deviceCoverages[0])?.sample
            .coverage.rasterPng?.colormap ?? []"
          :key="color.value_dbuvm"
          ><b
            :style="{
              background: `rgba(${color.rgba[0]},${color.rgba[1]},${color.rgba[2]},${color.rgba[3] / 255})`,
            }"
          />{{ ['弱', '中', '强'][index] }} {{ color.value_dbuvm }} dBμV/m</span
        >
        <span>紫：本设备盲区 · 灰：未计算</span>
        <span>重叠色不代表合成场强</span>
      </template>
      <template v-if="mockCoverage?.rasterPng && coverageShown">
        <span>Mock 教学场强图 / dBμV/m</span>
        <span
          v-for="(color, index) in mockCoverage.rasterPng.colormap"
          :key="color.value_dbuvm"
          ><b
            :style="{
              background: `rgba(${color.rgba[0]},${color.rgba[1]},${color.rgba[2]},${color.rgba[3] / 255})`,
            }"
          />{{ ['弱', '中', '强'][index] }} {{ color.value_dbuvm }}</span
        >
        <span>盲区 / 未计算区域保留</span>
      </template>
      <span><b class="normal" />正常</span><span><b class="warn" />正常＋告警</span
      ><span><b class="fault" />故障</span><span><b class="offline" />离线</span
      ><span
        v-if="coverageLegend"
        class="region-key"
        >▱ 覆盖 / 盲区 / 未计算</span
      >
      <span v-if="illustrationLegend">▱ 原有影响示意区域</span>
      <span v-if="devicePointFrame && showNodes">站点参考圆点：节点数</span>
      <!-- 观测图例只用于显式接入的普通 GIS 设备帧。 -->
      <template v-if="devicePointFrame?.statusSource"
        ><span>设备状态：{{ devicePointFrame.statusSource }}</span
        ><span>灰紫：状态/告警未提供</span><span>节点状态：台账基线</span></template
      >
      <template v-if="devicePointFrame && devicePointSummary.count">
        <span
          v-if="devicePointSummary.HF"
          :style="{ opacity: devicePointFrame.settings.HF.opacity }"
          >◇ 短波设备 HF</span
        >
        <span
          v-if="devicePointSummary.VUHF"
          :style="{ opacity: devicePointFrame.settings.VUHF.opacity }"
          >□ 超短波设备 VUHF</span
        >
        <span>设备聚合数字：台数 · 点击查看清单</span
        ><span>设备状态独立于站点，告警为附加标记</span>
      </template>
      <!-- 链路线段与节点圆点分开展示，图例随已有图层开关显隐。 -->
      <template v-if="topologyShown && links.length">
        <span v-if="topologySimplified">拓扑已简化</span>
        <span
          v-for="(status, key) in LINK_STATUS_STYLES"
          :key="key"
          ><i
            class="link-key"
            :style="{ borderTopColor: status.color, borderTopWidth: `${status.width}px` }"
          />链路 · {{ status.label }}</span
        >
        <span v-if="links.some((link) => link.backup)"><i class="link-key dashed" />备用链路</span>
      </template>
      <span v-if="showCandidates && (candidateWorkset ?? candidateLinks).length"
        ><i class="link-key candidate" />候选链路<span v-if="candidateWorkset !== undefined">
          · 非当前评估</span
        ></span
      >
      <span v-if="interferences.length && showInterferences">● 干扰源点位</span
      ><span v-if="resourceMarkers">金色外框：手工站点</span>
      <span v-if="demands.length && showDemands">┄ 任务需求</span>
      <!-- 注入场景图例与设备运行状态、影响等级各自表达。 -->
      <template v-if="diagnosisFaults.length"
        ><span
          v-for="item in diagnosisFaultTypes"
          :key="item.type"
          :style="{ color: item.color }"
          >{{ item.glyph }} 场景注入 · {{ item.label }}</span
        ></template
      >
      <span v-if="interferenceImpact && !gisLayers">干扰：严重 / 中等 / 轻微</span>
      <span v-if="interferenceRegionLegend"
        >{{ gisLayers ? '干扰分析区域' : '干扰影响区域' }}：<b
          :style="{ background: interferenceRegionColors.SEVERE }"
        />严重 / <b :style="{ background: interferenceRegionColors.MODERATE }" />中等 /
        <b :style="{ background: interferenceRegionColors.MINOR }" />轻微</span
      >
      <span v-if="interferenceObjectsLegend">受扰对象：严重 / 中等 / 轻微</span>
      <span v-if="diagnosisRegions.length && !gisLayers">影响：严重 / 中等 / 轻微</span>
      <span
        v-for="item in diagnosisLegend"
        :key="item.level ?? 'unknown'"
        ><b :style="{ background: item.color }" />诊断影响区域 · {{ item.label }}</span
      >
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { unByKey } from 'ol/Observable';
import type { EventsKey } from 'ol/events';
import type {
  GisPickContext,
  GisPickResult,
  GisPickTarget,
  GisPickToggle,
} from '../types/gis-pick';
import {
  createPickHighlight,
  nearestPickTarget,
  pickTargetLabel,
  renderedPickTargets,
  validPickCoordinate,
} from '../maps/gis-pick';
import { splitGisRegions, type GisResultLayerSettings } from '../maps/gis-result-layers';
import { createGisDeviceLayer } from '../maps/gis-device-layers';
import { createPlanningCandidateLayer } from '../maps/planning-candidate-layers';
import { createDeploymentConstraintLayer } from '../maps/deployment-constraint-layers';
import type { DeploymentConstraintFrame } from '../types/deployment-constraints';
import type { CandidateMapFrame, CandidateSelection } from '../types/planning-candidates';
import { candidateEndpoints, candidateLinkLayer } from '../maps/candidate-link-layers';
import type { CandidateLink } from '../types/candidate-link';
import { gisDeviceSummary, type GisDeviceMapFrame } from '../maps/gis-device-display';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { createFaultPulse, shouldDisplayLink, type LinkDisplayState } from '../maps/link-display';
import type { InterferenceImpact } from '../types/interference';
import { interferenceImpactLayers, interferenceRegionColors } from '../maps/interference-layers';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import { defaults, ScaleLine } from 'ol/control';
import { boundingExtent } from 'ol/extent';
import { resourceReadLayer, resourceViewport } from '../maps/resource-read-layers';
import { planningApiLayer, type PlanningMapOverlay } from '../maps/planning-api-layers';
import { coverageLayers, type CoverageImageState } from '../maps/coverage-layers';
import {
  createMockCoverageLayers,
  type MockCoverageDisplay,
  type MockCoverageState,
} from '../maps/mock-coverage-layers';
import type { CoverageDisplay, PlanningCoverage } from '../types/coverage';
import type { DeviceCoverageOverlay } from '../types/device-coverage';
import { createDeviceCoverageLayers } from '../maps/device-coverage-layers';
import { usePlanningCoverage } from '../composables/usePlanningCoverage';
import type {
  Bounds,
  ResourceMapCluster,
  ResourceMapFrame,
  ResourceMapPoint,
} from '../types/resource-read';
import type {
  Station,
  NetworkLink,
  MapRegion,
  Device,
  Coordinate,
  InterferenceSource,
} from '../types/domain';
import type { DiagnosisRegion, FaultInput } from '../types/diagnosis';
import { diagnosisFaultLayer, diagnosisRegionLayer } from '../maps/diagnosis-layers';
import { diagnosisFaultTypes } from '../services/diagnosis-display';
import { interferenceLayer, resourcePickLayer } from '../maps/resource-layers';
import type { PlanningDemand } from '../types/planning';
import type { TerrainBasemap } from '../services/terrain-basemap';
import {
  roadLayer,
  nodeLayer,
  linkLayer,
  regionLayer,
  projectCoordinate,
  unprojectCoordinate,
  demandLayer,
} from '../maps/layers';

const props = withDefaults(
  defineProps<{
    stations: Station[];
    resourceRead?: boolean;
    planningOverlay?: PlanningMapOverlay | null;
    terrainBasemap?: TerrainBasemap | null;
    planningCandidates?: CandidateMapFrame;
    deploymentConstraints?: DeploymentConstraintFrame | null;
    coverageDisplay?: CoverageDisplay;
    mockCoverage?: PlanningCoverage;
    mockCoverageDisplay?: MockCoverageDisplay;
    deviceCoverageActive?: boolean;
    deviceCoverages?: DeviceCoverageOverlay[];
    deviceCoverageDisplay?: MockCoverageDisplay;
    planningContext?: 'gis' | 'planning';
    resourceFrame?: ResourceMapFrame | null;
    resourceBounds?: Bounds;
    resourceSelectedKind?: string;
    interferenceImpact?: InterferenceImpact | null;
    interferences?: InterferenceSource[];
    showInterferences?: boolean;
    selectedInterferenceId?: string;
    picking?: boolean;
    gisPick?: GisPickContext;
    pickLabel?: string;
    pickPreview?: Coordinate;
    resourceMarkers?: boolean;
    links?: NetworkLink[];
    candidateLinks?: NetworkLink[];
    candidateWorkset?: CandidateLink[];
    candidateStations?: Station[];
    selectedCandidateLinkId?: string;
    regions?: MapRegion[];
    selectedId?: string;
    selectedLinkId?: string;
    selectLinks?: boolean;
    diagnosisFaults?: FaultInput[];
    diagnosisRegions?: DiagnosisRegion[];
    diagnosisDevices?: Device[];
    demands?: PlanningDemand[];
    selectedDemandId?: string;
    showDemands?: boolean;
    highlightStationIds?: string[];
    highlightLinkIds?: string[];
    showRoads?: boolean;
    showNodes?: boolean;
    showLinks?: boolean;
    topologyOpacity?: number;
    showCoverage?: boolean;
    gisResultLayers?: GisResultLayerSettings;
    gisDeviceFrame?: GisDeviceMapFrame;
    showCandidates?: boolean;
    opacity?: number;
    compact?: boolean;
    // 显式接入后才收起图例，其他地图调用维持原显示方式。
    collapsibleLegend?: boolean;
  }>(),
  {
    resourceRead: false,
    resourceFrame: null,
    planningOverlay: null,
    terrainBasemap: null,
    planningContext: 'planning',
    coverageDisplay: 'auto',
    mockCoverageDisplay: 'auto',
    deviceCoverageActive: false,
    deviceCoverages: () => [],
    deviceCoverageDisplay: 'auto',
    interferenceImpact: null,
    interferences: () => [],
    showInterferences: true,
    picking: false,
    resourceMarkers: false,
    links: () => [],
    candidateLinks: () => [],
    regions: () => [],
    demands: () => [],
    showDemands: true,
    highlightStationIds: () => [],
    highlightLinkIds: () => [],
    selectLinks: false,
    diagnosisFaults: () => [],
    diagnosisRegions: () => [],
    diagnosisDevices: () => [],
    showRoads: true,
    showNodes: true,
    showLinks: true,
    showCoverage: true,
    showCandidates: false,
    opacity: 0.8,
    collapsibleLegend: false,
  },
);
const emit = defineEmits<{
  selectPlanningCandidate: [selection: CandidateSelection];
  gisPick: [result: GisPickResult];
  gisPickCancel: [key: string];
  gisPickToggle: [event: GisPickToggle];
  selectCandidateLink: [id: string];
  selectDevice: [id: string, version: number];
  selectDeviceCluster: [ids: string[], version: number];
  viewport: [bbox: Bounds, zoom: number];
  deviceCoverageState: [snapshotId: string, state: MockCoverageState];
  selectResource: [point: ResourceMapPoint];
  selectCluster: [cluster: ResourceMapCluster];
  selectDemand: [id: string];
  pick: [coordinate: Coordinate];
  cancelPick: [];
  selectInterference: [id: string];
  select: [id: string];
  selectLink: [id: string];
  selectFault: [type: FaultInput['objectType'], id: string];
}>();
const host = ref<HTMLDivElement>();
const legendOpen = ref(false);
// 设备实例层只由普通 Mock GIS 传入，站点参考点及旧页面继续使用原图层。
const devicePoints = createGisDeviceLayer();
// 候选有独立图层和事件身份，选择/筛选只更新本层。
const planningCandidatePoints = createPlanningCandidateLayer();
// 输入约束有独立生命周期；地图操作只调整显示范围。
const deploymentLayer = createDeploymentConstraintLayer(),
  deploymentDrawable = ref(false);
function updateDeployment() {
  deploymentLayer.update(props.deploymentConstraints);
  deploymentDrawable.value = !!deploymentLayer.extent();
}
function fitDeployment() {
  const extent = deploymentLayer.extent();
  if (pickAlive && props.deploymentConstraints && extent)
    map?.getView().fit(extent, { padding: [70, 70, 70, 70], maxZoom: 14, duration: 250 });
}
type CandidatePress = Pick<CandidateSelection, 'owner' | 'epoch'>;
let candidatePress: CandidatePress | undefined;
const candidateClicks = new WeakMap<object, CandidatePress>();
const devicePointFrame = computed(() => (props.resourceRead ? undefined : props.gisDeviceFrame));
const devicePointSummary = computed(() => gisDeviceSummary(devicePointFrame.value?.points ?? []));
// 独立控制仅供 Mock GIS 选择接入；规划、诊断和 HTTP 调用保留原显隐语义。
const gisLayers = computed(() => (props.resourceRead ? undefined : props.gisResultLayers));
// 不设默认值，只有显式接入的 Mock GIS 才将链路高亮纳入同一显示偏好。
const topologyEnabled = computed(() => !props.resourceRead && props.topologyOpacity !== undefined);
const topologyShown = computed(
  () => props.showLinks && (!topologyEnabled.value || props.topologyOpacity! > 0),
);
const impactObjectCounts = ref({ nodes: 0, links: 0 });
const interferenceObjectsLegend = computed(
  () =>
    gisLayers.value &&
    (topologyEnabled.value
      ? impactObjectCounts.value.nodes > 0 ||
        (topologyShown.value && impactObjectCounts.value.links > 0)
      : !!(props.interferenceImpact?.nodes.length || props.interferenceImpact?.links.length)),
);
const coverageSetting = computed(
  () => gisLayers.value?.coverage ?? { visible: props.showCoverage, opacity: props.opacity },
);
const coverageShown = computed(
  () => coverageSetting.value.visible && (!gisLayers.value || coverageSetting.value.opacity > 0),
);
const visibleDevices = computed(() =>
  props.deviceCoverages.filter((row) => row.visible && (!gisLayers.value || row.opacity > 0)),
);
const coverageLegend = computed(
  () =>
    !gisLayers.value ||
    (coverageShown.value &&
      (props.deviceCoverageActive
        ? visibleDevices.value.length > 0
        : !!props.mockCoverage || splitGisRegions(props.regions).coverage.length > 0)),
);
const illustrationLegend = computed(
  () =>
    gisLayers.value?.illustration.visible &&
    gisLayers.value.illustration.opacity > 0 &&
    splitGisRegions(props.regions).illustration.length > 0,
);
const interferenceLegend = computed(
  () =>
    gisLayers.value?.interference.visible &&
    gisLayers.value.interference.opacity > 0 &&
    !!props.interferenceImpact?.regions.length,
);
// 区域图例与实际渲染共用色表；共用预览沿用原覆盖开关和透明度。
const interferenceRegionLegend = computed(
  () =>
    interferenceLegend.value ||
    (!gisLayers.value &&
      props.showCoverage &&
      props.opacity > 0 &&
      !!props.interferenceImpact?.regions.length),
);
// 诊断页未传 GIS 设置时沿用原区域语义；GIS 的零透明度同时隐藏区域与图例。
const diagnosisSetting = computed(
  () => gisLayers.value?.diagnosis ?? { visible: true, opacity: props.opacity },
);
const diagnosisShown = computed(
  () => diagnosisSetting.value.visible && (!gisLayers.value || diagnosisSetting.value.opacity > 0),
);
const diagnosisLegend = computed(() =>
  gisLayers.value && diagnosisShown.value
    ? [
        { level: 'SEVERE', label: '严重', color: '#ef8799' },
        { level: 'MODERATE', label: '中等', color: '#efc16b' },
        { level: 'MINOR', label: '轻微', color: '#72c5df' },
        { level: null, label: '未提供等级', color: '#b8c4d5' },
      ].filter((item) => props.diagnosisRegions.some((region) => region.level === item.level))
    : [],
);
// 设备图层独立收集加载状态，单台失败不影响其他样例。
const deviceLayers = createDeviceCoverageLayers((id, state) =>
  emit('deviceCoverageState', id, state),
);
const roadError = ref(false);
const terrainRenderError = ref(false);
let terrainLayer: ImageLayer<ImageStatic> | null = null;
let terrainKey: TerrainBasemap | null = null;
// HTTP 图片取得后仍需等待地图解码；失败时保留同一图层供轮廓回退。
const rasterRenderState = ref<CoverageImageState>('idle');
const rasterRenderError = computed(() => rasterRenderState.value === 'error');
const mockCoverageState = ref<MockCoverageState>('idle');
const topologySimplified = ref(false);
const linkDisplay: LinkDisplayState = { zoom: 9, faultDimmed: false };
let renderedLinks: ReturnType<typeof linkLayer> | null = null;
let renderedCandidates: ReturnType<typeof candidateLinkLayer> | null = null;
let renderedImpactLinks: ReturnType<typeof interferenceImpactLayers>['linkObjects'];
let faultPulse: ReturnType<typeof createFaultPulse> | null = null;
let mockCoverageLayers: ReturnType<typeof createMockCoverageLayers> | null = null;
let mockCoverageKey: PlanningCoverage | undefined;
const coverageImage = usePlanningCoverage(
  () => props.planningOverlay?.coverage,
  () => props.planningOverlay?.snapshotId,
  () => props.planningContext,
);
let map: Map | undefined;
const pickHighlight = createPickHighlight(),
  pickHover = ref<GisPickTarget>();
const pickEpoch = ref(0),
  pickClustered = ref(false);
let pickAlive = true,
  pickNodes: ReturnType<typeof nodeLayer> | undefined,
  pickSources: ReturnType<typeof interferenceLayer> | undefined;
let pickClusterListener: EventsKey | undefined;
const pickViewListeners: EventsKey[] = [];
function clearPickHover() {
  pickEpoch.value++;
  pickHover.value = undefined;
  pickHighlight.update();
}
const pickActive = computed(
  () => pickAlive && !props.resourceRead && props.picking && props.gisPick?.active,
);
const pickControls = computed(() => {
  const key = props.gisPick?.key,
    epoch = pickEpoch.value;
  const valid = () =>
    pickAlive && pickActive.value && key === props.gisPick?.key && epoch === pickEpoch.value;
  return {
    cancel: () => {
      if (key !== undefined) {
        if (valid()) emit('gisPickCancel', key);
      } else if (pickAlive && props.picking) emit('cancelPick');
    },
    toggle: (event: Event) => {
      if (key !== undefined && valid())
        emit('gisPickToggle', { key, enabled: (event.target as HTMLInputElement).checked });
    },
  };
});
function pickAt(pixel: number[]) {
  if (!pickAlive || !map || !pickActive.value || !props.gisPick?.enabled) return;
  const clusters = pickNodes?.getSource()?.getFeatures() ?? [];
  pickClustered.value =
    props.showNodes && clusters.some((feature) => (feature.get('features')?.length ?? 0) > 1);
  const targets = renderedPickTargets(
    props.gisPick.targets,
    clusters,
    pickSources?.getSource()?.getFeatures() ?? [],
    props.showNodes && !!pickNodes?.getVisible(),
    props.showInterferences && !!pickSources?.getVisible(),
  );
  return nearestPickTarget(
    pixel,
    targets,
    props.gisPick.owner,
    (coordinate) => map!.getPixelFromCoordinate(projectCoordinate(coordinate)),
    map.getSize() ?? [],
  );
}
// OL 的 singleclick 延迟 250ms；把按下时的会话归属保存在同次 click 的原事件上。
type PickPress = { key?: string; epoch: number; picking: boolean };
let pickPress: PickPress | undefined;
const pickClicks = new WeakMap<object, PickPress>();
function startPick() {
  if (props.gisPick)
    pickPress = { key: props.gisPick.key, epoch: pickEpoch.value, picking: props.picking };
  if (props.planningCandidates)
    candidatePress = {
      owner: props.planningCandidates.owner,
      epoch: props.planningCandidates.epoch,
    };
}
watch(() => [props.gisPick, props.picking], clearPickHover, { deep: true, flush: 'sync' });
let observer: ResizeObserver | undefined;
let renderedCoverage: ReturnType<typeof coverageLayers> | null = null;
let coverageKey: { value: PlanningMapOverlay['coverage']; url: string } | null = null;
const roads = roadLayer();
roads.getSource()?.on('featuresloaderror', () => {
  roadError.value = true;
});
function paint() {
  if (!map) return;
  clearPickHover();
  pickClustered.value = false;
  if (pickClusterListener) unByKey(pickClusterListener);
  pickClusterListener = undefined;
  pickNodes = undefined;
  pickSources = undefined;
  // 清空结果后失效旧图片回调；仅切换页签时仍复用该快照的图层。
  if (!props.resourceRead || !props.planningOverlay?.coverage) {
    renderedCoverage = null;
    coverageKey = null;
    rasterRenderState.value = 'idle';
  }
  devicePoints.update(devicePointFrame.value);
  planningCandidatePoints.update(props.planningCandidates);
  updateDeployment();
  if (props.resourceRead) {
    // HTTP 使用原图层，切换后释放 Mock 动画的当前目标。
    renderedLinks = null;
    renderedCandidates = null;
    renderedImpactLinks = undefined;
    impactObjectCounts.value = { nodes: 0, links: 0 };
    updateLinkDisplay();
    roads.setVisible(props.showRoads);
    if (props.terrainBasemap !== terrainKey) {
      terrainKey = props.terrainBasemap ?? null;
      terrainRenderError.value = false;
      terrainLayer = terrainKey ? new ImageLayer({ source: new ImageStatic({
        url: terrainKey.url, imageExtent: terrainKey.extent, projection: 'EPSG:4326',
      }) }) : null;
      const source = terrainLayer?.getSource();
      source?.on('imageloaderror', () => {
        if (terrainLayer?.getSource() === source) terrainRenderError.value = true;
      });
      source?.on('imageloadend', () => {
        if (terrainLayer?.getSource() === source) terrainRenderError.value = false;
      });
    }
    const layers: import('ol/layer/Base').default[] = [
      ...(terrainLayer ? [terrainLayer] : []), roads,
    ];
    if (props.planningOverlay?.coverage && props.showCoverage) {
      const url = coverageImage.url.value;
      if (
        !coverageKey ||
        coverageKey.value !== props.planningOverlay.coverage ||
        coverageKey.url !== url
      ) {
        renderedCoverage = coverageLayers(
          props.planningOverlay.coverage,
          url,
          map.getView().getZoom() ?? 9,
          props.opacity,
        );
        coverageKey = { value: props.planningOverlay.coverage, url };
        rasterRenderState.value = 'idle';
        const current = renderedCoverage;
        // 旧快照事件不影响新结果；只更新样式与显隐，不重新创建图片源。
        current.raster?.getSource()?.on('imageloadstart', () => {
          if (renderedCoverage === current) {
            rasterRenderState.value = 'loading';
            updateHttpCoverage();
          }
        });
        current.raster?.getSource()?.on('imageloadend', () => {
          if (renderedCoverage === current) {
            rasterRenderState.value = 'ready';
            updateHttpCoverage();
          }
        });
        current.raster?.getSource()?.on('imageloaderror', () => {
          if (renderedCoverage === current) {
            rasterRenderState.value = 'error';
            updateHttpCoverage();
          }
        });
      }
      const coverage = renderedCoverage!;
      updateHttpCoverage();
      if (coverage.raster) layers.push(coverage.raster);
      layers.push(coverage.vector);
    }
    layers.push(
      resourceReadLayer(props.resourceFrame, props.selectedId, props.resourceSelectedKind),
    );
    if (props.planningOverlay)
      layers.push(
        planningApiLayer(props.planningOverlay, props.selectedId, props.selectedLinkId, [
          ...props.highlightStationIds,
          ...props.highlightLinkIds,
        ]),
      );
    if (props.planningCandidates) layers.push(planningCandidatePoints.layer);
    if (props.deploymentConstraints) layers.push(deploymentLayer.layer);
    map.setLayers(layers);
    return;
  }
  // 按快照复用图片层；切换页签、缩放、节点选择不重新加载图片。
  if (mockCoverageKey !== props.mockCoverage) {
    mockCoverageLayers?.dispose();
    mockCoverageKey = props.mockCoverage;
    mockCoverageState.value = 'idle';
    mockCoverageLayers = props.mockCoverage
      ? createMockCoverageLayers(props.mockCoverage, (state) => {
          mockCoverageState.value = state;
        })
      : null;
  }
  updateMockCoverage();
  const deviceCoverageLayers = updateDeviceCoverage();
  const regionRows = props.deviceCoverageActive
    ? props.regions.filter((region) => region.kind === 'impact')
    : props.mockCoverage
      ? props.regions.filter((region) => region.kind !== 'coverage')
      : props.regions;
  const regionLayers: ReturnType<typeof regionLayer>[] = [];
  if (gisLayers.value) {
    // 原有影响示意只按 kind 分组，不推测其属于故障还是干扰。
    const groups = splitGisRegions(regionRows);
    for (const id of ['coverage', 'illustration'] as const) {
      const layer = regionLayer(groups[id]),
        setting = gisLayers.value[id];
      layer.setVisible(setting.visible);
      layer.setOpacity(setting.opacity);
      regionLayers.push(layer);
    }
  } else {
    const layer = regionLayer(regionRows);
    layer.setVisible(props.showCoverage);
    layer.setOpacity(props.opacity);
    regionLayers.push(layer);
  }
  const links = linkLayer(props.links, props.stations, false, props.highlightLinkIds, linkDisplay);
  renderedLinks = links;
  // 新维护集合显式接入才替换旧候选层；空数组也不回填旧教学候选。
  renderedCandidates =
    props.candidateWorkset === undefined
      ? null
      : candidateLinkLayer(
          props.candidateWorkset,
          props.candidateStations ?? props.stations,
          props.selectedCandidateLinkId,
        );
  const candidates = renderedCandidates ?? linkLayer(props.candidateLinks, props.stations, true);
  candidates.setVisible(props.showCandidates);
  const nodes = nodeLayer(
    props.stations,
    props.selectedId,
    props.highlightStationIds,
    props.resourceMarkers,
  );
  nodes.setVisible(props.showNodes);
  roads.setVisible(props.showRoads);
  // 诊断叠加层独立于资源真实状态；默认空输入不改变原页面。
  const impacts = diagnosisRegionLayer(props.diagnosisRegions);
  impacts.setOpacity(diagnosisSetting.value.opacity);
  impacts.setVisible(diagnosisShown.value);
  const interference = interferenceLayer(props.interferences, props.selectedInterferenceId);
  interference.setVisible(props.showInterferences);
  if (props.gisPick) {
    pickNodes = nodes;
    pickSources = interference;
    pickClusterListener = nodes.getSource()!.on('change', () => {
      clearPickHover();
      pickClustered.value =
        props.showNodes &&
        nodes
          .getSource()!
          .getFeatures()
          .some((feature) => (feature.get('features')?.length ?? 0) > 1);
    });
  }
  const demands = demandLayer(props.demands, props.stations, props.selectedDemandId);
  demands.setVisible(props.showDemands);
  const analysis = interferenceImpactLayers(
    props.interferenceImpact,
    props.stations,
    props.links,
    props.selectedLinkId || props.selectedId,
    topologyEnabled.value,
  );
  renderedImpactLinks = analysis.linkObjects;
  impactObjectCounts.value = {
    nodes: analysis.objects
      .getSource()!
      .getFeatures()
      .filter((feature) => feature.get('kind') === 'interference-node').length,
    links: analysis.linkObjects?.getSource()?.getFeatures().length ?? 0,
  };
  analysis.regions.setOpacity(gisLayers.value?.interference.opacity ?? props.opacity);
  analysis.regions.setVisible(gisLayers.value?.interference.visible ?? props.showCoverage);
  map.setLayers([
    roads,
    ...deviceCoverageLayers,
    ...(mockCoverageLayers
      ? [
          ...(mockCoverageLayers.raster ? [mockCoverageLayers.raster] : []),
          mockCoverageLayers.vector,
        ]
      : []),
    ...regionLayers,
    impacts,
    analysis.regions,
    candidates,
    links,
    demands,
    nodes,
    ...(devicePointFrame.value ? [devicePoints.layer] : []),
    ...(props.planningCandidates ? [planningCandidatePoints.layer] : []),
    ...(props.deploymentConstraints ? [deploymentLayer.layer] : []),
    ...(analysis.linkObjects ? [analysis.linkObjects] : []),
    analysis.objects,
    interference,
    resourcePickLayer(props.pickPreview),
    ...(props.gisPick ? [pickHighlight.layer] : []),
    diagnosisFaultLayer(props.diagnosisFaults, props.stations, props.diagnosisDevices, props.links),
  ]);
  updateLinkDisplay();
}
function updateLinkDisplay() {
  linkDisplay.zoom = map?.getView().getZoom() ?? 9;
  linkDisplay.selectedLinkId = props.selectedLinkId;
  // 从已生成要素检查，资源筛选或缺失端点不会因“保留故障”而被重新加入。
  const drawable =
    renderedLinks
      ?.getSource()
      ?.getFeatures()
      .map((feature) => feature.get('link') as NetworkLink) ?? [];
  const visible = !props.resourceRead && topologyShown.value;
  // 只更新当前两类链路层，不重建图片、其他图层或改变视角。
  const opacity = topologyEnabled.value ? props.topologyOpacity! : 1;
  renderedLinks?.setOpacity(opacity);
  renderedLinks?.setVisible(visible);
  renderedImpactLinks?.setOpacity(opacity);
  renderedImpactLinks?.setVisible(visible);
  topologySimplified.value =
    visible &&
    drawable.some(
      (link) =>
        !shouldDisplayLink(
          link,
          linkDisplay.zoom,
          props.highlightLinkIds.includes(link.id) || props.selectedLinkId === link.id,
        ),
    );
  faultPulse?.setActive(visible && drawable.some((link) => link.state === 'FAULT'));
  renderedLinks?.changed();
}
function updateMockCoverage() {
  mockCoverageLayers?.setDisplay(
    props.mockCoverageDisplay,
    map?.getView().getZoom() ?? 9,
    coverageSetting.value.visible,
    coverageSetting.value.opacity,
  );
}
function updateHttpCoverage() {
  renderedCoverage?.setDisplay(
    props.coverageDisplay,
    map?.getView().getZoom() ?? 9,
    rasterRenderState.value,
    props.resourceRead && props.showCoverage,
    props.opacity,
  );
}
function retryMockCoverage() {
  mockCoverageLayers?.retry();
}
function updateDeviceCoverage() {
  return deviceLayers.update(
    props.deviceCoverages,
    props.deviceCoverageDisplay,
    map?.getView().getZoom() ?? 9,
    props.deviceCoverageActive && coverageSetting.value.visible,
    coverageSetting.value.opacity,
  );
}
function retryDeviceCoverage(snapshotId: string) {
  deviceLayers.retry(snapshotId);
}
function fitDeviceCoverage(snapshotId: string) {
  const row = props.deviceCoverages.find((item) => item.sample.snapshotId === snapshotId);
  const bbox = row?.sample.coverage.rasterPng?.bbox;
  if (
    !map ||
    !props.deviceCoverageActive ||
    !coverageSetting.value.visible ||
    !row?.visible ||
    !bbox
  )
    return;
  map
    .getView()
    .fit(
      boundingExtent([
        projectCoordinate([bbox[0], bbox[1]]),
        projectCoordinate([bbox[2], bbox[3]]),
      ]),
      { padding: [65, 65, 80, 65], maxZoom: 13, duration: 250 },
    );
}
function fit() {
  if (map && props.resourceRead && props.resourceBounds) {
    const b = props.resourceBounds;
    map
      .getView()
      .fit(boundingExtent([projectCoordinate([b[0], b[1]]), projectCoordinate([b[2], b[3]])]), {
        padding: [65, 65, 60, 65],
        maxZoom: 11,
      });
    return;
  }
  if (!map || !props.stations.length) return;
  map
    .getView()
    .fit(boundingExtent(props.stations.map((station) => projectCoordinate(station.coordinate))), {
      padding: [65, 65, 60, 65],
      maxZoom: 11,
    });
}
function locate() {
  const candidate =
    !props.resourceRead &&
    props.candidateWorkset?.find((item) => item.id === props.selectedCandidateLinkId);
  if (candidate) {
    locateCandidate(candidate);
    return;
  }
  const link = props.links.find((item) => item.id === props.selectedLinkId);
  if (map && link) {
    const endpoints = props.stations.filter((item) => item.id === link.a || item.id === link.b);
    if (endpoints.length === 2)
      map
        .getView()
        .fit(boundingExtent(endpoints.map((item) => projectCoordinate(item.coordinate))), {
          padding: [90, 90, 90, 90],
          maxZoom: 12,
          duration: 300,
        });
    return;
  }
  const source = props.interferences.find((row) => row.id === props.selectedInterferenceId);
  if (map && source) {
    map
      .getView()
      .animate({ center: projectCoordinate(source.coordinate), zoom: 12, duration: 300 });
    return;
  }
  const station = props.stations.find((item) => item.id === props.selectedId);
  if (map && station)
    map
      .getView()
      .animate({ center: projectCoordinate(station.coordinate), zoom: 12, duration: 300 });
}
function locateCandidate(link: CandidateLink) {
  if (!map || props.resourceRead || props.candidateWorkset === undefined) return;
  // 定位仅使用合法端点；即使候选层隐藏也保持用户的显隐偏好。
  const points = candidateEndpoints(link, props.candidateStations ?? props.stations);
  if (points.length === 2)
    map.getView().fit(boundingExtent(points.map(projectCoordinate)), {
      padding: [90, 90, 90, 90],
      maxZoom: 12,
      duration: 300,
    });
}
function locateResource(point: Coordinate) {
  map?.getView().animate({ center: projectCoordinate(point), zoom: 14, duration: 250 });
}
function expandResource(cluster: ResourceMapCluster) {
  if (cluster.expansionZoom === null) return;
  map?.getView().animate({
    center: projectCoordinate(cluster.coordinate),
    zoom: cluster.expansionZoom,
    duration: 250,
  });
}
onMounted(() => {
  map = new Map({
    target: host.value,
    view: new View({
      center: projectCoordinate([114.65, 37.5]),
      zoom: 9,
      minZoom: props.resourceRead ? 0 : 6,
      maxZoom: 17,
    }),
    controls: defaults({ attributionOptions: { collapsible: false } }).extend([new ScaleLine()]),
  });
  // 闪烁只使当前链路层重绘；不调用 paint、重建覆盖图或请求业务数据。
  faultPulse = createFaultPulse((dimmed) => {
    linkDisplay.faultDimmed = dimmed;
    renderedLinks?.changed();
  });
  if (props.resourceRead)
    map.on('moveend', () => {
      const bbox = resourceViewport(map!.getView().calculateExtent(map!.getSize()));
      if (bbox) emit('viewport', bbox, Math.round((map!.getView().getZoom() ?? 9) * 100) / 100);
    });
  // 缩放只调整已创建图层的可见性，不重建几何或重复加载图片。
  map.getView().on('change:resolution', () => {
    updateLinkDisplay();
    updateMockCoverage();
    updateDeviceCoverage();
    updateHttpCoverage();
  });
  paint();
  fit();
  if (props.gisPick) {
    pickViewListeners.push(
      map.getView().on('change:center', clearPickHover),
      map.getView().on('change:resolution', clearPickHover),
      map.getView().on('change:rotation', clearPickHover),
    );
    map.on('movestart', clearPickHover);
    map.on('pointerdrag', clearPickHover);
    map.on('pointermove', (event) => {
      if (!pickAlive || event.dragging || !pickActive.value) {
        clearPickHover();
        return;
      }
      pickHover.value = pickAt(event.pixel);
      pickHighlight.update(pickHover.value);
    });
  }
  // singleclick 延迟期间可能换方案；按原始点击携带的代次核对。
  map.on('click', (event) => {
    if (props.gisPick) {
      if (event.originalEvent)
        pickClicks.set(event.originalEvent, pickPress ?? { epoch: -1, picking: props.picking });
      pickPress = undefined;
    }
    if (event.originalEvent && candidatePress)
      candidateClicks.set(event.originalEvent, candidatePress);
    candidatePress = undefined;
  });
  map.on('singleclick', (event) => {
    const press = event.originalEvent && pickClicks.get(event.originalEvent);
    if (props.gisPick && (props.picking || press?.picking)) {
      if (
        pickAlive &&
        press?.picking &&
        pickActive.value &&
        press.key === props.gisPick.key &&
        press.epoch === pickEpoch.value
      ) {
        const target = pickAt(event.pixel),
          coordinate = target
            ? ([...target.coordinate] as Coordinate)
            : unprojectCoordinate(event.coordinate);
        if (validPickCoordinate(coordinate))
          emit('gisPick', { key: press.key, coordinate, ...(target ? { target } : {}) });
      }
      return;
    }
    if (props.picking) {
      emit('pick', unprojectCoordinate(event.coordinate));
      return;
    }
    map?.forEachFeatureAtPixel(event.pixel, (feature) => {
      // 输入区域不遮挡原资源选择，也不发出候选或正式部署事件。
      if (feature.get('kind') === 'deployment-constraint') return undefined;
      if (feature.get('kind') === 'planning-candidate-point') {
        const token = event.originalEvent && candidateClicks.get(event.originalEvent);
        const target = pickAlive ? planningCandidatePoints.pick(feature as Feature) : undefined;
        if (target && token?.owner === target.owner && token.epoch === target.epoch)
          emit('selectPlanningCandidate', target);
        return true;
      }
      if (feature.get('kind') === 'candidate-workset-link') {
        // 已移除、隐藏或切出资源模式的旧要素不能继续发出候选选择。
        if (
          props.resourceRead ||
          !props.showCandidates ||
          !renderedCandidates
            ?.getSource()
            ?.hasFeature(feature as Feature<import('ol/geom/LineString').default>)
        )
          return undefined;
        emit('selectCandidateLink', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'gis-device-cluster') {
        if (!devicePointFrame.value) return true;
        const target = devicePoints.pick(feature as Feature);
        if (target?.version !== devicePointFrame.value.version) return true;
        if (target?.ids.length === 1) emit('selectDevice', target.ids[0], target.version);
        else if (target) emit('selectDeviceCluster', target.ids, target.version);
        return true;
      }
      if (feature.get('kind') === 'api-planning-node') {
        emit('select', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'api-planned-link') {
        emit('selectLink', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'resource-read-point') {
        emit('selectResource', feature.get('object'));
        return true;
      }
      if (feature.get('kind') === 'resource-read-cluster') {
        emit('selectCluster', feature.get('cluster'));
        return true;
      }
      if (feature.get('kind') === 'interference-node') {
        emit('select', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'interference-link') {
        if (topologyEnabled.value && !topologyShown.value) return undefined;
        emit('selectLink', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'task-demand') {
        emit('selectDemand', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'interference-source') {
        emit('selectInterference', feature.get('objectId'));
        return true;
      }
      if (feature.get('kind') === 'diagnosis-fault') {
        emit('selectFault', feature.get('objectType'), feature.get('objectId'));
        return true;
      }
      if (props.selectLinks && feature.get('kind') === 'planned-link') {
        if (topologyEnabled.value && !topologyShown.value) return undefined;
        emit('selectLink', feature.get('objectId'));
        return true;
      }
      const members = feature.get('features') as Feature[] | undefined;
      if (!members) return undefined;
      if (members.length === 1) emit('select', (members[0].get('station') as Station).id);
      else
        map
          ?.getView()
          .fit(
            boundingExtent(
              members.map((item) => projectCoordinate((item.get('station') as Station).coordinate)),
            ),
            { padding: [70, 70, 70, 70], maxZoom: 14, duration: 250 },
          );
      return true;
    });
  });
  observer = new ResizeObserver(() => map?.updateSize());
  observer.observe(host.value!);
});
watch(
  () => [
    props.resourceRead,
    props.terrainBasemap,
    props.resourceFrame,
    props.resourceSelectedKind,
    props.planningOverlay,
    coverageImage.url.value,
    props.mockCoverage,
    props.deviceCoverageActive,
    props.deviceCoverages,
    props.stations,
    props.interferenceImpact,
    props.interferences,
    props.showInterferences,
    props.selectedInterferenceId,
    props.pickPreview,
    props.resourceMarkers,
    props.links,
    props.regions,
    props.candidateLinks,
    props.candidateWorkset,
    props.candidateStations,
    props.selectedCandidateLinkId,
    props.selectedId,
    props.selectedLinkId,
    props.diagnosisFaults,
    props.diagnosisRegions,
    props.diagnosisDevices,
    props.demands,
    props.selectedDemandId,
    props.showDemands,
    props.highlightStationIds,
    props.highlightLinkIds,
    props.showRoads,
    props.showNodes,
    props.showLinks,
    props.showCoverage,
    props.gisResultLayers,
    props.gisDeviceFrame,
    props.showCandidates,
    props.opacity,
  ],
  paint,
  { deep: true },
);
// 显示偏好只更新已有图层，保留图片源与当前业务快照。
watch(
  () => props.deploymentConstraints,
  (frame, previous) => {
    updateDeployment();
    if (map && !!frame !== !!previous) {
      if (frame) map.addLayer(deploymentLayer.layer);
      else map.removeLayer(deploymentLayer.layer);
    }
  },
  { deep: true, flush: 'sync' },
);
watch(
  () => props.planningCandidates,
  (frame, previous) => {
    if (!!frame !== !!previous) paint();
    else planningCandidatePoints.update(frame);
  },
  { deep: true, flush: 'sync' },
);
watch(
  () => props.topologyOpacity,
  (value, previous) => {
    // 接入方式变化才需拆分／合并；普通滑块调整复用现有图层。
    if (!props.resourceRead && (value === undefined) !== (previous === undefined)) paint();
    else if (topologyEnabled.value) updateLinkDisplay();
  },
);
watch(() => props.coverageDisplay, updateHttpCoverage);
watch(() => props.mockCoverageDisplay, updateMockCoverage);
watch(() => props.deviceCoverageDisplay, updateDeviceCoverage);
watch(() => props.selectedId, locate);
watch(
  () => props.planningOverlay?.snapshotId,
  () => {
    if (props.planningOverlay?.snapshotId) fit();
  },
);
watch(() => props.selectedInterferenceId, locate);
function escape(event: KeyboardEvent) {
  if (props.picking && event.key === 'Escape') pickControls.value.cancel();
}
onMounted(() => window.addEventListener('keydown', escape));
watch(() => props.selectedLinkId, locate);
watch(() => props.selectedCandidateLinkId, locate);
defineExpose({
  locate,
  locateCandidate,
  locateResource,
  expandResource,
  fitDeviceCoverage,
  retryDeviceCoverage,
});
onBeforeUnmount(() => {
  pickAlive = false;
  clearPickHover();
  pickPress = undefined;
  if (pickClusterListener) unByKey(pickClusterListener);
  unByKey(pickViewListeners);
  window.removeEventListener('keydown', escape);
  faultPulse?.dispose();
  renderedLinks = null;
  renderedCandidates = null;
  renderedImpactLinks = undefined;
  observer?.disconnect();
  mockCoverageLayers?.dispose();
  renderedCoverage = null;
  terrainLayer = null;
  deviceLayers.dispose();
  devicePoints.dispose();
  planningCandidatePoints.dispose();
  candidatePress = undefined;
  deploymentLayer.dispose();
  map?.dispose();
});
</script>
<style scoped>
.deployment-map-legend {
  position: absolute;
  z-index: 3;
  left: 12px;
  top: 40px;
  max-width: 80%;
  background: #12243bea;
  padding: 7px;
  color: #e1c2dc;
  font-size: 11px;
}
.deployment-map-legend button {
  margin-left: 6px;
}
.mock-coverage-notice {
  position: absolute;
  top: 58px;
  left: 20px;
  right: 85px;
  padding: 8px 10px;
  background: #0c1b2de8;
  color: #c4d6e5;
  font-size: 12px;
  line-height: 1.7;
}
.coverage-legend {
  position: absolute;
  left: 16px;
  bottom: 64px;
  padding: 8px;
  background: #102033e8;
  display: flex;
  gap: 10px;
  font-size: 11px;
}
.coverage-legend span {
  display: flex;
  gap: 4px;
  align-items: center;
}
.coverage-legend b {
  width: 14px;
  height: 10px;
}
.picking .map-host {
  cursor: crosshair;
}
.pick-notice {
  position: absolute;
  z-index: 4;
  top: 64px;
  left: 15px;
  max-width: calc(100% - 30px);
  background: #19374fed;
  color: #e2f0ff;
  padding: 10px;
  border: 1px solid #76bae9;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.pick-notice label {
  display: flex;
  gap: 6px;
  align-items: center;
}
.map-wrap {
  width: 100%;
  height: 100%;
  min-height: 350px;
  position: relative;
  overflow: hidden;
  background: radial-gradient(ellipse at 30% 45%, #152e3e, #0b182b 75%);
}
.map-host {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(#45627c0a 1px, transparent 1px),
    linear-gradient(90deg, #45627c0a 1px, transparent 1px);
  background-size: 65px 65px;
}
.map-host:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: -3px;
}
.map-caption {
  position: absolute;
  top: 17px;
  left: 17px;
  padding: 8px 11px;
  border: 1px solid #33495e;
  border-radius: 4px;
  color: #95b1ca;
  background: #0c1a2be0;
  font-size: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-caption span:last-child {
  color: #6c8aa4;
  margin-left: 8px;
}
.map-dot {
  width: 5px;
  height: 5px;
  background: #5bb1c9;
  border-radius: 50%;
}
.map-reset {
  position: absolute;
  right: 16px;
  top: 96px;
  background: #0e2135;
}
.map-watermark {
  position: absolute;
  top: 19%;
  left: 28%;
  font-size: 24px;
  color: #7ba1bb26;
  pointer-events: none;
  letter-spacing: 8px;
}
.map-watermark span {
  display: block;
  letter-spacing: 2px;
  font-size: 8px;
  margin-top: 10px;
  text-align: center;
}
.map-legend {
  position: absolute;
  bottom: 29px;
  right: 15px;
  display: flex;
  gap: 13px;
  padding: 8px 11px;
  background: #0b1a2be8;
  border: 1px solid #2a4156;
  border-radius: 5px;
  font-size: 10px;
  color: #9cb0c8;
  pointer-events: none;
}
.map-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
/* 仅扩展 Mock 图例，窄地图内换行，不改变 HTTP 资源图例。 */
.mock-legend {
  max-width: calc(100% - 30px);
  box-sizing: border-box;
  flex-wrap: wrap;
  row-gap: 8px;
}
.mock-legend span {
  white-space: nowrap;
}
/* 说明在地图内受限滚动，按钮独立常驻，避免展开后挡住收起入口。 */
.map-legend-toggle {
  position: absolute;
  right: 15px;
  bottom: 29px;
  background: #0b1a2bf5;
}
.mock-legend.collapsible-legend {
  bottom: 69px;
  width: min(320px, calc(100% - 30px));
  max-height: min(180px, calc(100% - 140px));
  overflow: auto;
  pointer-events: auto;
  gap: 10px 14px;
}
.collapsible-legend span {
  white-space: normal;
  line-height: 1.6;
}
.link-key {
  width: 20px;
  flex-shrink: 0;
  border-top: 2px solid #9cb0c8;
}
.link-key.dashed {
  border-top-style: dashed;
}
.link-key.candidate {
  border-top: 1px dashed #8291ab;
}
.map-legend b {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.normal {
  background: #45c9af;
}
.warn {
  background: #f0bd67;
}
.fault {
  background: #f27887;
}
.offline {
  background: #8192a8;
}
.compact .region-key {
  display: none;
}
.map-error {
  position: absolute;
  left: 20px;
  top: 60px;
  color: #f0b972;
  background: #302721;
  padding: 8px;
}
.terrain-render-error {
  top: 100px;
}
/* 候选图例独立标注语义，避免与设备运行状态图例混用。 */
.candidate-map-legend {
  position: absolute;
  left: 18px;
  top: 58px;
  max-width: calc(100% - 36px);
  padding: 8px;
  background: #102638ed;
  color: #c1e7ed;
  font-size: 12px;
  pointer-events: none;
}
</style>
