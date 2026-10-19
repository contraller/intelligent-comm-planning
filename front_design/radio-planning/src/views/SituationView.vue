<template>
  <div
    v-if="data"
    class="situation-page"
  >
    <div class="situation-toolbar">
      <div class="toolbar">
        <h2>区域网络态势</h2>
        <span class="divider" /><span class="muted">太行山地区域通信保障</span
        ><span
          class="chip blue"
          aria-label="当前视图数据来源"
          >{{ visibleSource }}</span
        >
      </div>
      <div class="toolbar">
        <span class="chip">{{
          diagnosisMode
            ? '诊断只读快照'
            : editing
              ? editor.dirty
                ? '编辑中 · 未保存'
                : '编辑模式'
              : '浏览模式'
        }}</span>
        <button
          v-if="!editing && !diagnosisMode"
          class="btn small"
          :disabled="!editor.canEdit || editor.busy"
          @click="configurationAction(() => gis.begin())"
        >
          <i class="pi pi-pencil" />编辑
        </button>
        <template v-else-if="!diagnosisMode">
          <button
            class="btn small"
            :disabled="
              !editor.canEdit || editor.busy || (!gis.undoStack.length && !editor.formDirty)
            "
            @click="configurationAction(() => gis.moveHistory('undo'))"
          >
            撤销
          </button>
          <button
            class="btn small"
            :disabled="!editor.canEdit || editor.busy || !gis.redoStack.length"
            @click="configurationAction(() => gis.moveHistory('redo'))"
          >
            重做
          </button>
          <button
            class="btn primary small"
            :disabled="!editor.canEdit || editor.busy"
            @click="configurationAction(() => gis.save())"
          >
            <i class="pi pi-save" />{{ editor.busy ? '保存中…' : '保存' }}
          </button>
          <button
            class="btn small"
            :disabled="!editor.canEdit || editor.busy"
            @click="
              configurationAction(async () => {
                const ok = await gis.leave();
                if (ok) editor.clearSession();
                return ok;
              })
            "
          >
            退出编辑
          </button>
        </template>
      </div>
    </div>
    <div class="maintenance-toolbar toolbar">
      <button
        class="btn small"
        :class="{ primary: gis.mapMode === 'resource' }"
        @click="
          configurationAction(() => {
            gis.mapMode = 'resource';
          })
        "
        >资源视图</button
      >
      <button
        v-if="auth.can('diagnosis.view')"
        class="btn small"
        :class="{ primary: diagnosisMode }"
        @click="configurationAction(() => openDiagnosis())"
        >诊断快照</button
      >
      <button
        v-if="analysis.readable"
        class="btn small"
        :class="{ primary: snapshotMode }"
        @click="configurationAction(openInterferenceAnalysis)"
        >干扰分析{{ snapshotMode ? ' · 冻结快照' : '' }}</button
      >
      <button
        v-if="monitor.networkReadable"
        class="btn small"
        :class="{ primary: monitorMode }"
        @click="configurationAction(() => monitor.showNetwork())"
        >监控网络快照</button
      >
      <template v-if="editing"
        ><button
          class="btn small"
          :disabled="!editor.canEdit || editor.busy"
          @click="newPoint('station')"
          >新建固定站</button
        ><button
          class="btn small"
          :disabled="!editor.canEdit || editor.busy"
          @click="newPoint('interference')"
          >新建干扰源</button
        ><button
          class="btn small"
          :disabled="!editor.canEdit || editor.busy"
          @click="importResources"
          >导入资源</button
        ></template
      >
      <button
        v-if="editing && gis.mapMode === 'resource'"
        class="btn small"
        :disabled="!editor.canEdit || editor.busy || editor.picking"
        :onClick="candidateActions.create"
        >新建候选链路</button
      >
      <button
        class="btn small"
        :disabled="!auth.can('resources.view') || editor.busy"
        @click="
          configurationAction(() => {
            exportOpen = true;
          })
        "
        >导出已保存资源</button
      >
      <span class="muted">{{
        diagnosisMode
          ? '诊断快照只读；切回资源视图继续原草稿操作'
          : editing
            ? '点选位置后填写参数；草稿需统一保存'
            : '当前资源点位 · 业务结果为历史快照'
      }}</span>
    </div>
    <div
      v-if="focusError || editor.error"
      class="edit-notice error"
      role="alert"
      >{{ focusError || editor.error }}</div
    >
    <GisValidationPanel
      v-if="gis.validationIssues.length"
      :issues="gis.validationIssues"
      message=""
      :notice="validation.notice.value"
      :disabled="validation.disabled.value"
      :reason="validation.reason"
      @locate="validation.locate"
    />
    <div
      v-if="editor.message"
      class="edit-notice"
      role="status"
      >{{ editor.message }}</div
    >
    <div
      v-if="resourceFiltersActive"
      class="edit-notice"
      role="status"
    >
      <template v-if="!diagnosisMode && !monitorMode && !snapshotMode"
        >资源筛选：{{ stations.length }} 个节点、{{
          interferences.length
        }}
        个干扰源。筛选仅改变点位和连线显示。</template
      >
      <template v-else>当前快照保持完整；筛选仅更新资源树，切换“资源视图”后同步到地图。</template>
      <span v-if="selectedResourceFiltered"
        >当前选中对象不在筛选结果中，详情和编辑内容已保留。</span
      >
      <button
        class="text-link"
        @click="clearResourceFilters"
        >清除筛选</button
      >
    </div>
    <ResourceStatusPanel
      v-if="env.mode === 'mock'"
      context="gis"
      :enabled="statusEnabled"
      :paused-reason="
        statusEnabled
          ? ''
          : editing
            ? '编辑态暂不叠加同步观测，显示已应用草稿的台账基线；退出后恢复来源偏好。'
            : '当前快照暂停台账观测，返回普通资源浏览后恢复。'
      "
    />
    <div
      v-if="deviceDisplay.hiddenSelection.value"
      class="edit-notice"
      role="status"
      >当前选中设备未在地图显示，详情和编辑内容已保留；可在图层管理调整设备显示条件。</div
    >
    <div
      v-if="oldResultsHidden && !snapshotMode && !monitorMode && !diagnosisMode"
      class="edit-notice"
    >
      资源已有修改，当前输入暂无预生成结果；旧链路和区域图层已隐藏。<RouterLink
        v-if="auth.can('planning.view')"
        class="text-link"
        to="/planning"
        >查看历史方案快照</RouterLink
      >
    </div>
    <div
      class="situation-main"
      :class="{ 'details-open': rightOpen }"
    >
      <!-- 收起面板或切换标签保留任务表单，避免丢失尚未应用的需求输入。 -->
      <aside
        v-show="leftOpen"
        class="situation-left panel"
        :class="{ 'task-mode': sideTab === '任务输入' }"
      >
        <div class="panel-head">
          <h3><i class="pi pi-sitemap" />资源与图层</h3>
          <button
            class="icon-btn"
            aria-label="收起资源面板"
            @click="leftOpen = false"
          >
            <i class="pi pi-angle-double-left" />
          </button>
        </div>
        <div class="tabs">
          <button
            v-for="tab in auth.can('planning.view')
              ? ['资源树', '图层管理', '任务输入']
              : ['资源树', '图层管理']"
            :key="tab"
            :class="{ active: sideTab === tab }"
            @click="sideTab = tab"
          >
            {{ tab }}
          </button>
        </div>
        <GisResourceTree
          v-if="sideTab === '资源树'"
          :key="diagnosisMode ? diagnosis.contextKey.value : 'resource-tree'"
          v-model:query="query"
          v-model:filter="filter"
          :tree="resourceTree"
          :resources="resources"
          :selected-id="selectedId"
          :selected-device-id="selectedDeviceId"
          :selected-link-id="selectedLinkId"
          :selected-interference-id="selectedInterferenceId"
          :selected-candidate-link-id="selectedCandidateLinkId"
          :candidate-disabled="gis.mapMode !== 'resource'"
          :total-nodes="data.resources.stations.length"
          :total-devices="data.resources.devices.length"
          :disabled="!auth.can('situation.view') || editor.busy || editor.picking"
          @select-station="resourceSelection.station"
          @select-device="directorySelection.device"
          @select-link="directorySelection.link"
          @select-interference="resourceSelection.interference"
          :onSelectCandidateLink="candidateActions.select"
        />
        <div
          v-if="auth.can('planning.view')"
          v-show="sideTab === '任务输入'"
          class="task-scroll"
          ><p
            v-if="planning.loadError"
            role="alert"
            >{{ planning.loadError
            }}<button
              class="btn small"
              @click="planning.reload()"
              >重试</button
            ></p
          ><TaskWorkspacePanel
            ref="taskPanelRef"
            v-else-if="planning.draft"
            context="gis"
            @locate-issue="locateTaskIssue"
            :resources="resources"
            :changes="gis.changes()"
            :selected-demand-id="selectedDemand"
          /><p v-else>正在加载任务输入…</p></div
        >
        <div
          v-if="sideTab === '图层管理'"
          class="layer-settings"
        >
          <p class="muted">显示与透明度仅影响已有结果渲染。</p>
          <label v-if="auth.can('planning.view')"
            ><input
              v-model="demandsVisible"
              type="checkbox"
            />任务通联需求 / 部署输入约束</label
          ><label
            ><input
              v-model="roads"
              type="checkbox"
            />本地道路</label
          ><label
            ><input
              v-model="nodes"
              type="checkbox"
            />站点参考点</label
          ><label
            ><input
              v-model="interferenceVisible"
              type="checkbox"
            />干扰源点位</label
          >
          <!-- 控件按显示代次重建，旧 DOM 不能把输入转交给新上下文。 -->
          <div
            :key="topologyEpoch"
            class="topology-settings"
          >
            <label
              ><input
                :checked="links"
                type="checkbox"
                aria-label="显示规划后链路"
                :disabled="!topologyAvailable"
                :onChange="topologyActions.visible"
              />规划后链路</label
            >
            <label
              >拓扑透明度 {{ Math.round(topologyOpacity * 100) }}%
              <input
                type="range"
                aria-label="拓扑透明度"
                min="0"
                max="1"
                step="0.1"
                :value="topologyOpacity"
                :disabled="!topologyAvailable"
                :onInput="topologyActions.opacity"
              />
            </label>
            <p class="muted">仅控制正式链路及其选中、受扰高亮。{{ topologyReason }}</p>
          </div>
          <label
            ><input
              :checked="candidates"
              :onChange="candidateActions.visible"
              type="checkbox"
              :disabled="
                gis.mapMode !== 'resource' ||
                !auth.can('situation.view') ||
                editor.busy ||
                editor.picking
              "
            />候选链路（独立数据）</label
          >
          <GisDeviceLayerPanel
            :settings="deviceDisplay.settings.value"
            :state="deviceDisplay.state.value"
            :observed="statusObserved"
            :status-source="statusSource"
            :available="deviceDisplay.available.value"
            :missing-count="deviceDisplay.catalog.value.missingCount"
            :count="deviceDisplay.points.value.length"
            :frequency-input="deviceDisplay.frequencyInput.value"
            :frequency="deviceDisplay.frequency.value"
            :frequency-pending="deviceDisplay.frequencyPending.value"
            :frequency-error="deviceDisplay.frequencyError.value"
            :frequency-notice="deviceDisplay.frequencyNotice.value"
            @update-frequency="deviceDisplay.frequencyActions.value.update"
            @apply-frequency="deviceDisplay.frequencyActions.value.apply"
            @clear-frequency="deviceDisplay.frequencyActions.value.clear"
            @configure="deviceDisplay.configure.value"
            @filter="deviceDisplay.filter.value"
          />
          <!-- 更换显示所有者时销毁旧控件，避免旧 DOM 的 emit 转发给新报告。 -->
          <GisResultLayerPanel
            :key="
              gis.mapMode +
              ':' +
              auth.generation +
              ':' +
              auth.can('situation.view') +
              ':' +
              (diagnosisMode ? diagnosis.contextKey.value : '')
            "
            :rows="resultLayers.rows.value"
            @change="resultLayers.change.value"
          />
          <div class="notice section-gap">覆盖轮廓与孔洞来自预生成结果，地图操作不触发计算。</div>
          <DeviceCoveragePanel
            :samples="deviceCoverage.samples.value"
            :mode="deviceCoverage.state.mode"
            :display="deviceCoverage.state.display"
            :single-id="deviceCoverage.state.singleId"
            :selected-ids="deviceCoverage.state.selectedIds"
            :overlays="deviceCoverage.overlays.value"
            :loads="deviceCoverage.state.loads"
            :paused-reason="deviceCoverage.pausedReason.value"
            :enabled="
              resultLayers.rendered.value.coverage.visible &&
              resultLayers.rendered.value.coverage.opacity > 0
            "
            :can-resume="diagnosisMode || snapshotMode || monitorMode"
            @mode="deviceCoverage.setMode"
            @display="deviceCoverage.state.display = $event"
            @single="deviceCoverage.open"
            @toggle="deviceCoverage.toggle"
            @configure="deviceCoverage.configure"
            @clear="deviceCoverage.state.selectedIds = []"
            @locate="mapRef?.fitDeviceCoverage($event)"
            @retry="mapRef?.retryDeviceCoverage($event)"
            @resume="gis.mapMode = 'resource'"
          />
        </div>
      </aside>
      <div
        class="situation-center"
        :class="{ 'monitor-active': monitorMode }"
      >
        <div class="map-frame panel">
          <div
            v-if="!links || topologyOpacity === 0"
            class="topology-notice"
            >{{
              !links ? '拓扑已关闭' : '拓扑透明度为 0'
            }}，详情与定位仍可用；可在图层管理恢复。</div
          >
          <div
            v-if="diagnosisMode"
            class="snapshot-label"
            >诊断冻结网络 · {{ diagnosis.display.value?.record.network.id ?? '暂无可用报告' }} ·
            {{
              diagnosis.display.value?.record.network.snapshotId ??
              diagnosis.target.value.id ??
              '无效目标'
            }}
            ·
            {{
              diagnosis.refreshing.value
                ? '来源正在重新核实'
                : diagnosis.display.value
                  ? diagnosisLabel(diagnosis.display.value.record.source.state)
                  : diagnosis.error.value || '正在读取完整报告'
            }}</div
          >
          <div
            v-if="snapshotMode"
            class="snapshot-label"
            >分析冻结网络 · {{ analysis.selected?.run.network.version }} ·
            {{ analysis.effectiveAfter ? '措施后预评估' : '措施前影响' }} ·
            {{ analysis.selected?.source.state === 'CURRENT' ? '当前来源' : '历史 / 待核实' }}</div
          >
          <div
            v-if="monitorMode"
            class="snapshot-label"
            >监控冻结网络 · {{ monitor.network?.version }} ·
            {{
              monitor.network?.kind === 'DEMO'
                ? '内置演示'
                : monitor.context?.source.state === 'CURRENT'
                  ? '当前确认方案'
                  : '历史 / 待核实'
            }}
            · {{ monitor.networkResult?.frame.observedAt ?? '暂无观测' }}</div
          >
          <MapCanvas
            ref="mapRef"
            collapsible-legend
            :key="
              diagnosisMode
                ? diagnosis.contextKey.value
                : monitorMode
                  ? 'monitor:' + monitor.network?.key
                  : 'gis'
            "
            :device-coverage-active="deviceCoverage.active.value"
            :device-coverages="mapLayerInputs.deviceCoverages"
            :device-coverage-display="deviceCoverage.state.display"
            @device-coverage-state="deviceCoverage.loaded"
            :stations="mapStations"
            :gis-device-frame="deviceDisplay.frame.value"
            @select-device="pickMapDevice"
            @select-device-cluster="openDeviceCluster"
            :demands="mapLayerInputs.demands"
            :show-demands="demandsVisible"
            :selected-demand-id="selectedDemand"
            @select-demand="mapSelection.demand"
            :deployment-constraints="mapLayerInputs.deployment"
            :interferences="mapSources"
            :selected-interference-id="
              diagnosisMode || monitorMode
                ? undefined
                : snapshotMode
                  ? analysisSource
                  : selectedInterferenceId
            "
            :show-interferences="interferenceVisible"
            :resource-markers="!diagnosisMode && !snapshotMode && !monitorMode"
            :picking="!diagnosisMode && !snapshotMode && !monitorMode && editor.picking"
            :pick-label="editor.form?.kind === 'station' ? '固定站' : '干扰源'"
            :pick-preview="diagnosisMode || snapshotMode || monitorMode ? undefined : pickPreview"
            :gis-pick="gisPick.context.value"
            @gis-pick="gisPick.actions.value.pick"
            @gis-pick-cancel="gisPick.actions.value.cancel"
            @gis-pick-toggle="gisPick.actions.value.toggle"
            @select-interference="mapSelection.source"
            :links="mapLinks"
            :select-links="topologyVisible"
            :topology-opacity="topologyOpacity"
            :selected-link-id="
              diagnosisMode
                ? diagnosisLink
                : monitorMode
                  ? monitor.selectedLinkId
                  : snapshotMode
                    ? analysisLink
                    : resourceLinkHighlightIds[0]
            "
            :onSelectLink="mapSelection.link"
            :highlight-link-ids="mapLayerInputs.highlightLinks"
            :highlight-station-ids="mapLayerInputs.highlightStations"
            :diagnosis-devices="mapLayerInputs.diagnosisDevices"
            :diagnosis-faults="mapLayerInputs.diagnosisFaults"
            :diagnosis-regions="mapLayerInputs.diagnosisRegions"
            @select-fault="mapSelection.fault"
            :interference-impact="snapshotMode ? analysis.filteredImpact : null"
            :candidate-links="mapLayerInputs.candidates"
            :candidate-workset="mapLayerInputs.candidateWorkset"
            :candidate-stations="resources.stations"
            :selected-candidate-link-id="gis.mapMode === 'resource' ? candidateMapSelection : ''"
            :onSelectCandidateLink="candidateActions.map"
            :regions="mapRegions"
            :selected-id="
              diagnosisMode
                ? diagnosisNode
                : monitorMode
                  ? monitor.selectedStationId
                  : snapshotMode
                    ? analysisNode
                    : selectedId
            "
            :show-roads="roads"
            :show-nodes="nodes"
            :show-links="links && topologyAvailable"
            :show-candidates="
              gis.mapMode === 'resource' && auth.can('situation.view') && candidates
            "
            :gis-result-layers="resultLayers.rendered.value"
            :show-coverage="resultLayers.rendered.value.coverage.visible"
            :opacity="resultLayers.rendered.value.coverage.opacity"
            @select="mapSelection.node"
          />
          <div class="panel-toggle">
            <button
              v-if="!leftOpen || rightOpen"
              class="btn small"
              :class="{ 'narrow-only': leftOpen }"
              @click="showResourcePanel"
            >
              <i class="pi pi-angle-double-right" />资源</button
            ><button
              v-if="!rightOpen"
              class="btn small"
              @click="rightOpen = true"
            >
              详情<i class="pi pi-angle-double-left" />
            </button>
          </div>
        </div>
        <!-- 监控抽屉独立维护图表与播放，页面只传递地图上下文。 -->
        <SituationMonitoringDrawer />
      </div>
      <aside
        v-if="rightOpen"
        class="situation-right panel"
        :class="{ 'analysis-width': diagnosisMode || (!monitorMode && rightTab === '干扰分析') }"
      >
        <div class="panel-head">
          <h3
            ><i class="pi pi-info-circle" />{{
              diagnosisMode ? '诊断快照' : monitorMode ? '监控详情' : rightTab
            }}</h3
          >
          <button
            class="icon-btn"
            aria-label="收起详情面板"
            @click="rightOpen = false"
          >
            <i class="pi pi-angle-double-right" />
          </button>
        </div>
        <div
          v-if="!monitorMode && !diagnosisMode"
          class="tabs"
          ><button
            :class="{ active: rightTab === '对象详情' }"
            @click="
              configurationAction(() => {
                rightTab = '对象详情';
                gis.mapMode = 'resource';
              })
            "
            >对象详情</button
          ><button
            :class="{ active: rightTab === '干扰分析' }"
            @click="configurationAction(openInterferenceAnalysis)"
            >干扰分析</button
          ></div
        >
        <div class="detail-scroll">
          <GisDeviceClusterPanel
            v-if="deviceDisplay.members.value.length"
            :members="deviceDisplay.members.value"
            :disabled="!deviceDisplay.available.value || editor.busy || editor.picking"
            @select="pickClusterDevice"
            @close="deviceDisplay.close"
          />
          <GisDiagnosisPanel
            v-if="diagnosisMode"
            :target-id="diagnosis.target.value.id"
            :display="diagnosis.display.value"
            :status="diagnosis.status.value"
            :error="diagnosis.error.value"
            :refreshing="diagnosis.refreshing.value"
            :levels="diagnosis.levels.value"
            :selected="diagnosis.selected.value"
            :impact="diagnosis.impact.value"
            :actions="diagnosis.actions.value"
            @leave="diagnosis.leave"
          />
          <MonitoringObjectPanel v-else-if="monitorMode" />
          <InterferenceAnalysisPanel
            v-else-if="rightTab === '干扰分析'"
            :measure-targets="measureNavigation.list.value"
            :target-notice="measureNavigation.notice.value"
            :source="analysisDetailSource"
            :source-editable="!snapshotMode && editing && editor.canEdit && !editor.busy"
            :selected-node-id="analysisNode"
            :selected-link-id="analysisLink"
            @edit-source="
              (id) => configurationAction(() => editor.openForm('interference', id, 'gis'))
            "
            @select-node="focusAnalysisNode"
            @select-link="focusAnalysisLink"
            @select-source="selectInterference"
          />
          <LinkDetailPanel
            v-else-if="!snapshotMode && selectedResourceLink"
            :link="selectedResourceLink"
            :resources="resources"
            :context="linkDetails"
            :hidden="!links || topologyOpacity === 0 || selectedResourceFiltered"
          />
          <CandidateLinkPanel
            v-else-if="gis.mapMode === 'resource' && selectedCandidateLink"
            :link="selectedCandidateLink"
            :resources="resources"
            :hidden="!candidates || selectedResourceFiltered"
            :dirty="editing && editor.dirty"
            :editable="editing && editor.canEdit && !editor.busy"
            :onEdit="candidateActions.edit"
          />
          <ObjectInfoPanel
            v-else
            coverage-enabled
            @view-coverage="openDeviceCoverage"
            :station="selected"
            :resources="resources"
            :device-catalog="data.deviceDetails"
            :device-network="deviceNetwork"
            :status-displays="statusDisplays"
            :selected-device-id="selectedDeviceId"
            :editable="editing && !editor.busy"
            :draft="editing && editor.draftDirty"
            :configuration="configurationEntry"
            @configure="openConfiguration"
            @select-device="selectDevice"
            @edit-station="(id) => configurationAction(() => editor.openForm('station', id, 'gis'))"
            @edit-device="(id) => configurationAction(() => editor.openForm('device', id, 'gis'))"
            @new-device="(id) => configurationAction(() => editor.newForm('device', 'gis', id))"
          />
        </div>
        <div
          v-if="
            !diagnosisMode &&
            !monitorMode &&
            rightTab === '对象详情' &&
            !selectedResourceLink &&
            !selectedCandidateLink
          "
          class="detail-footer"
        >
          <!-- 这里只说明数据来源，运行状态由设备详情使用服务数据展示。 -->
          <span>{{
            editing && editor.draftDirty ? '数据来源：未保存草稿' : '数据来源：已保存资源'
          }}</span>
        </div>
      </aside>
    </div>
    <template v-if="analysis.readable"
      ><InterferenceHistoryDrawer /><InterferenceMeasureDrawer
        :target-entry="measureNavigation.drawer.value"
        @open-plan="openAdoptedPlan"
    /></template>
    <InterferenceSourceDrawer
      v-model:visible="interferenceOpen"
      :source="selectedInterference"
    />
    <ResourceExportDrawer
      v-model:visible="exportOpen"
      context="gis"
      :filtered-ids="exportFiltered"
      :selected-ids="exportSelected"
      :candidate-filtered-ids="candidateExportFiltered"
      :candidate-selected-ids="candidateExportSelected"
    />
  </div>
  <DecisionDialog
    :request="planning.decision"
    @answer="planning.answer"
  />
