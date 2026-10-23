<template>
  <section class="result-panel"
    ><template v-if="current"
      ><div class="result-heading"
        ><small
          >融合结论 ·
          {{ result.fusionMode === 'TWO_WAY_DEGRADED' ? '两路降级' : '三路融合' }}</small
        ><select
          v-if="result.conclusions.length > 1"
          v-model="index"
          aria-label="选择诊断结论"
          ><option
            v-for="(conclusion, i) in result.conclusions"
            :key="i"
            :value="i"
            >{{ conclusion.label }}</option
          ></select
        ><h2>{{ diagnosisLabel(current.faultType) }}</h2
        ><strong class="confidence">{{ confidenceText(current.confidence) }}</strong
        ><progress
          :value="current.confidence"
          max="1"
        /><p>{{ current.rootCause }}</p
        ><p class="muted">{{ result.disabledReason }}</p
        ><p
          v-if="current.needManualReview"
          class="manual"
          >低置信度 · 需要人工研判</p
        ></div
      >
      <div
        class="branch-summary"
        aria-label="三路推理摘要"
        ><div
          v-for="branch in branches"
          :key="branch.source"
          class="branch-row"
        >
          <strong>{{ branch.label }}</strong
          ><span>{{ branch.conclusion }}</span
          ><b>{{ branch.confidence }}</b>
          <small>权重 {{ branch.weight }} · 贡献 {{ branch.contribution }}</small
          ><p v-if="branch.reason">{{ branch.reason }}</p>
        </div></div
      >
      <div class="tabs"
        ><button
          v-for="item in [
            { id: 'evidence', label: '依据' },
            { id: 'root', label: '根因' },
            { id: 'impact', label: '影响' },
            { id: 'suggestions', label: '建议' },
          ]"
          :key="item.id"
          :class="{ active: tab === item.id }"
          @click="tab = item.id"
          >{{ item.label }}</button
        ></div
      >
      <div class="result-body">
        <template v-if="tab === 'evidence'"
          ><details
            v-for="branch in current.branches"
            :key="branch.source"
            open
            ><summary
              >{{ diagnosisLabel(branch.source) }} ·
              {{ confidenceText(branch.confidence) }}</summary
            ><p>{{ branch.conclusion }}</p
            ><p class="muted"
              >权重 {{ reportValue(branch.weight) }} · 贡献
              {{ reportValue(branch.contribution) }}</p
            ><p
              v-if="branch.disabledReason"
              class="muted"
              >{{ branch.disabledReason }}</p
            ><p
              v-for="(evidence, i) in branch.evidence"
              :key="i"
              ><b>{{ evidence.label }}</b
              ><br />{{ evidence.value }}</p
            ></details
          ><h4 v-if="current.candidates.length">候选结论</h4
          ><p
            v-for="candidate in [...current.candidates].sort((a, b) => b.confidence - a.confidence)"
            :key="candidate.faultType"
            >{{ diagnosisLabel(candidate.faultType) }}
            <b>{{ confidenceText(candidate.confidence) }}</b></p
          ></template
        >
        <template v-else-if="tab === 'root'"
          ><DiagnosisRootCausePanel
            :conclusion="current"
            :symptoms="symptoms"
          /><button
            v-if="current.fault"
            class="btn small"
            @click="$emit('locate', current.fault.objectType, current.fault.objectId)"
            >定位故障对象 {{ current.fault.objectId }}</button
          ></template
        >
        <template v-else-if="tab === 'impact'"
          ><p
            v-if="!impactReady"
            class="muted"
            >影响分析尚未完成，暂不展示影响结果。</p
          ><template v-else
            ><p v-if="result.summary"
              >受影响节点 {{ result.summary.affectedNodeCount }} · 链路
              {{ result.summary.affectedLinkCount }}<br />直接 {{ result.summary.directCount }} /
              间接 {{ result.summary.indirectCount }}<br />中断节点
              {{ reportValue(result.summary.interruptedNodeCount) }} / 性能降级节点
              {{ reportValue(result.summary.degradedNodeCount) }}<br />受影响必要通联需求：{{
                result.summary.affectedDemandIds.join('、') || '无'
              }}<br />带宽损失 {{ result.summary.totalBandwidthLossKbps }} kbps</p
            ><p
              v-else
              class="muted"
              >历史资料未提供结构化统计。</p
            ><h4>节点清单</h4
            ><button
              v-for="node in result.nodes"
              :key="node.nodeId"
              class="impact-row"
              @click="$emit('locate', 'NODE', node.nodeId)"
              ><strong>{{ node.nodeId }}</strong
              ><span
                >{{ diagnosisLabel(node.affectType) }} · {{ diagnosisLabel(node.level) }} ·
                {{ diagnosisLabel(node.state) }}</span
              ><small>{{ node.reason }}</small
              ><small v-if="node.detourRoute.length"
                >备份：{{ node.detourRoute.join(' → ') }}</small
              ></button
            ><h4>链路清单</h4
            ><button
              v-for="link in result.links"
              :key="link.linkId"
              class="impact-row"
              @click="$emit('locate', 'LINK', link.linkId)"
              ><strong>{{ link.linkId }}</strong
              ><span>{{ diagnosisLabel(link.level) }} · {{ diagnosisLabel(link.state) }}</span
              ><small>{{
                link.isBackbone === true
                  ? '主干链路'
                  : link.isBackbone === false
                    ? '非主干链路'
                    : '主干属性未提供'
              }}</small
              ><small
                >{{ link.reason }} · {{ reportValue(link.bandwidthLossKbps) }} kbps</small
              ></button
            ><div class="buttons"
              ><button
                class="btn small"
                :disabled="!auth.can('diagnosis.export') || !reportReady || exporting"
                @click="$emit('exportImpact', 'xlsx')"
                >影响清单 XLSX</button
              ><button
                class="btn small"
                :disabled="!auth.can('diagnosis.export') || !reportReady || exporting"
                @click="$emit('exportImpact', 'png')"
                >示意图 PNG</button
              ></div
            ></template
          ></template
        >
        <template v-else
          ><p
            v-if="!reportReady"
            class="muted"
            >建议将在完整诊断流程结束后提供。</p
          ><details
            v-for="(suggestion, suggestionIndex) in reportReady ? suggestions : []"
            :key="suggestionIndex"
            open
            ><summary>{{ suggestion.priority }}. {{ suggestion.action }}</summary
            ><p>{{ suggestion.applicability }}</p
            ><ol
              ><li
                v-for="(step, i) in suggestion.steps"
                :key="i"
                >{{ step }}</li
              ></ol
            ><p
              >备件：{{ suggestion.spares.join('、') || '未提供' }}<br />工具：{{
                suggestion.tools.join('、') || '未提供'
              }}<br />预计 {{ reportValue(suggestion.estimatedTimeMin) }} 分钟</p
            ><p class="muted">图谱依据 {{ suggestion.tripleIds.join('、') || '未提供' }}</p
            ><p
              v-for="item in suggestion.similarCases"
              :key="item.id"
              >{{ item.id }} · {{ confidenceText(item.similarity) }}<br />{{ item.solution
              }}<br />案例修复耗时：{{ caseRepairTimeText(item.repairTimeMin) }}</p
            ></details
          ></template
        > </div
      ><button
        class="btn primary report"
        :disabled="!reportReady"
        @click="$emit('report')"
        >预览与下载完整报告</button
      ></template
    ></section
  >
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, ref, watch } from 'vue';
import type { DiagnosisResult } from '../types/diagnosis';
import {
  confidenceText,
  diagnosisLabel,
  reportValue,
  orderedDiagnosisSuggestions,
  caseRepairTimeText,
} from '../reports/diagnosis-report';
import DiagnosisRootCausePanel from './DiagnosisRootCausePanel.vue';
import { diagnosisBranchSummary, type DiagnosisSymptomLabel } from '../services/diagnosis-display';
const props = withDefaults(
  defineProps<{
    result: DiagnosisResult;
    impactReady: boolean;
    reportReady: boolean;
    exporting: boolean;
    symptoms?: DiagnosisSymptomLabel[];
    contextKey?: string;
  }>(),
  { symptoms: () => [], contextKey: '' },
);
defineEmits<{
  locate: [type: 'NODE' | 'DEVICE' | 'LINK', id: string];
  report: [];
  exportImpact: [format: 'xlsx' | 'png'];
}>();
const index = ref(0),
  tab = ref('evidence');
