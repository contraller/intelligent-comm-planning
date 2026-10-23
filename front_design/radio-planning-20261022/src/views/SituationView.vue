<template>
  <div
    v-if="data || workspace.ready.value || frozenView"
    class="situation-page"
    :class="{
      'is-editing': resourceEditable || (fault.active.value && fault.canEdit.value),
      'is-picking': editor.picking || (fault.active.value && fault.drawing.value),
    }"
  >
    <div class="situation-toolbar">
      <!-- 模式条使用文字和颜色共同提示当前可编辑范围。 -->
      <div class="toolbar">
        <button v-if="httpMode && auth.can('planning.view')" class="btn small" :disabled="editor.busy || fault.active.value" @click="toggleFrozenPlans">
          {{ frozenView ? '返回当前资源' : '查看已保存方案' }}
        </button>
        <!-- 页面标题与导航同名，沿用业务页面共享的标题样式。 -->
        <h1>GIS 态势</h1>
        <span class="divider" /><span class="muted">太行山地区域通信保障</span
        ><span
          class="chip blue"
          aria-label="当前视图数据来源"
          >{{ visibleSource }}</span
        >
      </div>
      <div class="toolbar">
        <button
          class="btn small"
          :disabled="
            !workspace.read.readable || workspace.read.refreshing || editor.busy || editing
          "
          @click="workspace.refresh()"
          >{{ workspace.read.refreshing ? '正在刷新' : '刷新资源' }}</button
        >
        <span
          class="mode-indicator"
          role="status"
          ><i
            :class="
              editor.picking || (fault.active.value && fault.drawing.value)
                ? 'pi pi-map-marker'
                : resourceEditable || (fault.active.value && fault.canEdit.value)
                  ? 'pi pi-pencil'
                  : 'pi pi-lock'
            "
          />{{ modeLabel
          }}<span v-if="fault.active.value ? scene.dirty : (editing && gis.dirty) || editor.dirty">
            · 未保存</span
          ></span
        >
        <button
          v-if="!frozenView && !editing && !diagnosisMode && !taskViewing && !fault.active.value"
          class="btn small"
          :disabled="!workspaceEditable || !editor.canEdit || editor.busy"
          @click="configurationAction(() => gis.begin())"
        >
          <i class="pi pi-pencil" />编辑资源
        </button>
        <template v-else-if="resourceEditable">
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
            <i class="pi pi-save" />{{ gis.busy ? '保存中…' : '保存资源' }}
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
    <GisFrozenPlanPanel v-if="frozenView" ref="frozenPanel" :services="frozenServices" :operations="frozenOperationServices"
      :initial-tab="frozenInitialTab" :current-resource-revision="workspace.read.workspace?.revision" :session-generation="auth.generation"
      @open-plan="openAnalysisResult" @open-job="openAnalysisJob" />
    <template v-if="!frozenView">
    <div class="maintenance-toolbar toolbar">
      <!-- 资源恢复属于低频维护操作，沿用壳层权限与确认流程。 -->
      <details
        v-if="resourceReset && auth.can('resources.reset')"
        class="resource-more"
      >
        <summary class="btn small">更多操作</summary>
        <div class="resource-more-panel">
          <button
            class="btn"
            :disabled="resourceReset.disabled.value"
            @click="resourceReset.run()"
            >恢复初始资源</button
          >
        </div>
      </details>
      <button
        v-if="fault.active.value"
        class="btn small"
        @click="returnToResources()"
        >返回资源浏览</button
      >
      <button
        v-if="auth.can('diagnosis.scenario') && !fault.active.value"
        class="btn small"
        :disabled="editor.picking || editor.busy"
        @click="beginFaultEditing"
        >故障标绘</button
      >
      <template v-if="fault.active.value">
        <button
          class="btn small"
          :disabled="!fault.canEdit.value || !scene.undoStack.length"
          @click="scene.undo"
          >撤销标绘</button
        >
        <button
          class="btn small"
          :disabled="!fault.canEdit.value || !scene.redoStack.length"
          @click="scene.redo"
          >重做标绘</button
        >
        <button
          class="btn primary small"
          :disabled="!fault.canEdit.value || fault.busy.value"
          @click="fault.save"
          >{{ fault.busy.value ? '保存中…' : '保存场景' }}</button
        >
        <button
          class="btn small"
          :disabled="!fault.ready.value || fault.busy.value"
          @click="fault.saveAndReturn"
          >去诊断</button
        >
      </template>
      <template v-if="resourceEditable"
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
        v-if="resourceEditable"
        class="btn small"
        :disabled="!editor.canEdit || editor.busy || editor.picking"
        :onClick="candidateActions.create"
        >新建候选链路</button
      >
      <button
        v-if="!fault.active.value"
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
        fault.active.value
          ? '选择网络与场景 → 点选故障对象 → 配置并应用 → 保存场景 → 去诊断'
          : taskViewing
            ? '当前任务只读；在网络规划中编辑与保存'
            : diagnosisMode
              ? '诊断快照只读；点击左侧“资源树”继续原草稿操作'
              : monitorMode
                ? '监控网络只读；设备、链路与频谱态势在底部查看'
                : snapshotMode
                  ? '干扰分析结果只读；分析输入与历史结果分别保留来源'
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
      v-if="!fault.active.value && resourceSaveFeedback"
      class="edit-notice save-feedback"
      :class="gis.saveState"
      :role="
        gis.saveState === 'validation-failed' || gis.saveState === 'failed' ? 'alert' : 'status'
      "
      >{{ resourceSaveFeedback }}</div
    >
    <div
      v-if="!fault.active.value && editor.message && !resourceSaveFeedback"
      class="edit-notice"
      role="status"
      >{{ editor.message }}</div
    >
    <div
      v-if="resourceFiltersActive && !fault.active.value"
      class="edit-notice"
      role="status"
    >
      <template v-if="!diagnosisMode && !monitorMode && !snapshotMode && !taskViewing"
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
    <!-- 状态同步留在资源管理，GIS 使用台账／草稿与独立监控来源。 -->
    <ResourceReadStatus />
    <p
      v-if="gis.sceneError"
      class="notice"
      role="alert"
      >{{ gis.sceneError }}
      <button
        class="text-link"
        :disabled="gis.sceneLoading"
        @click="gis.loadScene"
        >重试展示资料</button
      ></p
    >
    <p
      v-if="editor.error && !editing"
      class="notice"
      role="alert"
      >{{ editor.error }}</p
    >
    <div
      v-if="deviceDisplay.hiddenSelection.value"
      class="edit-notice"
      role="status"
      >当前选中设备未在地图显示，详情和编辑内容已保留；可在图层管理调整设备显示条件。</div
    >
    <div
      v-if="
        data &&
        oldResultsHidden &&
        !snapshotMode &&
        !monitorMode &&
        !diagnosisMode &&
        !taskViewing &&
        !fault.active.value
      "
      class="edit-notice"
    >
      资源已有修改，旧结果与当前资源不一致，相关图层已隐藏。<RouterLink
        v-if="auth.can('planning.view')"
        class="text-link"
        to="/planning?history=references"
        >查看历史方案快照</RouterLink
      >
    </div>
    <div
      class="situation-main"
      :class="{ 'details-open': rightOpen }"
    >
      <!-- 恢复把手归属工作区两侧，不占地图工具区；沿用原窄屏互切和草稿保护。 -->
      <button
        v-if="!leftOpen || rightOpen"
        class="panel-restore resource-restore btn small"
        :class="{ 'narrow-only': leftOpen }"
        :aria-label="fault.active.value ? '展开场景面板' : '展开资源面板'"
        aria-controls="gis-resource-panel"
        :aria-expanded="false"
        :title="fault.active.value ? '展开场景面板' : '展开资源面板'"
        @click="showResourcePanel"
        ><i
          class="pi pi-angle-double-right"
          aria-hidden="true"
        /><span>{{ fault.active.value ? '场景' : '资源' }}</span></button
      >
      <button
        v-if="!rightOpen"
        class="panel-restore detail-restore btn small"
        aria-label="展开详情面板"
        aria-controls="gis-detail-panel"
        :aria-expanded="false"
        title="展开详情面板"
        @click="rightOpen = true"
        ><i
          class="pi pi-angle-double-left"
          aria-hidden="true"
        /><span>详情</span></button
      >
      <!-- 左栏按当前工作内容组织，任务只读查看与资源维护分开。 -->
      <aside
        v-show="leftOpen"
        id="gis-resource-panel"
        class="situation-left panel"
      >
        <div class="panel-head">
          <h3
            ><i class="pi pi-sitemap" />{{
              fault.active.value ? '网络与故障场景' : '资源与任务'
            }}</h3
          >
          <button
            class="icon-btn"
            aria-label="收起资源面板"
            @click="leftOpen = false"
          >
            <i class="pi pi-angle-double-left" />
          </button>
        </div>
        <section
          v-if="fault.active.value"
          class="fault-controls"
        >
          <p class="muted">1 选择网络与场景　2 地图点选对象　3 配置、保存后去诊断</p>
          <label
            >绑定网络<select
              :value="scene.draft?.planId ?? ''"
              :disabled="!fault.canEdit.value || fault.busy.value"
              @change="fault.switchPlan(($event.target as HTMLSelectElement).value)"
            >
              <option
                value=""
                disabled
                >请选择已确认网络</option
              >
              <option
                v-if="scene.draft && !scene.sources.plans.some((p) => p.id === scene.draft!.planId)"
                :value="scene.draft.planId"
                >历史网络 · {{ scene.draft.planId }}</option
              >
              <option
                v-for="network in scene.sources.plans"
                :key="network.id"
                :value="network.id"
                >{{ network.name }} · {{ network.id }}</option
              >
            </select></label
          >
          <button
            class="btn small"
            :disabled="
              !scene.sources.plans.length || fault.busy.value || !auth.can('diagnosis.scenario')
            "
            @click="fault.newScenario()"
            >新建故障场景</button
          >
          <button
            class="btn small"
            :disabled="!fault.canEdit.value || fault.busy.value"
            @click="fault.openEditor"
            >配置场景参数</button
          >
          <label
            >已保存场景版本<select
              :value="scene.versionId ?? ''"
              :disabled="fault.busy.value"
              @change="selectFaultVersion(($event.target as HTMLSelectElement).value)"
            >
              <option value="">当前场景草稿</option>
              <optgroup
                v-for="item in fault.scenes.value"
                :key="item.id"
                :label="item.versions.at(-1)?.name ?? item.id"
              >
                <option
                  v-for="version in item.versions"
                  :key="version.id"
                  :value="version.id"
                  >{{ version.name }} · V{{ version.version }}</option
                >
              </optgroup>
            </select></label
          >
          <p
            v-if="!scene.sources.plans.length"
            class="notice"
            >暂无可用的已确认网络，请先在网络规划保存并确认方案。</p
          >
          <RouterLink
            v-if="!scene.sources.plans.length && auth.can('planning.view')"
            class="text-link"
            to="/planning"
            >前往网络规划</RouterLink
          >
          <p v-if="fault.draft.value"
            ><strong>{{ fault.draft.value.name || '未命名场景' }}</strong
            ><br />{{ scene.versionId || '尚未保存版本' }} ·
            {{ scene.dirty ? '未保存' : '已保存' }}</p
          >
          <p
            v-if="fault.network.value"
            class="muted"
            >本次标绘仅使用绑定网络的节点、设备与链路。</p
          >
        </section>
        <div
          v-else
          class="tabs"
        >
          <button
            v-for="tab in auth.can('planning.view')
              ? ['资源树', '任务查看', '图层管理']
              : ['资源树', '图层管理']"
            :key="tab"
            :class="{ active: sideTab === tab }"
            @click="chooseSideTab(tab)"
          >
            {{ tab }}
          </button>
        </div>
        <GisResourceTree
          v-if="!fault.active.value && sideTab === '资源树'"
          :key="diagnosisMode ? diagnosis.contextKey.value : 'resource-tree'"
          v-model:query="query"
          v-model:filter="filter"
          :tree="resourceTree"
          :ready="editing || !!workspace.directory.value"
          :resources="resources"
          :selected-id="selectedId"
          :selected-device-id="selectedDeviceId"
          :selected-link-id="selectedLinkId"
          :selected-interference-id="selectedInterferenceId"
          :selected-candidate-link-id="selectedCandidateLinkId"
          :candidate-disabled="gis.mapMode !== 'resource'"
          :total-links="gis.scene && gis.scene.network.state !== 'ready' ? null : data?.situation.links.length ?? null"
          :total-nodes="editing ? resources.stations.length : workspace.counts.value.nodes"
          :total-devices="editing ? resources.devices.length : workspace.counts.value.devices"
          v-model:browse="workspace.browse.value"
          v-model:category="workspace.category.value"
          v-model:classification="workspace.classification.value"
          :cluster-id="workspace.cluster.value?.id"
          :counts="workspace.counts.value"
          :disabled="!auth.can('situation.view') || editor.busy || editor.picking"
          @select-station="
            !editing ? selectReadObject('node', $event) : resourceSelection.station($event)
          "
          @select-device="directorySelection.device($event)"
          @select-link="directorySelection.link"
          @select-interference="
            !editing
              ? selectReadObject('interference', $event)
              : resourceSelection.interference($event)
          "
          :onSelectCandidateLink="candidateActions.select"
          :analysis-available="canInterferenceRead"
          @analyze="configurationAction(openInterferenceAnalysis)"
        />
        <GisTaskPanel
          v-if="!fault.active.value && sideTab === '任务查看' && auth.can('planning.view')"
          :controller="task"
          :stations="taskStations"
          :selected-demand-id="selectedDemand"
          @locate-node="locateTaskNode"
          @locate-demand="locateTaskDemand"
          @edit-task="editSelectedTask"
        />
        <div
          v-if="!fault.active.value && sideTab === '图层管理'"
          class="layer-settings"
        >
          <p class="muted layer-tip">图层设置仅影响地图显示。</p>

          <label v-if="auth.can('planning.view')"
            ><input
              v-model="demandsVisible"
              type="checkbox"
            />任务通联与部署约束</label
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
            <p
              v-if="topologyReason"
              class="muted"
              role="status"
              >{{ topologyReason }}</p
            >
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
            />候选链路</label
          >
          <GisDeviceLayerPanel
            :settings="deviceDisplay.settings.value"
            :state="deviceDisplay.state.value"
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
          <details
            class="coverage-settings"
            :open="deviceCoverage.state.mode !== 'network'"
            @toggle="($event.target as HTMLDetailsElement).open && loadCoverage()"
          >
            <summary>设备覆盖设置</summary>
            <p
              v-if="coverageError"
              role="alert"
              >{{ coverageError
              }}<button
                class="text-link"
                @click="loadCoverage"
                >重试读取覆盖资料</button
              ></p
            >
            <DeviceCoveragePanel
              :samples="deviceCoverage.samples.value"
              :mode="deviceCoverage.state.mode"
              :display="deviceCoverage.state.display"
              :representation="deviceCoverage.state.representation"
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
              @mode="setCoverageMode"
              @display="deviceCoverage.state.display = $event"
              @representation="deviceCoverage.state.representation = $event"
              @single="selectCoverageDevice"
              @toggle="deviceCoverage.toggle"
              @configure="deviceCoverage.configure"
              @clear="deviceCoverage.state.selectedIds = []"
              @locate="mapRef?.fitDeviceCoverage($event)"
              @retry="mapRef?.retryDeviceCoverage($event)"
              @resume="gis.mapMode = 'resource'"
            />
          </details>
        </div>
      </aside>
      <div
        class="situation-center"
        :class="{ 'monitor-active': monitorMode && !fault.active.value }"
      >
        <div class="map-frame panel">
          <div
            v-if="!fault.active.value && (!links || topologyOpacity === 0)"
            class="topology-notice"
            >{{
              !links ? '拓扑已关闭' : '拓扑透明度为 0'
            }}，详情与定位仍可用；可在图层管理恢复。</div
          >
          <div
            v-if="diagnosisMode && !fault.active.value"
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
            v-if="monitorMode && !fault.active.value"
            class="snapshot-label"
            >监控冻结网络 · {{ monitor.network?.version }} ·
            {{
              monitor.network?.kind === 'DEMO'
                ? '参考网络'
                : monitor.context?.source.state === 'CURRENT'
                  ? '当前确认方案'
                  : '历史 / 待核实'
            }}
            · {{ monitor.networkResult?.frame.observedAt ?? '暂无观测' }}</div
          >
          <MapCanvas
            v-if="fault.active.value && fault.network.value"
            :key="fault.contextKey.value"
            ref="mapRef"
            gis-surface
            collapsible-legend
            :stations="faultStations"
            :terrain-basemap="terrainBasemap"
            :map-caption="terrainBasemap ? 'DEM 地形' : terrainMessage || '地形加载中'"
            :links="fault.network.value.links"
            :diagnosis-devices="fault.network.value.inputSnapshot.devices"
            :diagnosis-faults="fault.draft.value?.faults ?? []"
            :diagnosis-regions="[]"
            :selected-id="faultSelectedNode"
            :selected-link-id="fault.focus.value?.type === 'LINK' ? fault.focus.value.id : ''"
            :highlight-station-ids="faultHighlights.nodes"
            :highlight-link-ids="faultHighlights.links"
            :show-roads="roads"
            :show-links="true"
            :show-coverage="false"
            :select-links="true"
            @select="fault.actions.value.node"
            @select-link="fault.actions.value.link"
            @select-fault="fault.actions.value.pick"
          />
          <div
            v-else-if="fault.active.value"
            class="empty-panel fault-empty"
            role="status"
            >{{ fault.error.value || '正在准备故障场景，请选择可用网络。' }}</div
          >
          <MapCanvas
            v-else
            ref="mapRef"
            gis-surface
            :hover-preview="resourceHoverContext"
            :terrain-basemap="terrainBasemap"
            :map-caption="terrainBasemap ? 'DEM 地形' : terrainMessage || '地形加载中'"
            :resource-read="
              taskViewing || (!editing && !diagnosisMode && !monitorMode && !snapshotMode)
            "
            :rich-scene="
              !taskViewing && (!!data || editing || diagnosisMode || monitorMode || snapshotMode)
            "
            :resource-frame="taskViewing ? null : workspace.read.frame"
            :resource-bounds="workspace.read.workspace?.bounds"
            :resource-selected-kind="
              workspace.read.detail?.object.kind === 'device'
                ? 'node'
                : workspace.read.detail?.object.kind
            "
            :planning-overlay="taskOverlay"
            planning-context="gis"
            @viewport="workspace.viewport"
            @select-resource="selectReadObject($event.kind, $event.id, false)"
            @select-cluster="selectReadCluster"
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
            :gis-device-frame="taskViewing ? undefined : deviceDisplay.frame.value"
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
            :resource-markers="!diagnosisMode && !snapshotMode && !monitorMode && !taskViewing"
            :picking="
              !diagnosisMode && !snapshotMode && !monitorMode && !taskViewing && editor.picking
            "
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
              networkFocusActive
                ? (networkFocus?.linkIds[0] ?? '')
                : diagnosisMode
                  ? diagnosisLink
                  : monitorMode
                    ? monitor.selectedLinkId
                    : snapshotMode
                      ? analysisLink
                      : resourceLinkHighlightIds[0]
            "
            :onSelectLink="mapSelection.link"
            :highlight-link-ids="
              networkFocusActive ? networkFocus!.linkIds : mapLayerInputs.highlightLinks
            "
            :highlight-station-ids="
              networkFocusActive ? networkFocus!.stationIds : mapLayerInputs.highlightStations
            "
            :diagnosis-devices="mapLayerInputs.diagnosisDevices"
            :diagnosis-faults="mapLayerInputs.diagnosisFaults"
            :diagnosis-regions="mapLayerInputs.diagnosisRegions"
            :diagnosis-paths="diagnosisMode ? (diagnosis.impact.value.paths ?? []) : []"
            @select-fault="mapSelection.fault"
            :interference-impact="null"
            :candidate-workset="mapLayerInputs.candidateWorkset"
            :candidate-stations="
              editing ? editor.resources.stations : (gis.scene?.map.stations ?? [])
            "
            :selected-candidate-link-id="gis.mapMode === 'resource' ? candidateMapSelection : ''"
            :onSelectCandidateLink="candidateActions.map"
            :regions="mapRegions"
            :selected-id="
              taskViewing
                ? selectedTaskNode
                : diagnosisMode
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
        </div>
        <!-- 监控抽屉独立维护图表与播放，页面只传递地图上下文。 -->
        <SituationMonitoringDrawer v-if="!httpMode && !fault.active.value" />
      </div>
      <aside
        v-if="rightOpen"
        id="gis-detail-panel"
        class="situation-right panel"
      >
        <div class="panel-head">
          <h3
            ><i class="pi pi-info-circle" />{{
              fault.active.value
                ? '故障对象与参数'
                : taskViewing
                  ? '任务详情'
                  : diagnosisMode
                    ? '诊断快照'
                    : monitorMode
                      ? '监控详情'
                      : rightTab
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
          v-if="!fault.active.value && !taskViewing && !monitorMode && !diagnosisMode"
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
        <section
          v-if="fault.active.value"
          class="detail-scroll fault-controls"
        >
          <p
            v-if="fault.error.value || scene.error"
            class="notice error"
            role="alert"
            >{{ fault.error.value || scene.error }}</p
          >
          <p
            v-if="fault.sourceNotice.value"
            class="notice"
            role="status"
            >{{ fault.sourceNotice.value }}</p
          >
          <p
            v-if="fault.notice.value || scene.notice"
            class="notice"
            role="status"
            >{{ fault.notice.value || scene.notice }}</p
          >
          <p>在地图连续点选节点或链路；选中节点后可选择所属设备，再配置故障。</p>
          <button
            class="btn primary small"
            :disabled="!fault.canEdit.value || fault.busy.value"
            @click="fault.openEditor"
            >配置场景与故障参数</button
          >
          <h4>已选对象（{{ fault.selected.value.length }}）</h4>
          <button
            v-for="target in fault.selected.value"
            :key="target.objectType + target.objectId"
            class="btn small fault-object"
            @click="fault.pick(target.objectType, target.objectId)"
            >{{ diagnosisLabel(target.objectType) }} · {{ target.objectId }} ×</button
          >
          <template v-if="faultDeviceChoices.length">
            <h4>所选节点的设备</h4>
            <button
              v-for="device in faultDeviceChoices"
              :key="device.id"
              class="btn small fault-object"
              :class="{
                primary: fault.selected.value.some(
                  (t) => t.objectType === 'DEVICE' && t.objectId === device.id,
                ),
              }"
              :disabled="!fault.canEdit.value"
              @click="fault.pick('DEVICE', device.id)"
              >{{ device.id }}</button
            >
          </template>
          <h4>场景故障（{{ fault.draft.value?.faults.length ?? 0 }}）</h4>
          <button
            v-for="item in fault.draft.value?.faults ?? []"
            :key="item.objectType + item.objectId"
            class="btn small fault-object"
            @click="fault.locate(item.objectType, item.objectId)"
            >{{ diagnosisLabel(item.objectType) }} · {{ item.objectId }}</button
          >
          <p
            v-if="scene.formDirty"
            class="notice"
            >参数尚未应用，请在配置抽屉中应用后再保存场景。</p
          >
        </section>
        <section
          v-else-if="taskViewing"
          class="detail-scroll fault-controls"
        >
          <h4>{{ task.selected?.name ?? '请选择已保存任务' }}</h4>
          <p v-if="task.selected">{{ task.selected.version }} · {{ task.selected.updatedAt }}</p>
          <p>地图展示任务参与节点和通联关系，节点位置取已保存资源。</p>
          <p v-if="selectedTaskNode">当前节点：{{ selectedTaskNode }}</p>
          <template v-if="selectedTaskDemand">
            <h4>通联 {{ selectedTaskDemand.id }}</h4>
            <p>{{ selectedTaskDemand.sourceId }} → {{ selectedTaskDemand.targetId }}</p>
            <p
              >{{ selectedTaskDemand.service }} ·
              {{ selectedTaskDemand.requiredRateKbps ?? '未提供' }} kbps ·
              {{ selectedTaskDemand.maxDelayMs ?? '未提供' }} ms</p
            >
          </template>
          <p
            v-if="editor.draftDirty"
            class="notice"
            >资源草稿尚未保存，任务地图使用已保存坐标。</p
          >
          <p
            v-if="task.referenceNotice"
            role="status"
            >{{ task.referenceNotice }}</p
          >
          <button
            v-if="task.taskId"
            class="btn small"
            @click="editSelectedTask(task.taskId)"
            >编辑任务</button
          >
        </section>
        <div
          v-else
          class="detail-scroll"
        >
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
          <template v-else-if="rightTab === '干扰分析'">
            <button
              v-if="analysisReturn"
              class="btn small"
              :onClick="analysisReturn.open"
              >返回规划方案</button
            >
            <button class="btn" :disabled="!canInterferenceRead" @click="openInterferenceAnalysis">打开方案干扰工作区</button>
          </template>
          <LinkDetailPanel
            v-else-if="!snapshotMode && selectedResourceLink && linkDetails"
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
          <GisObjectInfoPanel
            v-else
            coverage-enabled
            @view-coverage="openDeviceCoverage"
            :station="
              editing ? editor.resources.stations.find((row) => row.id === selectedId) : undefined
            "
            :paged="!editing"
            :detail="workspace.read.detail"
            :resources="editing ? editor.resources : undefined"
            :references="resources"
            :device-catalog="editing ? data?.deviceDetails : undefined"
            :device-network="deviceNetwork"
            :selected-device-id="selectedDeviceId"
            :editable="editing && !editor.busy"
            :draft="editing && editor.draftDirty"
            :configuration="configurationEntry"
            :maintenance-binding="
              workspace.read.workspace && !workspace.read.frozen && gis.mapMode === 'resource'
                ? {
                    context: 'gis',
                    revision: workspace.read.workspace.revision,
                    editable: editing && editor.canEdit && !editor.busy,
                  }
                : undefined
            "
            @ports="(id) => configurationAction(() => editor.openPorts(id))"
            @restore="(id, value) => configurationAction(() => editor.applyRestore(id, value))"
            @locate-network="locateDeviceNetwork"
            @configure="openConfiguration"
            @select-device="!editing ? selectReadObject('device', $event) : selectDevice($event)"
            @edit-station="
              (id: string) => configurationAction(() => editor.openForm('station', id))
            "
            @edit-device="(id: string) => configurationAction(() => editor.openForm('device', id))"
            @new-device="(id: string) => configurationAction(() => editor.newForm('device', id))"
          />
        </div>
        <div
          v-if="
            !fault.active.value &&
            !taskViewing &&
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
    <DevicePortsEditDrawer
      v-if="editor.portsEditing && !!editor.form"
      :visible="editor.portsEditing && !!editor.form"
      :form="editor.form"
      context="gis"
      :editable="editor.canEdit && editing"
      :busy="editor.busy"
      :error="editor.error"
      :message="editor.message"
      :issues="editor.issues"
      @ports="editor.form && (editor.form.fields.ports = JSON.stringify($event))"
      @close="editor.closeForm"
      @submit="applyPorts"
    />
    <DiagnosisScenarioDrawer
      v-if="fault.active.value && fault.drawerOpen.value && scene.draft && faultFormNetwork"
      :key="'fault-form:' + (scene.scenarioId ?? 'new') + ':' + faultFormNetwork.snapshotId"
      :visible="fault.drawerOpen.value"
      :draft="scene.draft"
      :network="faultFormNetwork"
      :symptoms="scene.symptoms"
      :interference-ids="scene.interferenceIds"
      :selected="fault.selected.value"
      @close="fault.closeEditor"
      @apply="fault.actions.value.apply"
      @dirty="fault.actions.value.dirty"
    />
    <InterferenceSourceDrawer
      v-model:visible="interferenceOpen"
      :source="selectedInterference"
    />
    <ResourceExportDrawer
      v-if="auth.can('resources.view')"
      v-model:visible="exportOpen"
      context="gis"
      :gis-query="
        workspace.read.workspace
          ? {
              revision: workspace.read.workspace.revision,
              filter: { ...workspace.read.mapFilter, search: query || undefined },
              browse: workspace.browse.value,
            }
          : undefined
      "
      :filtered-ids="exportFiltered"
      :selected-ids="exportSelected"
      :candidate-filtered-ids="candidateExportFiltered"
      :candidate-selected-ids="candidateExportSelected"
    />
    </template>
  </div>
  <section
    v-if="!workspace.ready.value && !data"
    class="situation-page"
    ><ResourceReadStatus show-refresh />
    <!-- 首次读取失败时，仍保留原有资源恢复入口。 -->
    <details
      v-if="resourceReset && auth.can('resources.reset')"
      class="resource-more"
    >
      <summary class="btn small">更多操作</summary>
      <div class="resource-more-panel">
        <button
          class="btn"
          :disabled="resourceReset.disabled.value"
          @click="resourceReset.run()"
          >恢复初始资源</button
        >
      </div>
    </details>
  </section>
  <DecisionDialog
    :request="scene.decision"
    @answer="scene.answer"
  />
  <DeviceConfigurationDrawer v-if="httpMode && httpConfiguration" ref="httpConfigurationPanel" visible view-context="gis"
    :device-id="httpConfiguration.deviceId" :resource-revision="httpConfiguration.revision" :services="collaborationHttp.deviceConfigurations"
    :editable="httpConfiguration.editable && !configurationBlocked && !auth.blocked" disabled-reason="系统受理不代表真实设备下发；当前台账值不会自动修改。" @close="httpConfiguration = null" />
</template>
<script setup lang="ts">
import GisValidationPanel from '../components/GisValidationPanel.vue';
import GisDiagnosisPanel from '../components/GisDiagnosisPanel.vue';
import { useSituationDiagnosis } from '../composables/useSituationDiagnosis';
import type { FaultObjectType } from '../types/diagnosis';
import { diagnosisLabel } from '../reports/diagnosis-report';
import { useGisValidationNavigation } from '../composables/useGisValidationNavigation';
import DiagnosisScenarioDrawer from '../components/DiagnosisScenarioDrawer.vue';
import { useDiagnosisStore } from '../stores/diagnosis';
import { useGisDiagnosisEditing } from '../composables/useGisDiagnosisEditing';
import SituationMonitoringDrawer from '../components/SituationMonitoringDrawer.vue';
import MonitoringObjectPanel from '../components/MonitoringObjectPanel.vue';
import { useSituationMonitoring } from '../composables/useSituationMonitoring';
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useTerrainBasemap } from '../composables/useTerrainBasemap';
const resourceReset = inject<{
  disabled: { readonly value: boolean };
  run: () => Promise<void>;
} | null>('resourceResetAction', null);
import DevicePortsEditDrawer from '../components/DevicePortsEditDrawer.vue';
import { useRoute, useRouter, onBeforeRouteUpdate, onBeforeRouteLeave } from 'vue-router';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import DeviceConfigurationDrawer from '../components/DeviceConfigurationDrawer.vue';
import { useDeviceConfigurationAcceptanceStore } from '../stores/device-configuration-acceptance';
import { useResourceEditStore } from '../stores/resource-edit';
import { useGisTaskLeaveGuard } from '../composables/useGisTaskLeaveGuard';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { usePlanningStore } from '../stores/planning';
import GisTaskPanel from '../components/GisTaskPanel.vue';
import { useGisTaskSelection } from '../composables/useGisTaskSelection';
import { useGisResourceWorkspace } from '../composables/useGisResourceWorkspace';
import { projectGisTree } from '../services/gis-workspace';
import ResourceReadStatus from '../components/ResourceReadStatus.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import MapCanvas from '../components/MapCanvas.vue';
import GisFrozenPlanPanel from '../components/GisFrozenPlanPanel.vue';
import { collaborationHttp } from '../services/http';
import { previewService } from '../services';
import { env } from '../config/env';
import GisObjectInfoPanel from '../components/GisObjectInfoPanel.vue';
import LinkDetailPanel from '../components/LinkDetailPanel.vue';
import CandidateLinkPanel from '../components/CandidateLinkPanel.vue';
import { createLinkDetailContext } from '../services/link-detail';
import DeviceCoveragePanel from '../components/DeviceCoveragePanel.vue';
import GisResultLayerPanel from '../components/GisResultLayerPanel.vue';
import GisDeviceLayerPanel from '../components/GisDeviceLayerPanel.vue';
import GisDeviceClusterPanel from '../components/GisDeviceClusterPanel.vue';
// GIS 不读取资源管理中的观测来源偏好。
import { useGisDeviceDisplay } from '../composables/useGisDeviceDisplay';
import { useGisPick } from '../composables/useGisPick';
import { useGisResultLayers } from '../composables/useGisResultLayers';
import { useDeviceCoverage } from '../composables/useDeviceCoverage';
import { useGisCoverageCatalog } from '../composables/useGisCoverageCatalog';
import type { DeviceCoverageMode } from '../types/device-coverage';
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
import type { Coordinate, PlanVersion } from '../types/domain';
import { planStations } from '../services/planning-snapshot';
import { safeReturnPath } from '../config/permissions';
const workspace = useGisResourceWorkspace();
const task = useGisTaskSelection();
// 浏览资料只组合轻引用与独立地图；完整资源只属于明确加载的编辑上下文。
const data = computed(() =>
  gis.scene
    ? {
        ...gis.scene,
        resources: resources.value,
        deviceDetails: editing.value ? editor.saved?.deviceDetails : undefined,
      }
    : editor.context === 'gis'
      ? editor.saved
      : null,
);
const editor = useResourceEditStore();
const frozenView = ref(false), httpMode = env.mode === 'http';
const frozenInitialTab = ref<'devices' | 'interference'>('devices');
const frozenPanel = ref<InstanceType<typeof GisFrozenPlanPanel>>();
const frozenServices = { plans: collaborationHttp.gisPlans, queryPlans: previewService.querySavedPlanningPlans, getPlan: previewService.getPlanningPlan };
const frozenOperationServices = { deviceStatuses: collaborationHttp.deviceStatuses, deviceConfigurations: collaborationHttp.deviceConfigurations, observations: collaborationHttp.observations,
  interferenceWorkbench: collaborationHttp.interferenceWorkbench, interferenceScenes: collaborationHttp.interferenceScenes };