</template>
<script setup lang="ts">
import GisValidationPanel from '../components/GisValidationPanel.vue';
import GisDiagnosisPanel from '../components/GisDiagnosisPanel.vue';
import { useSituationDiagnosis } from '../composables/useSituationDiagnosis';
import type { FaultObjectType } from '../types/diagnosis';
import { diagnosisLabel } from '../reports/diagnosis-report';
import { useGisValidationNavigation } from '../composables/useGisValidationNavigation';
import type { PlanningIssue } from '../types/planning';
import SituationMonitoringDrawer from '../components/SituationMonitoringDrawer.vue';
import MonitoringObjectPanel from '../components/MonitoringObjectPanel.vue';
import { useSituationMonitoring } from '../composables/useSituationMonitoring';
import { useInterferenceStore } from '../stores/interference';
import { useInterferenceTargetNavigation } from '../composables/useInterferenceTargetNavigation';
import { configuredStations, planStations } from '../services/planning-snapshot';
import InterferenceAnalysisPanel from '../components/InterferenceAnalysisPanel.vue';
import InterferenceHistoryDrawer from '../components/InterferenceHistoryDrawer.vue';
import InterferenceMeasureDrawer from '../components/InterferenceMeasureDrawer.vue';
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteUpdate } from 'vue-router';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import { usePreviewStore } from '../stores/preview';
import { useResourceEditStore } from '../stores/resource-edit';
import { useGisTaskLeaveGuard } from '../composables/useGisTaskLeaveGuard';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { usePlanningStore } from '../stores/planning';
import TaskWorkspacePanel from '../components/TaskWorkspacePanel.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import MapCanvas from '../components/MapCanvas.vue';
import ObjectInfoPanel from '../components/ObjectInfoPanel.vue';
import LinkDetailPanel from '../components/LinkDetailPanel.vue';
import CandidateLinkPanel from '../components/CandidateLinkPanel.vue';
import { createLinkDetailContext } from '../services/link-detail';
import DeviceCoveragePanel from '../components/DeviceCoveragePanel.vue';
import GisResultLayerPanel from '../components/GisResultLayerPanel.vue';
import GisDeviceLayerPanel from '../components/GisDeviceLayerPanel.vue';
import GisDeviceClusterPanel from '../components/GisDeviceClusterPanel.vue';
import ResourceStatusPanel from '../components/ResourceStatusPanel.vue';
import { useResourceStatusStore } from '../stores/resource-status';
import { env } from '../config/env';
import { useGisDeviceDisplay } from '../composables/useGisDeviceDisplay';
import { useGisPick } from '../composables/useGisPick';
import { useGisResultLayers } from '../composables/useGisResultLayers';
import { useDeviceCoverage } from '../composables/useDeviceCoverage';
import { createDeviceNetworkContext, selectDeviceNetwork } from '../services/device-network';
import InterferenceSourceDrawer from '../components/InterferenceSourceDrawer.vue';
import ResourceExportDrawer from '../components/ResourceExportDrawer.vue';
import GisResourceTree from '../components/GisResourceTree.vue';
import {
  buildGisResourceTree,
  gisResourceExportIds,
  gisCandidateExportIds,
  gisSelectedCandidateExportIds,
} from '../services/gis-resource-tree';
import type {
  GisResourceFilter,
  GisResourceTree as ResourceTreeResult,
} from '../services/gis-resource-tree';
import type { Coordinate } from '../types/domain';
const store = usePreviewStore();
const data = computed(() => store.data!);
const editor = useResourceEditStore();
const route = useRoute(),
  router = useRouter();
