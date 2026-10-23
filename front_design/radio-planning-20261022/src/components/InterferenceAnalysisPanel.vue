<template>
  <section class="analysis-panel">
    <details
      v-if="source"
      open
    >
      <summary>干扰源详情 · {{ source.name }}</summary>
      <dl class="source-kv"
        ><dt>ID</dt><dd>{{ source.id }}</dd
        ><dt>位置</dt><dd>{{ source.coordinate.join(', ') }}</dd
        ><dt>状态</dt><dd>{{ source.active ? '生效' : '未生效' }}</dd>
        <template
          v-for="field in sourceFields"
          :key="field.key"
          ><dt>{{ field.label }}</dt
          ><dd>{{ source[field.key] ?? '未提供' }}</dd></template
        >
      </dl>
      <button
        v-if="sourceEditable"
        class="btn small"
        @click="emit('editSource', source.id)"
        >编辑参数</button
      >
      <!-- 选择对象不改分析输入，只有明确点击才预选此保存源。 -->
      <button
        v-if="store.executable"
        class="btn small"
        :disabled="
          store.locked ||
          store.running ||
          !source.active ||
          !store.sources.sources.some((item) => item.id === source!.id)
        "
        @click="emit('analyzeSource', source.id)"
        >分析此干扰源</button
      >
      <p
        v-if="!store.sources.sources.some((item) => item.id === source!.id)"
        class="muted"
        >此干扰源需先保存，再作为分析输入。</p
      >
    </details>
    <template v-if="store.readable">
      <div class="toolbar"
        ><h4>干扰分析</h4
        ><button
          class="text-link"
          :disabled="store.locked"
          @click="store.load()"
          >刷新</button
        ><button
          class="text-link"
          @click="store.historyOpen = true"
          >历史 {{ store.historyTotal }}</button
        ></div
      >
      <label
        >已确认网络<select
          v-model="store.planId"
          :disabled="store.locked || store.running"
        >
          <option value="">请选择当前确认网络</option>
          <option
            v-for="entry in store.sources.plans"
            :key="entry.plan.id"
            :value="entry.plan.id"
            :disabled="!entry.eligible"
            >{{ entry.plan.name }} · {{ entry.plan.version
            }}{{ entry.eligible ? '' : '（不可分析）' }}</option
          >
        </select></label
      >
      <p
        v-if="!store.sources.plans.some((row) => row.eligible)"
        class="muted"
        >请先在网络规划中保存并确认方案。</p
      >
      <p
        v-if="eligible?.interferenceOnly"
        class="notice"
        >此网络仅因干扰源修改失效，可用作重新分析基线。</p
      >
      <p
        v-if="eligible && !eligible.eligible"
        role="alert"
        >{{ eligible.reason }}</p
      >
      <label
        >分析场景<select
          v-model="store.scenarioId"
          :disabled="store.locked || store.running"
          ><option
            v-for="item in store.scenarios"
            :key="item.id"
            :value="item.id"
            >{{ scenarioLabel(item.label) }}</option
          ></select
        ></label
      >
      <p class="muted">{{ scenario?.instruction }}</p>
      <!-- 搜索只改变可见清单，不清除已选源；定位独立于复选框标签。 -->
      <fieldset
        :disabled="store.locked || store.running"
        class="source-selector"
      >
        <legend>选择已保存干扰源</legend>
        <input
          v-model="sourceQuery"
          aria-label="搜索已保存干扰源"
          placeholder="搜索名称或编号"
        />
        <p
          class="source-summary"
          role="status"
          >已选 {{ store.interferenceIds.length }} 项 · 共 {{ store.sources.sources.length }} 项</p
        >
        <div class="source-list">
          <div
            v-for="item in filteredSources"
            :key="item.id"
            class="source-choice"
          >
            <label class="source-check">
              <input
                v-model="store.interferenceIds"
                type="checkbox"
                :value="item.id"
                :disabled="!item.active"
                :aria-label="item.name + ' · ' + item.id + (item.active ? '' : '（未生效）')"
              />
              <span class="source-copy"
                ><strong>{{ item.name }}</strong
                ><small>{{ item.id }}<span v-if="!item.active"> · 未生效</span></small></span
              >
            </label>
            <button
              class="text-link"
              type="button"
              :aria-label="'定位干扰源 ' + item.id"
              @click="emit('selectSource', item.id)"
              >定位</button
            >
          </div>
          <p
            v-if="!filteredSources.length"
            class="muted"
            >没有匹配的干扰源</p
          >
        </div>
      </fieldset>
      <button
        class="btn primary"
        :disabled="
          !store.executable ||
          store.locked ||
          store.running ||
          !eligible?.eligible ||
          !store.interferenceIds.length ||
          !!store.sources.error
        "
        @click="store.submit()"
        >开始干扰分析</button
      >
      <p
        v-if="store.sources.error || store.error"
        role="alert"
        >{{ store.sources.error || store.error }}</p
      >
      <p
        v-for="issue in store.issues"
        :key="issue.objectId + issue.field"
        role="alert"
        >{{ issue.objectId }}：{{ issue.message }}</p
      >
      <p
        v-if="store.queryError"
        role="alert"
        >{{ store.queryError }}
        <button
          class="text-link"
          :disabled="store.locked"
          @click="store.query()"
          >重试查询</button
        ></p
      >
      <template v-if="store.selected">
        <h4>分析快照 · {{ store.selected.run.network.version }}</h4>
        <p
          >{{ store.selected.run.network.name }} · {{ store.selected.phase }}
          {{ store.selected.progress }}%</p
        >
        <progress
          :value="store.selected.progress"
          max="100"
        />
        <p class="muted"
          >提交源：{{ store.selected.run.sources.map((row) => row.id).join(' / ') }}</p
        >
        <p
          v-if="store.selected.source.state !== 'CURRENT'"
          class="notice"
          >{{ store.selected.source.reasons.join('；') }}。可查看冻结历史。</p
        >
        <p
          v-if="store.selected.error"
          role="alert"
          >{{ store.selected.error }}</p
        >
        <button
          v-if="['PENDING', 'RUNNING'].includes(store.selected.state)"
          class="btn small"
          :disabled="!store.executable || store.locked"
          @click="store.cancel()"
          >取消当前分析</button
        >
        <template v-if="store.selected.result">
          <!-- 按实际显示状态标记前后，缺少预览时保留完整的措施前影响。 -->
          <div class="toolbar"
            ><button
              class="btn small"
              :class="{ primary: !store.effectiveAfter }"
              @click="
                gis.mapMode = 'analysis';
                store.after = false;
              "
              >措施前</button
            ><button
              class="btn small"
              :class="{ primary: store.effectiveAfter }"
              :disabled="!store.canPreviewAfter"
              @click="
                gis.mapMode = 'analysis';
                store.after = true;
              "
              >措施后预览</button
            ></div
          >
          <p
            v-if="store.measure && store.previewUnavailableReason"
            class="notice"
            >{{ store.previewUnavailableReason }}</p
          >
          <p v-if="store.impact"
            >受影响节点 {{ store.impact.summary.affectedNodeCount }} · 链路
            {{ store.impact.summary.affectedLinkCount }} · 严重链路
            {{ store.impact.summary.severeLinkCount }}</p
          >
          <div class="levels"
            ><label
              v-for="(label, level) in levelNames"
              :key="level"
              ><input
                v-model="store.levels"
                type="checkbox"
                :value="level"
              />{{ label }}</label
            ></div
          >
          <div
            v-if="store.filteredImpact"
            class="impact-list"
          >
            <button
              v-for="row in store.filteredImpact.nodes"
              :key="row.nodeId"
              :class="{ selected: selectedNodeId === row.nodeId }"
              @click="emit('selectNode', row.nodeId)"
              >{{ row.nodeId }} · {{ levelNames[row.level] }} · {{ row.snrBeforeDb }} →
              {{ row.snrAfterDb }} dB</button
            >
            <button
              v-for="row in store.filteredImpact.links"
              :key="row.linkId"
              :class="{ selected: selectedLinkId === row.linkId }"
              @click="emit('selectLink', row.linkId)"
              >{{ row.linkId }} · {{ levelNames[row.level] }} · {{ row.snrBeforeDb }} →
              {{ row.snrAfterDb }} dB</button
            >
          </div>
          <p
            v-if="!store.impact?.nodes.length && !store.impact?.links.length"
            class="notice"
            >此预生成结果中没有受影响对象。</p
          >
          <p v-if="detail"
            >选中对象信噪比：{{ detail.snrBeforeDb }} → {{ detail.snrAfterDb }} dB
            <span v-if="'deltaDb' in detail">（变化 {{ detail.deltaDb }} dB）</span
            ><span v-else>
              · {{ detail.stateBefore }} → {{ detail.stateAfter }} · 来源
              {{ detail.interferenceIds.join(' / ') }}</span
            ></p
          >
          <h4>抗干扰措施</h4>
          <!-- 详情与定位分开，定位只读取本条分析的措施前冻结对象。 -->
          <div
            v-for="row in store.selected.result.measures"
            :key="row.id"
            class="measure"
            :data-measure-id="row.id"
          >
            <button
              class="text-link"
              @click="store.inspectMeasure(row)"
              ><strong>{{ row.priority }} · {{ row.title }}</strong
              ><br /><span>{{ row.unavailableReason ?? row.detail }}</span
              ><br />
              <small>{{
                store.selected.adoptions.some((item) => item.measureId === row.id)
                  ? '已生成方案 · 查看'
                  : row.unavailableReason
                    ? '查看原因'
                    : '查看配置与预评估'
              }}</small>
            </button>
            <template v-if="measureTargets">
              <div
                v-for="target in measureTargets.find((item) => item.measureId === row.id)
                  ?.targets ?? []"
                :key="target.kind"
              >
                <button
                  class="btn small"
                  :disabled="!!target.reason"
                  :onClick="target.locate"
                  >{{ target.label }} · {{ target.id }}</button
                ><small v-if="target.reason">{{ target.reason }}</small>
              </div>
              <small
                v-if="!measureTargets.find((item) => item.measureId === row.id)?.targets.length"
                >未提供定位对象</small
              >
            </template>
          </div>
          <p class="muted">{{ store.selected.result.notes.join('；') }}</p>
        </template>
      </template>
      <p
        v-if="store.notice"
        role="status"
        >{{ store.notice }}</p
      >
      <p
        v-if="targetNotice"
        role="status"
        >{{ targetNotice }}</p
      >
    </template>
    <p
      v-else
      class="muted"
      >干扰分析需要 GIS 态势及网络规划查看权限。</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useInterferenceStore } from '../stores/interference';
