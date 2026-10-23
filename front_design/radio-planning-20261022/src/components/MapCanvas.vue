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
      @pointerdown.capture="
        clearHoverPreview();
        startPick();
      "
      @pointerleave="
        clearPickHover();
        clearHoverPreview();
      "
      :aria-label="
        resourceRead
          ? '资源地图，可拖动、缩放并选择资源或聚合点；方向键平移，加减键缩放'
          : '太行山地区域地图，可拖动、缩放并选择节点；方向键平移，加减键缩放'
      "
    />
    <GisHoverPreview
      v-if="hoverSummary && hoverPosition"
      :summary="hoverSummary"
      :position="hoverPosition"
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
    <div class="map-caption" :class="{ 'with-terrain': !!terrainBasemap }"
      ><span class="map-dot" /> WGS84
      <span>{{ mapCaption ?? (terrainBasemap ? 'DEM 地形' : gisSurface || resourceRead ? '本地道路底图' : '本地演示地图') }}</span
      ><span v-if="terrainRenderError" role="status" class="terrain-error">地形图片显示失败；站点和链路仍可浏览。</span
      ><span
        v-if="showRoads && roadState === 'loading'"
        role="status"
        >当前视口道路加载中</span
      ></div
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
      >太 行 山 地 区<span>{{
        watermarkCaption ?? (gisSurface ? 'TAIHANG REGION' : 'TAIHANG REGION · DEMO')
      }}</span></div
    >
    <div
      v-if="interferenceGeometryNotice"
      class="map-error" role="alert"
      >{{ interferenceGeometryNotice }}</div>
    <div
      v-if="showRoads && roadState === 'error'"
      class="map-error"
      >本地道路瓦片加载失败；节点仍可浏览，请检查 maps 资源。</div
    >
    <div
      v-if="mockCoverage && coverageShown && ['loading', 'error'].includes(mockCoverageState)"
      class="mock-coverage-notice"
      role="status"
    >
      {{
        mockCoverageState === 'loading'
          ? gisSurface
            ? '场强图加载中…'
            : '教学场强图加载中…'
          : gisSurface
            ? '场强图加载失败。'
            : '教学场强图加载失败。'
      }}
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
      v-if="collapsibleLegend && (!resourceRead || richScene)"
      class="map-legend-toggle btn small"
      :aria-expanded="legendOpen"
      :aria-label="legendOpen ? '收起地图图例' : '展开地图图例'"
      @click="legendOpen = !legendOpen"
      ><i class="pi pi-list" />图例<i
        class="pi"
        :class="legendOpen ? 'pi-angle-down' : 'pi-angle-up'"
    /></button>
    <div
      v-if="interferenceProjection"
      class="map-legend"
      ><span>干扰影响 · 模型预测</span><span>{{ interferenceProjection.phase === 'PREVIEW' ? '措施预览' : '措施前' }}</span><span>黄色：冻结干扰源</span><span>灰色：未提供受扰等级</span></div>
    <div
      v-else-if="frozenNetwork"
      class="map-legend"
      ><span>冻结方案 · 算法预测</span><span><b class="normal" />冻结状态正常</span><span><b class="offline" />灰色：状态／告警未提供或离线</span><span>虚线：备用链路</span></div
    >
    <div
      v-else-if="resourceRead && !richScene"
      class="map-legend"
      ><span>数字圆点：资源聚合</span><span><b class="normal" />正常</span
      ><span><b class="warn" />告警 / 生效干扰源</span><span><b class="fault" />故障</span
      ><span><b class="offline" />离线 / 未生效</span><span>？告警未提供</span></div
    >
    <div
      v-else-if="!collapsibleLegend || legendOpen"
      class="map-legend mock-legend"
      :class="{ 'collapsible-legend': collapsibleLegend, 'gis-legend': gisLegend }"
    >
      <template
        v-if="deviceCoverageActive && coverageShown && (!gisLayers || visibleDevices.length)"
      >
        <span>{{ gisSurface ? '设备覆盖' : '设备覆盖 · Mock 教学示意' }}</span>
        <span
          v-for="row in visibleDevices"
          :key="row.sample.snapshotId"
          ><i
            class="link-key"
            :style="{ borderTopColor: row.sample.color }"
          />{{ row.sample.deviceId }} ·
          {{ row.representation === 'heatmap' ? '热力图' : '场强图' }}</span
        >
        <span
          v-for="(color, index) in deviceLegendRaster?.colormap ?? []"
          :key="color.value_dbuvm"
          ><b
            :style="{
              background: `rgba(${color.rgba[0]},${color.rgba[1]},${color.rgba[2]},${color.rgba[3] / 255})`,
            }"
          />{{ ['弱', '中', '强'][index] }} {{ color.value_dbuvm }} dBμV/m</span
        >
        <span v-if="!gisLegend">紫：本设备盲区 · 灰：未计算</span>
        <span v-if="!gisLegend">重叠色不代表合成场强</span>
      </template>
      <template v-if="mockCoverage?.rasterPng && coverageShown">
        <span>{{ gisSurface ? '场强图 / dBμV/m' : 'Mock 教学场强图 / dBμV/m' }}</span>
        <span
          v-for="(color, index) in mockCoverage.rasterPng.colormap"
          :key="color.value_dbuvm"
          ><b
            :style="{
              background: `rgba(${color.rgba[0]},${color.rgba[1]},${color.rgba[2]},${color.rgba[3] / 255})`,
            }"
          />{{ ['弱', '中', '强'][index] }} {{ color.value_dbuvm }}</span
        >
        <span v-if="!gisLegend">盲区 / 未计算区域保留</span>
      </template>
      <!-- GIS 只解释可见图层的符号；其他页面沿用原图例和文案。 -->
      <template v-if="!gisLegend || gisStatusLegend">
        <span><b class="normal" />正常</span><span><b class="warn" />正常＋告警</span
        ><span><b class="fault" />故障</span><span><b class="offline" />离线</span>
      </template>
      <span
        v-if="coverageLegend && !gisLegend"
        class="region-key"
        >▱ 覆盖 / 盲区 / 未计算</span
      >
      <span
        v-for="item in gisCoverageAreas"
        :key="item.label"
        ><i
          class="area-key"
          :style="{ background: item.fill, borderColor: item.stroke }"
        />{{ item.label }}</span
      >
      <span v-if="illustrationLegend"
        ><i
          v-if="gisLegend"
          class="area-key"
          style="background: #ed67883b; border-color: #ef7e98"
        />{{ gisLegend ? '影响示意' : '▱ 原有影响示意区域' }}</span
      >
      <span v-if="gisLegend && visibleStationLegend"
        ><i
          class="cluster-key station-cluster"
          aria-hidden="true"
          >n</i
        >站点聚合（个）</span
      >
      <span v-else-if="!gisLegend && devicePointFrame && showNodes">站点参考圆点：节点数</span>
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
        <span v-if="gisLegend"
          ><i
            class="cluster-key device-cluster"
            aria-hidden="true"
            >n</i
          >设备聚合（台）</span
        >
        <template v-else
          ><span>设备聚合数字：台数 · 点击查看清单</span
          ><span>设备状态独立于站点，告警为附加标记</span></template
        >
        <span
          v-if="
            gisLegend &&
            devicePointFrame.points.some((point) => point.status === null || point.alert === null)
          "
          ><b :style="{ background: GIS_DEVICE_COLORS.UNKNOWN }" />状态／告警未提供</span
        >
      </template>
      <!-- 链路线段与节点圆点分开展示，图例随已有图层开关显隐。 -->
      <template v-if="topologyShown && links.length">
        <span v-if="topologySimplified && !gisLegend">拓扑已简化</span>
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
      <span v-if="showCandidates && candidateWorkset?.length"
        ><i class="link-key candidate" />候选链路 · 非当前评估</span
      >
      <template v-if="interferences.length && showInterferences">
        <template v-if="gisLegend"
          ><span v-if="interferences.some((source) => source.active)"
            ><i
              class="source-key"
              style="background: #e4a859"
            />干扰源</span
          ><span v-if="interferences.some((source) => !source.active)"
            ><i
              class="source-key"
              style="background: #6b7c91"
            />未生效干扰源</span
          ></template
        >
        <span v-else>● 干扰源点位</span>
      </template>
      <span v-if="gisLegend && manualStationLegend"><i class="manual-key" />人工站点</span>
      <span v-else-if="!gisLegend && resourceMarkers">金色外框：手工站点</span>
      <span v-if="demands.length && showDemands"
        ><i
          v-if="gisLegend"
          class="link-key demand-key"
        />{{ gisLegend ? '任务需求' : '┄ 任务需求' }}</span
      >
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
      <template v-if="interferenceObjectsLegend">
        <template v-if="gisLegend"
          ><span
            v-for="(color, level) in interferenceColors"
            :key="level"
            ><i
              class="impact-key"
              :style="{ borderColor: color, background: color + '40' }"
            />受扰 · {{ { SEVERE: '严重', MODERATE: '中等', MINOR: '轻微' }[level] }}</span
          ></template
        >
        <span v-else>受扰对象：严重 / 中等 / 轻微</span>
      </template>
      <span v-if="diagnosisRegions.length && !gisLayers">影响：严重 / 一般 / 轻微</span>
      <span v-if="diagnosisPaths.length && diagnosisShown">青色箭头：故障传播方向</span>
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
import GisHoverPreview from './GisHoverPreview.vue';
import {
  gisHoverSummary,
  gisHoverPlacement,
  type GisHoverContext,
  type GisHoverSummary,
} from '../maps/gis-hover';
import { createPlanningCandidateLayer } from '../maps/planning-candidate-layers';
import { createDeploymentConstraintLayer } from '../maps/deployment-constraint-layers';
import type { DeploymentConstraintFrame } from '../types/deployment-constraints';
import type { CandidateMapFrame, CandidateSelection } from '../types/planning-candidates';
import { candidateEndpoints, candidateLinkLayer } from '../maps/candidate-link-layers';
import type { CandidateLink } from '../types/candidate-link';
import {
  GIS_DEVICE_COLORS,
  gisDeviceSummary,
  type GisDeviceMapFrame,
} from '../maps/gis-device-display';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { createFaultPulse, shouldDisplayLink, type LinkDisplayState } from '../maps/link-display';
import type { InterferenceImpact } from '../types/interference';
import {
  interferenceImpactLayers,
  interferenceRegionColors,
  interferenceColors,
} from '../maps/interference-layers';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import type { TerrainBasemap } from '../services/terrain-basemap';
import { defaults, ScaleLine } from 'ol/control';
import { boundingExtent } from 'ol/extent';
import { resourceReadLayer, resourceViewport } from '../maps/resource-read-layers';
import { Style, Circle as CircleStyle } from 'ol/style';
import { planningApiLayer, type PlanningMapOverlay } from '../maps/planning-api-layers';
import { gisPlanLayer } from '../maps/gis-plan-layers';
import { interferenceWorkbenchLayer, workbenchCoordinates, workbenchMapKey } from '../maps/interference-workbench-layers';
import type { MapProjection } from '../types/interference-workbench';
import type { GisNetwork } from '../types/gis-plan';
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
import type { DiagnosisPropagationPath, DiagnosisRegion, FaultInput } from '../types/diagnosis';
import {
  diagnosisFaultLayer,
  diagnosisRegionLayer,
  diagnosisPropagationLayer,
} from '../maps/diagnosis-layers';
import { diagnosisFaultTypes } from '../services/diagnosis-display';
import { interferenceLayer, resourcePickLayer } from '../maps/resource-layers';
import type { RoadState } from '../maps/road-layers';
import type { PlanningDemand } from '../types/planning';
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
    terrainBasemap?: TerrainBasemap | null;
    // 公共资源底层可与完整 GIS 图层组合，编辑/冻结网络自行提供底层。
    richScene?: boolean;
    // GIS 文案作用域独立于分页渲染能力，其他地图维持原展示。
    gisSurface?: boolean;
    // 诊断可独立指定中性文案，其他地图调用沿用默认展示。
    mapCaption?: string;
    watermarkCaption?: string;
    // 显式接入资源视图；共用地图的其他调用默认不启用。
    hoverPreview?: GisHoverContext;
    planningOverlay?: PlanningMapOverlay | null;
    frozenNetwork?: GisNetwork | null;
    interferenceProjection?: MapProjection | null;
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
    candidateWorkset?: CandidateLink[];
    candidateStations?: Station[];
    selectedCandidateLinkId?: string;
    regions?: MapRegion[];
    selectedId?: string;
    selectedLinkId?: string;
    selectLinks?: boolean;
    diagnosisFaults?: FaultInput[];
    diagnosisRegions?: DiagnosisRegion[];
    diagnosisPaths?: DiagnosisPropagationPath[];
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
    terrainBasemap: null,
    richScene: false,
    resourceFrame: null,
    planningOverlay: null,
    frozenNetwork: null,
    interferenceProjection: null,
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
    regions: () => [],
    demands: () => [],
    showDemands: true,
    highlightStationIds: () => [],
    highlightLinkIds: () => [],
    selectLinks: false,
    diagnosisFaults: () => [],
    diagnosisRegions: () => [],
    diagnosisPaths: () => [],
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
  selectFrozenNode: [id: string];
  selectFrozenLink: [id: string];
  selectFrozenDemand: [id: string];
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
const interferenceGeometryNotice = ref('');
const readClicks = new WeakMap<object, string>();
let readPress = '';
// 在原生按下事件中捕获来源，避免延迟 singleclick 选中切换后的网络。
function captureReadPress() { readPress = readOwner(); }
function readOwner() {
  if (props.interferenceProjection) return workbenchMapKey(props.interferenceProjection);
  const source = props.frozenNetwork?.identity;
  return source ? `${source.task_id}:${source.plan_id}:${source.snapshot_id}` : '';
}
const legendOpen = ref(false);
// 普通 GIS 传入设备实例，站点参考点继续使用独立图层。
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
// 仅按展示上下文选择图例，不按 Mock／HTTP 分流。
const fullScene = computed(() => !props.resourceRead || props.richScene);
const gisLegend = computed(() => !!props.gisSurface && fullScene.value);
const visibleStationLegend = computed(() => props.showNodes && props.stations.length > 0);
const gisStatusLegend = computed(
  () => visibleStationLegend.value || devicePointSummary.value.count > 0,
);
const manualStationLegend = computed(
  () =>
    (props.resourceMarkers &&
      visibleStationLegend.value &&
      props.stations.some((station) => station.origin === 'MANUAL')) ||
    !!devicePointFrame.value?.points.some((point) => point.manualStation),
);
const devicePointFrame = computed(() => (fullScene.value ? props.gisDeviceFrame : undefined));
const devicePointSummary = computed(() => gisDeviceSummary(devicePointFrame.value?.points ?? []));
// GIS 区域控制独立接入，其他页面继续使用共用显隐设置。
const gisLayers = computed(() => (fullScene.value ? props.gisResultLayers : undefined));
// 显式接入拓扑透明度后，链路与高亮使用同一显示偏好。
const topologyEnabled = computed(() => fullScene.value && props.topologyOpacity !== undefined);
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
const deviceLegendRaster = computed(() => {
  const row = (gisLayers.value ? visibleDevices.value : props.deviceCoverages)[0];
  return row?.representation === 'heatmap' ? row.sample.heatmapPng : row?.sample.coverage.rasterPng;
});
// 只列当前显示的已有覆盖区域，色块沿用对应图层的固定样式，不推算场强。
const gisCoverageAreas = computed(() => {
  if (!gisLegend.value || !coverageShown.value) return [];
  if (props.deviceCoverageActive)
    return [
      { kind: 'blind', label: '设备盲区', fill: '#b26aa844', stroke: '#b26aa8' },
      { kind: 'uncalculated', label: '未计算', fill: '#79839633', stroke: '#798396' },
    ].filter((item) =>
      visibleDevices.value.some((row) =>
        row.sample.regions.some((region) => region.kind === item.kind),
      ),
    );
  if (props.mockCoverage)
    return [
      { kind: 'blind', label: '盲区', fill: '#a75e8055', stroke: '#a75e80' },
      { kind: 'uncalculated', label: '未计算', fill: '#79839644', stroke: '#798396' },
    ].filter((item) =>
      props.mockCoverage?.contour?.features.some(
        (feature) => feature.properties.level === item.kind,
      ),
    );
  return [
    { kind: 'coverage', label: '覆盖区域', fill: '#249db91c', stroke: '#469dba99' },
    { kind: 'blind', label: '盲区', fill: '#d6a25223', stroke: '#b1935b' },
    { kind: 'uncalculated', label: '未计算', fill: '#73839d16', stroke: '#667a96' },
  ].filter((item) => props.regions.some((region) => region.kind === item.kind));
});
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
        { level: 'MODERATE', label: '一般', color: '#efc16b' },
        { level: 'MINOR', label: '轻微', color: '#72c5df' },
        { level: null, label: '未提供等级', color: '#b8c4d5' },
      ].filter((item) => props.diagnosisRegions.some((region) => region.level === item.level))
    : [],
);
// 设备图层独立收集加载状态，单台失败不影响其他样例。
const deviceLayers = createDeviceCoverageLayers((id, state) =>
  emit('deviceCoverageState', id, state),
);
const roadState = ref<RoadState>('idle');
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
const hoverSummary = ref<GisHoverSummary | null>(null),
  hoverPosition = ref<ReturnType<typeof gisHoverPlacement> | null>(null);