// 公共权限目录由总集成接线；GIS入口不借用宽泛的资源编辑权限。
const workspaceEditable = computed(() => !auth.blocked && !!auth.identity?.permissions.some(permission => String(permission) === 'resources.workspace.edit'));
async function toggleFrozenPlans() {
  if (frozenView.value) { if (await frozenPanel.value?.requestLeave()) frozenView.value = false; return; }
  if (!httpMode || !auth.can('planning.view') || fault.active.value) return;
  if (!(await configurationAction(() => gis.leave()))) return;
  editor.clearSession(); frozenInitialTab.value = 'devices'; frozenView.value = true;
}
watch(() => auth.generation, () => { frozenView.value = false; });
onBeforeRouteLeave(async () => !frozenView.value || !frozenPanel.value || await frozenPanel.value.requestLeave());
const route = useRoute(),
  router = useRouter();
const analysisRoutePresent = computed(
  () => route.query.analysisTaskId !== undefined || route.query.analysisPlanId !== undefined,
);
const scene = useDiagnosisStore(),
  fault = useGisDiagnosisEditing();
const rightTab = ref('对象详情');
const canInterferenceRead = computed(() => !auth.blocked && auth.can('situation.view') && auth.can('planning.view'));
const analysisNode = ref(''),
  analysisLink = ref(''),
  analysisSource = ref('');
