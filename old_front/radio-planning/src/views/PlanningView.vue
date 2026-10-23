<template>
  <div class="page planning-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">NETWORK PLANNING</p>
        <h1>网络规划</h1>
        <p class="subtitle">任务输入、有限档位结果与方案配置 · 当前浏览器演示工作区</p>
      </div>
      <div class="toolbar">
        <span class="chip cyan">Mock / 预生成结果</span
        ><button
          class="btn"
          :disabled="
            planning.running || planning.busy || !planning.workspace || !!planning.loadError
          "
          v-if="
            auth.can('planning.execute') && !(planning.step === 1 && planning.draft && preview.data)
          "
          @click="planning.newTask"
        >
          新建任务</button
        ><button
          class="btn"
          :disabled="planning.busy || planning.loading"
          v-if="auth.can('planning.reset')"
          @click="planning.reset"
        >
          重置规划演示数据
        </button>
      </div>
    </div>
    <div
      v-if="planning.loadError"
      class="notice warn section-gap"
      role="alert"
    >
      <p>{{ planning.loadError }}</p>
      <div class="toolbar section-gap">
        <button
          class="btn"
          @click="planning.reload"
          >重试加载</button
        ><button
          class="btn"
          @click="planning.selectPlan('PLAN-V1')"
          >查看内置只读方案</button
        >
      </div>
    </div>
    <p
      v-if="planning.loading"
      class="notice"
      >正在加载规划工作区…</p
    >
    <div
      v-if="planning.error"
      class="notice warn section-gap"
      role="alert"
    >
      {{ planning.error
      }}<button
        class="text-link"
        :disabled="planning.busy"
        @click="planning.reload"
      >
        重新加载工作区
      </button>
    </div>
    <p
      v-if="planning.notice"
      class="notice section-gap"
      role="status"
      >{{ planning.notice }}</p
    >
    <p
      v-if="planning.savePending"
      class="notice warn"
      >方案保存结果待核实。<button
        class="btn small"
        :disabled="planning.busy"
        @click="planning.reconcileSave"
        >核实原保存请求</button
      ></p
    >
    <p class="notice section-gap"
      >新增资源可登记与选择；无在架设备的节点不可提交，新增设备集合须匹配已有预设。任意新增资源不会自动产生规划结果。</p
    >
    <p
      v-if="interferenceChanged && stale"
      class="notice warn section-gap"
      >干扰配置已变化，当前集合尚未匹配初始预设；旧结果按历史参考保留，暂无新的预生成规划结果。</p
    >
    <p
      v-if="referencedDown.length"
      class="notice warn section-gap"
      >当前引用设备已下架：{{
        referencedDown.join('、')
      }}。历史快照保留，新规划请调整输入或恢复设备。</p
    >
    <div class="stepper section-gap">
      <button
        v-for="(label, index) in ['任务与约束', '规划结果', '方案调整与对比']"
        :key="label"
        :class="{ active: planning.step === index + 1, done: planning.step > index + 1 }"
        @click="planning.step = index + 1"
      >
        <span>{{ index + 1 }}</span
        ><strong>{{ label }}</strong
        ><small>{{ ['节点与通联需求', '阶段进度与完整结果', '有限调整与保存版本'][index] }}</small>
      </button>
      <div class="stepper-note"><i class="pi pi-database" />{{ taskStatusText }}</div>
    </div>
    <div class="record-toolbar">
      <label
        >已提交任务<select
          :value="planning.jobId"
          :disabled="planning.busy || planning.running || !!planning.loadError"
          @change="planning.switchJob(($event.target as HTMLSelectElement).value)"
        >
          <option value="">新任务 / 尚未提交</option>
          <option
            v-for="job in planning.workspace?.jobs ?? []"
            :key="job.id"
            :value="job.id"
          >
            {{ job.input.name }} · {{ job.input.presetId }} ·
            {{ new Date(job.startedAt).toLocaleTimeString() }}
          </option>
        </select></label
      >
      <label
        >保存及历史版本<select
          :value="planning.selectedPlanId"
          :disabled="planning.busy"
          @change="planning.selectPlan(($event.target as HTMLSelectElement).value)"
        >
          <option value="">当前任务结果</option>
          <option
            v-for="plan in plans"
            :key="plan.id"
            :value="plan.id"
          >
            {{ plan.name }} · {{ plan.version }}{{ plan.sourceChanged ? ' · 历史参考' : '' }}
          </option>
        </select></label
      >
      <button
        class="btn"
        :disabled="planning.busy || planning.loading"
        @click="planning.reload"
      >
        重新加载
      </button>
    </div>
    <PlanningSolutionsPanel
      v-if="planning.step !== 1 && planning.view?.solutions"
      :solutions="planning.view.solutions"
      :selected="planning.selectedPlan ? '' : planning.selectedSolutionId"
      :requested="planning.view.job.input.deploymentSolve?.solutionCount"
      :owner="resultOwner"
      :disabled="solutionSelectionDisabled"
      @select="planning.selectSolution"
    />
    <PlanningOptionsSummary
      v-if="planning.step !== 1"
      :input="snapshotInput"
    />
    <!-- 第一步由任务表单提供新建入口，其他步骤仍可从顶栏新建。 -->
    <div
      v-if="planning.step === 1 && planning.draft && preview.data"
      class="planning-input"
    >
      <TaskWorkspacePanel
        context="planning"
        :resources="preview.data.resources"
        :selected-demand-id="selectedDemand"
      />
      <section class="panel input-map">
        <MapCanvas
          :deployment-constraints="deploymentFrame"
          :stations="inputStations"
          :demands="planning.draft.demands"
          :selected-demand-id="selectedDemand"
          @select-demand="selectedDemand = $event"
          :selected-id="focused"
          @select="focused = $event"
        />
        <div class="input-map-note">
          紫色虚线为任务需求；节点来自已保存资源。<br />尚未提交的 GIS 草稿不参与本次输入。
        </div>
      </section>
    </div>
    <template v-else-if="planning.step === 2">
      <DeploymentConstraintsSummary
        :value="snapshotInput?.deploymentConstraints"
        label="当前结果的冻结部署筛选条件"
      />
      <PlanningProgressPanel
        v-if="!planning.selectedPlan"
        :view="planning.view"
        :selected-outcome="planning.currentOutcome"
        :solution-label="planning.currentSolution?.label"
        :selected-expired="planning.currentExpired"
        :query-error="planning.queryError"
        :busy="planning.busy || !!planning.loadError"
        @cancel="planning.cancelJob"
        @retry="planning.startPolling"
        @resubmit="planning.submit"
      />
      <template v-if="result">
        <div class="plan-selector section-gap">
          <div>
            <h3>{{ planning.selectedPlan?.name ?? planning.view?.job.input.name }}</h3>
            <small class="muted">{{ resultStatusText }}</small>
          </div>
          <div class="toolbar">
            <span
              v-if="planning.selectedPlan?.workflow?.interferenceOrigin"
              class="chip"
              >{{ planOriginLabel(planning.selectedPlan) }}</span
            >
            <button
              v-if="planning.selectedPlan"
              class="btn"
              @click="exportDrawer = true"
              >导出方案</button
            >
            <button
              v-if="planning.selectedPlan && planning.view?.solutions?.length"
              class="btn"
              :disabled="planning.busy || !!planning.savePending"
              @click="
                planning.selectSolution(
                  planning.selectedSolutionId || planning.view.defaultSolutionId!,
                )
              "
              >返回本次备选方案</button
            >
            <button
              v-if="canSave"
              class="btn primary"
              @click="openSave"
              >保存方案版本</button
            ><button
              v-if="planning.savedCurrent && !planning.selectedPlan"
              class="btn"
              @click="planning.selectPlan(planning.savedCurrent.id)"
            >
              查看已保存版本</button
            ><button
              v-if="planning.selectedPlan?.workflow"
              class="btn"
              :disabled="!canConfirm"
              title="仅校验通过且源未变化的待确认版本可确认；参考方案禁止确认"
              @click="planning.confirm(planning.selectedPlan)"
            >
              确认配置</button
            ><button
              v-if="configuration"
              class="btn"
              @click="configurationDrawer = true"
            >
              查看配置快照
            </button>
          </div>
        </div>
        <div
          v-if="stale"
          class="notice warn section-gap"
        >
          源数据已变更，配置待更新。当前结果保留为历史快照，重新规划后才能确认新版本。
        </div>
        <p
          v-else-if="effective"
          class="notice section-gap"
        >
          此版本是本任务当前有效的已确认配置 ·
          {{ planning.selectedPlan?.workflow?.confirmation?.confirmedAt }}
        </p>
        <p
          v-else-if="planning.selectedPlan?.workflow?.confirmation"
          class="notice section-gap"
        >
          此版本曾确认，历史配置保留；当前确认版本以任务指针为准。
        </p>
        <p
          v-if="planning.dirty"
          class="notice warn section-gap"
        >
          存在未提交的调整；下方仍为原任务输入对应的结果。
        </p>
        <div class="planning-result">
          <div class="panel plan-map">
            <MapCanvas
              ref="candidateMap"
              :planning-candidates="candidates.frame.value"
              :deployment-constraints="deploymentFrame"
              @select-planning-candidate="candidates.selectMap"
              :mock-coverage="result.coverage"
              :mock-coverage-display="coverageDisplay"
              :stations="stations"
              :links="result.links"
              :regions="result.regions"
              :show-coverage="tab === '覆盖结果'"
              :selected-id="resultSelection.focus.value.stationId"
              :selected-link-id="resultSelection.focus.value.linkId"
              :highlight-link-ids="resultSelection.focus.value.linkIds"
              :highlight-station-ids="resultSelection.focus.value.stationIds"
              compact
              @select="resultSelection.handlers.value.station"
            />
            <div class="map-plan-label">
              结果快照 <span>{{ result.snapshotId }}</span>
            </div>
          </div>
          <PlanningMetricPanel
            :metrics="result.metrics"
            :checks="checks"
          />
        </div>
        <section class="panel section-gap">
          <div class="tabs">
            <button
              v-for="item in [
                '中继部署',
                '参数配置',
                '覆盖结果',
                '路由结果',
                '通信资源',
                '优化建议',
                '优化权衡',
                '任务快照',
              ]"
              :key="item"
              :class="{ active: tab === item }"
              @click="tab = item"
            >
              {{ item }}
            </button>
          </div>
          <div
            class="result-selection"
            role="status"
          >
            <span>{{
              resultSelection.focus.value.message ||
              '当前显示本页签结果，选择表格行可查看关联对象。'
            }}</span>
            <button
              v-if="resultSelection.selection.value"
              class="btn"
              @click="resultSelection.handlers.value.clear"
              >清除选择</button
            >
          </div>
          <p
            v-if="!details"
            class="panel-body muted"
            >此结果未提供补充明细。</p
          >
          <template v-if="tab === '路由结果'"
            ><p
              v-if="detailCollection(details?.routeQuality)"
              class="panel-body"
              >路由质量：{{ detailCollection(details?.routeQuality) }}</p
            ><AppTable
              v-if="configuration"
              :rows="routeRows"
              :columns="routeColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('route', routeRows)"
              @select="resultSelection.handlers.value.route"
            /><AppTable
              :rows="result.links"
              :columns="linkColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('link', result.links)"
              @select="resultSelection.handlers.value.link"
            /><p class="panel-body">不可达需求：{{ unreachableDemandText(details) }}</p></template
          >
          <template v-else-if="tab === '中继部署'"
            ><PlanningCandidatePanel :view="candidates.view.value" /><h4 class="panel-body"
              >最终部署配置</h4
            ><AppTable
              v-if="configuration"
              :rows="deploymentRows"
              :columns="deploymentColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('deployment', deploymentRows)"
              @select="resultSelection.handlers.value.deployment" /><AppTable
              v-else
              :rows="stations"
              :columns="stationColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('station', stations)"
              @select="resultSelection.handlers.value.stationRow"
          /></template>
          <template v-else-if="tab === '参数配置'"
            ><p
              v-if="detailCollection(details?.deviceParameters)"
              class="panel-body"
              >设备参数补充：{{ detailCollection(details?.deviceParameters) }}</p
            ><AppTable
              v-if="configuration"
              :rows="deviceRows"
              :columns="deviceColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('device', deviceRows)"
              @select="resultSelection.handlers.value.device"
            />
            <div
              v-else
              class="panel-body"
            >
              该历史版本未提供方案设备配置；输入设备参数可在任务快照中查看。
            </div></template
          >
          <template v-else-if="tab === '通信资源'"
            ><AppTable
              v-if="configuration"
              :rows="frequencyRows"
              :columns="frequencyColumns"
              :selected="resultSelection.selectedRow('frequency', frequencyRows)"
              @select="resultSelection.handlers.value.frequency"
            /><AppTable
              v-else
              :rows="result.links"
              :columns="linkColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('link', result.links)"
              @select="resultSelection.handlers.value.link"
            />
            <div class="panel-body"
              ><h4>逐链路频率分配</h4
              ><p>{{ detailCollection(details?.frequencyAssignments) }}</p></div
            >
            <AppTable
              :rows="frequencyDetails.assignments"
              :columns="assignmentColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('assignment', frequencyDetails.assignments)"
              @select="resultSelection.handlers.value.assignment"
            />
            <div class="panel-body"
              ><h4>频率冲突记录</h4><p>{{ detailCollection(details?.frequencyConflicts) }}</p
              ><p>{{ frequencyDetailSummary(details) }}</p></div
            >
            <AppTable
              :rows="frequencyDetails.conflicts"
              :columns="conflictColumns"
              :page-size="5"
            />
          </template>
          <div
            v-else-if="tab === '覆盖结果'"
            class="panel-body"
          >
            <label
              v-if="result.coverage"
              class="coverage-display"
            >
              覆盖显示
              <select
                v-model="coverageDisplay"
                aria-label="覆盖显示"
              >
                <option value="auto">自动</option>
                <option value="raster">场强图</option>
                <option value="contour">覆盖轮廓</option>
              </select>
              <span class="muted"
                >自动：全域显示场强图，放大保留场强并叠加已有边界；手动选择不随缩放改变。</span
              >
            </label>
            <p
              v-if="
                coverageDisplay === 'contour' &&
                result.coverage &&
                !result.coverage.contour?.features.length
              "
              class="notice"
              >此快照未提供覆盖轮廓。</p
            >
            <p
              v-else-if="
                result.coverage &&
                !result.coverage.rasterPng &&
                !result.coverage.contour?.features.length
              "
              class="notice"
              >此快照未提供覆盖数据。</p
            >
            <dl class="kv">
              <dt>覆盖率</dt>
              <dd>{{ result.metrics.coveragePercent }}% · 读取预设结果</dd>
              <dt>区域结果</dt>
              <dd>不规则轮廓及孔洞，盲区与未计算区域分开展示</dd>
              <dt>场强栅格</dt>
              <dd v-if="result.coverage?.rasterPng"
                >Mock 教学场强图 · 强 / 中 / 弱为固定示意值，随当前结果快照保存。</dd
              >
              <dd v-else
                >此快照未提供预生成场强图，{{
                  result.coverage?.contour?.features.length || !result.coverage
                    ? '显示已有覆盖轮廓。'
                    : '也未提供覆盖轮廓。'
                }}</dd
              >
            </dl>
          </div>
          <PlanningOptimizationPanel
            v-else-if="tab === '优化权衡'"
            :value="details?.optimization"
            :owner="resultOwner"
            :disabled="!auth.can('planning.view')"
            @link="locateCritical"
          />
          <div
            v-else-if="tab === '优化建议'"
            class="panel-body"
          >
            <p
              v-for="note in result.notes"
              :key="note"
              class="plan-note"
              >{{ note }}</p
            >
            <p
              v-for="check in checks"
              :key="check.id"
              class="plan-note"
            >
              {{ check.passed === true ? '通过' : check.passed === false ? '未通过' : '未知' }} ·
              {{ check.label }}：{{ check.detail }}
            </p>
            <p
              v-if="!checks.length"
              class="notice"
              >历史版本未提供完整校验结论，不开放确认。</p
            >
            <p
              v-for="suggestion in suggestions"
              :key="suggestion"
            >
              {{ suggestion }}
            </p>
          </div>
          <div
            v-else
            class="panel-body"
          >
            <dl class="kv">
              <dt>任务</dt>
              <dd>
                {{ snapshotInput?.name ?? preview.data?.planning.task.name }} ·
                {{ planning.selectedPlan?.taskId ?? planning.view?.job.taskId }}
              </dd>
              <dt>输入版本</dt>
              <dd>
                {{ snapshotInputVersion ?? '历史快照未提供' }}
              </dd>
              <dt>说明</dt>
              <dd>{{ snapshotInput?.description ?? '原始预生成输入' }}</dd>
              <dt>快照</dt>
              <dd>{{ result.snapshotId }}</dd>
              <dt>预设时延</dt>
              <dd>{{ result.metrics.delayMs }} ms</dd>
              <dt>部署成本</dt>
              <dd>{{ deploymentCostDisplay.value }} {{ deploymentCostDisplay.unit }}</dd>
              <dt>调整来源</dt>
              <dd>{{ planning.selectedPlan?.workflow?.changeSummary ?? '当前提交输入' }}</dd>
            </dl>
            <AppTable
              v-if="snapshotInput"
              :rows="snapshotInput.demands"
              :columns="demandColumns"
            /><AppTable
              :rows="result.inputSnapshot.devices"
              :columns="inputDeviceColumns"
              :page-size="5"
              :selected="resultSelection.selectedRow('input-device', result.inputSnapshot.devices)"
              @select="resultSelection.handlers.value.inputDevice"
            />
          </div>
        </section>
      </template>
      <p
        v-else
        class="empty-inline"
      >
        当前没有可展示的完整规划结果。可在任务输入中选择预设，或查看保存的历史版本。
      </p>
    </template>
    <template v-else-if="planning.step === 3">
      <DeploymentConstraintsSummary
        :value="snapshotInput?.deploymentConstraints"
        label="当前选定版本的部署筛选条件"
      />
      <section class="panel">
        <div class="panel-head">
          <h3>设备参数与主路由调整</h3>
          <button
            v-if="configuration"
            class="btn"
            @click="configurationDrawer = true"
            >查看配置快照</button
          >
          <button
            v-if="auth.can('planning.execute')"
            class="btn primary"
            :disabled="planning.locked || !!planning.adjustmentUnavailable(planning.selectedPlan)"
            @click="planning.selectedPlan && planning.openPlanAdjustment(planning.selectedPlan)"
            >调整设备参数与路由</button
          >
          <button
            class="btn primary"
            :disabled="
              planning.locked ||
              (!planning.selectedPlan?.workflow && !planning.currentResult) ||
              (!!planning.selectedPlan && !planning.selectedPlan.workflow)
            "
            v-if="auth.can('planning.execute')"
            @click="openAdjustment"
          >
            修改整套任务预设
          </button>
        </div>
        <div class="panel-body">
          <p>
            基于已保存的完整方案逐设备调整功率和高度、逐需求调整主路由。提交后预览服务返回结果，保存产生关联父版本的新方案。
          </p>
          <p
            v-if="planning.adjustmentUnavailable(planning.selectedPlan)"
            class="notice"
            >{{ planning.adjustmentUnavailable(planning.selectedPlan) }}</p
          >
          <p
            v-if="planning.selectedPlan?.workflow"
            class="muted section-gap"
          >
            父版本：{{ planning.selectedPlan.id }} · {{ planning.selectedPlan.name }}
          </p>
          <p
            v-else
            class="muted section-gap"
          >
            选择本批保存的版本可记录父版本；内置历史方案仅供查看与对比。
          </p>
        </div>
      </section>
      <template v-if="planning.adjustmentParent">
        <PlanningProgressPanel
          v-if="planning.view?.job.adjustment"
          :view="planning.view"
          :query-error="planning.queryError"
          :busy="planning.busy || !!planning.loadError"
          @cancel="planning.cancelJob"
          @retry="planning.startPolling"
          @resubmit="planning.submitAdjustment"
        />
        <div class="toolbar section-gap"
          ><button
            class="btn"
            :disabled="planning.busy"
            @click="planning.adjustmentOpen = true"
            >查看调整输入</button
          ><button
            v-if="planning.adjustmentPending"
            class="btn"
            :disabled="planning.busy"
            @click="planning.reconcileAdjustment"
            >核实原调整请求</button
          ><button
            v-if="canSave"
            class="btn primary"
            @click="openSave"
            >保存调整结果为新版本</button
          ></div
        >
        <PlanningAdjustmentPreview
          class="section-gap"
          :before="planning.adjustmentParent"
          :after="planning.adjustmentResult"
          :status="planning.adjustmentStatus"
        />
      </template>
      <PlanComparisonPanel
        class="section-gap"
        :plans="plans"
        :comparison="planning.comparison"
        :error="planning.comparisonError"
        :disabled="planning.busy || !!planning.loadError"
        @compare="planning.compare"
        @select="planning.selectPlan"
      />
    </template>
    <p
      v-else
      class="empty-inline"
      >规划输入尚未加载，请重试加载或查看内置历史方案。</p
    >

    <AppDrawer
      v-model:visible="saveDrawer"
      title="保存方案版本"
      subtitle="完整未达标结果保存为参考方案；通过校验且源未变化的版本可继续确认。"
    >
      <div class="drawer-fields">
        <label
          >方案名称<input
            v-model="saveName"
            :readonly="!auth.can('planning.save')"
            maxlength="60" /></label
        ><label
          >备注<textarea
            v-model="saveNote"
            :readonly="!auth.can('planning.save')"
            rows="4"
            maxlength="500"
          />
        </label>
        <p
          v-if="planning.error"
          class="notice warn"
          role="alert"
          >{{ planning.error }}</p
        >
      </div>
      <template #footer
        ><div class="toolbar">
          <button
            class="btn"
            :disabled="planning.busy"
            @click="saveDrawer = false"
            >取消</button
          ><button
            class="btn primary"
            :disabled="!canSave"
            @click="save"
            >保存不可变版本</button
          >
        </div></template
      >
    </AppDrawer>
    <AppDrawer
      v-model:visible="adjustDrawer"
      title="修改整套任务预设"
      subtitle="切换整套任务条件，应用后仍需保存任务并重新规划；具体设备与路径调整请使用独立入口。"
    >
      <div class="drawer-fields">
        <label
          >调整档位<select
            v-model="adjustmentId"
            :disabled="!auth.can('planning.execute')"
          >
            <option
              v-for="p in planning.presets"
              :key="p.id"
              :value="p.id"
              >{{ p.label }}</option
            >
          </select></label
        >
        <p>
          {{ adjustedPreset?.frequency.label }} · {{ adjustedPreset?.frequency.minKhz }}–{{
            adjustedPreset?.frequency.maxKhz
          }}
          kHz
        </p>
        <template v-if="adjustedPreset?.result"
          ><h3>设备参数</h3>
          <p
            v-for="device in adjustedPreset.result.configuration.devices"
            :key="device.deviceId"
            class="config-row"
          >
            {{ device.deviceId }} · {{ device.txPowerDbm }} dBm · {{ device.frequencyKhz }} kHz ·
            {{ device.antennaHeightM }} m
          </p>
          <h3>主备路由</h3>
          <p
            v-for="route in adjustedPreset.result.configuration.routes"
            :key="route.id"
            class="config-row"
          >
            {{ route.backup ? '备' : '主' }} · {{ route.demandId }}<br />{{
              route.nodeIds.join(' → ')
            }}
          </p></template
        >
        <p
          v-else
          class="notice warn"
        >
          {{
            adjustedPreset?.executionError ?? adjustedPreset?.outcome.message
          }}，该档位不提供完整方案结果。
        </p>
      </div>
      <template #footer
        ><div class="toolbar">
          <button
            class="btn"
            @click="adjustDrawer = false"
            >取消</button
          ><button
            class="btn primary"
            :disabled="!auth.can('planning.execute') || planning.locked"
            @click="applyAdjustment"
          >
            应用到输入，继续提交
          </button>
        </div></template
      >
    </AppDrawer>
    <PlanningAdjustmentDrawer
      v-if="adjustmentContext && planning.adjustmentDraft && planning.adjustmentParent"
      :visible="planning.adjustmentOpen"
      :parent="adjustmentContext"
      :parent-label="`${planning.adjustmentParent.name} · ${planning.adjustmentParent.version}`"
      :model-value="planning.adjustmentDraft"
      :examples="planning.adjustmentExamples"
      :disabled="!auth.can('planning.execute') || planning.locked"
      :busy="planning.busy || planning.running || !!planning.adjustmentPending"
      :error="planning.error"
      :issues="planning.issues"
      :status="planning.adjustmentStatus"
      @update:model-value="planning.updateAdjustment"
      :pending="!!planning.adjustmentPending"
      @reconcile="planning.reconcileAdjustment"
      @close="planning.closeAdjustment"
      @submit="planning.submitAdjustment"
    />
    <AppDrawer
      v-model:visible="configurationDrawer"
      title="方案配置快照"
      :subtitle="
        effective
          ? '当前有效的 Mock 确认配置；未执行设备下发。'
          : '保存的配置快照；是否当前有效以方案状态为准。'
      "
    >
      <div
        v-if="configuration"
        class="drawer-fields"
      >
        <p
          v-if="!details"
          class="muted"
          >此结果未提供补充明细。</p
        >
        <p
          v-else
          class="muted"
          >明细版本：{{ details.assetVersion }} · 结构版本 {{ details.schemaVersion }}</p
        >
        <p v-if="planning.selectedPlan?.workflow?.confirmation">
          确认时间：{{ planning.selectedPlan.workflow.confirmation.confirmedAt }}
        </p>
        <h3>部署</h3>
        <p
          v-for="row in configuration.deployment"
          :key="row.stationId"
          class="config-row"
        >
          {{ row.stationId }} · {{ row.role }}<br />{{ row.deviceIds.join(' / ')
          }}<br />规划输出坐标：{{ row.plannedCoordinate?.join(', ') ?? '沿用输入坐标' }}
        </p>
        <h3>设备参数</h3>
        <p v-if="detailCollection(details?.deviceParameters)"
          >设备参数补充：{{ detailCollection(details?.deviceParameters) }}</p
        >
        <p
          v-for="row in deviceRows"
          :key="row.deviceId"
          class="config-row"
        >
          {{ row.deviceId }} · {{ row.frequencyKhz }} kHz<br />{{ row.txPowerDbm }} dBm /
          {{ row.antennaHeightM }} m<br />天线倾角 / °：{{ row.tiltDeg }} · 倾角参与计算：{{
            row.tiltEffective
          }}
        </p>
        <h3>路由</h3>
        <p v-if="detailCollection(details?.routeQuality)"
          >路由质量：{{ detailCollection(details?.routeQuality) }}</p
        >
        <p
          v-for="row in routeRows"
          :key="row.id"
          class="config-row"
        >
          {{ row.backup ? '备份' : '主路由' }} · {{ row.demandId }}<br />{{ row.nodeIds.join(' → ')
          }}<br />跳数：{{ row.hopCount }} · 总距离：{{ row.totalDistanceM }} m · 总时延：{{
            row.totalDelayMs
          }}
          ms<br />瓶颈裕度：{{ row.bottleneckMarginDb }} dB · 可靠性：{{ row.reliability }} ·
          {{ row.isFeasible }} · 瓶颈链路：{{ row.bottleneckLinkId }}
        </p>
        <p>不可达需求：{{ unreachableDemandText(details) }}</p>
        <h3>频率分配</h3>
        <p
          v-for="row in configuration.frequencies"
          :key="row.id"
        >
          {{ row.allocatedKhz.join(' / ') }} kHz
        </p>
        <p>逐链路分配：{{ detailCollection(details?.frequencyAssignments) }}</p>
        <AppTable
          :rows="frequencyDetails.assignments"
          :columns="assignmentColumns"
          :page-size="5"
        />
        <p>频率冲突：{{ detailCollection(details?.frequencyConflicts) }}</p>
        <AppTable
          :rows="frequencyDetails.conflicts"
          :columns="conflictColumns"
          :page-size="5"
        />
        <p>{{ frequencyDetailSummary(details) }}</p>
      </div>
      <template #footer
        ><button
          class="btn"
          @click="configurationDrawer = false"
          >关闭</button
        ></template
      >
    </AppDrawer>
    <PlanExportDrawer
      v-model:visible="exportDrawer"
      :plan="planning.selectedPlan"
    />
    <DecisionDialog
      :request="planning.decision"
      @answer="planning.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