const analysis = useInterferenceStore(),
  rightTab = ref('对象详情');
const analysisNode = ref(''),
  analysisLink = ref(''),
  analysisSource = ref('');
// 显式进入分析时退出其他快照；没有记录就显示资源底图和分析输入，不提交分析。
function openInterferenceAnalysis() {
  if (!analysis.readable) return false;
  gis.mapMode = analysis.selected ? 'analysis' : 'resource';
  rightTab.value = '干扰分析';
  rightOpen.value = true;
  return true;
}
const snapshotMode = computed(
  () => analysis.readable && gis.mapMode === 'analysis' && !!analysis.selected,
);
// 措施后网络及其输入来自同一服务快照，不能混用原方案坐标。
const afterResult = computed(() =>
  analysis.effectiveAfter ? analysis.selectedMeasurePreview?.result : null,
);
// 资源图与资源树共用筛选结果；监控和分析仍使用各自完整的冻结网络。
const mapStations = computed(() =>
  diagnosisMode.value
    ? (diagnosis.display.value?.stations ?? [])
    : monitorMode.value && monitorMap.value
      ? monitorMap.value.stations
      : !snapshotMode.value
        ? stations.value
        : afterResult.value
          ? configuredStations(
              afterResult.value.inputSnapshot.stations,
              afterResult.value.configuration,
            )
          : planStations(analysis.selected!.run.network),
);
const mapLinks = computed(() =>
  diagnosisMode.value
    ? (diagnosis.display.value?.links ?? [])
    : monitorMode.value && monitorMap.value
      ? monitorMap.value.links
      : snapshotMode.value
        ? (afterResult.value?.links ?? analysis.selected!.run.network.links)
        : resourceTree.value.links,
);
const mapSources = computed(() =>
  diagnosisMode.value || monitorMode.value
    ? []
    : snapshotMode.value
      ? analysis.selected!.run.sources
      : interferences.value,
);
const analysisDetailSource = computed(() =>
  snapshotMode.value
    ? mapSources.value.find((row) => row.id === analysisSource.value)
    : selectedInterference.value,
);
async function openAdoptedPlan(id: string) {
  if (!(await gis.leave(false, true))) return;
  if (await planning.selectPlan(id)) {
    analysis.measureOpen = false;
    await router.push('/planning');
  }
}
function focusAnalysisNode(id: string) {
  gis.mapMode = 'analysis';
  analysisNode.value = id;
  analysisLink.value = '';
  analysisSource.value = '';
  rightTab.value = '干扰分析';
  rightOpen.value = true;
}
function focusAnalysisLink(id: string) {
  gis.mapMode = 'analysis';
  analysisLink.value = id;
  analysisNode.value = '';
  analysisSource.value = '';
  rightTab.value = '干扰分析';
  rightOpen.value = true;
}
function selectMapSource(id: string) {
  if (!snapshotMode.value) {
    void selectInterference(id);
    return;
  }
  analysisSource.value = id;
  analysisNode.value = '';
  analysisLink.value = '';
  rightTab.value = '干扰分析';
  rightOpen.value = true;
}
watch(
  () => analysis.analysisId,
  () => {
    analysisNode.value = '';
    analysisLink.value = '';
    analysisSource.value = '';
  },
);
useGisTaskLeaveGuard();
const gis = useGisWorkspaceStore(),
  planning = usePlanningStore(),
  selectedDemand = ref(''),
  demandsVisible = ref(true);