// 显式进入分析时退出其他快照；没有记录就显示资源底图和分析输入，不提交分析。
async function openInterferenceAnalysis() {
  if (fault.active.value) return false;
  if (!canInterferenceRead.value) return false;
  if (frozenView.value) {
    if (!frozenPanel.value || !await frozenPanel.value.requestLeave()) return false;
    frozenInitialTab.value = 'interference'; return true;
  }
  if (!canInterferenceRead.value || !(await configurationAction(() => gis.leave()))) return false;
  editor.clearSession(); frozenInitialTab.value = 'interference'; frozenView.value = true;
  return true;
}
async function openAnalysisResult(value: { taskId: string; planId: string }) {
  if (!await frozenPanel.value?.requestLeave()) return;
  await router.push({ path: '/planning', query: { taskId: value.taskId, planId: value.planId } });
}
async function openAnalysisJob(value: { taskId: string; jobId: string }) {
  if (!await frozenPanel.value?.requestLeave()) return;
  await router.push({ path: '/planning', query: { taskId: value.taskId, jobId: value.jobId } });
}
async function analyzeSource(id: string) {
  if (!id || !auth.can('planning.execute')) return;
  await openInterferenceAnalysis();
}
const snapshotMode = computed(() => frozenView.value);
// 资源图与资源树共用筛选结果；监控和分析仍使用各自完整的冻结网络。
const mapStations = computed(() =>
  diagnosisMode.value
    ? (diagnosis.display.value?.stations ?? [])
    : monitorMode.value && monitorMap.value
      ? monitorMap.value.stations
      : taskViewing.value ? [] : stations.value,
);
const mapLinks = computed(() =>
  diagnosisMode.value
    ? (diagnosis.display.value?.links ?? [])
    : monitorMode.value && monitorMap.value
      ? monitorMap.value.links
      : taskViewing.value
          ? []
          : resourceTree.value.links,
);
const mapSources = computed(() =>
  diagnosisMode.value || monitorMode.value || taskViewing.value
    ? []
    : interferences.value,
);
const analysisDetailSource = computed(() => selectedInterference.value);
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
const gis = useGisWorkspaceStore(),
  planning = usePlanningStore(),
  selectedDemand = ref(''),
  demandsVisible = ref(true);
