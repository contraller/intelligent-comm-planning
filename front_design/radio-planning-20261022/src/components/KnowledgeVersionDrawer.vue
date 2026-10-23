<template>
  <AppDrawer
    :visible="!!version"
    :title="'知识版本 v' + version?.number"
    subtitle="历史快照固定显示；回滚会生成新版本，旧记录保留。"
    @update:visible="!$event && store.closeVersion()"
    ><template v-if="version"
      ><dl class="kv"
        ><dt>版本 ID</dt><dd>{{ version.id }}</dd
        ><dt>状态</dt><dd>{{ version.id === store.current?.id ? '当前已发布' : '历史已发布' }}</dd
        ><dt>类型</dt
        ><dd>{{
          version.kind === 'ROLLBACK'
            ? '回滚发布'
            : version.kind === 'BASELINE'
              ? '初始基线'
              : '审核发布'
        }}</dd
        ><dt>父版本</dt><dd>{{ version.parentId ?? '无' }}</dd
        ><dt>恢复来源</dt><dd>{{ version.restoredFromVersionId ?? '不适用' }}</dd
        ><dt>发布人</dt><dd>{{ store.actorName(version.actorId, 'version:' + version.id) }}</dd
        ><dt>发布时间</dt><dd>{{ version.time }}</dd
        ><dt>摘要</dt><dd>{{ version.summary }}</dd
        ><dt>关联变更单</dt><dd>{{ version.changeId ?? '无' }}</dd></dl
      ><p class="notice section-gap"
        >{{ version.entities.length }} 个实体 · {{ version.relations.length }} 条关系；相对父版
        {{ differences.length }} 项差异。</p
      ><details
        v-if="version.changeId"
        class="item"
        ><summary>审核来源</summary
        ><p
          v-for="s in store.historyChange?.submissions"
          :key="s.number"
          >第 {{ s.number }} 次 / 修订 {{ s.revision }} ·
          {{
            s.outcome === 'APPROVED'
              ? '审核通过'
              : s.outcome === 'REJECTED'
                ? '驳回'
                : s.outcome === 'WITHDRAWN'
                  ? '撤回'
                  : '待审核'
          }}<br />提交：{{
            store.actorName(s.actorId, 'submit:' + version.changeId + ':' + s.number)
          }}
          / {{ s.time }}<br />审核：{{
            s.review
              ? store.actorName(s.review.actorId, 'review:' + version.changeId + ':' + s.number)
              : '未审核'
          }}
          / {{ s.review?.opinion || '无附加意见' }}</p
        ></details
      ><details class="item"
        ><summary>查看变更前后</summary
        ><div
          v-for="d in differences"
          :key="d.id"
          class="difference"
          ><strong>{{ d.action }} · {{ d.id }}</strong
          ><p>变更前</p><pre>{{ describe(d.before) }}</pre
          ><p>变更后</p><pre>{{ describe(d.after) }}</pre>
        </div></details
      ><details class="item"
        ><summary>完整实体快照</summary
        ><details
          v-for="e in version.entities"
          :key="e.id"
          class="item"
          ><summary>{{ e.name }} · {{ e.id }}</summary
          ><pre>{{ describe(e) }}</pre
          ><KnowledgePrincipleFlow
            :entity="e"
            :context="
              '历史快照 · ' + version.id
            " /><!-- 规则说明只读当前历史版本。 --><KnowledgeNetworkRulePanel
            :entity="e"
            :context="'历史快照 · ' + version.id" /></details></details
      ><details class="item"
        ><summary>完整关系快照</summary
        ><!-- 保留预格式文本边界，避免格式器额外输出尖括号。 -->
        <!-- prettier-ignore -->
        <pre
          v-for="r in version.relations"
          :key="r.id"
          class="item">{{ r.id }}<br />{{ describe(r) }}</pre></details
      ><label
        v-if="
          auth.can('knowledge.rollback') && version.id === store.current?.id && version.parentId
        "
        class="section-gap"
        >回滚原因<textarea
          v-model="store.rollbackReason"
          :disabled="store.locked"
          maxlength="500"
          rows="3"
          placeholder="说明恢复上一完整发布版的原因"
        /></label
      ><p
        v-if="store.error"
        class="error"
        role="alert"
        >{{ store.error }}</p
      ></template
    ><template #footer
      ><button
        v-if="
          version &&
          auth.can('knowledge.rollback') &&
          version.id === store.current?.id &&
          version.parentId
        "
        class="btn"
        :disabled="store.locked || !store.rollbackReason.trim()"
        @click="rollback"
        >恢复上一版并生成新版本</button
      ><p
        v-else
        class="readonly-note"
        >仅有回滚权限的账号可恢复当前发布版的上一版本。</p
      ></template
    ></AppDrawer
  >
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed } from 'vue';
import { useKnowledgeStore } from '../stores/knowledge';
import { knowledgeDiff } from '../services/knowledge-validation';
import type { KnowledgeEntity, KnowledgeRelation } from '../types/knowledge';
import AppDrawer from './AppDrawer.vue';
import KnowledgePrincipleFlow from './KnowledgePrincipleFlow.vue';
import { describeKnowledgePrinciple } from '../services/knowledge-principle';
import KnowledgeNetworkRulePanel from './KnowledgeNetworkRulePanel.vue';
import { describeNetworkRule } from '../services/knowledge-network-rule';
const store = useKnowledgeStore();
const version = computed(() => store.historyVersion);
const parent = computed(
  () =>
    store.historyParent ??
    store.workspace?.versions.find(
      (v): v is import('../types/knowledge').KnowledgeVersion =>
        v.id === version.value?.parentId && 'entities' in v,
    ),
);
const differences = computed(() =>
  version.value
    ? knowledgeDiff(parent.value ?? { entities: [], relations: [] }, version.value)
    : [],
);
// 审核来源按提交／审核事件读取历史身份，后续改名不改写历史显示。
// 回滚原因由 store 管理，抽屉关闭和路由离开共用未保存保护。
function describe(row: KnowledgeEntity | KnowledgeRelation | null) {
  if (!row) return '无';
  return 'name' in row
    ? [
        row.name,
        row.category + ' / ' + row.type,
        row.description,
        describeKnowledgePrinciple(row),
        describeNetworkRule(row),
        '来源：' + row.source,
        '关键词：' + row.keywords.join('、'),
        '型号：' + row.modelIds.join('、'),
        ...row.attributes.map((a) => a.name + '：' + a.value + (a.unit ? ' ' + a.unit : '')),
      ].join('\n')
    : `${row.head} → ${row.type} → ${row.tail}\n权重：${row.weight ?? '未提供'}\n来源：${row.source}`;
}
async function rollback() {
  if (await store.rollback(store.rollbackReason))
    await store.showVersion({ id: store.workspace!.currentVersionId });
}
</script>
<style scoped>
.item {
  padding: 12px;
  margin-top: 12px;
  background: #101e31;
  border: 1px solid #283b54;
  border-radius: 5px;
}
.item summary {
  cursor: pointer;
  color: #c1daec;
}
.item p {
  margin: 10px 0;
  overflow-wrap: anywhere;
  line-height: 1.7;
  font-size: 12px;
}
pre {
  font: 12px/1.7 inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: 9px;
}
.difference {
  margin-top: 12px;
  border-top: 1px solid #30435b;
  padding-top: 12px;
}
.error {
  color: #ffafaf;
  margin-top: 12px;
}
</style>