const resources = computed(() => editor.resources);
const editing = computed(() => editor.context === 'gis');
const configuration = useDeviceConfigurationStore();
const configurationBlocked = computed(
  () =>
    env.mode !== 'mock' ||
    gis.mapMode !== 'resource' ||
    editor.busy ||
    editor.dirty ||
    !!editor.form ||
    editor.importOpen ||
    gis.busy,
);
const configurationEntry = computed(() =>
  gis.mapMode === 'resource'
    ? {
        editable: editing.value && auth.can('resources.edit'),
        disabled: configurationBlocked.value || auth.blocked,
        reason: configurationBlocked.value
          ? '请先完成或关闭资源表单、导入及未保存草稿'
          : '配置回执独立记录，资源仍需单独保存',
      }
    : undefined,
);
watch(
  () => [
    configuration.visible,
    configuration.context,
    configuration.data,
    configurationBlocked.value,
    editing.value,
    data.value?.resourceMeta.revision,
  ],
  () => {
    const source = configuration.data,
      meta = data.value?.resourceMeta;
    // 退出时资源先清空、组件随后卸载，同步监听不能再读取旧来源。
    if (!meta) return;
    const changed =
      !!source &&
      (source.resourceEpoch !== meta.resourceEpoch ||
        source.deviceVersion !== (meta.deviceVersions[source.deviceId] ?? 'initial'));
    configuration.setEligibility(
      'gis',
      editing.value && !configurationBlocked.value && !changed,
      changed
        ? '来源已变化，请重新读取并校验'
        : gis.mapMode !== 'resource'
          ? '地图已切入其他来源，配置输入保留并冻结'
          : (configurationEntry.value?.reason ?? '当前为只读模式'),
    );
  },
  { flush: 'sync' },
);
// 主动导航先作配置决策；被动地图来源变化仅冻结保留。
async function prepareConfiguration() {
  const session = auth.generation,
    mode = gis.mapMode;
  return (
    (await configuration.leave(true)) &&
    session === auth.generation &&
    mode === gis.mapMode &&
    !auth.blocked
  );
}
async function configurationAction(action: () => unknown | Promise<unknown>) {
  const active = configuration.visible,
    session = auth.generation;
  if (active && !(await prepareConfiguration())) return false;
  if (session !== auth.generation || auth.blocked || !auth.can('situation.view')) return false;
  const value = await action();
  if (value === false) return false;
  if (active && session === auth.generation) configuration.clearForSession();
  return true;
}
async function openConfiguration(id: string, history = false) {
  if (
    !configurationEntry.value ||
    configurationEntry.value.disabled ||
    (!history && !configurationEntry.value.editable) ||
    !resources.value.devices.some((d) => d.id === id) ||
    id !== selectedDeviceId.value
  )
    return;
  if (await configuration.open('gis', id, !history && configurationEntry.value.editable)) {
    configuration.setEligibility(
      'gis',
      editing.value && !configurationBlocked.value,
      configurationEntry.value?.reason,
    );
    if (history) configuration.tab = 'history';
  }
}
onBeforeRouteUpdate(async () => {
  if (!configuration.visible) return true;
  return configurationAction(() => true);
});
const oldResultsHidden = computed(
  () =>
    !data.value ||
    (editing.value && editor.resultsDirty) ||
    !!data.value.resourceMeta.changedStationIds.length ||
    !!data.value.resourceMeta.changedDeviceIds.length ||
    (data.value.resourceMeta.interferenceVersion ?? 'initial') !== 'initial',
);
const selectedDeviceId = ref('');
// 普通 GIS 链路选择独立于监控/分析；资料只绑定当前网络快照。
const selectedLinkId = ref('');
// 候选身份与正式链路分开，即使编号相同也只打开各自的资料。
const selectedCandidateLinkId = ref('');
const selectedCandidateLink = computed(() =>
  resources.value.candidateLinks?.find((row) => row.id === selectedCandidateLinkId.value),
);
// 字段错误的定位只用当前表单合法端点，不让地图选择监听退回旧配置。
const candidateMapSelection = computed(() =>
  editor.form?.kind === 'candidate' && editor.issueFocus?.id === selectedCandidateLinkId.value
    ? ''
    : selectedCandidateLinkId.value,
);
const selectedResourceLink = computed(() =>
  data.value?.situation.links.find((row) => row.id === selectedLinkId.value),
);
const linkDetails = computed(() =>
  createLinkDetailContext(
    data.value.situation,
    data.value.resources,
    data.value.resourceMeta,
    editing.value && editor.resultsDirty,
  ),
);
const resourceLinkHighlightIds = computed(() =>
  auth.can('situation.view') && !oldResultsHidden.value && selectedResourceLink.value
    ? [selectedResourceLink.value.id]
    : [],
);
// 关联资料沿用旧结果保护；GIS 草稿不与演示路径混用。
const deviceNetwork = computed(() =>
  createDeviceNetworkContext(
    data.value.situation,
    data.value.resources,
    data.value.resourceMeta,
    editing.value && editor.resultsDirty,
  ),
);
const resourceDeviceLinkIds = computed(() =>
  auth.can('situation.view')
    ? selectDeviceNetwork(deviceNetwork.value, selectedDeviceId.value).links.map((link) => link.id)
    : [],
);
const selectedInterferenceId = ref(''),
  interferenceOpen = ref(false),
  exportOpen = ref(false),
  interferenceVisible = ref(true);
const selectedInterference = computed(() =>
  resources.value.interferences?.find((row) => row.id === selectedInterferenceId.value),
);
const interferences = computed(() => resourceTree.value.interferences);
const pickPreview = computed<Coordinate | undefined>(() => {
  const fields = editor.form?.fields;
  if (!fields || !fields.longitude?.trim() || !fields.latitude?.trim()) return;
  const point: Coordinate = [Number(fields.longitude), Number(fields.latitude)];
  return point.every(Number.isFinite) ? point : undefined;
});
// 仅把已保存且仍存在的对象放入导出范围，避免混入草稿。
const exportFiltered = computed(() =>
  gisResourceExportIds(resourceTree.value, data.value.resources),
);
const candidateExportFiltered = computed(
  () => gisCandidateExportIds(resourceTree.value, data.value.resources).topology_links,
);
const candidateExportSelected = computed(
  () =>
    gisSelectedCandidateExportIds(selectedCandidateLinkId.value, data.value.resources)
      .topology_links,
);
const exportSelected = computed(() => ({
  nodes: data.value.resources.stations.filter((s) => s.id === selectedId.value).map((s) => s.id),
  devices: data.value.resources.devices
    .filter((d) => d.id === selectedDeviceId.value)
    .map((d) => d.id),
  interference_sources: (data.value.resources.interferences ?? [])
    .filter((i) => i.id === selectedInterferenceId.value)
    .map((i) => i.id),
}));
const focusError = ref('');
const query = ref('');
const filter = ref<GisResourceFilter>('全部');
const resourceFiltersActive = computed(() => !!query.value || filter.value !== '全部');
// 清除筛选只改变显示，不能重置对象选择、未保存表单或草稿。
function clearResourceFilters() {
  query.value = '';
  filter.value = '全部';
}
const selectedId = ref('ND-0001');
const leftOpen = ref(true);
// 普通入口优先显示地图，诊断深链保留报告及错误提示的可见入口。
const rightOpen = ref(route.query.diagnosisId !== undefined);
function showResourcePanel() {
  leftOpen.value = true;
  // 窄窗口只让一个侧栏占位，切换显示不清空对象选择或草稿。
  if (window.matchMedia?.('(max-width: 1280px)').matches) rightOpen.value = false;
}
const mapRef = ref<InstanceType<typeof MapCanvas>>();
// 按参数是否存在识别定位意图；空值或重复值仍交给原定位校验处理。
const hasResourceTarget = computed(() =>
  ['stationId', 'deviceId', 'interferenceId'].some((key) => route.query[key] !== undefined),
);
const diagnosis = useSituationDiagnosis(() => route.query),
  diagnosisMode = diagnosis.active;