// 每次进入先显示资源；明确的任务和报告入口再选择各自上下文。
gis.mapMode = 'resource';
useGisTaskLeaveGuard({
  additionalPending: () => httpMode && !!httpConfiguration.value && (configurationAcceptance.busy || configurationAcceptance.dirty || !!configurationAcceptance.pending),
  fault: {
    active: () => fault.active.value,
    dirty: () => fault.dirty.value,
    busy: () => fault.busy.value,
    leave: fault.leave,
    isReturnTarget: fault.isReturnTarget,
  },
});
const resources = computed<import('../types/gis-workspace').GisResourceIndex>(() =>
  editing.value
    ? editor.resources
    : (workspace.directory.value?.resources ?? {
        stations: [],
        devices: [],
        models: [],
        source: '',
        version: '',
      }),
);
const editing = computed(() => editor.context === 'gis');
const configuration = useDeviceConfigurationStore();
const httpConfiguration = ref<{ deviceId: string; revision: string; editable: boolean } | null>(null);
const httpConfigurationPanel = ref<InstanceType<typeof DeviceConfigurationDrawer>>();
const configurationAcceptance = useDeviceConfigurationAcceptanceStore();
const configurationBlocked = computed(
  () =>
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
        editable: httpMode ? !auth.blocked && !!auth.identity?.permissions.some(value => String(value) === 'resources.device.edit') : editing.value && auth.can('resources.edit'),
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
    (httpMode ? !httpConfigurationPanel.value || await httpConfigurationPanel.value.requestLeave() : await configuration.leave(true)) &&
    session === auth.generation &&
    mode === gis.mapMode &&
    !auth.blocked
  );
}
async function configurationAction(action: () => unknown | Promise<unknown>) {
  if (fault.active.value) return false;
  const active = httpMode ? !!httpConfiguration.value : configuration.visible,
    session = auth.generation;
  if (active && !(await prepareConfiguration())) return false;
  if (
    fault.active.value ||
    session !== auth.generation ||
    auth.blocked ||
    !auth.can('situation.view')
  )
    return false;
  const value = await action();
  if (value === false) return false;
  if (active && session === auth.generation) {
    if (httpMode) httpConfiguration.value = null;
    else configuration.clearForSession();
  }
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
  if (httpMode) {
    if (httpConfigurationPanel.value && !await httpConfigurationPanel.value.requestLeave()) return;
    const revision = workspace.read.workspace?.revision;
    if (!revision) { focusError.value = '当前资源版本尚未读取，不能发起设备配置。'; return; }
    httpConfiguration.value = { deviceId: id, revision, editable: !history && configurationEntry.value.editable };
    return;
  }
  if (await configuration.open('gis', id, !history && configurationEntry.value.editable)) {
    configuration.setEligibility(
      'gis',
      editing.value && !configurationBlocked.value,
      configurationEntry.value?.reason,
    );
    if (history) configuration.tab = 'history';
  }
}
const releaseHttpConfiguration = auth.registerLeave(async () => !httpConfigurationPanel.value || await httpConfigurationPanel.value.requestLeave(), () => !!httpConfiguration.value);
onBeforeRouteLeave(async () => !httpConfigurationPanel.value || await httpConfigurationPanel.value.requestLeave());
watch(() => auth.generation, () => { httpConfiguration.value = null; });
onBeforeUnmount(releaseHttpConfiguration);
onBeforeRouteUpdate(async (to) => {
  if (
    (to.query.analysisTaskId !== undefined || to.query.analysisPlanId !== undefined) &&
    !safeReturnPath(to.fullPath)
  ) {
    focusError.value = '干扰分析入口参数无效，当前现场已保留';
    return false;
  }
  if (!(await fault.allowRouteUpdate(to))) return false;
  if (to.query.faultEdit !== undefined && !fault.active.value) {
    if (!(await configurationAction(() => gis.leave()))) return false;
    editor.clearSession();
  }
  // 同页任务深链也先处理资源表单，避免只读任务地图覆盖尚未应用的输入。
  if (to.query.taskId !== undefined && to.query.taskId !== route.query.taskId) {
    return configurationAction(
      async () => (await editor.closeForm()) && (await editor.closeImport()),
    );
  }
  if (!(httpMode ? httpConfiguration.value : configuration.visible)) return true;
  return configurationAction(() => true);
});
const oldResultsHidden = computed(
  () =>
    !data.value ||
    (editing.value && editor.resultsDirty) ||
    !!data.value?.resourceMeta.changedStationIds.length ||
    !!data.value?.resourceMeta.changedDeviceIds.length ||
    (data.value?.resourceMeta.interferenceVersion ?? 'initial') !== 'initial',
);
const selectedDeviceId = ref('');
// 普通 GIS 链路选择独立于监控/分析；资料只绑定当前网络快照。
const selectedLinkId = ref('');
// 链路历史只随所选身份读取，不随资源底图提前运输。
watch([selectedLinkId, editing, () => gis.scene?.revision], ([id, inEdit]) => {
  if (!inEdit) void gis.loadLinkDetails(id);
});
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
  editing.value && data.value
    ? createLinkDetailContext(
        editor.saved?.situation ?? data.value.situation,
        editor.resources,
        data.value.resourceMeta,
        editing.value && editor.resultsDirty,
      )
    : !gis.scene
      ? undefined
      : oldResultsHidden.value
        ? {
            ...(gis.linkDetails ?? gis.scene.linkDetails),
            state: 'stale' as const,
            message: '资源已变更，暂无匹配的链路指标与历史样例；恢复演示基线后可查看。',
            records: [],
          }
        : (gis.linkDetails ?? gis.scene.linkDetails).snapshotId !== gis.scene.situation.snapshotId
          ? {
              ...(gis.linkDetails ?? gis.scene.linkDetails),
              state: 'invalid' as const,
              message: '链路指标与当前网络版本不匹配，暂不可用。',
              records: [],
            }
          : (gis.linkDetails ?? gis.scene.linkDetails),
);
const resourceLinkHighlightIds = computed(() =>
  auth.can('situation.view') && !oldResultsHidden.value && selectedResourceLink.value
    ? [selectedResourceLink.value.id]
    : [],
);
// 关联资料沿用旧结果保护；GIS 草稿不与演示路径混用。
const deviceNetwork = computed(() =>
  editing.value && data.value
    ? createDeviceNetworkContext(
        editor.saved?.situation ?? data.value.situation,
        editor.resources,
        data.value.resourceMeta,
        editing.value && editor.resultsDirty,
      )
    : !gis.scene
      ? undefined
      : oldResultsHidden.value
        ? {
            ...(workspace.read.detail?.network ?? gis.scene.network),
            state: 'stale' as const,
            message: '资源已变更，暂无匹配的网络关联样例；恢复演示基线后可查看。',
          }
        : (workspace.read.detail?.network ?? gis.scene.network).snapshotId !==
            gis.scene.situation.snapshotId
          ? {
              ...(workspace.read.detail?.network ?? gis.scene.network),
              state: 'invalid' as const,
              message: '网络关联资料不完整或版本不匹配，暂不可用。',
            }
          : (workspace.read.detail?.network ?? gis.scene.network),
);
const resourceDeviceLinkIds = computed(() =>
  auth.can('situation.view') && deviceNetwork.value
    ? selectDeviceNetwork(deviceNetwork.value, selectedDeviceId.value).links.map((link) => link.id)
    : [],
);
const selectedInterferenceId = ref(''),
  interferenceOpen = ref(false),
  exportOpen = ref(false),
  interferenceVisible = ref(true);
