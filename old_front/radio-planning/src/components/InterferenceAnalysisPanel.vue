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
          >历史 {{ store.views.length }}</button
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
        >教学场景<select
          v-model="store.scenarioId"
          :disabled="store.locked || store.running"
          ><option
            v-for="item in store.scenarios"
            :key="item.id"
            :value="item.id"
            >{{ item.label }}</option
          ></select
        ></label
      >
      <p class="muted">{{ scenario?.instruction }}</p>
      <fieldset :disabled="store.locked || store.running"
        ><legend>选择已保存干扰源</legend>
        <label
          v-for="item in store.sources.sources"
          :key="item.id"
          class="source-choice"
          ><input
            v-model="store.interferenceIds"
            type="checkbox"
            :value="item.id"
            :disabled="!item.active"
          /><span>{{ item.name }} · {{ item.id }}{{ item.active ? '' : '（未生效）' }}</span
          ><button
            class="text-link"
            type="button"
            @click="emit('selectSource', item.id)"
            >定位</button
          ></label
        >
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
import { computed } from 'vue';
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
  editSource: [id: string];
  selectNode: [id: string];
  selectLink: [id: string];
  selectSource: [id: string];
}>();
// 地图上下文由 GIS 统一管理，分析仅请求切换。
const store = useInterferenceStore(),
  gis = useGisWorkspaceStore();
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
  max-height: 170px;
  overflow: auto;
}
.source-choice {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 0;
}
.source-choice span {
  flex: 1;
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