const diagnosisNode = computed(() => diagnosis.selected.value?.station?.id ?? '');
const diagnosisLink = computed(() => diagnosis.selected.value?.link?.id ?? '');
// 地图事件绑定渲染时的报告代次，不借当前同名对象解释旧点击。
const mapSelection = computed(() => {
  const diagnostic = diagnosisMode.value,
    actions = diagnosis.actions.value,
    mode = gis.mapMode;
  const topologyContext = topologyEpoch.value;
  const valid = () => gis.mapMode === mode;
  return {
    node: (id: string) =>
      diagnostic
        ? actions.select({ objectType: 'NODE', objectId: id })
        : valid() &&
          (monitorMode.value
            ? monitor.selectStation(id)
            : snapshotMode.value
              ? focusAnalysisNode(id)
              : void select(id)),
    link: (id: string) => {
      // 线条事件必须属于仍可见的当前网络；清单及故障图标沿各自入口选择。
      if (
        topologyContext !== topologyEpoch.value ||
        !topologyVisible.value ||
        !drawableTopologyIds.value.has(id)
      )
        return;
      if (diagnostic) actions.select({ objectType: 'LINK', objectId: id });
      else if (valid()) {
        if (monitorMode.value) monitor.selectLink(id);
        else if (snapshotMode.value) focusAnalysisLink(id);
        else void selectResourceLink(id);
      }
    },
    fault: (type: FaultObjectType, id: string) => {
      if (diagnostic) actions.select({ objectType: type, objectId: id }, 'fault');
    },
    source: (id: string) => {
      if (!diagnostic && valid()) selectMapSource(id);
    },
    demand: (id: string) => {
      if (!diagnostic && valid()) {
        selectedDemand.value = id;
        sideTab.value = '任务输入';
        leftOpen.value = true;
      }
    },
  };
});
watch(diagnosis.focus, async (target) => {
  if (!target) return;
  const context = diagnosis.contextKey.value;
  rightOpen.value = true;
  await nextTick();
  if (
    diagnosisMode.value &&
    context === diagnosis.contextKey.value &&
    target === diagnosis.focus.value
  )
    mapRef.value?.locate();
});
function openDiagnosis() {
  rightOpen.value = true;
  if (!diagnosis.open()) void router.push('/diagnosis');
}
const {
  monitor,
  mode: monitorMode,
  map: monitorMap,
} = useSituationMonitoring(
  () => {
    mapRef.value?.locate();
    if (monitor.selectedDeviceId || monitor.selectedStationId || monitor.selectedLinkId)
      rightOpen.value = true;
  },
  () => hasResourceTarget.value || diagnosis.target.value.present,
);
// 来源标识跟随实际显示的数据；措施预览没有独立快照 ID，明确显示措施与来源方案。
const visibleSource = computed(() => {
  if (diagnosisMode.value) return `诊断 ${diagnosis.display.value?.record.id ?? '结果未提供'}`;
  if (monitorMode.value) return `监控网络 ${monitor.network?.key || '标识未提供'}`;
  if (snapshotMode.value) {
    const run = analysis.selected?.run;
    return afterResult.value
      ? `措施预览 ${analysis.selectedMeasurePreview?.measureId || '标识未提供'} · 来源方案 ${run?.network.id || '未提供'}`
      : `干扰分析 ${run?.analysisId || '未提供'} · 网络 ${run?.network.snapshotId || '标识未提供'}`;
  }
  return `资源${editing.value && editor.draftDirty ? '草稿' : ''} · ${data.value.resourceMeta.revision ?? '版本未提供'}`;
});
const sideTab = ref('资源树');
const taskPanelRef = ref<InstanceType<typeof TaskWorkspacePanel>>();
const roads = ref(true);
const nodes = ref(true);
const links = ref(true);
const topologyOpacity = ref(1);
const candidates = ref(false);
// 新增定位先保护未保存输入和活动操作，不调用保存或离开决策。
const measureNavigation = useInterferenceTargetNavigation({
  blockedReason: () =>
    configuration.visible
      ? '请先完成或关闭设备配置'
      : editor.picking
        ? '请先完成地图取点'
        : gis.dirty || editor.form || editor.importOpen || planning.importRequest
          ? '请先完成或关闭表单、导入及未保存输入'
          : editor.busy || gis.busy || planning.busy || planning.loading || planning.importing
            ? '请先等待当前操作完成'
            : '',
  show: (kind, id) => (kind === 'node' ? focusAnalysisNode(id) : focusAnalysisLink(id)),
  locate: () => mapRef.value?.locate(),
  hidden: () => !links.value || topologyOpacity.value === 0,
});
const deviceCoverage = useDeviceCoverage(
  () => data.value?.situation.deviceCoverage,
  () =>
    diagnosisMode.value
      ? '诊断冻结网络中暂停设备教学覆盖，选择已保留。'
      : monitorMode.value
        ? '监控冻结网络中暂停设备教学覆盖，选择已保留。'
        : snapshotMode.value
          ? '干扰分析网络中暂停设备教学覆盖，选择已保留。'
          : oldResultsHidden.value
            ? '资源已有修改，当前输入暂无匹配的设备覆盖样例；恢复演示基线后可查看。'
            : '',
);
// 区域仍来自原有资源/冻结快照，图层偏好仅控制本页展示。
const mapRegions = computed(() =>
  diagnosisMode.value || monitorMode.value
    ? []
    : snapshotMode.value
      ? (afterResult.value?.regions ?? analysis.selected!.run.network.regions)
      : (data.value?.situation.regions ?? []),
);
const resultLayers = useGisResultLayers(
  () => ({
    mode: diagnosisMode.value
      ? 'diagnosis'
      : monitorMode.value
        ? 'monitoring'
        : snapshotMode.value
          ? 'analysis'
          : 'resource',
    contextId: diagnosisMode.value ? diagnosis.contextKey.value : undefined,
    diagnosisAvailable: !!diagnosis.display.value?.regions.length,
    diagnosisFilteredOut:
      !!diagnosis.display.value?.regions.length && !diagnosis.impact.value.regions.length,
    readable: auth.can('situation.view'),
    paused: oldResultsHidden.value,
    regions: mapRegions.value,
    deviceMode: deviceCoverage.state.mode !== 'network',
    deviceCoverageAvailable: deviceCoverage.overlays.value.length > 0,
    interferenceAvailable: !!analysis.impact?.regions.length,
    interferenceFilteredOut:
      !!analysis.impact?.regions.length && !analysis.filteredImpact?.regions.length,
  }),
  () => auth.generation,
);
// 显式入口只切换显示上下文，不选择另一资源或丢弃编辑表单。
function openDeviceCoverage(id: string) {
  deviceCoverage.open(id);
  gis.mapMode = 'resource';
  resultLayers.enableCoverage();
  sideTab.value = '图层管理';
  leftOpen.value = true;
}
const resourceTree = computed(() =>
  buildGisResourceTree(
    resources.value,
    data.value?.situation.links ?? [],
    query.value,
    filter.value,
    !oldResultsHidden.value,
  ),
);
const stations = computed(() => resourceTree.value.stations);
// 吸附只读取当前草稿和资源筛选，冻结视图不提供可写取点上下文。
const gisPick = useGisPick(() => ({
  mode: diagnosisMode.value || monitorMode.value || snapshotMode.value ? 'snapshot' : gis.mapMode,
  stations: stations.value,
  interferences: interferences.value,
  showStations: nodes.value,
  showInterferences: interferenceVisible.value,
  filterKey: `${filter.value}/${query.value}`,
}));
// 观测只叠加普通浏览；编辑和各类快照继续使用各自资源状态。
const statusSync = useResourceStatusStore();
const statusEnabled = computed(
  () =>
    env.mode === 'mock' &&
    gis.mapMode === 'resource' &&
    !editing.value &&
    !diagnosisMode.value &&
    !monitorMode.value &&
    !snapshotMode.value &&
    auth.can('situation.view'),
);
const statusDisplays = computed(() => (statusEnabled.value ? statusSync.displays : undefined));
const statusObserved = computed(() => statusEnabled.value && statusSync.mode === 'observed');
const statusSource = computed(() =>
  statusEnabled.value
    ? statusObserved.value
      ? (statusSync.source?.label ?? '同步观测')
      : '台账基线'
    : undefined,
);
// 新设备层仅使用普通资源/编辑草稿，绝不与监控或分析冻结网络拼接。
const deviceDisplay = useGisDeviceDisplay(() => ({
  resources: resources.value,
  stationIds: resourceTree.value.stationIds,
  deviceIds: resourceTree.value.deviceIds,
  enabled: !!data.value && gis.mapMode === 'resource' && !monitorMode.value && !snapshotMode.value,
  readable: auth.can('situation.view'),
  generation: auth.generation,
  sourceKey:
    (data.value?.situation.snapshotId ?? '') +
    '/' +
    (data.value?.resourceMeta.revision ?? '') +
    '/' +
    statusEnabled.value +
    '/' +
    statusSync.mode +
    '/' +
    statusSync.exampleId,
  selectedDeviceId: selectedDeviceId.value,
  statusDisplays: statusDisplays.value,
  statusSource: statusSource.value,
  observed: statusObserved.value,
  statusPaused: statusSync.mode === 'observed' && !statusEnabled.value,
}));
// 定位通过原确认后才改变显示；无有效坐标时只打开表单，不移动已有地图选择。
const validation = useGisValidationNavigation({
  taskReason: (issue) => taskPanelRef.value?.validationReason(issue) ?? '任务输入尚未加载',
  focusTask: (issue) => taskPanelRef.value?.focusValidationIssue(issue) ?? Promise.resolve(false),
  showTask: () => {
    sideTab.value = '任务输入';
    leftOpen.value = true;
  },
  showResource: (target) => {
    rightOpen.value = true;
    if (target.kind === 'candidate') {
      gis.mapMode = 'resource';
      selectedCandidateLinkId.value = target.id;
      selectedLinkId.value = '';
      selectedId.value = '';
      selectedDeviceId.value = '';
      selectedInterferenceId.value = '';
      rightTab.value = '对象详情';
      // 字段错误只定位已确认的端点，未应用配置不回退到旧线段。
      const request = editor.issueFocus,
        epoch = directoryEpoch.value;
      void nextTick().then(() => {
        if (target.coordinate && request === editor.issueFocus && epoch === directoryEpoch.value)
          mapRef.value?.locateResource(target.coordinate);
      });
      return;
    }
    if (!target.coordinate) return;
    gis.mapMode = 'resource';
    selectedLinkId.value = '';
    selectedCandidateLinkId.value = '';
    deviceDisplay.close();
    focusError.value = '';
    if (target.kind === 'interference') {
      if (!interferences.value.some((row) => row.id === target.id)) query.value = '';
      interferenceVisible.value = true;
      selectedInterferenceId.value = target.id;
      selectedId.value = '';
      selectedDeviceId.value = '';
      rightTab.value = '干扰分析';
    } else {
      const exists =
        target.kind === 'device'
          ? resources.value.devices.some((row) => row.id === target.id)
          : resources.value.stations.some((row) => row.id === target.id);
      if (exists) revealResource(target.kind, target.id);
      selectedInterferenceId.value = '';
      interferenceOpen.value = false;
      rightTab.value = '对象详情';
      if (target.kind === 'device') {
        selectedDeviceId.value = target.id;
        selectedId.value =
          resources.value.devices.find((row) => row.id === target.id)?.stationId ?? '';
        deviceDisplay.reveal(target.id);
      } else {
        selectedDeviceId.value = '';
        selectedId.value = exists ? target.id : '';
        nodes.value = true;
      }
    }
    const request = editor.issueFocus,
      session = auth.generation,
      revision = data.value.resourceMeta.revision,
      epoch = directoryEpoch.value;
    void nextTick().then(() => {
      if (
        request === editor.issueFocus &&
        session === auth.generation &&
        revision === data.value?.resourceMeta.revision &&
        epoch === directoryEpoch.value &&
        gis.mapMode === 'resource'
      )
        mapRef.value?.locateResource(target.coordinate!);
    });
  },
});
function locateTaskIssue(issue: PlanningIssue) {
  const current = gis.taskIssues.find((row) => row === issue);
  if (current) void validation.locate(current);
}
function openDeviceCluster(ids: string[], version: number) {
  if (!editor.busy && !editor.picking && deviceDisplay.open(ids, version)) rightOpen.value = true;
}
async function pickMapDevice(id: string, version: number, listRevision?: number) {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return;
  if (editor.busy || editor.picking) return;
  const current = deviceDisplay.capture(id, version, listRevision),
    point = current?.();
  if (!point) return;
  if (
    (id !== selectedDeviceId.value || point.stationId !== selectedId.value) &&
    !(await editor.closeForm())
  )
    return;
  // 原确认可能应用草稿或等待较久；提交选择前重新核对当前成员和归属。
  const accepted = current?.();
  if (!accepted || editor.busy || editor.picking) return;
  if (configurationActive) configuration.clearForSession();
  selectedId.value = accepted.stationId;
  selectedDeviceId.value = accepted.id;
  selectedLinkId.value = '';
  selectedCandidateLinkId.value = '';
  selectedInterferenceId.value = '';
  interferenceOpen.value = false;
  rightTab.value = '对象详情';
  rightOpen.value = true;
  focusError.value = '';
  deviceDisplay.close();
}
const pickClusterDevice = computed(() => {
  const version = deviceDisplay.frame.value?.version ?? -1,
    revision = deviceDisplay.clusterRevision.value;
  return (id: string) => pickMapDevice(id, version, revision);
});
watch(
  [selectedId, selectedDeviceId, selectedLinkId, selectedCandidateLinkId, selectedInterferenceId],
  () => deviceDisplay.close(),
);
const selected = computed(() =>
  resources.value.stations.find((station) => station.id === selectedId.value),
);
const selectedResourceFiltered = computed(() => {
  if (diagnosisMode.value || monitorMode.value || snapshotMode.value) return false;
  if (selectedCandidateLink.value)
    return !resourceTree.value.candidateLinkIds.includes(selectedCandidateLinkId.value);
  if (selectedResourceLink.value)
    return !resourceTree.value.linkRows.some((row) => row.link.id === selectedLinkId.value);
  if (selectedDeviceId.value) return !resourceTree.value.deviceIds.includes(selectedDeviceId.value);
  if (selectedInterference.value)
    return !interferences.value.some((row) => row.id === selectedInterferenceId.value);
  return !!selected.value && !stations.value.some((row) => row.id === selectedId.value);
});
type DirectoryKind = 'device' | 'link';
function includesResource(tree: ResourceTreeResult, kind: DirectoryKind | 'station', id: string) {
  return kind === 'device'
    ? tree.deviceIds.includes(id)
    : kind === 'link'
      ? tree.linkRows.some((row) => row.link.id === id)
      : tree.stationIds.includes(id);
}
function revealResource(kind: DirectoryKind | 'station', id: string) {
  // 先单独核对搜索，再核对节点条件；命中设备时不因父节点名称不同而清空搜索。
  const queried = buildGisResourceTree(
    resources.value,
    data.value.situation.links,
    query.value,
    '全部',
    !oldResultsHidden.value,
  );
  if (!includesResource(queried, kind, id)) query.value = '';
  if (!includesResource(resourceTree.value, kind, id)) filter.value = '全部';
}
// 目录可解除资源筛选；链路显示偏好保留，跨身份、版本或模式的旧回调无效。
const directoryEpoch = ref(0);
let directoryRequest = 0;
watch(
  [
    () => gis.mapMode,
    () => auth.generation,
    () => auth.can('situation.view'),
    () => data.value?.situation.snapshotId,
    () => data.value?.resourceMeta.revision,
    () => editor.context,
    () => monitor.network?.key,
    () => analysis.analysisId,
    () => diagnosis.contextKey.value,
  ],
  () => {
    directoryEpoch.value++;
  },
  { flush: 'sync' },
);
onBeforeUnmount(() => {
  directoryEpoch.value++;
});
// 拓扑是本页显示偏好；同一身份临时失权只暂停，换身份或会话才复位。
watch(
  () => JSON.stringify([auth.identity?.id, auth.identity?.sessionId]),
  () => {
    links.value = true;
    topologyOpacity.value = 1;
    candidates.value = false;
    selectedCandidateLinkId.value = '';
  },
  { flush: 'sync' },
);
const drawableTopologyIds = computed(() => {
  const stationIds = new Set(
    mapStations.value
      .filter(
        (row) =>
          Array.isArray(row.coordinate) &&
          row.coordinate.length === 2 &&
          row.coordinate.every(Number.isFinite),
      )
      .map((row) => row.id),
  );
  return new Set(
    mapLinks.value
      .filter((row) => stationIds.has(row.a) && stationIds.has(row.b))
      .map((row) => row.id),
  );
});
const topologyReason = computed(() => {
  if (!auth.can('situation.view') || auth.blocked) return '需要 GIS 态势查看权限';
  if (!data.value) return '资源尚未加载或已清理';
  if (gis.mapMode === 'diagnosis') {
    if (!auth.can('diagnosis.view')) return '需要故障诊断查看权限';
    if (!diagnosis.display.value) return diagnosis.error.value || '诊断完整报告尚未加载';
  } else if (gis.mapMode === 'monitoring') {
    if (!monitor.networkReadable) return '需要网络监控查看权限';
    if (!monitorMode.value || !monitorMap.value) return '暂无可用监控网络';
  } else if (gis.mapMode === 'analysis') {
    if (!analysis.readable) return '需要干扰分析查看权限';
    if (!snapshotMode.value) return '暂无可用分析冻结网络';
  } else if (oldResultsHidden.value) return '资源已修改，旧规划链路已暂停';
  if (!drawableTopologyIds.value.size)
    return gis.mapMode === 'resource' && resourceFiltersActive.value
      ? '当前筛选下没有可绘制规划链路'
      : '当前网络没有可绘制规划链路';
  return '';
});
const topologyAvailable = computed(() => !topologyReason.value);
const topologyVisible = computed(
  () => topologyAvailable.value && links.value && topologyOpacity.value > 0,
);
// 单调代次覆盖措施前后态及权限往返，不能让 A→B→A 恢复旧控件的所有权。
const topologyEpoch = ref(0);
watch(
  [
    directoryEpoch,
    () => auth.identity?.id,
    () => auth.identity?.sessionId,
    () => auth.blocked,
    () => auth.can('planning.view'),
    () => auth.can('diagnosis.view'),
    () => analysis.measureId,
    () => analysis.after,
    () => analysis.effectiveAfter,
    () => topologyAvailable.value,
  ],
  () => {
    topologyEpoch.value++;
  },
  { flush: 'sync' },
);
const topologyActions = computed(() => {
  const epoch = topologyEpoch.value;
  const current = () => epoch === topologyEpoch.value && topologyAvailable.value;
  return {
    visible: (event: Event) => {
      if (current()) links.value = (event.target as HTMLInputElement).checked;
    },
    opacity: (event: Event) => {
      if (!current()) return;
      const raw = (event.target as HTMLInputElement).value;
      if (!raw.trim()) return;
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0 && value <= 1) topologyOpacity.value = value;
    },
  };
});
// 模板临时数组会让地图误判业务数据变化；滑块重渲染时复用同一份输入。
const mapLayerInputs = computed(() => ({
  // 任务预览关闭或进入冻结网络时，不叠加当前草稿约束。
  deployment:
    !diagnosisMode.value &&
    !snapshotMode.value &&
    !monitorMode.value &&
    demandsVisible.value &&
    auth.can('planning.view')
      ? {
          owner: planning.taskId + ':' + auth.generation,
          label: '任务草稿',
          constraints: planning.draft?.deploymentConstraints,
        }
      : null,
  deviceCoverages: deviceCoverage.active.value ? deviceCoverage.overlays.value : [],
  demands:
    diagnosisMode.value || snapshotMode.value || monitorMode.value
      ? []
      : auth.can('planning.view')
        ? (planning.draft?.demands ?? [])
        : [],
  highlightLinks: diagnosisMode.value
    ? diagnosis.impact.value.links.map((row) => row.linkId)
    : monitorMode.value
      ? monitor.selectedLinkId
        ? [monitor.selectedLinkId]
        : []
      : snapshotMode.value
        ? []
        : selectedLinkId.value
          ? resourceLinkHighlightIds.value
          : resourceDeviceLinkIds.value,
  highlightStations: diagnosisMode.value
    ? diagnosis.impact.value.nodes.map((row) => row.nodeId)
    : [],
  diagnosisDevices: diagnosisMode.value ? (diagnosis.display.value?.devices ?? []) : [],
  diagnosisFaults: diagnosisMode.value ? (diagnosis.display.value?.faults ?? []) : [],
  diagnosisRegions: diagnosisMode.value ? diagnosis.impact.value.regions : [],
  candidates:
    diagnosisMode.value || snapshotMode.value || monitorMode.value
      ? []
      : data.value.situation.candidateLinks,
  candidateWorkset:
    gis.mapMode === 'resource' && auth.can('situation.view')
      ? resourceTree.value.candidateLinks
      : [],
}));
// 候选事件绑定当前资源会话；失权、换视图或离页后，旧点击不能关闭新表单。
const candidateActions = computed(() => {
  const epoch = directoryEpoch.value;
  const current = () =>
    epoch === directoryEpoch.value &&
    gis.mapMode === 'resource' &&
    auth.can('situation.view') &&
    !editor.busy &&
    !editor.picking;
  async function selectCandidate(id: string, fromMap = false) {
    const configurationActive = configuration.visible;
    if (configurationActive && !(await prepareConfiguration())) return;
    if (
      !current() ||
      (fromMap && (!candidates.value || !resourceTree.value.candidateLinkIds.includes(id)))
    )
      return;
    const link = resources.value.candidateLinks?.find((row) => row.id === id);
    if (!link) return;
    const identity = JSON.stringify(link),
      request = ++directoryRequest;
    if (!(await editor.closeForm()) || !current() || request !== directoryRequest) return;
    const fresh = resources.value.candidateLinks?.find((row) => row.id === id);
    if (
      !fresh ||
      JSON.stringify(fresh) !== identity ||
      (fromMap && (!candidates.value || !resourceTree.value.candidateLinkIds.includes(id)))
    )
      return;
    if (configurationActive) configuration.clearForSession();
    selectedCandidateLinkId.value = id;
    selectedLinkId.value = '';
    selectedDeviceId.value = '';
    selectedId.value = '';
    selectedInterferenceId.value = '';
    interferenceOpen.value = false;
    rightTab.value = '对象详情';
    rightOpen.value = true;
    focusError.value = '';
    deviceDisplay.close();
    await nextTick();
    if (current() && request === directoryRequest && selectedCandidateLinkId.value === id)
      mapRef.value?.locateCandidate(fresh);
  }
  return {
    select: (id: string) => selectCandidate(id),
    map: (id: string) => selectCandidate(id, true),
    edit: (id: string) => {
      if (current() && editing.value && selectedCandidateLinkId.value === id)
        return configurationAction(
          () => current() && editor.openForm('candidate', id, 'gis', current),
        );
    },
    create: async () => {
      if (current() && editing.value)
        await configurationAction(
          () => current() && editor.newForm('candidate', 'gis', '', current),
        );
    },
    visible: (event: Event) => {
      if (current()) candidates.value = (event.target as HTMLInputElement).checked;
    },
  };
});
function directoryIdentity(kind: DirectoryKind, id: string) {
  if (!auth.can('situation.view') || editor.busy || editor.picking) return;
  if (kind === 'device') {
    const device = resources.value.devices.find((row) => row.id === id);
    if (
      !device ||
      !resources.value.stations.some((row) => row.id === device.stationId) ||
      !resources.value.models.some((row) => row.id === device.modelId)
    )
      return;
    return JSON.stringify([device.id, device.stationId, device.modelId]);
  }
  if (oldResultsHidden.value) return;
  const row = buildGisResourceTree(resources.value, data.value.situation.links).linkRows.find(
    (row) => row.link.id === id && row.available,
  );
  return row ? JSON.stringify(row.link) : undefined;
}
async function selectDirectory(kind: DirectoryKind, id: string, epoch: number) {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return;
  if (epoch !== directoryEpoch.value) return;
  const identity = directoryIdentity(kind, id),
    request = ++directoryRequest;
  if (!identity || !(await editor.closeForm())) return;
  // 确认可能应用草稿；只在原对象身份和归属仍有效时提交新的选择。
  if (
    epoch !== directoryEpoch.value ||
    request !== directoryRequest ||
    identity !== directoryIdentity(kind, id)
  )
    return;
  if (configurationActive) configuration.clearForSession();
  revealResource(kind, id);
  gis.mapMode = 'resource';
  selectedLinkId.value = kind === 'link' ? id : '';
  selectedCandidateLinkId.value = '';
  selectedDeviceId.value = kind === 'device' ? id : '';
  selectedId.value =
    kind === 'device' ? resources.value.devices.find((row) => row.id === id)!.stationId : '';
  selectedInterferenceId.value = '';
  interferenceOpen.value = false;
  if (kind === 'device') deviceDisplay.reveal(id);
  else {
    nodes.value = true;
  }
  rightTab.value = '对象详情';
  rightOpen.value = true;
  focusError.value = '';
  deviceDisplay.close();
  const acceptedEpoch = directoryEpoch.value;
  await nextTick();
  // 同一对象重复点击也定位；等待渲染时切走的上下文不再定位。
  if (
    request === directoryRequest &&
    acceptedEpoch === directoryEpoch.value &&
    gis.mapMode === 'resource' &&
    (kind === 'device' ? selectedDeviceId.value === id : selectedLinkId.value === id)
  )
    mapRef.value?.locate();
}
const directorySelection = computed(() => {
  const epoch = directoryEpoch.value;
  return {
    device: (id: string) => selectDirectory('device', id, epoch),
    link: (id: string) => selectDirectory('link', id, epoch),
  };
});
// 资源树在诊断模式仍可操作，但不能由旧报告的树事件切出新报告。
const resourceSelection = computed(() => {
  const diagnostic = diagnosisMode.value,
    context = diagnosis.contextKey.value;
  const current = () =>
    diagnostic
      ? diagnosisMode.value && context === diagnosis.contextKey.value && auth.can('situation.view')
      : !diagnosisMode.value;
  return {
    station: (id: string) => (current() ? select(id) : Promise.resolve(false)),
    interference: (id: string) => {
      if (current()) return selectInterference(id);
    },
  };
});
async function select(id: string) {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return false;
  const diagnostic = diagnosisMode.value,
    context = diagnosis.contextKey.value,
    session = auth.generation;
  if (diagnostic && !auth.can('situation.view')) return false;
  if (!diagnostic) gis.mapMode = 'resource';
  if (!resources.value.stations.some((row) => row.id === id)) {
    focusError.value = '节点 ID 不存在，无法定位';
    return false;
  }
  if ((diagnostic || id !== selectedId.value) && !(await editor.closeForm())) return false;
  // 诊断切出只有在原确认通过且节点仍存在时提交，不改变其他模式原流程。
  if (
    diagnostic &&
    (!diagnosisMode.value ||
      !auth.can('situation.view') ||
      context !== diagnosis.contextKey.value ||
      session !== auth.generation ||
      !resources.value.stations.some((row) => row.id === id))
  )
    return false;
  if (configurationActive) configuration.clearForSession();
  gis.mapMode = 'resource';
  if (id !== selectedId.value) selectedDeviceId.value = '';
  selectedLinkId.value = '';
  selectedCandidateLinkId.value = '';
  selectedId.value = id;
  selectedInterferenceId.value = '';
  interferenceOpen.value = false;
  rightTab.value = '对象详情';
  rightOpen.value = true;
  focusError.value = '';
  return true;
}
async function selectInterference(id: string) {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return;
  const diagnostic = diagnosisMode.value,
    context = diagnosis.contextKey.value,
    session = auth.generation;
  if (diagnostic && !auth.can('situation.view')) return;
  if (!diagnostic) gis.mapMode = 'resource';
  if (!resources.value.interferences?.some((row) => row.id === id)) {
    focusError.value = '干扰源 ID 不存在，无法定位';
    return;
  }
  if (!(await editor.closeForm())) return;
  if (
    diagnostic &&
    (!diagnosisMode.value ||
      !auth.can('situation.view') ||
      context !== diagnosis.contextKey.value ||
      session !== auth.generation ||
      !resources.value.interferences?.some((row) => row.id === id))
  )
    return;
  if (configurationActive) configuration.clearForSession();
  gis.mapMode = 'resource';
  selectedLinkId.value = '';
  selectedCandidateLinkId.value = '';
  if (!interferences.value.some((row) => row.id === id)) query.value = '';
  selectedId.value = '';
  selectedDeviceId.value = '';
  selectedInterferenceId.value = id;
  interferenceOpen.value = false;
  rightTab.value = '干扰分析';
  rightOpen.value = true;
  focusError.value = '';
}
async function newPoint(kind: 'station' | 'interference') {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return;
  // 新增和资源树选择统一回到可编辑的资源地图。
  const diagnostic = diagnosisMode.value,
    context = diagnosis.contextKey.value,
    session = auth.generation;
  if (diagnostic) {
    if (
      !(await editor.settleForm()) ||
      !diagnosisMode.value ||
      context !== diagnosis.contextKey.value ||
      session !== auth.generation
    )
      return;
  } else gis.mapMode = 'resource';
  if (await editor.newForm(kind, 'gis')) {
    if (configurationActive) configuration.clearForSession();
    if (
      diagnostic &&
      (!diagnosisMode.value ||
        context !== diagnosis.contextKey.value ||
        session !== auth.generation)
    )
      return;
    gis.mapMode = 'resource';
    interferenceOpen.value = false;
  }
}
async function importResources() {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return;
  const diagnostic = diagnosisMode.value,
    context = diagnosis.contextKey.value,
    session = auth.generation;
  if (
    diagnostic &&
    (!(await editor.settleForm()) ||
      !diagnosisMode.value ||
      context !== diagnosis.contextKey.value ||
      session !== auth.generation)
  )
    return;
  await editor.openImport('gis');
  if (configurationActive && editor.importOpen) configuration.clearForSession();
  if (
    diagnostic &&
    editor.importOpen &&
    diagnosisMode.value &&
    context === diagnosis.contextKey.value &&
    session === auth.generation
  )
    gis.mapMode = 'resource';
}
// 撤销新增后清除失效选择，重做仍使用原 ID。
watch(
  resources,
  () => {
    if (selectedCandidateLinkId.value && !selectedCandidateLink.value)
      selectedCandidateLinkId.value = '';
    if (selectedId.value && !resources.value.stations.some((s) => s.id === selectedId.value)) {
      selectedId.value = '';
      selectedDeviceId.value = '';
    }
    if (
      selectedDeviceId.value &&
      !resources.value.devices.some((d) => d.id === selectedDeviceId.value)
    )
      selectedDeviceId.value = '';
    if (selectedInterferenceId.value && !selectedInterference.value) {
      selectedInterferenceId.value = '';
      interferenceOpen.value = false;
    }
  },
  { deep: true },
);
async function selectDevice(id: string) {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return false;
  if (id !== selectedDeviceId.value && !(await editor.closeForm())) return false;
  if (configurationActive) configuration.clearForSession();
  selectedLinkId.value = '';
  selectedCandidateLinkId.value = '';
  gis.mapMode = 'resource';
  selectedDeviceId.value = id;
  return true;
}
function selectableResourceLink(id: string) {
  if (
    monitorMode.value ||
    snapshotMode.value ||
    gis.mapMode !== 'resource' ||
    !auth.can('situation.view') ||
    !topologyVisible.value ||
    oldResultsHidden.value ||
    editor.picking ||
    editor.busy
  )
    return;
  return resourceTree.value.links.find(
    (link) =>
      link.id === id &&
      stations.value.some((row) => row.id === link.a) &&
      stations.value.some((row) => row.id === link.b),
  );
}
async function selectResourceLink(id: string) {
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return;
  const link = selectableResourceLink(id),
    snapshotId = data.value.situation.snapshotId,
    generation = auth.generation,
    epoch = topologyEpoch.value;
  // 无效或已隐藏的地图事件不能关闭表单；等待确认后再次检查上下文。
  if (!link || !(await editor.closeForm())) return;
  if (
    epoch !== topologyEpoch.value ||
    snapshotId !== data.value.situation.snapshotId ||
    generation !== auth.generation ||
    selectableResourceLink(id) !== link
  )
    return;
  if (configurationActive) configuration.clearForSession();
  selectedLinkId.value = id;
  selectedId.value = '';
  selectedDeviceId.value = '';
  selectedInterferenceId.value = '';
  selectedCandidateLinkId.value = '';
  interferenceOpen.value = false;
  rightTab.value = '对象详情';
  rightOpen.value = true;
  focusError.value = '';
}
watch(
  [() => data.value?.situation.snapshotId, selectedResourceLink],
  ([snapshot, link], [previous]) => {
    if (snapshot !== previous || !link) selectedLinkId.value = '';
  },
);
watch(
  () => gis.mapMode,
  (mode) => {
    if (mode === 'resource' && selectedResourceLink.value) rightTab.value = '对象详情';
  },
  // 先恢复原资源详情，避免异步回调覆盖随后显式选择的干扰分析面板。
  { flush: 'sync' },
);
// 台账定位只认稳定 ID 及归属关系，不以相似名称匹配。
watch(
  () => [
    route.query.stationId,
    route.query.deviceId,
    route.query.interferenceId,
    route.query.diagnosisId,
  ],
  async ([stationId, deviceId, interferenceId]) => {
    // 即使诊断参数无效也不同时执行普通资源定位。
    if (diagnosis.target.value.present) return;
    const generation = auth.generation,
      sourceKey = data.value.situation.snapshotId + '/' + data.value.resourceMeta.revision;
    if (interferenceId !== undefined) {
      if (typeof interferenceId !== 'string' || stationId !== undefined || deviceId !== undefined) {
        focusError.value = '地图定位参数无效';
        return;
      }
      await selectInterference(interferenceId);
      return;
    }
    if (stationId === undefined && deviceId === undefined) return;
    if (
      typeof stationId !== 'string' ||
      (deviceId !== undefined && typeof deviceId !== 'string') ||
      !resources.value.stations.some((row) => row.id === stationId) ||
      (deviceId !== undefined &&
        !resources.value.devices.some((row) => row.id === deviceId && row.stationId === stationId))
    ) {
      focusError.value = '地图定位失败：节点或设备 ID 缺失、无效，或设备不属于该节点';
      return;
    }
    if (await select(stationId)) {
      if (typeof deviceId === 'string' && !(await selectDevice(deviceId))) return;
      // 完成原定位校验及未保存确认后，才解除会隐藏目标的筛选。
      revealResource(
        typeof deviceId === 'string' ? 'device' : 'station',
        typeof deviceId === 'string' ? deviceId : stationId,
      );
      if (
        typeof deviceId === 'string' &&
        generation === auth.generation &&
        sourceKey === data.value.situation.snapshotId + '/' + data.value.resourceMeta.revision &&
        resources.value.devices.some((row) => row.id === deviceId && row.stationId === stationId)
      )
        deviceDisplay.reveal(deviceId);
      // 初次挂载或定位当前节点也触发地图已有的定位监听。
      selectedId.value = '';
      await nextTick();
      selectedId.value = stationId;
    }
  },
  { immediate: true },
);
</script>
<style scoped>
.topology-notice {
  position: absolute;
  z-index: 3;
  top: 12px;
  left: 14px;
  max-width: 85%;
  padding: 8px;
  background: #13263eeb;
  color: #c4d8ed;
  font-size: 11px;
  pointer-events: none;
}
.topology-settings input[type='range'] {
  min-width: 0;
  flex: 1;
}
.analysis-width {
  flex-basis: 340px !important;
}
.snapshot-label {
  position: absolute;
  z-index: 3;
  bottom: 60px;
  left: 14px;
  max-width: 85%;
  padding: 8px;
  background: #13263eeb;
  color: #c4d8ed;
  font-size: 11px;
  pointer-events: none;
}