const selectedInterference = computed(() => {
  const object = workspace.read.detail?.object;
  // 详情优先使用同版本响应；来源缺失时由通用详情显示，不能伪造来源。
  if (
    !editing.value &&
    object?.kind === 'interference' &&
    object.id === selectedInterferenceId.value
  )
    return object.origin ? { ...object, origin: object.origin } : undefined;
  return resources.value.interferences?.find((row) => row.id === selectedInterferenceId.value);
});
const interferences = computed(() =>
  editing.value
    ? resourceTree.value.interferences
    : (gis.scene?.map.interferences ?? []).filter(
        (row) =>
          !workspace.directory.value ||
          resourceTree.value.interferences.some((source) => source.id === row.id),
      ),
);
const pickPreview = computed<Coordinate | undefined>(() => {
  const fields = editor.form?.fields;
  if (!fields || !fields.longitude?.trim() || !fields.latitude?.trim()) return;
  const point: Coordinate = [Number(fields.longitude), Number(fields.latitude)];
  return point.every(Number.isFinite) ? point : undefined;
});
// 仅把已保存且仍存在的对象放入导出范围，避免混入草稿。
const exportFiltered = computed(() =>
  data.value
    ? gisResourceExportIds(resourceTree.value, data.value.resources)
    : { nodes: [], devices: [], interference_sources: [] },
);
const candidateExportFiltered = computed(() =>
  data.value ? gisCandidateExportIds(resourceTree.value, data.value.resources).topology_links : [],
);
const candidateExportSelected = computed(() =>
  data.value
    ? gisSelectedCandidateExportIds(selectedCandidateLinkId.value, data.value.resources)
        .topology_links
    : [],
);
const exportSelected = computed(() => {
  const saved =
    data.value?.revision === workspace.read.workspace?.revision ? data.value?.resources : undefined;
  const detail =
    workspace.read.detail?.revision === workspace.read.workspace?.revision
      ? workspace.read.detail?.object
      : undefined;
  // 已选详情本身即可提供确定 ID，不依赖完整展示资料或其他分页。
  return {
    nodes:
      saved?.stations.some((row) => row.id === selectedId.value) ||
      (detail?.kind === 'node' && detail.id === selectedId.value) ||
      (detail?.kind === 'device' && detail.stationId === selectedId.value)
        ? [selectedId.value]
        : [],
    devices:
      saved?.devices.some((row) => row.id === selectedDeviceId.value) ||
      (detail?.kind === 'device' && detail.id === selectedDeviceId.value)
        ? [selectedDeviceId.value]
        : [],
    interference_sources:
      saved?.interferences?.some((row) => row.id === selectedInterferenceId.value) ||
      (detail?.kind === 'interference' && detail.id === selectedInterferenceId.value)
        ? [selectedInterferenceId.value]
        : [],
  };
});
const focusError = ref('');
const query = ref('');
const filter = ref<GisResourceFilter>('全部');
const resourceFiltersActive = computed(
  () =>
    !!query.value ||
    filter.value !== '全部' ||
    Object.values(workspace.classification.value).some(Boolean),
);
watch([query, filter, workspace.classification], () => {
  workspace.search.value = query.value;
  workspace.read.setMapFilter({
    search: query.value || undefined,
    deviceClass: filter.value === 'HF' || filter.value === 'VUHF' ? filter.value : undefined,
    alert: filter.value === '告警' ? 'YES' : undefined,
    mobility: workspace.classification.value.mobility || undefined,
    nodeRole: workspace.classification.value.role || undefined,
    relayCapable: workspace.classification.value.relay
      ? workspace.classification.value.relay === 'YES'
      : undefined,
  });
});
// 清除筛选只改变显示，不能重置对象选择、未保存表单或草稿。
function clearResourceFilters() {
  query.value = '';
  filter.value = '全部';
  workspace.classification.value = { mobility: '', role: '', relay: '' };
}
const selectedId = ref(
  editor.context === 'gis' && editor.form?.kind === 'device'
    ? (editor.resources.devices.find((d) => d.id === editor.form?.id)?.stationId ?? '')
    : '',
);
const leftOpen = ref(true);
// 普通入口优先显示地图，诊断深链保留报告及错误提示的可见入口。
const rightOpen = ref(route.query.diagnosisId !== undefined);
function showResourcePanel() {
  leftOpen.value = true;
  // 窄窗口只让一个侧栏占位，切换显示不清空对象选择或草稿。
  if (window.matchMedia?.('(max-width: 1280px)').matches) rightOpen.value = false;
}
const mapRef = ref<InstanceType<typeof MapCanvas>>();
// 只预览当前资源来源；冻结快照、取点、失权和切账号均令旧悬浮失效。
const resourceHoverContext = computed(() => {
  const revision = workspace.read.workspace?.revision;
  if (
    !revision ||
    auth.blocked ||
    !auth.can('situation.view') ||
    workspace.read.frozen ||
    gis.mapMode !== 'resource' ||
    fault.active.value ||
    taskViewing.value ||
    editor.picking
  )
    return undefined;
  const directory = workspace.directory.value;
  return {
    key: JSON.stringify([auth.generation, revision, editing.value, directoryEpoch.value]),
    source: editing.value ? '当前 GIS 草稿（已应用）' : '已保存资源',
    models: editing.value
      ? editor.resources.models
      : directory?.revision === revision
        ? directory.resources.models
        : [],
  };
});
const networkFocus = ref<{
  snapshotId: string;
  linkIds: string[];
  stationIds: string[];
  deviceId: string;
  revision: string;
} | null>(null);
const networkFocusActive = computed(
  () =>
    networkFocus.value?.revision === workspace.read.workspace?.revision &&
    networkFocus.value?.deviceId === selectedDeviceId.value &&
    gis.mapMode === 'resource',
);
// 离开设备或快照即清除临时定位，返回原设备时不复活旧高亮。
watch(
  [
    () => selectedDeviceId.value,
    () => workspace.read.workspace?.revision,
    () => gis.mapMode,
    () => auth.generation,
  ],
  () => {
    networkFocus.value = null;
  },
);
async function locateDeviceNetwork(value: {
  snapshotId: string;
  linkIds: string[];
  stationIds: string[];
}) {
  if (!value.linkIds.length) {
    networkFocus.value = null;
    return;
  }
  if (gis.mapMode !== 'resource' || data.value?.situation.snapshotId !== value.snapshotId) {
    editor.report(new Error('当前地图与下钻网络快照不同，无法定位'));
    return;
  }
  networkFocus.value = {
    ...value,
    deviceId: selectedDeviceId.value,
    revision: workspace.read.workspace?.revision ?? '',
  };
  await nextTick();
  mapRef.value?.locate();
}
async function applyPorts() {
  if (editor.applyForm()) await editor.closeForm();
}
const diagnosis = useSituationDiagnosis(
    () => (analysisRoutePresent.value ? {} : route.query),
    () => !fault.active.value && !analysisRoutePresent.value,
  ),
  diagnosisMode = diagnosis.active;
