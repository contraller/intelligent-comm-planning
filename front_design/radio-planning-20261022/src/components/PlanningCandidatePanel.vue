<template>
  <section
    class="candidate-panel"
    aria-label="候选部署点"
  >
    <h4>候选部署点</h4>
    <p
      v-if="!view.screening"
      class="muted"
      >此结果未提供候选筛选明细。</p
    >
    <template v-else>
      <p>{{ view.screening.sourceLabel }}</p>
      <p class="candidate-counts"
        >服务候选统计：{{ candidateValue(view.screening.candidateCount) }} · 服务可部署统计：{{
          candidateValue(view.screening.deployableCount)
        }}
        · 已返回明细条数：{{ candidateValue(view.screening.candidates?.length) }}</p
      >
      <p class="muted"
        >仅展示本结果已返回的候选明细；完整性未声明。评分按原值显示，候选不等同于正式部署。</p
      >
      <!-- 对象绑定保留当前代次的闭包，旧控件不得转调新结果动作。 -->
      <div class="candidate-tools">
        <label
          >搜索候选<input
            aria-label="搜索候选"
            :value="view.search"
            :disabled="!view.enabled"
            placeholder="编号、角色或拒绝原因"
            v-on="{ input: view.actions.search }"
        /></label>
        <label
          >服务结论<select
            aria-label="候选部署结论"
            :value="view.filter"
            :disabled="!view.enabled"
            v-on="{ change: view.actions.filter }"
            ><option value="all">全部</option
            ><option value="yes">可部署</option
            ><option value="no">不可部署</option
            ><option value="unknown">未提供结论</option></select
          ></label
        >
        <label
          ><input
            type="checkbox"
            :checked="view.visible"
            :disabled="!view.enabled"
            v-on="{ change: view.actions.visible }"
          />显示已返回候选点</label
        >
      </div>
      <p v-if="view.screening.candidates === null">候选明细：未提供</p>
      <p v-else-if="!view.screening.candidates.length">本次未返回候选明细。</p>
      <template v-else>
        <p>当前明细中匹配 {{ view.rows.length }} 条</p>
        <AppTable
          :sortable="false"
          compact
          :rows="view.rows"
          :columns="summaryColumns"
          actions-min-width="88px"
          :selected="view.selected"
          :page-size="5"
          @select="view.actions.select"
        >
          <template #siteId="{ row }"
            ><strong>{{ row.siteId }}</strong
            ><small class="cell-secondary">{{ candidateValue(row.candidateRole) }}</small></template
          >
          <template #isDeployable="{ row }"
            >{{ candidateConclusion(row.isDeployable)
            }}<small class="cell-secondary"
              >推荐 {{ candidateValue(row.recommendationLevel) }}</small
            ></template
          >
          <template #candidateRole="{ row }">{{ candidateValue(row.candidateRole) }}</template>
          <template #recommendationLevel="{ row }">{{
            candidateValue(row.recommendationLevel)
          }}</template>
          <template #score="{ row }">{{ candidateValue(row.score) }}</template>
          <template #actions="{ row }"
            ><button
              class="text-link"
              :disabled="!view.enabled"
              @click="view.actions.select(row)"
              >详情</button
            ><button
              class="text-link"
              :disabled="!view.enabled || !row.coordinate"
              @click="view.actions.locate(row)"
              >定位候选</button
            ></template
          >
        </AppTable>
      </template>
      <p
        v-if="view.notice"
        role="status"
        >{{ view.notice }}</p
      >
      <div
        v-if="view.selected"
        class="candidate-detail"
      >
        <h4
          >候选详情 · {{ view.selected.siteId }}
          <button
            class="text-link"
            :disabled="!view.enabled"
            v-on="{ click: view.actions.clear }"
            >清除候选选择</button
          ></h4
        >
        <p>服务结论：{{ candidateConclusion(view.selected.isDeployable) }}</p>
        <p>经度、纬度：{{ view.selected.coordinate?.join(', ') ?? '未提供坐标，无法定位' }}</p>
        <dl
          ><template
            v-for="[field, label] in candidateDetailFields"
            :key="field"
            ><dt>{{ label }}</dt
            ><dd>{{ candidateValue(view.selected[field]) }}</dd></template
          ></dl
        >
      </div>
      <h4>服务筛除统计</h4>
      <p v-if="view.screening.rejectedStats === null">筛除统计：未提供</p>
      <p v-else-if="!Object.keys(view.screening.rejectedStats).length">服务未列出筛除统计项目。</p>
      <ul v-else
        ><li
          v-for="item in candidateRejections(view.screening)"
          :key="item.id"
          >{{ item.label }}：{{ candidateValue(item.count) }}</li
        ></ul
      >
    </template>
  </section>
</template>
<script setup lang="ts">
import AppTable from './AppTable.vue';
import type { PlanningCandidatesView } from '../types/planning-candidates';
import {
  candidateColumns,
  candidateConclusion,
  candidateDetailFields,
  candidateRejections,
  candidateValue,
} from '../services/planning-candidates-display';
defineProps<{ view: PlanningCandidatesView }>();
// 角色与推荐等级并入摘要单元格，完整筛选依据仍从现有详情入口查看。
const summaryColumns = candidateColumns
  .filter((column) => ['siteId', 'isDeployable', 'score'].includes(column.field))
  .map((column) => ({ ...column, minWidth: column.field === 'siteId' ? '100px' : '76px' }));
</script>
<style scoped>
.candidate-panel {
  padding: 16px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  line-height: 1.7;
  min-width: 0;
}
.cell-secondary {
  display: block;
  color: var(--muted);
  margin-top: 4px;
  font-size: 11px;
}
.candidate-panel h4 {
  margin: 10px 0;
}
.candidate-tools {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.candidate-tools label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.candidate-tools {
  gap: 8px;
}
.candidate-tools label {
  flex: 1 1 130px;
  flex-wrap: wrap;
}
.candidate-tools input:not([type='checkbox']),
.candidate-tools select {
  width: 100%;
  min-width: 0;
}
.candidate-tools label:last-child {
  flex-basis: 100%;
}
.candidate-detail {
  margin-top: 12px;
  padding: 12px;
  background: #142b3d;
}
.candidate-detail dl {
  display: grid;
  grid-template-columns: minmax(130px, 1fr) 2fr;
  gap: 6px;
}
.candidate-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.candidate-panel ul {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  padding-left: 18px;
}
</style>