import type { InterferenceSource } from '../types/domain';
import type { InterferenceTargetEntry } from '../composables/useInterferenceTargetNavigation';
const props = defineProps<{
  source?: InterferenceSource;
  sourceEditable: boolean;
  selectedNodeId: string;
  selectedLinkId: string;
  measureTargets?: InterferenceTargetEntry[];
  targetNotice?: string;
}>();
const emit = defineEmits<{
  analyzeSource: [id: string];
  editSource: [id: string];
  selectNode: [id: string];
  selectLink: [id: string];
  selectSource: [id: string];
}>();
// 地图上下文由 GIS 统一管理，分析仅请求切换。
const store = useInterferenceStore(),
  gis = useGisWorkspaceStore();
const sourceQuery = ref('');
const filteredSources = computed(() => {
  const query = sourceQuery.value.trim().toLocaleLowerCase();
  return store.sources.sources.filter((row) =>
    `${row.name} ${row.id}`.toLocaleLowerCase().includes(query),
  );
});
// 只调整预设的展示名称，场景标识和服务行为保持原值。
const scenarioLabel = (value: string) =>
  value.replace(/教学分支|教学场景/g, '').replace(/教学|演示/g, '');
const scenario = computed(() => store.scenarios.find((row) => row.id === store.scenarioId));
const eligible = computed(() => store.sources.plans.find((row) => row.plan.id === store.planId));
const levelNames = { SEVERE: '严重', MODERATE: '中等', MINOR: '轻微' };
const detail = computed(
  () =>
    store.impact?.nodes.find((row) => row.nodeId === props.selectedNodeId) ??
    store.impact?.links.find((row) => row.linkId === props.selectedLinkId),
);
const sourceFields: { key: keyof InterferenceSource; label: string }[] = [
  { key: 'elevationM', label: '高程 / m' },
  { key: 'antennaHeightM', label: '天线高度 / m' },
  { key: 'centerFreqKhz', label: '中心频率 / kHz' },
  { key: 'bandwidthKhz', label: '带宽 / kHz' },
  { key: 'txPowerDbm', label: '功率 / dBm' },
  { key: 'antennaGainDbi', label: '天线增益 / dBi' },
  { key: 'interferenceType', label: '干扰类型' },
  { key: 'patternType', label: '方向图' },
  { key: 'azimuthDeg', label: '方位角 / °' },
  { key: 'dutyCycle', label: '占空比' },
];
</script>
<style scoped>
.analysis-panel {
  padding: 14px;
  display: grid;
  gap: 13px;
  font-size: 12px;
}
.analysis-panel p {
  margin: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.analysis-panel h4 {
  margin: 0;
}
.analysis-panel select {
  width: 100%;
  min-width: 0;
}
.analysis-panel fieldset {
  margin: 0;
  padding: 10px;
  border: 1px solid #304661;
  min-width: 0;
}
.source-selector > input {
  width: 100%;
  min-width: 0;
  margin: 5px 0;
}
.source-summary {
  color: var(--muted);
  font-size: 11px;
}
.source-list {
  max-height: 260px;
  overflow-y: auto;
  margin-top: 6px;
}
.source-choice {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.analysis-panel .source-check {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  margin: 0;
  cursor: pointer;
}
.source-check input {
  width: auto;
  margin: 0;
}
.source-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.source-copy strong {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.source-copy small {
  color: var(--muted);
  overflow-wrap: anywhere;
}
.source-kv {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.source-kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.source-kv dt {
  color: #8aa2bb;
}
.levels {
  display: flex;
  gap: 12px;
}
.levels label {
  display: flex;
  gap: 4px;
}
.impact-list {
  display: grid;
  gap: 5px;
}
.impact-list button,
.measure {
  background: #14283e;
  border: 1px solid #304a65;
  text-align: left;
  padding: 9px;
  font-size: 11px;
}
.impact-list button.selected {
  border-color: #69b9ed;
}
.measure {
  display: grid;
  gap: 7px;
}
.measure small {
  color: #6bbbea;
}
progress {
  width: 100%;
  height: 7px;
}
</style>