import { computed, ref, toRaw, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { usePreviewStore } from '../stores/preview';
import { usePlanningStore } from '../stores/planning';
import { usePlanningLeaveGuard } from '../composables/usePlanningLeaveGuard';
import { usePlanningResultSelection } from '../composables/usePlanningResultSelection';
import PlanningMetricPanel from '../components/PlanningMetricPanel.vue';
import PlanningCandidatePanel from '../components/PlanningCandidatePanel.vue';
import { usePlanningCandidates } from '../composables/usePlanningCandidates';
import PlanningAdjustmentDrawer from '../components/PlanningAdjustmentDrawer.vue';
import PlanningAdjustmentPreview from '../components/PlanningAdjustmentPreview.vue';
import { configuredStations, planOriginLabel } from '../services/planning-snapshot';
import { checksPass } from '../services/planning-validation';
import type { MockCoverageDisplay } from '../maps/mock-coverage-layers';
import MapCanvas from '../components/MapCanvas.vue';
import DeploymentConstraintsSummary from '../components/DeploymentConstraintsSummary.vue';
import PlanningOptionsSummary from '../components/PlanningOptionsSummary.vue';
import PlanningSolutionsPanel from '../components/PlanningSolutionsPanel.vue';
import PlanningOptimizationPanel from '../components/PlanningOptimizationPanel.vue';
import AppTable from '../components/AppTable.vue';
import AppDrawer from '../components/AppDrawer.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import TaskWorkspacePanel from '../components/TaskWorkspacePanel.vue';
import PlanExportDrawer from '../components/PlanExportDrawer.vue';
import PlanningProgressPanel from '../components/PlanningProgressPanel.vue';
import PlanComparisonPanel from '../components/PlanComparisonPanel.vue';
import {
  deviceDetailCells,
  routeDetailCells,
  deviceDetailColumns,
  routeDetailColumns,
  assignmentColumns,
  conflictColumns,
  frequencyDetailRows,
  frequencyDetailSummary,
  detailCollection,
  unreachableDemandText,
} from '../services/planning-result-details-display';

// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
const preview = usePreviewStore();
const planning = usePlanningStore();
usePlanningLeaveGuard();
// 待核实保存留在当前现场；GIS 的共享草稿快捷跳转也不能跳过这项保护。
onBeforeRouteLeave(() => !planning.savePending && !(planning.busy && planning.currentSolution));
const tab = ref('路由结果');
const focused = ref('');
// 输入地图保留独立选择，结果区由 resultSelection 管理。
const saveDrawer = ref(false);
const adjustDrawer = ref(false);
const configurationDrawer = ref(false);
const exportDrawer = ref(false);
const selectedDemand = ref('');
const saveName = ref('');
const saveNote = ref('');
const adjustmentId = ref('balanced');
const saveInitial = ref('');
const adjustInitial = ref('');
// 保存说明与调整抽屉也参加会话离开保护，不提前丢弃本地输入。
// 此处响应抽屉字段；下方 saveDrafts 监听负责缓存变化与明确放弃时的清理。
watch(
  [saveDrawer, saveName, saveNote, adjustDrawer, adjustmentId],
  () => {
    planning.auxiliaryDirty =
      Object.values(saveDrafts.value).some(
        (row) => JSON.stringify([row.name, row.note]) !== row.initial,
      ) ||
      (saveDrawer.value &&
        JSON.stringify([saveName.value, saveNote.value]) !== saveInitial.value) ||
      (adjustDrawer.value && adjustmentId.value !== adjustInitial.value);
  },
  { flush: 'sync' },
);
const plans = computed(() => preview.data?.planning.plans ?? []);
// 任务状态沿用原优先级，未提交输入优先于运行提示。
const taskStatusText = computed(() =>
  planning.dirty ? '输入未提交' : planning.running ? '任务运行中' : '已提交记录可恢复',
);
// 结果选择沿用现有忙碌、待核实、调整与权限限制。
const solutionSelectionDisabled = computed(
  () =>
    planning.busy ||
    !!planning.savePending ||
    !!planning.adjustmentPending ||
    planning.adjustmentDirty ||
    !auth.can('planning.view'),
);
const adjustmentContext = computed(() => {
  const parent = planning.adjustmentParent;
  return parent?.workflow
    ? {
        id: parent.id,
        snapshotId: parent.snapshotId,
        input: parent.workflow.input,
        configuration: parent.workflow.configuration,
        nodeIds: parent.inputSnapshot.stations.map((row) => row.id),
      }
    : null;
});
const result = computed(() => planning.selectedPlan ?? planning.currentResult);
const resultOwner = computed(() =>
  JSON.stringify([
    auth.generation,
    planning.view?.job.id,
    planning.selectedSolutionId,
    planning.selectedPlanId,
    result.value?.snapshotId,
  ]),
);
const details = computed(() => result.value?.resultDetails);
// 候选定位只使用当前结果坐标，不复用正式节点身份。
const candidateMap = ref<InstanceType<typeof MapCanvas>>();
const candidates = usePlanningCandidates({
  screening: () => details.value?.candidateScreening,
  owner: () =>
    result.value
      ? JSON.stringify([
          planning.selectedPlan?.taskId ?? planning.view?.job.taskId,
          planning.selectedPlan?.id ?? planning.view?.job.id,
          planning.selectedPlan?.version,
          result.value.snapshotId,
        ])
      : '',
  active: () => planning.step === 2 && tab.value === '中继部署',
  readable: () => auth.can('planning.view'),
  generation: () => auth.generation,
  locate: (coordinate) => candidateMap.value?.locateResource(coordinate),
});
const frequencyDetails = computed(() => {
  const rows = frequencyDetailRows(details.value);
  return { ...rows, assignments: resultSelection.bindFrequencyRows(rows.assignments) };
});
// 显示偏好只属于本页面；页签、结果切换与缩放均保留手动选择。
const coverageDisplay = ref<MockCoverageDisplay>('auto');
const configuration = computed(() =>
  planning.selectedPlan
    ? planning.selectedPlan.workflow?.configuration
    : planning.currentResult?.configuration,
);
// 结果身份包含所属任务或方案版本，避免复用对象 ID 时串选。
const resultSelection = usePlanningResultSelection({
  context: () => ({
    key: !result.value
      ? ''
      : JSON.stringify(
          planning.selectedPlan
            ? ['plan', planning.selectedPlan.id, planning.selectedPlan.version]
            : ['job', planning.view?.job.id, planning.selectedSolutionId, result.value.snapshotId],
        ),
    result: result.value,
    configuration: configuration.value,
  }),
  tab: () => tab.value,
  readable: () => auth.can('planning.view'),
  generation: () => auth.generation,
  active: () => planning.step === 2,
});
const checks = computed(() =>
  planning.selectedPlan
    ? (planning.selectedPlan.workflow?.checks ?? [])
    : (planning.currentResult?.checks ?? []),
);
const snapshotInput = computed(() =>
  planning.selectedPlan ? planning.selectedPlan.workflow?.input : planning.view?.job.input,
);
// 各步骤读取自己的输入，历史未提供时不借用当前草稿。
const deploymentFrame = computed(() => ({
  owner: JSON.stringify([
    auth.generation,
    planning.step,
    planning.taskId,
    planning.selectedPlan?.id,
    planning.selectedPlan?.version,
    planning.view?.job.id,
  ]),
  label: planning.step === 1 ? '任务草稿' : '冻结输入',
  constraints: (planning.step === 1 ? planning.draft : snapshotInput.value)?.deploymentConstraints,
}));
// 查看内置历史版本时，不从当前任务补入其他版本的元数据。
const snapshotInputVersion = computed(() =>
  planning.selectedPlan
    ? planning.selectedPlan.workflow?.inputVersion
    : planning.view?.job.inputVersion,
);
// 成本数值按选中版本分支；单位保留原有逐级回退，不合并来源。
const deploymentCostDisplay = computed(() => ({
  value: planning.selectedPlan
    ? (planning.selectedPlan.workflow?.deploymentCost ?? '未提供')
    : (planning.currentResult?.deploymentCost ?? '未提供'),
  unit: planning.selectedPlan?.workflow?.costUnit ?? planning.currentResult?.costUnit ?? '',
}));
const suggestions = computed(() =>
  planning.selectedPlan
    ? (planning.selectedPlan.workflow?.outcome.suggestions ?? [])
    : (planning.currentOutcome?.suggestions ?? []),
);
const planStateLabel = computed(() => {
  const state = planning.selectedPlan?.state ?? '';
  return (
    ({ SAVED: '待确认', REFERENCE: '参考方案', CONFIRMED: '已确认' } as Record<string, string>)[
      state
    ] ?? state
  );
});
// 结果说明随当前任务或所选保存版本切换，沿用原文案与回退值。
const resultStatusText = computed(() =>
  planning.selectedPlan
    ? planning.selectedPlan.version + ' · ' + planStateLabel.value
    : (planning.currentSolution?.label ?? '当前任务完整结果') +
      (planning.savedCurrent ? ' · 已保存' : ' · 尚未保存'),
);
const stations = computed(() =>
  configuredStations(result.value?.inputSnapshot.stations ?? [], configuration.value),
);
const inputStations = computed(
  () =>
    preview.data?.resources.stations.filter((s) => planning.draft?.stationIds.includes(s.id)) ?? [],
);
// 当前资源提示不修改冻结输入和指标；只按明确设备 ID 标记引用。
const downDeviceIds = computed(
  () =>
    new Set(
      preview.data?.resources.devices
        .filter((d) => d.availability === 'OFF_SHELF')
        .map((d) => d.id) ?? [],
    ),
);
const referencedDown = computed(
  () =>
    result.value?.inputSnapshot.devices
      .filter((d) => downDeviceIds.value.has(d.id))
      .map((d) => d.id) ?? [],
);
const interferenceChanged = computed(
  () => (preview.data?.resourceMeta.interferenceVersion ?? 'initial') !== 'initial',
);
const stale = computed(() =>
  planning.selectedPlan ? planning.selectedPlan.sourceChanged : planning.sourceChanged,
);
const effective = computed(
  () =>
    !!planning.selectedPlan &&
    !stale.value &&
    planning.workspace?.currentConfirmedByTask[planning.selectedPlan.taskId] ===
      planning.selectedPlan.id,
);
const canSave = computed(
  () =>
    auth.can('planning.save') &&
    !planning.adjustmentDirty &&
    !planning.adjustmentPending &&
    !planning.savePending &&
    !planning.selectedPlan &&
    !!planning.currentResult &&
    planning.view?.state === 'SUCCESS' &&
    !planning.currentExpired &&
    !planning.savedCurrent &&
    !planning.busy &&
    !planning.loadError &&
    !planning.queryError,
);
const canConfirm = computed(
  () =>
    auth.can('planning.confirm') &&
    planning.selectedPlan?.state === 'SAVED' &&
    !stale.value &&
    checksPass(checks.value) &&
    !planning.busy &&
    !planning.loadError,
);
const adjustedPreset = computed(() => planning.presets.find((p) => p.id === adjustmentId.value));
const deviceRows = computed(
  () =>
    configuration.value?.devices.map((row) => ({
      ...row,
      id: row.deviceId,
      ...deviceDetailCells(details.value, row.deviceId),
    })) ?? [],
);
const deploymentRows = computed(
  () =>
    configuration.value?.deployment.map((row) => ({
      ...row,
      id: row.stationId,
      devices: row.deviceIds.join(' / '),
      position: row.plannedCoordinate?.join(', ') ?? '沿用输入坐标',
    })) ?? [],
);
const routeRows = computed(
  () =>
    configuration.value?.routes.map((row) => ({
      ...row,
      path: row.nodeIds.join(' → '),
      links: row.linkIds.join(' / '),
      usage: row.backup ? '备份' : '主路由',
      ...routeDetailCells(details.value, row.id),
    })) ?? [],
);
const frequencyRows = computed(() =>
  resultSelection.bindFrequencyRows(
    configuration.value?.frequencies.map((row) => ({
      ...row,
      allocated: row.allocatedKhz.join(' / '),
    })) ?? [],
  ),
);
// 页面表格列集中维护，保留各视图的字段、标题和列顺序。
const deploymentColumns = [
  { field: 'stationId', header: '节点' },
  { field: 'devices', header: '部署设备' },
  { field: 'role', header: '作用' },
  { field: 'position', header: '规划输出坐标' },
];
const stationColumns = [
  { field: 'id', header: '节点' },
  { field: 'name', header: '名称' },
  { field: 'status', header: '状态' },
];
const frequencyColumns = [
  { field: 'id', header: '频率资源' },
  { field: 'minKhz', header: '下限 / kHz' },
  { field: 'maxKhz', header: '上限 / kHz' },
  { field: 'allocated', header: '分配 / kHz' },
];
const demandColumns = [
  { field: 'sourceId', header: '起点' },
  { field: 'targetId', header: '终点' },
  { field: 'service', header: '业务' },
  { field: 'requiredRateKbps', header: '速率 / kbps' },
  { field: 'maxDelayMs', header: '时延 / ms' },
  { field: 'minReliability', header: '可靠性 / 0–1' },
];
const inputDeviceColumns = [
  { field: 'id', header: '输入设备' },
  { field: 'stationId', header: '节点' },
  { field: 'txPowerDbm', header: '输入功率 / dBm' },
  { field: 'antennaHeightM', header: '输入天线高度 / m' },
];
const deviceColumns = [
  { field: 'deviceId', header: '设备' },
  { field: 'stationId', header: '节点' },
  { field: 'frequencyKhz', header: '频率 / kHz' },
  { field: 'txPowerDbm', header: '方案功率 / dBm' },
  { field: 'antennaHeightM', header: '天线高度 / m' },
  ...deviceDetailColumns,
];
const routeColumns = [
  { field: 'id', header: '路由' },
  { field: 'demandId', header: '需求' },
  { field: 'path', header: '节点路径' },
  { field: 'links', header: '规划链路' },
  { field: 'usage', header: '主备' },
  ...routeDetailColumns,
];
const linkColumns = [
  { field: 'id', header: '链路' },
  { field: 'a', header: '起点' },
  { field: 'b', header: '终点' },
  { field: 'deviceA', header: '设备 A' },
  { field: 'deviceB', header: '设备 B' },
  { field: 'frequencyKhz', header: '频率 / kHz' },
];
async function removeDemand(id: string) {
  if (planning.locked || !planning.draft) return;
  if (
    (await planning.ask({
      title: '移除通联需求',
      message: '从当前未提交输入中移除此需求？已保存方案不变。',
      saveLabel: '确认移除',
    })) !== 'save'
  )
    return;
  const next = structuredClone(toRaw(planning.draft));
  next.demands = next.demands.filter((row) => row.id !== id);
  planning.updateDraft(next);
}
function openSave() {
  const cached = saveDrafts.value[saveKey.value];
  saveName.value = cached?.name ?? planning.view?.job.input.name ?? '';
  saveNote.value = cached?.note ?? '';
  saveInitial.value = cached?.initial ?? JSON.stringify([saveName.value, saveNote.value]);
  saveDrawer.value = true;
}
async function save() {
  const key = saveKey.value;
  if (await planning.save(saveName.value, saveNote.value)) {
    saveDrawer.value = false;
    delete saveDrafts.value[key];
  }
}
// 每份结果保留自己的未保存说明；关闭抽屉和切换结果不互相覆盖。
// 与前面的抽屉字段监听共同维护 auxiliaryDirty，以下同步监听保持原注册顺序。
const saveDrafts = ref<Record<string, { name: string; note: string; initial: string }>>({});
const saveKey = computed(() => JSON.stringify([planning.jobId, planning.selectedSolutionId]));
watch(
  [saveName, saveNote, saveDrawer],
  () => {
    if (saveDrawer.value)
      saveDrafts.value[saveKey.value] = {
        name: saveName.value,
        note: saveNote.value,
        initial: saveInitial.value,
      };
  },
  { flush: 'sync' },
);
// 任务或登录身份变化时释放全部缓存，避免把输入带入另一会话。
watch(
  () => [planning.jobId, auth.generation],
  () => {
    saveDrawer.value = false;
    saveDrafts.value = {};
  },
  { flush: 'sync' },
);
// 同任务切换结果只关闭抽屉，原结果的名称与说明仍留在缓存中。
watch(
  saveKey,
  () => {
    saveDrawer.value = false;
  },
  { flush: 'sync' },
);
// 缓存中的未保存内容也参加离开保护，包括当前未显示的结果。
watch(
  saveDrafts,
  () => {
    planning.auxiliaryDirty =
      Object.values(saveDrafts.value).some(
        (row) => JSON.stringify([row.name, row.note]) !== row.initial,
      ) ||
      (adjustDrawer.value && adjustmentId.value !== adjustInitial.value);
  },
  { deep: true, flush: 'sync' },
);
// 用户在原离开对话框明确放弃时，同时释放各份名称缓存，不能再次恢复。
watch(
  () => planning.auxiliaryDirty,
  (dirty) => {
    if (
      !dirty &&
      Object.values(saveDrafts.value).some(
        (row) => JSON.stringify([row.name, row.note]) !== row.initial,
      )
    ) {
      saveDrafts.value = {};
      saveDrawer.value = false;
    }
  },
  { flush: 'sync' },
);
function locateCritical(id: string) {
  if (!auth.can('planning.view') || planning.step !== 2) return;
  resultSelection.handlers.value.link({ id });
  const link = result.value?.links.find((row) => row.id === id);
  const station = stations.value.find((row) => row.id === link?.a);
  if (station) candidateMap.value?.locateResource(station.coordinate);
}
function openAdjustment() {
  adjustmentId.value = snapshotInput.value?.presetId ?? planning.draft?.presetId ?? 'balanced';
  adjustInitial.value = adjustmentId.value;
  adjustDrawer.value = true;
}
async function applyAdjustment() {
  if (planning.selectedPlan && !(await planning.adjustPlan(planning.selectedPlan))) return;
  planning.applyPreset(adjustmentId.value);
  planning.step = 1;
  adjustDrawer.value = false;
}
</script>
<style scoped>
.coverage-display {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  font-size: 12px;
}
.record-toolbar {
  display: flex;
  align-items: end;
  gap: 16px;
  margin-bottom: 18px;
}
.record-toolbar label {
  display: grid;
  gap: 7px;
  flex: 1;
  color: #9cb5cf;
  font-size: 12px;
  min-width: 0;
}
.record-toolbar select {
  width: 100%;
}
.input-map {
  height: 610px;
  position: sticky;
  top: 0;
  overflow: hidden;
}
.input-map-note {
  position: absolute;
  left: 20px;
  bottom: 70px;
  padding: 12px;
  background: #0c1b2de8;
  font-size: 12px;
  line-height: 1.8;
  border-left: 2px solid #b798e3;
}
.drawer-fields {
  display: grid;
  gap: 16px;
}
.drawer-fields label {
  display: grid;
  gap: 9px;
  color: #a0b9d2;
  font-size: 12px;
}
.drawer-fields input,
.drawer-fields select,
.drawer-fields textarea {
  width: 100%;
}
.config-row {
  padding: 12px;
  border: 1px solid #2a405a;
  font-size: 12px;
  line-height: 1.9;
  border-radius: 5px;
}
.notice {
  line-height: 1.9;
}
.notice .text-link {
  margin-left: 12px;
}
.kv dd {
  overflow-wrap: anywhere;
}
.stepper {
  display: flex;
  align-items: center;
  background: #0f1c30;
  border: 1px solid var(--line);
  padding: 16px 25px;
  border-radius: 6px;
  margin-bottom: 20px;
  gap: 50px;
}
.stepper button {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 5px 12px;
  text-align: left;
  border: 0;
  background: transparent;
  color: #7086a2;
}
.stepper button > span {
  grid-row: span 2;
  display: grid;
  place-items: center;
  border: 1px solid #344862;
  border-radius: 50%;
  width: 31px;
  height: 31px;
}
.stepper button strong {
  font-size: 13px;
}
.stepper button small {
  font-size: 10px;
}
.stepper button.active {
  color: #83c3ff;
}
.stepper button.active > span {
  background: #236eb1;
  border-color: #4dacf6;
  color: white;
}
.stepper button.done > span {
  color: #55c4ba;
  border-color: #317e80;
}
.stepper-note {
  margin-left: auto;
  color: #587492;
  font-size: 11px;
}
.stepper-note .pi {
  margin-right: 7px;
}
.plan-selector {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.plan-selector .muted {
  font-size: 11px;
}
.planning-result {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 268px;
  gap: 17px;
  margin-top: 16px;
}
.plan-map {
  height: 408px;
  position: relative;
}
.result-selection {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  font-size: 12px;
}
.map-plan-label {
  position: absolute;
  left: 20px;
  bottom: 75px;
  font-size: 12px;
  color: #a0bad0;
  padding: 9px 12px;
  background: #0c1c2fe0;
  border-left: 2px solid #488fc0;
}
.map-plan-label span {
  font-size: 10px;
  margin-left: 15px;
  color: #617f9d;
}
.planning-input {
  display: grid;
  grid-template-columns: minmax(360px, 0.85fr) minmax(0, 1.4fr);
  gap: 20px;
}
.constraint {
  display: flex;
  align-items: center;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
  gap: 13px;
  font-size: 12px;
}
.constraint > span {
  color: #508cc3;
}
.constraint .pi {
  margin-left: auto;
  color: #4baa9b;
}
.plan-note {
  padding: 12px;
  color: #9fb9d5;
}
.plan-note .pi {
  color: #5eb6a5;
  margin-right: 10px;
}
.compare-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 20px;
}
.compare-map {
  height: 350px;
}
</style>