.task-mode {
  width: 390px !important;
  flex-basis: 390px !important;
}
.task-scroll {
  overflow: auto;
  min-height: 0;
  flex: 1;
}
.maintenance-toolbar {
  padding: 0 2px 10px;
  flex-wrap: wrap;
}
.maintenance-toolbar .muted {
  font-size: 11px;
}
.edit-notice {
  padding: 8px 12px;
  margin-bottom: 8px;
  background: #152b42;
  color: #b4d5ed;
  font-size: 12px;
  line-height: 1.7;
}
.edit-notice.error {
  background: #392333;
  color: #ffb4b4;
}
.edit-notice .text-link {
  margin-left: 12px;
}
.situation-page {
  height: 100%;
  min-height: 610px;
  display: flex;
  flex-direction: column;
  padding: 0 16px 15px;
}
.situation-toolbar {
  height: 62px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  padding: 0 2px;
}
.situation-toolbar h2 {
  font-size: 15px;
}
.divider {
  height: 16px;
  width: 1px;
  background: var(--line);
  margin: 0 5px;
}
.situation-toolbar .muted {
  font-size: 12px;
}
.situation-main {
  display: flex;
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.situation-left {
  flex: 0 0 265px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.situation-left .tabs {
  gap: 25px;
}
.situation-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
/* 保留展开监控的同时提高地图下限；小高度窗口由外层滚动承接。 */
.monitor-active .map-frame {
  min-height: 280px;
}
/* 画布跟随态势页分配的高度，避免内部固定下限裁切图例和比例尺。 */
.map-frame > :deep(.map-wrap) {
  min-height: 0;
}
.situation-center {
  min-height: 0;
}
.map-frame {
  flex: 1;
  position: relative;
  min-height: 340px;
}
.panel-toggle {
  position: absolute;
  left: 17px;
  top: 61px;
  display: flex;
  gap: 8px;
}
.narrow-only {
  display: none;
}
.situation-right {
  flex: 0 0 290px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.detail-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.detail-footer {
  padding: 13px;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #6c85a1;
}
.layer-settings {
  padding: 18px;
  /* 多设备控制留在资源面板内滚动，不挤占地图或遮住后续选项。 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.layer-settings p {
  font-size: 11px;
  margin-bottom: 22px;
  line-height: 1.7;
}
.layer-settings label {
  flex-direction: row;
  align-items: center;
  margin-bottom: 20px;
}
.layer-settings input[type='checkbox'] {
  accent-color: #45a7f8;
}
.layer-settings input[type='range'] {
  width: 100%;
  padding: 0;
  accent-color: #45a7f8;
}
@media (max-width: 1450px) {
  .situation-left {
    flex-basis: 230px;
  }
  .situation-right {
    flex-basis: 265px;
  }
}
/* 详情打开时临时让出左栏位置；宽度恢复后仍保留原资源面板状态。 */
@media (max-width: 1280px) {
  .details-open .situation-left {
    display: none !important;
  }
  .panel-toggle .narrow-only {
    display: inline-flex;
  }
}
</style>
