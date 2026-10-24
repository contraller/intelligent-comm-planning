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
        ><dt>摘要</dt><dd>{{ knowledgeText(version.summary) }}</dd
        ><dt>关联变更单</dt><dd>{{ version.changeId ?? '无' }}</dd></dl
      ><p class="notice section-gap"
        >{{ version.entities.length }} 个实体 · {{ version.relations.length }} 条关系；
        <template v-if="opened.differences">相对父版 {{ differences.length }} 项差异。</template>
        <template v-else>相对父版差异未展开。</template></p
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
          / {{ knowledgeText(s.review?.opinion ?? '') || '无附加意见' }}</p
        ></details
      ><details class="item" data-snapshot="differences" :open="opened.differences" @toggle="toggleSection('differences', $event)"
        ><summary>查看变更前后</summary
        ><template v-if="opened.differences">
        <nav class="snapshot-pages" aria-label="差异分页">
          <span>共 {{ differencePage.total }} 项 · 第 {{ differencePage.page }} / {{ differencePage.pages }} 页</span>
          <button type="button" class="btn" aria-label="上一页差异" :disabled="differencePage.page <= 1" @click="pages.differences = differencePage.page - 1"><i class="pi pi-chevron-left" aria-hidden="true" />上一页</button>
          <button type="button" class="btn" aria-label="下一页差异" :disabled="differencePage.page >= differencePage.pages" @click="pages.differences = differencePage.page + 1">下一页<i class="pi pi-chevron-right" aria-hidden="true" /></button>
        </nav>
        <p v-if="!differencePage.total">无差异。</p>
        <div
          v-for="d in differencePage.rows"
          :key="d.id"
          class="difference" :data-difference-id="d.id"
          ><strong>{{ d.action }} · {{ d.id }}</strong
          ><p>变更前</p><pre>{{ describe(d.before) }}</pre
          ><p>变更后</p><pre>{{ describe(d.after) }}</pre>
        </div></template></details
      ><details class="item" data-snapshot="entities" :open="opened.entities" @toggle="toggleSection('entities', $event)"
        ><summary>完整实体快照</summary
        ><template v-if="opened.entities">
        <nav class="snapshot-pages" aria-label="实体快照分页">
          <span>共 {{ entityPage.total }} 个实体 · 第 {{ entityPage.page }} / {{ entityPage.pages }} 页</span>
          <button type="button" class="btn" aria-label="上一页实体" :disabled="entityPage.page <= 1" @click="pages.entities = entityPage.page - 1"><i class="pi pi-chevron-left" aria-hidden="true" />上一页</button>
          <button type="button" class="btn" aria-label="下一页实体" :disabled="entityPage.page >= entityPage.pages" @click="pages.entities = entityPage.page + 1">下一页<i class="pi pi-chevron-right" aria-hidden="true" /></button>
        </nav>
        <p v-if="!entityPage.total">无实体。</p>
        <details
          v-for="e in entityPage.rows"
          :key="e.id"
          class="item" :data-entity-id="e.id"
          ><summary>{{ knowledgeEntityName(e) }} · {{ e.id }}</summary
          ><pre>{{ describe(e) }}</pre
          ><KnowledgePrincipleFlow
            :entity="e"
            :context="
              '历史快照 · ' + version.id
            " /><!-- 规则说明只读当前历史版本。 --><KnowledgeNetworkRulePanel
            :entity="e"
            :context="'历史快照 · ' + version.id" /></details></template></details
      ><details class="item" data-snapshot="relations" :open="opened.relations" @toggle="toggleSection('relations', $event)"
        ><summary>完整关系快照</summary
        ><template v-if="opened.relations">
        <nav class="snapshot-pages" aria-label="关系快照分页">
          <span>共 {{ relationPage.total }} 条关系 · 第 {{ relationPage.page }} / {{ relationPage.pages }} 页</span>
          <button type="button" class="btn" aria-label="上一页关系" :disabled="relationPage.page <= 1" @click="pages.relations = relationPage.page - 1"><i class="pi pi-chevron-left" aria-hidden="true" />上一页</button>
          <button type="button" class="btn" aria-label="下一页关系" :disabled="relationPage.page >= relationPage.pages" @click="pages.relations = relationPage.page + 1">下一页<i class="pi pi-chevron-right" aria-hidden="true" /></button>
        </nav>
        <p v-if="!relationPage.total">无关系。</p>
        <!-- 保留预格式文本边界，避免格式器额外输出尖括号。 -->
        <!-- prettier-ignore -->
        <pre
          v-for="r in relationPage.rows"
          :key="r.id"
          class="item" :data-relation-id="r.id">{{ r.id }}<br />{{ describe(r) }}</pre></template></details
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
        >{{ knowledgeText(store.error) }}</p
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
import { computed, reactive, watch } from 'vue';
import { useKnowledgeStore } from '../stores/knowledge';
import { knowledgeDiff } from '../services/knowledge-validation';
import {
  describeKnowledge as describe,
  knowledgeEntityName,
  knowledgeText,
} from '../services/knowledge-display';
import AppDrawer from './AppDrawer.vue';
import KnowledgePrincipleFlow from './KnowledgePrincipleFlow.vue';
import KnowledgeNetworkRulePanel from './KnowledgeNetworkRulePanel.vue';
const store = useKnowledgeStore();
const version = computed(() => store.historyVersion);
type SnapshotSection = 'entities' | 'relations' | 'differences';
const pageSize = 50;
const opened = reactive({ entities: false, relations: false, differences: false });
const pages = reactive({ entities: 1, relations: 1, differences: 1 });
watch(() => version.value?.id, () => {
  for (const section of ['entities', 'relations', 'differences'] as const) {
    opened[section] = false;
    pages[section] = 1;
  }
}, { flush: 'sync' });
function toggleSection(section: SnapshotSection, event: Event) {
  const target = event.currentTarget as HTMLDetailsElement | null;
  if (target) opened[section] = target.open;
}
// 切片只限制当前DOM，不改写完整历史快照或其服务端顺序。
function paginate<T>(rows: readonly T[], page: number, expanded: boolean) {
  const count = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), count);
  return { total: rows.length, page: current, pages: count,
    rows: expanded ? rows.slice((current - 1) * pageSize, current * pageSize) : [] };
}
const entityPage = computed(() => paginate(version.value?.entities ?? [], pages.entities, opened.entities));
const relationPage = computed(() => paginate(version.value?.relations ?? [], pages.relations, opened.relations));
const parent = computed(
  () =>
    store.historyParent ??
    store.workspace?.versions.find(
      (v): v is import('../types/knowledge').KnowledgeVersion =>
        v.id === version.value?.parentId && 'entities' in v,
    ),
);
const differences = computed(() =>
  opened.differences && version.value
    ? knowledgeDiff(parent.value ?? { entities: [], relations: [] }, version.value)
    : [],
);
const differencePage = computed(() => paginate(differences.value, pages.differences, opened.differences));
// 审核来源按提交／审核事件读取历史身份，后续改名不改写历史显示。
// 回滚原因由 store 管理，抽屉关闭和路由离开共用未保存保护。
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
.snapshot-pages {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.snapshot-pages span {
  flex: 1 1 180px;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.error {
  color: #ffafaf;
  margin-top: 12px;
}
</style>