const diagnosisNode = computed(() => diagnosis.selected.value?.station?.id ?? '');
const diagnosisLink = computed(() => diagnosis.selected.value?.link?.id ?? '');
// 地图事件绑定渲染时的报告代次，不借当前同名对象解释旧点击。
const mapSelection = computed(() => {
  const diagnostic = diagnosisMode.value,
    actions = diagnosis.actions.value,
    mode = gis.mapMode;
  const topologyContext = topologyEpoch.value;
  const valid = () => gis.mapMode === mode && !fault.active.value;
  return {
    node: (id: string) =>
      diagnostic
        ? actions.select({ objectType: 'NODE', objectId: id })
        : valid() &&
          (taskViewing.value
            ? void locateTaskNode(id)
            : monitorMode.value
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
        void locateTaskDemand(id);
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
  () => !httpMode && auth.can('situation.view'),
  () => fault.active.value,
);
let previousMonitorOpen: boolean | null = null;
watch(
  fault.active,
  (active) => {
    if (active) {
      if (previousMonitorOpen === null) previousMonitorOpen = monitor.open;
      monitor.open = false;
      leftOpen.value = true;
      rightOpen.value = false;
    } else if (previousMonitorOpen !== null) {
      monitor.open = previousMonitorOpen;
      previousMonitorOpen = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (previousMonitorOpen !== null) monitor.open = previousMonitorOpen;
});
// 来源标识跟随实际显示的数据；措施预览没有独立快照 ID，明确显示措施与来源方案。
const visibleSource = computed(() => {
  if (frozenView.value) return '数据库冻结方案 · 独立历史来源';
  if (fault.active.value)
    return `故障标绘 · ${fault.network.value?.name ?? '网络未就绪'} · ${fault.draft.value?.name || '新场景'}`;
  if (diagnosisMode.value) return `诊断 ${diagnosis.display.value?.record.id ?? '结果未提供'}`;
  if (monitorMode.value)
    return `监控网络 · ${monitor.network?.kind === 'DEMO' ? '参考网络' : (monitor.network?.taskId ?? '来源未提供')}`;
  if (taskViewing.value)
    return task.selected
      ? `任务 ${task.selected.name} · ${task.selected.version} · 已保存资源`
      : '任务查看 · 尚未选择任务';
  return `资源${editing.value && editor.draftDirty ? '草稿' : ''} · ${workspace.read.workspace?.revision ?? '版本未提供'}`;
});
const sideTab = ref('资源树');
const taskPreview = ref(false);
// 图层页签只调显示偏好，不改变已经选定的任务地图来源。
const taskViewing = computed(
  () => taskPreview.value && gis.mapMode === 'resource' && !fault.active.value,
);
const taskStations = computed(() => task.nodes);
const selectedTaskNode = ref('');
const selectedTaskDemand = computed(() =>
  task.input?.demands.find((row) => row.id === selectedDemand.value),
);
const resourceSaveFeedback = computed(
  () =>
    ({
      idle: '',
      saving: '保存中…',
      succeeded: '资源保存成功',
      'validation-failed': '资源校验失败，请检查错误清单。',
      failed: '资源保存失败，输入已保留。',
    })[gis.saveState],
);
const resourceEditable = computed(
  () =>
    editing.value &&
    editor.canEdit &&
    gis.mapMode === 'resource' &&
    !taskViewing.value &&
    !fault.active.value,
);
const modeLabel = computed(() => {
  if (fault.active.value)
    return fault.canEdit.value ? '故障标绘 · 场景编辑' : '故障标绘 · 当前不可编辑';
  if (taskViewing.value) return '任务查看 · 只读';
  if (editor.picking) return '标绘模式 · 地图取点';
  if (diagnosisMode.value) return '诊断快照 · 只读';
  if (snapshotMode.value || monitorMode.value) return '网络快照 · 只读';
  return resourceEditable.value ? '资源编辑模式' : '浏览模式 · 只读';
});
// 任务查看只改变地图来源，未保存资源仍由原工作区保留。
async function chooseSideTab(tab: string) {
  // 故障工作区没有资源页签；旧页签事件不能绕过其退出决策。
  if (fault.active.value) return;
  if (tab === '资源树') {
    await returnToResources();
    return;
  }
  if (tab !== '任务查看') {
    sideTab.value = tab;
    return;
  }
  if (
    !auth.can('planning.view') ||
    editor.picking ||
    !(await configurationAction(async () => {
      if (!(await editor.closeForm()) || !(await editor.closeImport())) return false;
      sideTab.value = tab;
      taskPreview.value = true;
      gis.mapMode = 'resource';
      if (!task.library.length) await task.initialize(route.query.taskId);
      return true;
    }))
  )
    return;
}
async function returnToResources() {
  if (fault.active.value) {
    if (await router.push('/situation')) return;
    sideTab.value = '资源树';
    taskPreview.value = false;
    gis.mapMode = 'resource';
    return;
  }
  await configurationAction(() => {
    sideTab.value = '资源树';
    taskPreview.value = false;
    gis.mapMode = 'resource';
  });
}
async function editSelectedTask(id: string) {
  if (id !== task.taskId || !auth.can('planning.view')) return;
  await router.push({ path: '/planning', query: { taskId: id, editTask: '1' } });
}
async function locateTaskNode(id: string) {
  if (!taskViewing.value || !task.input?.stationIds.includes(id)) return;
  const node = taskStations.value.find((row) => row.id === id);
  if (!node) {
    focusError.value = '此任务节点的已保存资源引用不可用，无法定位';
    return;
  }
  selectedTaskNode.value = id;
  rightOpen.value = true;
  focusError.value = '';
  await nextTick();
  mapRef.value?.locateResource(node.coordinate);
}
async function locateTaskDemand(id: string) {
  if (!taskViewing.value) return;
  const demand = task.input?.demands.find((row) => row.id === id);
  if (!demand) return;
  const ends = [demand.sourceId, demand.targetId].map((nodeId) =>
    taskStations.value.find((row) => row.id === nodeId),
  );
  if (!ends[0] || !ends[1]) {
    focusError.value = '通联端点引用不完整，无法定位';
    return;
  }
  selectedDemand.value = id;
  selectedTaskNode.value = '';
  rightOpen.value = true;
  focusError.value = '';
  // 中点仅用于地图定位，不参与链路质量或规划结果计算。
  const point: Coordinate = [
    (ends[0].coordinate[0] + ends[1].coordinate[0]) / 2,
    (ends[0].coordinate[1] + ends[1].coordinate[1]) / 2,
  ];
  await nextTick();
  mapRef.value?.locateResource(point);
}
async function beginFaultEditing() {
  if (fault.active.value || !auth.can('diagnosis.scenario') || editor.picking) return;
  // 同页路由守卫统一处理资源及配置决策，按钮与深链共用一次进入事务。
  await router.push({ path: '/situation', query: { faultEdit: '1' } });
}
function selectFaultVersion(id: string) {
  const version = fault.scenes.value
    .flatMap((item) => item.versions)
    .find((item) => item.id === id);
  if (version) void fault.selectVersion(version);
}
const faultStations = computed(() =>
  fault.network.value ? planStations(fault.network.value) : [],
);
// 权限暂失时保留抽屉本地输入；换身份或离开标绘才释放其网络引用。
const faultFormNetwork = ref<PlanVersion | null>(null);
watch(
  fault.network,
  (value) => {
    if (value) faultFormNetwork.value = value;
  },
  { immediate: true },
);
watch(
  () => [fault.active.value, auth.identity?.sessionId, auth.identity?.id] as const,
  ([active, sessionId, accountId], previous) => {
    if (!active || (previous && (previous[1] !== sessionId || previous[2] !== accountId)))
      faultFormNetwork.value = null;
  },
);
const faultSelectedNode = computed(() =>
  fault.focus.value?.type === 'NODE'
    ? fault.focus.value.id
    : fault.focus.value?.type === 'DEVICE'
      ? (fault.network.value?.inputSnapshot.devices.find((row) => row.id === fault.focus.value?.id)
          ?.stationId ?? '')
      : '',
);
const faultDeviceChoices = computed(
  () =>
    fault.network.value?.inputSnapshot.devices.filter(
      (row) => row.stationId === faultSelectedNode.value,
    ) ?? [],
);
const faultHighlights = computed(() => ({
  nodes: fault.selected.value.flatMap((target) =>
    target.objectType === 'NODE'
      ? [target.objectId]
      : target.objectType === 'DEVICE'
        ? [
            fault.network.value?.inputSnapshot.devices.find((row) => row.id === target.objectId)
              ?.stationId ?? '',
          ]
        : [],
  ),
  links: fault.selected.value
    .filter((target) => target.objectType === 'LINK')
    .map((target) => target.objectId),
}));
watch(fault.focus, async () => {
  if (fault.active.value) {
    rightOpen.value = true;
    await nextTick();
    mapRef.value?.locate();
  }
});
watch(
  () => task.selected,
  () => {
    selectedDemand.value = '';
    selectedTaskNode.value = '';
  },
);
watch(
  // 任务引用始终等待公共资源版本就绪，与传输方式无关。
  () => [workspace.ready.value, route.query.taskId, auth.generation] as const,
  async ([ready, id], previous) => {
    if (
      !ready ||
      analysisRoutePresent.value ||
      fault.active.value ||
      diagnosis.target.value.present ||
      !auth.can('planning.view')
    )
      return;
    if (id !== undefined) {
      sideTab.value = '任务查看';
      taskPreview.value = true;
      gis.mapMode = 'resource';
      leftOpen.value = true;
      await task.initialize(id);
    } else if (previous?.[1] !== undefined) {
      sideTab.value = '资源树';
      taskPreview.value = false;
    }
  },
  { immediate: true },
);
const roads = ref(false);
const nodes = ref(true);
const links = ref(true);
const topologyOpacity = ref(1);
const candidates = ref(false);
// 定位保护资源与设备配置现场，任务草稿独立保留。
// 请求生命周期由目录组合函数管理，显示意图序号仍属于页面交互。
let coverageRequest = 0;
const {
  catalog: coverageCatalog,
  error: coverageError,
  load: loadCoverage,
} = useGisCoverageCatalog(
  () => workspace.read.workspace?.revision,
  () => {
    coverageRequest++;
  },
);
async function setCoverageMode(mode: DeviceCoverageMode) {
  if (!auth.can('situation.view') || auth.blocked || fault.active.value) return;
  const request = ++coverageRequest,
    epoch = directoryEpoch.value;
  if (mode !== 'network') await loadCoverage();
  // 后发操作及来源变化优先，旧读取完成后不能覆盖新的显示选择。
  if (request !== coverageRequest || epoch !== directoryEpoch.value) return;
  deviceCoverage.setMode(mode);
}
function selectCoverageDevice(id: string) {
  if (!auth.can('situation.view') || auth.blocked || fault.active.value) return;
  coverageRequest++;
  deviceCoverage.open(id);
}
const deviceCoverage = useDeviceCoverage(
  () => coverageCatalog.value ?? undefined,
  () =>
    diagnosisMode.value
      ? '诊断冻结网络中暂停设备覆盖，选择已保留。'
      : monitorMode.value
        ? '监控冻结网络中暂停设备覆盖，选择已保留。'
        : snapshotMode.value
          ? '干扰分析网络中暂停设备覆盖，选择已保留。'
          : oldResultsHidden.value
            ? '资源已有修改，当前输入暂无匹配的设备覆盖样例；恢复相应资源条件后可查看。'
            : '',
);
// 区域仍来自原有资源/冻结快照，图层偏好仅控制本页展示。
const mapRegions = computed(() =>
  diagnosisMode.value || monitorMode.value || taskViewing.value
    ? []
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
    interferenceAvailable: false,
    interferenceFilteredOut: false,
  }),
  () => auth.generation,
);
// 显式入口只切换显示上下文，不选择另一资源或丢弃编辑表单。
async function openDeviceCoverage(id: string) {
  if (
    !auth.can('situation.view') ||
    auth.blocked ||
    fault.active.value ||
    taskViewing.value ||
    gis.mapMode !== 'resource'
  )
    return;
  const request = ++coverageRequest,
    epoch = directoryEpoch.value;
  await loadCoverage();
  if (request !== coverageRequest || epoch !== directoryEpoch.value) return;
  deviceCoverage.open(id);
  gis.mapMode = 'resource';
  resultLayers.enableCoverage();
  sideTab.value = '图层管理';
  leftOpen.value = true;
}
const resourceTree = computed(() =>
  projectGisTree(
    directoryResources.value,
    data.value?.situation.links ?? [],
    query.value,
    filter.value,
    !oldResultsHidden.value,
    workspace.browse.value,
    workspace.classification.value,
  ),
);
const directoryResources = computed(() => {
  const r = resources.value,
    ids = workspace.clusterIds.value;
  if (editing.value || ids === null) return r;
  const members = new Set(ids);
  return workspace.cluster.value?.kind === 'node'
    ? {
        ...r,
        stations: r.stations.filter((row) => members.has(row.id)),
        devices: r.devices.filter((row) => members.has(row.stationId)),
      }
    : { ...r, interferences: r.interferences?.filter((row) => members.has(row.id)) };
});
const stations = computed(() =>
  editing.value
    ? editor.resources.stations.filter((row) => resourceTree.value.stationIds.includes(row.id))
    : (gis.scene?.map.stations ?? []).filter(
        (row) => !workspace.directory.value || resourceTree.value.stationIds.includes(row.id),
      ),
);
// 吸附只读取当前草稿和资源筛选，冻结视图不提供可写取点上下文。
const gisPick = useGisPick(() => ({
  mode: diagnosisMode.value || monitorMode.value || snapshotMode.value ? 'snapshot' : gis.mapMode,
  stations: stations.value,
  interferences: interferences.value,
  showStations: nodes.value,
  showInterferences: interferenceVisible.value,
  filterKey: `${filter.value}/${query.value}`,
}));
// 新设备层仅使用普通资源/编辑草稿，绝不与监控或分析冻结网络拼接。
const deviceMap = computed(() =>
  gis.scene
    ? { points: gis.scene.map.devices, missingCount: gis.scene.map.missingCount }
    : undefined,
);
const deviceDisplay = useGisDeviceDisplay(() => ({
  resources: editing.value ? editor.resources : undefined,
  map: !editing.value ? deviceMap.value : undefined,
  stationIds: stations.value.map((row) => row.id),
  deviceIds: editing.value || workspace.directory.value ? resourceTree.value.deviceIds : undefined,
  enabled: !!data.value && gis.mapMode === 'resource' && !monitorMode.value && !snapshotMode.value,
  readable: auth.can('situation.view'),
  generation: auth.generation,
  sourceKey:
    (data.value?.situation.snapshotId ?? '') + '/' + (data.value?.resourceMeta.revision ?? ''),
  selectedDeviceId: selectedDeviceId.value,
}));
// 定位通过原确认后才改变显示；无有效坐标时只打开表单，不移动已有地图选择。
const validation = useGisValidationNavigation({
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
      revision = data.value?.resourceMeta.revision,
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
function openDeviceCluster(ids: string[], version: number) {
  if (!editor.busy && !editor.picking && deviceDisplay.open(ids, version)) rightOpen.value = true;
}
async function pickMapDevice(id: string, version: number, listRevision?: number) {
  if (fault.active.value || taskViewing.value) return;
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
  if (!accepted || editor.busy || editor.picking || fault.active.value || taskViewing.value) return;
  if (!editing.value) {
    if (await selectReadObject('device', id, false)) deviceDisplay.close();
    return;
  }
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
  if (!data.value) return;
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
    () => fault.active.value,
    () => taskViewing.value,
    () => auth.generation,
    () => auth.can('situation.view'),
    () => data.value?.situation.snapshotId,
    () => data.value?.resourceMeta.revision,
    () => editor.context,
    () => monitor.network?.key,
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
    if (!canInterferenceRead.value) return '需要干扰分析查看权限';
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
  // 仅查看所选已保存任务，冻结结果不混入任务或资源草稿。
  deployment:
    !diagnosisMode.value &&
    !snapshotMode.value &&
    !monitorMode.value &&
    taskViewing.value &&
    task.input &&
    demandsVisible.value &&
    auth.can('planning.view')
      ? {
          owner: task.taskId + ':' + auth.generation,
          label: `已保存任务 ${task.selected?.version ?? ''}`,
          constraints: task.input?.deploymentConstraints,
        }
      : null,
  deviceCoverages:
    !taskViewing.value && deviceCoverage.active.value ? deviceCoverage.overlays.value : [],
  demands:
    diagnosisMode.value || snapshotMode.value || monitorMode.value
      ? []
      : taskViewing.value && auth.can('planning.view')
        ? (task.input?.demands ?? [])
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
    : taskViewing.value
      ? (task.input?.stationIds ?? [])
      : [],
  diagnosisDevices: diagnosisMode.value ? (diagnosis.display.value?.devices ?? []) : [],
  diagnosisFaults: diagnosisMode.value ? (diagnosis.display.value?.faults ?? []) : [],
  diagnosisRegions: diagnosisMode.value ? diagnosis.impact.value.regions : [],
  candidateWorkset:
    gis.mapMode === 'resource' && !taskViewing.value && auth.can('situation.view')
      ? resourceTree.value.candidateLinks
      : [],
}));
// 候选事件绑定当前资源会话；失权、换视图或离页后，旧点击不能关闭新表单。
const candidateActions = computed(() => {
  const epoch = directoryEpoch.value;
  const current = () =>
    epoch === directoryEpoch.value &&
    gis.mapMode === 'resource' &&
    !fault.active.value &&
    !taskViewing.value &&
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
    // 用户已明确选择候选，进入编辑时不能再用初始 URL 覆盖当前详情。
    locatedResourceRoute = JSON.stringify([
      route.query.stationId,
      route.query.deviceId,
      route.query.interferenceId,
      route.query.taskId,
      auth.generation,
    ]);
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
        return configurationAction(() => current() && editor.openForm('candidate', id, current));
    },
    create: async () => {
      if (current() && editing.value)
        await configurationAction(() => current() && editor.newForm('candidate', '', current));
    },
    visible: (event: Event) => {
      if (current()) candidates.value = (event.target as HTMLInputElement).checked;
    },
  };
});
function directoryIdentity(kind: DirectoryKind, id: string) {
  if (!data.value) return;
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
  if (!editing.value && kind === 'device') return selectReadObject('device', id, true, epoch);
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
  if (!editing.value) return selectReadObject('node', id);
  if (fault.active.value || taskViewing.value) return false;
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
  // 等待表单决策期间若已切入其他工作区，旧资源选择不能覆盖当前来源。
  if (fault.active.value || taskViewing.value || session !== auth.generation) return false;
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
  if (!editing.value) return selectReadObject('interference', id);
  if (fault.active.value || taskViewing.value) return;
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
  if (fault.active.value || taskViewing.value) return;
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
  if (fault.active.value || taskViewing.value || !editing.value || !editor.canEdit) return;
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
  if (fault.active.value || taskViewing.value || session !== auth.generation) return;
  if (await editor.newForm(kind)) {
    // 新建先展示统一右侧表单，用户再主动选择地图取点。
    editor.picking = false;
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
  if (fault.active.value || taskViewing.value || !editing.value || !editor.canEdit) return;
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
  if (fault.active.value || taskViewing.value || session !== auth.generation) return;
  await editor.openImport();
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
    if (!editing.value) return;
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
  if (!editing.value) return selectReadObject('device', id);
  if (fault.active.value || taskViewing.value) return false;
  const configurationActive = configuration.visible;
  if (configurationActive && !(await prepareConfiguration())) return false;
  if (id !== selectedDeviceId.value && !(await editor.closeForm())) return false;
  if (fault.active.value || taskViewing.value) return false;
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
  if (fault.active.value || taskViewing.value) return;
  if (!data.value) return;
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
    snapshotId !== data.value?.situation.snapshotId ||
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
let locatedResourceRoute = '';
watch(
  () => [
    route.query.stationId,
    route.query.deviceId,
    route.query.interferenceId,
    route.query.diagnosisId,
    !!data.value,
  ],
  async ([stationId, deviceId, interferenceId]) => {
    if (analysisRoutePresent.value || !editing.value || !data.value) return;
    const routeKey = JSON.stringify([
      stationId,
      deviceId,
      interferenceId,
      route.query.taskId,
      auth.generation,
    ]);
    if (routeKey === locatedResourceRoute) return;
    // 即使诊断参数无效也不同时执行普通资源定位。
    if (diagnosis.target.value.present) return;
    const generation = auth.generation,
      sourceKey = data.value.situation.snapshotId + '/' + data.value.resourceMeta.revision;
    if (interferenceId !== undefined) {
      if (typeof interferenceId !== 'string' || stationId !== undefined || deviceId !== undefined) {
        focusError.value = '地图定位失败：参数无效';
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
      locatedResourceRoute = routeKey;
      // 初次挂载或定位当前节点也触发地图已有的定位监听。
      selectedId.value = '';
      await nextTick();
      selectedId.value = stationId;
    }
  },
  { immediate: true },
);

// 保存态选中、定位及聚合使用当前身份和版本，不补入编辑快照。
async function selectReadObject(
  kind: import('../types/resource-read').ResourceObjectKind,
  id: string,
  focus = true,
  expectedEpoch = directoryEpoch.value,
) {
  if (editing.value || workspace.read.frozen || fault.active.value || taskViewing.value)
    return false;
  const owner = auth.generation,
    sourceMode = gis.mapMode,
    revision = workspace.read.workspace?.revision,
    identity = kind === 'device' ? directoryIdentity('device', id) : undefined,
    request = ++directoryRequest;
  const current = () =>
    owner === auth.generation &&
    expectedEpoch === directoryEpoch.value &&
    request === directoryRequest &&
    revision === workspace.read.workspace?.revision &&
    sourceMode === gis.mapMode &&
    (!identity || identity === directoryIdentity('device', id));
  if (!current()) return false;
  if (
    !(await configurationAction(
      async () => (await editor.closeForm()) && (await editor.closeImport()),
    ))
  )
    return false;
  if (!current()) return false;
  await workspace.select(kind, id);
  if (!current()) return false;
  if (fault.active.value || taskViewing.value || sourceMode !== gis.mapMode) return false;
  const object = workspace.read.detail?.object;
  if (!object || object.id !== id || object.kind !== kind) {
    if (focus)
      focusError.value = '地图定位失败：' + (workspace.read.errors.detail ?? '资源对象不可用');
    return false;
  }
  selectedId.value =
    object.kind === 'device' ? object.stationId : object.kind === 'node' ? object.id : '';
  selectedDeviceId.value = object.kind === 'device' ? object.id : '';
  selectedInterferenceId.value = object.kind === 'interference' ? object.id : '';
  selectedLinkId.value = '';
  selectedCandidateLinkId.value = '';
  gis.mapMode = 'resource';
  rightTab.value = kind === 'interference' && selectedInterference.value ? '干扰分析' : '对象详情';
  rightOpen.value = true;
  if (kind === 'interference') {
    if (!interferences.value.some((row) => row.id === id)) query.value = '';
  } else if (focus) revealResource(kind === 'node' ? 'station' : kind, id);
  if (kind === 'device' && focus) deviceDisplay.reveal(id);
  focusError.value = '';
  if (focus)
    mapRef.value?.locateResource(
      object.kind === 'device' ? object.stationCoordinate : object.coordinate,
    );
  return true;
}
function selectReadCluster(cluster: import('../types/resource-read').ResourceMapCluster) {
  if (cluster.expansionZoom !== null) mapRef.value?.expandResource(cluster);
  else {
    workspace.selectCluster(cluster);
    sideTab.value = '资源树';
    leftOpen.value = true;
  }
}
const taskOverlay = computed(() =>
  taskViewing.value && task.input
    ? {
        taskId: task.taskId ?? '',
        nodes: task.nodes,
        demands: (demandsVisible.value ? task.input.demands : []).filter(
          (row) =>
            task.nodes.some((node) => node.id === row.sourceId) &&
            task.nodes.some((node) => node.id === row.targetId),
        ),
        selectedDemandId: selectedDemand.value,
      }
    : null,
);
watch([nodes, interferenceVisible], () => {
  if (!editing.value) {
    workspace.read.showNodes = nodes.value;
    workspace.read.showInterferences = interferenceVisible.value;
    void workspace.read.loadMap();
  }
});
// 同一深链只主动定位一次；保存后的版本刷新保留用户当前筛选和显示偏好。
watch(
  () => [
    workspace.ready.value,
    workspace.read.workspace?.revision,
    workspace.directory.value?.revision,
    workspace.read.pending['gis:directory'],
    route.query.stationId,
    route.query.deviceId,
    route.query.interferenceId,
    route.query.taskId,
  ],
  async (_value, _previous, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    // 目录首次到达会更新身份校验上下文；等读取结束再定位，避免取消初始深链。
    if (
      analysisRoutePresent.value ||
      editing.value ||
      !workspace.ready.value ||
      workspace.read.pending['gis:directory']
    )
      return;
    if (fault.active.value || diagnosis.target.value.present) return;
    const { stationId, deviceId, interferenceId } = route.query;
    if ([stationId, deviceId, interferenceId].every((value) => value === undefined)) {
      locatedResourceRoute = '';
      return;
    }
    const routeKey = JSON.stringify([
      stationId,
      deviceId,
      interferenceId,
      route.query.taskId,
      auth.generation,
    ]);
    if (routeKey === locatedResourceRoute) return;
    if (interferenceId !== undefined && (stationId !== undefined || deviceId !== undefined)) {
      focusError.value = '地图定位参数无效';
      return;
    }
    if (
      [stationId, deviceId, interferenceId].some(
        (value) =>
          value !== undefined && (typeof value !== 'string' || !value || value.length > 120),
      ) ||
      (interferenceId !== undefined && (stationId !== undefined || deviceId !== undefined)) ||
      (deviceId !== undefined && stationId === undefined)
    ) {
      focusError.value = '地图定位失败：参数无效';
      return;
    }
    if (interferenceId) {
      if (await selectReadObject('interference', String(interferenceId)))
        locatedResourceRoute = routeKey;
    } else if (deviceId) {
      await workspace.select('device', String(deviceId));
      if (!current) return;
      const object = workspace.read.detail?.object;
      if (object?.kind !== 'device' || object.stationId !== stationId) {
        workspace.read.notice = '设备与定位节点不匹配';
        focusError.value = '地图定位失败：' + workspace.read.notice;
        workspace.read.closeDetail();
        return;
      }
      await nextTick();
      locatedResourceRoute = routeKey;
      selectedId.value = object.stationId;
      selectedDeviceId.value = object.id;
      revealResource('device', object.id);
      deviceDisplay.reveal(object.id);
      rightTab.value = '对象详情';
      rightOpen.value = true;
      mapRef.value?.locateResource(object.stationCoordinate);
    } else if (stationId && (await selectReadObject('node', String(stationId))))
      locatedResourceRoute = routeKey;
  },
  { immediate: true },
);
// 精确方案入口等资源就绪后再执行原配置及资源草稿决定，不提交分析。
let analysisRouteAlive = true;
const analysisOrigin = ref<{ taskId: string; planId: string; owner: number; path: string } | null>(
  null,
);
let analysisReturnNavigation: { path: string; current: () => boolean } | null = null;
const analysisReturn = computed(() => {
  const origin = analysisOrigin.value;
  return origin &&
    analysisRouteAlive &&
    !auth.blocked &&
    auth.can('planning.view') &&
    auth.generation === origin.owner &&
    route.fullPath === origin.path
    ? {
        open: async () => {
          const current = () =>
            analysisOrigin.value === origin &&
            analysisRouteAlive &&
            auth.generation === origin.owner &&
            !auth.blocked &&
            auth.can('planning.view') &&
            route.fullPath === origin.path;
          if (!current()) return;
          const navigation = {
            path: router.resolve({
              path: '/planning',
              query: { taskId: origin.taskId, planId: origin.planId },
            }).fullPath,
            current,
          };
          analysisReturnNavigation = navigation;
          try {
            await router.push(navigation.path);
          } finally {
            if (analysisReturnNavigation === navigation) analysisReturnNavigation = null;
          }
        },
      }
    : null;
});
// 配置和资源离页决定之后仍须属于原入口，不能让换号前的返回继续导航。
onBeforeRouteLeave(
  (to) => analysisReturnNavigation?.path !== to.fullPath || analysisReturnNavigation.current(),
);
watch(
  () => [workspace.ready.value, route.fullPath, auth.generation, canInterferenceRead.value, auth.blocked],
  async (_value, _previous, onCleanup) => {
    let current = true;
    onCleanup(() => {
      current = false;
    });
    analysisOrigin.value = null;
    if (!analysisRoutePresent.value) return;
    const path = route.fullPath,
      owner = auth.generation;
    const valid = () =>
      current &&
      analysisRouteAlive &&
      route.fullPath === path &&
      owner === auth.generation &&
      !auth.blocked &&
      canInterferenceRead.value;
    if (!safeReturnPath(path)) {
      focusError.value = '干扰分析入口参数无效，当前现场已保留';
      return;
    }
    if (!canInterferenceRead.value || auth.blocked) {
      focusError.value = '当前角色没有干扰分析查看权限';
      return;
    }
    if (!workspace.ready.value) return;
    const taskId = String(route.query.analysisTaskId),
      planId = String(route.query.analysisPlanId);
    const accepted = await configurationAction(async () => {
      if (!valid() || !(await gis.prepareAnalysis()) || !valid()) return false;
      if (!valid()) return false;
      sideTab.value = '资源树';
      taskPreview.value = false;
      analysisNode.value = '';
      analysisLink.value = '';
      analysisSource.value = '';
      if (!(await openInterferenceAnalysis()) || !valid()) return false;
      await nextTick();
      if (!valid() || !await frozenPanel.value?.openIdentity({ taskId, planId }) || !valid()) return false;
      analysisOrigin.value = { taskId, planId, owner, path };
      focusError.value = '';
      return true;
    });
    if (!accepted && valid())
      focusError.value = '尚未进入目标方案的干扰分析，当前现场已保留';
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  analysisRouteAlive = false;
});
// 冻结诊断网络只使用自己的地形身份；普通资源视图才读取当前资源 DEM。
const terrainNetwork = computed(() => fault.active.value ? fault.network.value
  : diagnosisMode.value ? diagnosis.display.value?.record.network : null);
const { basemap: terrainBasemap, message: terrainMessage } = useTerrainBasemap(
  () => fault.active.value || diagnosisMode.value || snapshotMode.value ? terrainNetwork.value?.terrain
    : monitorMode.value ? null : workspace.read.workspace?.terrain,
  { enabled: () => !!workspace.read.workspace || !!terrainNetwork.value,
    unavailableReason: () => terrainNetwork.value?.terrainNotice ?? '该视图未提供可核验的 DEM 版本，未显示地形底图。' },
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

.maintenance-toolbar {
  padding: 0 2px 10px;
  flex-wrap: wrap;
}
.maintenance-toolbar .muted {
  font-size: 11px;
}
/* GIS 的入口靠左放置，菜单向右展开以免超出内容边界。 */
.resource-more-panel {
  left: 0;
  right: auto;
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
  /* 中间分配以当前窗口为准，避免低高度窗口被旧下限撑出整页滚动。 */
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 16px 15px;
}
.situation-toolbar {
  min-height: 62px;
  padding: 8px 0;
  border-bottom: 2px solid transparent;
  transition:
    border-color 0.15s,
    background-color 0.15s;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-shrink: 0;
  padding: 0 2px;
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
/* 模式提示位于页面顶部，编辑与取点同时有边框和文字信号。 */
.mode-indicator {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #9cb5ce;
  font-size: 12px;
}
.is-editing .situation-toolbar {
  border-color: #42bbdf;
  background: #123047;
}
.is-editing .mode-indicator {
  color: #8be2f8;
  font-weight: 600;
}
.is-picking .situation-toolbar {
  border-color: #f0bf67;
  background: #362f21;
}
.is-picking .mode-indicator {
  color: #f0d18c;
}
.save-feedback.succeeded {
  border-left: 3px solid #42cba3;
}
.save-feedback.validation-failed,
.save-feedback.failed {
  border-left: 3px solid #efae73;
  color: #ffd0a6;
}
.coverage-settings > summary {
  padding: 10px 0;
  cursor: pointer;
  font-size: 12px;
  color: #aac5df;
}
/* 标绘复用既有侧栏宽度，长清单只在面板内部滚动。 */
.fault-controls {
  padding: 12px;
  min-height: 0;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
.situation-left > .fault-controls {
  flex: 1;
}
.fault-controls label {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.fault-controls select {
  width: 100%;
}
.fault-object {
  display: block;
  margin: 8px 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.fault-empty {
  height: 100%;
  display: grid;
  place-content: center;
  padding: 24px;
}
.situation-main {
  position: relative;
  display: flex;
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.situation-left {
  flex: 0 0 320px;
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
  min-height: 0;
}
.panel-restore {
  position: absolute;
  z-index: 4;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 30px;
  min-height: 84px;
  padding: 8px 4px;
  background: #132b41f2;
  border-color: #3d6382;
  box-shadow: 0 2px 8px #07111b66;
}
.panel-restore span {
  writing-mode: vertical-rl;
  letter-spacing: 2px;
}
.panel-restore:focus-visible {
  outline: 2px solid #6bbfee;
  outline-offset: -3px;
}
/* 借用页面侧边距，避免把手压住地图内的图例和比例尺。 */
.resource-restore {
  left: -15px;
  border-radius: 0 6px 6px 0;
}
.detail-restore {
  right: -15px;
  border-radius: 6px 0 0 6px;
}
.panel-restore.narrow-only {
  display: none;
}
.situation-right {
  flex: 0 0 380px;
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
  padding: 12px;
  /* 多设备控制留在资源面板内滚动，不挤占地图或遮住后续选项。 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.layer-settings p {
  font-size: 11px;
  margin-bottom: 8px;
  line-height: 1.5;
}
/* 只压缩图层页签的留白，保持控件和说明直接可见。 */
.layer-settings label {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.layer-settings > .notice {
  padding: 8px;
}
.layer-settings > .section-gap {
  margin-top: 10px;
}
.layer-settings input[type='checkbox'] {
  flex-shrink: 0;
  accent-color: #45a7f8;
}
.layer-settings input[type='range'] {
  width: 100%;
  height: 18px;
  margin: 0;
  padding: 0;
  accent-color: #45a7f8;
}
@media (max-width: 1450px) {
  .situation-left {
    flex-basis: 300px;
  }
  .situation-right {
    flex-basis: 340px;
  }
}
/* 详情打开时临时让出左栏位置；宽度恢复后仍保留原资源面板状态。 */
@media (max-width: 1280px) {
  .details-open .situation-left {
    display: none !important;
  }
  .panel-restore.narrow-only {
    display: inline-flex;
  }
}
</style>