// 结果或记录切换只复位结论索引，不改变诊断任务与原页签。
watch([() => props.result, () => props.contextKey], () => {
  index.value = 0;
});
// 显示排序使用副本，避免修改冻结报告及持久化顺序。
const suggestions = computed(() => orderedDiagnosisSuggestions(props.result.suggestions));
const current = computed(
  () => props.result.conclusions[index.value] ?? props.result.conclusions[0],
);
const branches = computed(() => (current.value ? diagnosisBranchSummary(current.value) : []));
// 影响统计及主干属性直接展示服务返回值，0、false 与缺失分别处理。
</script>
<style scoped>
.result-panel {
  background: #111f34;
  border: 1px solid #2b425f;
  border-radius: 6px;
  min-width: 0;
  overflow: hidden;
}
.result-heading {
  padding: 18px;
}
.result-heading small {
  color: #86a5c5;
}
h2 {
  font-size: 19px;
  margin: 10px 0;
}
.confidence {
  font:
    34px Bahnschrift,
    sans-serif;
  color: #83d4f2;
}
progress {
  display: block;
  width: 100%;
  height: 6px;
  accent-color: #65c2e6;
  margin: 10px 0;
}
p,
li {
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.muted {
  color: #859eb9;
}
.manual {
  padding: 8px;
  color: #ffda94;
  background: #57422566;
}
.tabs {
  display: flex;
  border-block: 1px solid #2b425f;
}
.tabs button {
  flex: 1;
  padding: 11px;
  background: transparent;
  border: 0;
  color: #94b0cc;
}
.tabs .active {
  color: #99d6ff;
  background: #1a3552;
}
.result-body {
  padding: 16px;
  max-height: 600px;
  overflow: auto;
}
details {
  padding: 12px 0;
  border-bottom: 1px solid #2c425b;
}
summary {
  color: #abd6f5;
  font-size: 12px;
  cursor: pointer;
}
.impact-row {
  display: grid;
  gap: 7px;
  text-align: left;
  width: 100%;
  background: #162a43;
  color: #bcd5ec;
  border: 1px solid #294663;
  padding: 11px;
  margin-bottom: 8px;
  border-radius: 4px;
}
.impact-row span,
.impact-row small {
  font-size: 11px;
}
.buttons {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.report {
  margin: 15px;
  width: calc(100% - 30px);
}
select {
  background: #11253f;
  border: 1px solid #355577;
  color: #cee7fc;
  padding: 6px;
  width: 100%;
  margin-top: 8px;
}
.branch-summary {
  padding: 0 16px 16px;
  display: grid;
  gap: 8px;
}
.branch-row {
  display: grid;
  grid-template-columns: 75px minmax(0, 1fr);
  gap: 5px 8px;
  padding: 10px;
  background: #14283f;
  border: 1px solid #2b425f;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.branch-row strong {
  color: #94cdec;
}
.branch-row span {
  color: #bfd3e6;
  line-height: 1.7;
}
.branch-row b {
  color: #b6d9ed;
  font-weight: normal;
}
.branch-row small {
  color: #95aec5;
  line-height: 1.6;
}
.branch-row p {
  grid-column: 1/-1;
  margin: 0;
  color: #b8a7ca;
  font-size: 11px;
}
</style>