let hoverTimer: ReturnType<typeof setTimeout> | undefined,
  hoverSerial = 0,
  hoverKey = '';
let hoverAlive = true;
const hoverViewListeners: EventsKey[] = [];
const hoverEnabled = computed(() => !!props.hoverPreview && !props.picking);
function clearHoverPreview() {
  hoverSerial++;
  clearTimeout(hoverTimer);
  hoverTimer = undefined;
  hoverKey = '';
  hoverSummary.value = null;
  hoverPosition.value = null;
}
function previewAt(pixel: number[]) {
  if (!hoverAlive || !map || !hoverEnabled.value || !props.hoverPreview) return null;
  return (
    map.forEachFeatureAtPixel(pixel, (feature) => {
      const kind = feature.get('kind');
      // 只命中当前可见资源点；业务层不借当前资源补出悬浮信息。
      if (kind === 'gis-device-cluster') {
        return (
          gisHoverSummary(feature, {
            context: props.hoverPreview!,
            stations: props.stations,
            devices: devicePointFrame.value,
            deviceTarget: devicePoints.pick(feature as Feature),
          }) || undefined
        );
      }
      if (kind === 'resource-read-point' || kind === 'resource-read-cluster' || !kind)
        return (
          gisHoverSummary(feature, {
            context: props.hoverPreview!,
            stations: props.stations,
            devices: devicePointFrame.value,
            resources: props.resourceFrame,
          }) || undefined
        );
      return undefined;
    }) ?? null
  );
}
function moveHoverPreview(pixel: number[], dragging: boolean) {
  if (dragging || !hoverEnabled.value) {
    clearHoverPreview();
    return;
  }
  const summary = previewAt(pixel),
    size = map?.getSize();
  if (!summary || !size || size[0] < 40 || size[1] < 40) {
    clearHoverPreview();
    return;
  }
  hoverPosition.value = gisHoverPlacement(pixel, size);
  if (hoverKey === summary.key) return;
  clearHoverPreview();
  hoverKey = summary.key;
  hoverPosition.value = gisHoverPlacement(pixel, size);
  const token = hoverSerial,
    owner = props.hoverPreview?.key;
  // 延迟仅保留同一对象；切来源、移出或卸载后旧回调不可重新显示。
  hoverTimer = setTimeout(() => {
    if (
      hoverAlive &&
      token === hoverSerial &&
      hoverEnabled.value &&
      owner === props.hoverPreview?.key
    )
      hoverSummary.value = summary;
  }, 200);
}
watch([() => props.hoverPreview, () => props.picking], clearHoverPreview, {
  deep: true,
  flush: 'sync',
});
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
  () => pickAlive && fullScene.value && props.picking && props.gisPick?.active,
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
let lastViewportKey = '';
let resizeFrame: number | undefined;
let lastSize = '';
let renderedCoverage: ReturnType<typeof coverageLayers> | null = null;
let coverageKey: { value: PlanningMapOverlay['coverage']; url: string } | null = null;
// 道路按视口加载离线瓦片，业务图层无需等待；卸载时取消当前地图未完成的道路请求。
const roadManager = roadLayer((state) => {
  roadState.value = state;
});
const roads = roadManager.layer;
let originalRoadExtent:number[]|undefined,settingRoadExtent=false;
function updateRoadClip(){
  const dem=props.terrainBasemap?.extent;
  let target=originalRoadExtent;
  if(dem&&target){
    const a=projectCoordinate([dem[0],dem[1]]),b=projectCoordinate([dem[2],dem[3]]);
    target=[Math.max(target[0],a[0]),Math.max(target[1],a[1]),Math.min(target[2],b[0]),Math.min(target[3],b[1])];
    if(target[0]>=target[2]||target[1]>=target[3])target=[0,0,0,0];
  }
  const current=roads.getExtent();
  if(current===target||current&&target&&current.every((part,i)=>part===target![i]))return;
  // 仅裁剪显示范围，保留道路瓦片自己的真实坐标与许可信息。
  settingRoadExtent=true;try{roads.setExtent(target);}finally{settingRoadExtent=false;}
}
const roadClipListener=roads.on('change:extent',()=>{if(!settingRoadExtent){originalRoadExtent=roads.getExtent()?.slice();updateRoadClip();}});
const terrainRenderError = ref(false);
let terrainLayer: ImageLayer<ImageStatic> | null = null;
let terrainKey: TerrainBasemap | null = null;
let terrainListeners: EventsKey[] = [];
function clearTerrain() {
  unByKey(terrainListeners);
  terrainListeners = [];
  terrainLayer?.getSource()?.dispose();
  terrainLayer?.dispose();
  terrainLayer = null;
  terrainKey = null;
  terrainRenderError.value = false;
}
function updateTerrain() {
  if (terrainKey === (props.terrainBasemap ?? null)) return;
  clearTerrain();
  if (!props.terrainBasemap) return;
  terrainKey = props.terrainBasemap;
  const source = new ImageStatic({ url: terrainKey.url, imageExtent: terrainKey.extent, projection: 'EPSG:4326' });
  const layer = new ImageLayer({ source });
  terrainLayer = layer;
  // 换版后移除监听；迟到的旧图事件不得影响新图层。
  terrainListeners = [source.on('imageloaderror', () => {
    if (terrainLayer !== layer) return;
    terrainRenderError.value = true;
    layer.setVisible(false);
  }), source.on('imageloadend', () => {
    if (terrainLayer !== layer) return;
    terrainRenderError.value = false;
    layer.setVisible(true);
  })];
}
function paint() {
  if (!map) return;
  updateTerrain();
  updateRoadClip();
  clearHoverPreview();
  clearPickHover();
  pickClustered.value = false;
  if (pickClusterListener) unByKey(pickClusterListener);
  pickClusterListener = undefined;
  pickNodes = undefined;
  pickSources = undefined;
  // 清空结果后失效旧图片回调；仅切换页签时仍复用该快照的图层。
  if (fullScene.value || !props.planningOverlay?.coverage) {
    renderedCoverage = null;
    coverageKey = null;
    rasterRenderState.value = 'idle';
  }
  devicePoints.update(devicePointFrame.value);
  planningCandidatePoints.update(props.planningCandidates);
  updateDeployment();
  if (!fullScene.value) {
    // 简单资源底层不创建其他网络图层；富场景继续组合已提供的结果。
    renderedLinks = null;
    renderedCandidates = null;
    renderedImpactLinks = undefined;
    impactObjectCounts.value = { nodes: 0, links: 0 };
    updateLinkDisplay();
    roads.setVisible(props.showRoads);
    const layers: import('ol/layer/Base').default[] = [...(terrainLayer ? [terrainLayer] : []), roads];
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
    interferenceGeometryNotice.value = '';
    if (props.interferenceProjection) {
      const layer = interferenceWorkbenchLayer(props.interferenceProjection, props.selectedId, props.selectedLinkId, props.selectedInterferenceId);
      interferenceGeometryNotice.value = layer.get('geometryNotice') ?? '';
      layers.push(layer);
    }
    else if (props.frozenNetwork) layers.push(gisPlanLayer(props.frozenNetwork, { node: props.selectedId, link: props.selectedLinkId, demand: props.selectedDemandId }));
    else layers.push(resourceReadLayer(props.resourceFrame, props.selectedId, props.resourceSelectedKind));
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
  // 候选只读取当前维护集合，缺失或空集合都不补入旧结果。
  const candidates = candidateLinkLayer(
    props.candidateWorkset ?? [],
    props.candidateStations ?? props.stations,
    props.selectedCandidateLinkId,
  );
  renderedCandidates = candidates;
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
  const propagation = diagnosisPropagationLayer(
    props.diagnosisPaths,
    props.stations,
    props.diagnosisDevices,
    props.links,
  );
  propagation.setOpacity(diagnosisSetting.value.opacity);
  propagation.setVisible(diagnosisShown.value);
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
  // 公共点位沿用服务聚合，仅用同版本完整资料补充已有的人工来源样式。
  const resourceBase = props.resourceRead
    ? resourceReadLayer(props.resourceFrame, props.selectedId, props.resourceSelectedKind)
    : null;
  if (resourceBase && props.resourceMarkers) {
    const style = resourceBase.getStyleFunction()!,
      manual = new Set(
        props.stations.filter((node) => node.origin === 'MANUAL').map((node) => node.id),
      );
    resourceBase.setStyle((feature, resolution) => {
      const current = style(feature, resolution),
        point = feature.get('object');
      if (!point || point.kind !== 'node' || !manual.has(point.id) || point.id === props.selectedId)
        return current;
      const copy = (
        Array.isArray(current) ? current : current instanceof Style ? [current] : []
      ).map((item) => item.clone());
      for (const item of copy) {
        const image = item.getImage();
        if (image instanceof CircleStyle) {
          image.getStroke()?.setColor('#dcb976');
          image.getStroke()?.setWidth(3);
        }
      }
      return copy;
    });
  }
  map.setLayers([
    ...(terrainLayer ? [terrainLayer] : []),
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
    ...(resourceBase ? [resourceBase] : [nodes]),
    ...(devicePointFrame.value ? [devicePoints.layer] : []),
    ...(props.planningCandidates ? [planningCandidatePoints.layer] : []),
    ...(props.deploymentConstraints ? [deploymentLayer.layer] : []),
    ...(analysis.linkObjects ? [analysis.linkObjects] : []),
    analysis.objects,
    ...(!props.resourceRead ? [interference] : []),
    resourcePickLayer(props.pickPreview),
    ...(props.gisPick ? [pickHighlight.layer] : []),
    diagnosisFaultLayer(props.diagnosisFaults, props.stations, props.diagnosisDevices, props.links),
    propagation,
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
  const visible = fullScene.value && topologyShown.value;
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
    !fullScene.value && props.showCoverage,
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
  const bbox =
    row?.representation === 'heatmap'
      ? row.sample.heatmapPng?.bbox
      : row?.sample.coverage.rasterPng?.bbox;
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
  if (map && props.interferenceProjection) {
    const points = workbenchCoordinates(props.interferenceProjection);
    if (points.length) map.getView().fit(boundingExtent(points.map(projectCoordinate)), { padding: [65, 65, 60, 65], maxZoom: 11 });
    return;
  }
  if (map && props.frozenNetwork?.nodes.length) {
    map.getView().fit(boundingExtent(props.frozenNetwork.nodes.map(node => projectCoordinate(node.coordinate))), { padding: [65, 65, 60, 65], maxZoom: 11 });
    return;
  }
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
    fullScene.value &&
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
  if (!map || !fullScene.value || props.candidateWorkset === undefined) return;
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
  map.on('moveend', () => {
    if (!props.resourceRead) return;
    const bbox = resourceViewport(map!.getView().calculateExtent(map!.getSize()));
    if (bbox) {
      const zoom=Math.round((map!.getView().getZoom() ?? 9) * 100) / 100;
      const key=JSON.stringify([bbox.map(part=>Math.round(part*1e7)/1e7),zoom]);
      if(key!==lastViewportKey){lastViewportKey=key;emit('viewport',bbox,zoom);}
    }
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
  map.on('pointermove', (event) => moveHoverPreview(event.pixel, event.dragging));
  map.on('movestart', clearHoverPreview);
  map.on('pointerdrag', clearHoverPreview);
  hoverViewListeners.push(
    map.getView().on('change:center', clearHoverPreview),
    map.getView().on('change:resolution', clearHoverPreview),
    map.getView().on('change:rotation', clearHoverPreview),
  );
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
  map.getViewport().addEventListener('pointerdown', captureReadPress, true);
  map.on('click', (event) => {
    if (event.originalEvent && readPress) readClicks.set(event.originalEvent, readPress);
    readPress = '';
    clearHoverPreview();
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
      const frozenKind = feature.get('kind');
      if (typeof frozenKind === 'string' && frozenKind.startsWith('workbench-')) {
        if (!event.originalEvent || readClicks.get(event.originalEvent) !== readOwner() || feature.get('owner') !== readOwner()) return true;
        const id = feature.get('objectId');
        if (frozenKind === 'workbench-node') emit('selectFrozenNode', id);
        if (frozenKind === 'workbench-link') emit('selectFrozenLink', id);
        if (frozenKind === 'workbench-source') emit('selectInterference', id);
        return frozenKind === 'workbench-area' ? undefined : true;
      }
      if (typeof frozenKind === 'string' && frozenKind.startsWith('frozen-plan-')) {
        if (!event.originalEvent || readClicks.get(event.originalEvent) !== readOwner()) return true;
        if (feature.get('snapshot') !== props.frozenNetwork?.identity.snapshot_id) return true;
        const id = feature.get('objectId');
        if (frozenKind === 'frozen-plan-node') emit('selectFrozenNode', id);
        if (frozenKind === 'frozen-plan-link') emit('selectFrozenLink', id);
        if (frozenKind === 'frozen-plan-demand') emit('selectFrozenDemand', id);
        return true;
      }
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
          !fullScene.value ||
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
  observer = new ResizeObserver(() => {
    const element = host.value;
    if (!element || element.clientWidth <= 0 || element.clientHeight <= 0) return;
    const size = `${element.clientWidth}:${element.clientHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    // 过滤同尺寸通知并合并一帧内多次变更，不在尺寸观察回调中同步改变布局。
    if (resizeFrame !== undefined) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = undefined;
      if (!hoverAlive) return;
      clearHoverPreview(); map?.updateSize();
    });
  });
  observer.observe(host.value!);
});
watch(
  () => [
    props.resourceRead,
    props.terrainBasemap,
    props.richScene,
    props.resourceFrame,
    props.resourceSelectedKind,
    props.planningOverlay,
    props.frozenNetwork,
    props.interferenceProjection,
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
    props.candidateWorkset,
    props.candidateStations,
    props.selectedCandidateLinkId,
    props.selectedId,
    props.selectedLinkId,
    props.diagnosisFaults,
    props.diagnosisRegions,
    props.diagnosisPaths,
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
    if (fullScene.value && (value === undefined) !== (previous === undefined)) paint();
    else if (topologyEnabled.value) updateLinkDisplay();
  },
);
watch(() => props.coverageDisplay, updateHttpCoverage);
watch(() => props.mockCoverageDisplay, updateMockCoverage);
watch(() => props.deviceCoverageDisplay, updateDeviceCoverage);
watch(() => props.selectedId, locate);
watch(() => props.frozenNetwork?.identity.snapshot_id, () => { if (props.frozenNetwork) fit(); });
watch(() => props.interferenceProjection ? workbenchMapKey(props.interferenceProjection) : '', () => { if (props.interferenceProjection) fit(); });
watch(
  () => props.planningOverlay?.snapshotId,
  () => {
    if (props.planningOverlay?.snapshotId) fit();
  },
);
watch(() => props.selectedInterferenceId, locate);
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape') clearHoverPreview();
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
  hoverAlive = false;
  clearHoverPreview();
  unByKey(hoverViewListeners);
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
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
  mockCoverageLayers?.dispose();
  renderedCoverage = null;
  deviceLayers.dispose();
  devicePoints.dispose();
  planningCandidatePoints.dispose();
  candidatePress = undefined;
  deploymentLayer.dispose();
  unByKey(roadClipListener);
  roadManager.dispose();
  clearTerrain();
  map?.getViewport().removeEventListener('pointerdown', captureReadPress, true);
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
.map-caption.with-terrain {
  max-width: calc(100% - 100px);
  flex-wrap: wrap;
}
.map-caption .terrain-error {
  color: #f0b972;
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
.gis-legend .cluster-key {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 1.5px solid #52a8db;
  background: #143e63;
  color: #e1f2ff;
  font-size: 9px;
  font-style: normal;
  line-height: 1;
}
.gis-legend .station-cluster {
  width: 16px;
  height: 16px;
}
.gis-legend .device-cluster {
  width: 20px;
  height: 20px;
}
.gis-legend .manual-key,
.gis-legend .source-key,
.gis-legend .impact-key {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  border-radius: 50%;
}
.gis-legend .manual-key {
  border: 2px solid #dcb976;
  background: #10283d;
}
.gis-legend .source-key {
  border: 1px solid #462e24;
}
.gis-legend .impact-key {
  border: 2px solid;
}
.gis-legend .area-key {
  width: 14px;
  height: 10px;
  flex: 0 0 auto;
  border: 1px solid;
}
.gis-legend .demand-key {
  border-top: 2px dashed #b798e3;
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
