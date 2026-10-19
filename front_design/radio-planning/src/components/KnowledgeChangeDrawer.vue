<template>
  <AppDrawer
    :visible="store.drawerOpen"
    :title="store.change ? '知识变更 · ' + store.change.id : '新建知识变更'"
    subtitle="实体与关系作为同一变更单审核；发布前不影响当前图谱。"
    @update:visible="!$event && store.closeDrawer()"
  >
    <template v-if="store.draft">
      <KnowledgeStateBadge
        :state="store.change?.state ?? 'DRAFT'"
        :stale="store.stale"
      />
      <p class="muted section-gap"
        >作者：{{ author }} · 基线：{{ store.draft.baseVersionId }} · 修订：{{
          store.change?.revision ?? '尚未保存'
        }}</p
      >
      <p
        v-if="store.stale"
        class="notice"
        >基线已过期。保留此单供查看，请基于当前版本重新新建并送审。</p
      >
      <p
        v-if="store.error"
        class="error"
        role="alert"
        >{{ store.error }}</p
      >
      <ul
        v-if="store.issues.length"
        class="issues"
        ><li
          v-for="(issue, i) in store.issues"
          :key="i"
          ><button
            class="text-link"
            @click="locate(issue.objectId)"
            >{{ issue.objectId }} · {{ issue.field }}：{{ issue.message }}</button
          ></li
        ></ul
      >
      <label class="section-gap"
        >变更摘要<input
          v-model="store.draft.summary"
          :readonly="locked"
          maxlength="120"
          placeholder="说明本次修改目的"
      /></label>
      <div
        v-if="store.canEdit"
        class="add-tools"
      >
        <button
          class="btn small"
          :disabled="store.locked"
          @click="addEntity"
          >新增实体</button
        ><button
          class="btn small"
          :disabled="store.locked"
          @click="addRelation"
          >新增关系</button
        >
        <select
          v-model="addEntityId"
          aria-label="选择已有实体加入编辑"
          :disabled="store.locked"
          @change="editExisting('entities', addEntityId)"
          ><option value="">修改已有实体…</option
          ><option
            v-for="e in store.base?.entities.filter(
              (e) => !store.draft!.entities.some((x) => x.id === e.id),
            )"
            :key="e.id"
            :value="e.id"
            >{{ e.name }}</option
          ></select
        >
        <select
          v-model="addRelationId"
          aria-label="选择已有关系加入编辑"
          :disabled="store.locked"
          @change="editExisting('relations', addRelationId)"
          ><option value="">修改已有关系…</option
          ><option
            v-for="r in store.base?.relations.filter(
              (r) => !store.draft!.relations.some((x) => x.id === r.id),
            )"
            :key="r.id"
            :value="r.id"
            >{{ r.id }} ·
            {{ store.catalog.relationTypes.find((t) => t.id === r.type)?.name }}</option
          ></select
        >
      </div>
      <details
        v-for="(e, i) in store.draft.entities"
        :id="'knowledge-row-' + e.id"
        :key="e.id"
        class="edit-card"
        open
      >
        <summary>实体 {{ i + 1 }} · {{ e.name || '待填写名称' }}</summary
        ><small>{{ e.id.startsWith('new:') ? '保存时分配实体编号' : e.id }}</small>
        <div class="form-grid section-gap">
          <label class="full"
            >名称<input
              v-model="e.name"
              :readonly="locked"
              maxlength="80"
          /></label>
          <label class="full"
            >类型 / 图谱<select
              :value="e.type"
              :disabled="locked || !e.id.startsWith('new:')"
              @change="changeType(e, ($event.target as HTMLSelectElement).value)"
              ><option
                v-for="t in store.catalog.types"
                :key="t.id"
                :value="t.id"
                >{{ t.category }} · {{ t.name }}</option
              ></select
            ></label
          >
          <label class="full"
            >描述<textarea
              v-model="e.description"
              :readonly="locked"
              maxlength="2000"
              rows="4"
            />
          </label>
          <label class="full"
            >关键词（逗号分隔，最多 10 项）<input
              :value="e.keywords.join(',')"
              :readonly="locked"
              @input="keywords(e, $event)"
          /></label>
          <label class="full"
            >来源说明<input
              v-model="e.source"
              :readonly="locked"
              maxlength="200"
          /></label>
          <label
            v-if="e.category === '设备知识'"
            class="full"
            >适用设备型号（可多选）<select
              multiple
              size="4"
              :value="e.modelIds"
              :disabled="locked"
              @change="models(e, $event)"
              ><option
                v-for="m in store.catalog.models"
                :key="m.id"
                :value="m.id"
                >{{ m.id }} · {{ m.name }}</option
              ></select
            ></label
          >
        </div>
        <!-- 步骤只是实体草稿字段，沿用原有未保存保护及审核锁定。 -->
        <!-- 规则文字与原变更单一起审核，不更新链路评估。 -->
        <KnowledgeNetworkRuleEditor
          :entity="e"
          :readonly="locked"
          :context="
            '变更预览 · ' +
            (store.change?.id ?? '未保存') +
            ' · 修订 ' +
            (store.change?.revision ?? 0) +
            ' · 基线 ' +
            store.draft.baseVersionId
          "
          @update:rule="e.networkRule = $event"
        />
        <KnowledgePrincipleEditor
          :entity="e"
          :readonly="locked"
          :context="
            (store.change?.state === 'PUBLISHED' ? '已发布变更' : '变更预览') +
            ' · ' +
            (store.change?.id ?? '未保存') +
            ' · 修订 ' +
            (store.change?.revision ?? 0) +
            ' · 基线 ' +
            store.draft.baseVersionId
          "
          @update:flow="e.principleFlow = $event"
        />
        <div
          v-for="(a, index) in e.attributes"
          :key="index"
          class="attribute-row"
          ><label
            >字段<input
              v-model="a.name"
              :readonly="locked"
              maxlength="40" /></label
          ><label
            >内容<textarea
              v-model="a.value"
              :readonly="locked"
              maxlength="500"
              rows="2"
            /></label
          ><label
            >单位<input
              :value="a.unit ?? ''"
              :readonly="locked"
              maxlength="20"
              @input="a.unit = ($event.target as HTMLInputElement).value || null" /></label
          ><button
            v-if="!locked"
            class="text-link"
            @click="e.attributes.splice(index, 1)"
            >移除此属性</button
          ></div
        >
        <div
          v-if="!locked"
          class="toolbar section-gap"
          ><button
            class="btn small"
            :disabled="e.attributes.length >= 20"
            @click="e.attributes.push({ name: '', value: '', unit: null })"
            >添加说明属性</button
          ><button
            v-if="canRemove(e.id)"
            class="text-link"
            @click="remove('entities', e.id)"
            >移除未保存行</button
          ></div
        >
      </details>
      <details
        v-for="(r, i) in store.draft.relations"
        :id="'knowledge-row-' + r.id"
        :key="r.id"
        class="edit-card"
        open
      >
        <summary>关系 {{ i + 1 }} · {{ r.id.startsWith('new:') ? '待保存' : r.id }}</summary>
        <div class="form-grid section-gap">
          <label class="full"
            >头实体<select
              v-model="r.head"
              :disabled="locked"
              ><option value="">请选择</option
              ><option
                v-for="e in endpoints"
                :key="e.id"
                :value="e.id"
                >{{ e.name || '未命名实体' }} ·
                {{ e.id.startsWith('new:') ? '本单新增' : e.id }}</option
              ></select
            ></label
          >
          <label class="full"
            >关系类型<select
              v-model="r.type"
              :disabled="locked"
              ><option
                v-for="t in store.catalog.relationTypes"
                :key="t.id"
                :value="t.id"
                >{{ t.name }}</option
              ></select
            ></label
          >
          <label class="full"
            >尾实体<select
              v-model="r.tail"
              :disabled="locked"
              ><option value="">请选择</option
              ><option
                v-for="e in endpoints"
                :key="e.id"
                :value="e.id"
                >{{ e.name || '未命名实体' }} ·
                {{ e.id.startsWith('new:') ? '本单新增' : e.id }}</option
              ></select
            ></label
          >
          <label
            >权重（可空）<input
              :value="r.weight ?? ''"
              type="number"
              min="0"
              max="1"
              step="0.01"
              :readonly="locked"
              @input="
                r.weight = ($event.target as HTMLInputElement).validity.badInput
                  ? NaN
                  : ($event.target as HTMLInputElement).value === ''
                    ? null
                    : Number(($event.target as HTMLInputElement).value)
              "
          /></label>
          <label class="full"
            >来源说明<input
              v-model="r.source"
              :readonly="locked"
              maxlength="200"
          /></label> </div
        ><button
          v-if="!locked && canRemove(r.id)"
          class="text-link section-gap"
          @click="remove('relations', r.id)"
          >移除未保存行</button
        >
      </details>
      <p
        v-if="!store.draft.entities.length && !store.draft.relations.length"
        class="empty-inline"
        >添加实体或关系，或选择已有条目修改。</p
      >
      <details class="edit-card"
        ><summary>变更前后预览 · {{ differences.length }} 项</summary
        ><div
          v-for="d in differences"
          :key="d.id"
          class="diff-row"
          ><strong>{{ d.action }} · {{ d.id.startsWith('new:') ? '本单新增' : d.id }}</strong
          ><p>变更前</p><pre>{{ describe(d.before) }}</pre
          ><p>变更后</p><pre>{{ describe(d.after) }}</pre>
        </div></details
      >
      <details
        v-if="store.change?.submissions.length"
        class="edit-card"
        ><summary>历次送审与审核</summary
        ><article
          v-for="s in store.change.submissions"
          :key="s.number"
          class="submission"
          ><strong>第 {{ s.number }} 次 · 修订 {{ s.revision }}</strong
          ><KnowledgeStateBadge :state="s.outcome" /><p
            >{{ s.time }} ·
            {{ store.actorName(s.actorId, 'submit:' + store.change.id + ':' + s.number) }}</p
          ><p v-if="s.review"
            >{{
              store.actorName(s.review!.actorId, 'review:' + store.change.id + ':' + s.number)
            }}
            · {{ s.review.opinion || '无附加意见' }} · {{ s.review.time }}</p
          ><p
            >{{ s.content.summary }}（{{ s.content.entities.length }} 项实体 /
            {{ s.content.relations.length }} 项关系）</p
          ></article
        ></details
      >
      <label
        v-if="
          auth.can('knowledge.review') &&
          store.change?.authorId !== store.actorId &&
          store.change?.state === 'PENDING' &&
          !store.stale
        "
        class="section-gap"
        >审核意见（驳回必填）<textarea
          v-model="store.opinion"
          :disabled="store.locked"
          maxlength="500"
          rows="3"
        />
      </label>
    </template>
    <template #footer
      ><div
        class="toolbar"
        style="flex-wrap: wrap"
      >
        <template v-if="store.canEdit"
          ><button
            class="btn"
            :disabled="store.locked"
            @click="store.saveDraft"
            >保存草稿</button
          ><button
            class="btn primary"
            :disabled="store.locked"
            @click="store.submit"
            >提交审核</button
          ></template
        >
        <button
          v-if="
            auth.can('knowledge.edit') &&
            store.change?.authorId === store.actorId &&
            store.change?.state === 'PENDING' &&
            !store.stale
          "
          class="btn"
          :disabled="store.locked"
          @click="store.withdraw"
          >撤回</button
        >
        <template
          v-if="
            auth.can('knowledge.review') &&
            store.change?.authorId !== store.actorId &&
            store.change?.state === 'PENDING' &&
            !store.stale
          "
          ><button
            class="btn"
            :disabled="store.locked"
            @click="store.review(false)"
            >驳回</button
          ><button
            class="btn primary"
            :disabled="store.locked"
            @click="store.review(true)"
            >审核通过</button
          ></template
        >
        <button
          v-if="auth.can('knowledge.publish') && store.change?.state === 'APPROVED' && !store.stale"
          class="btn primary"
          :disabled="store.locked"
          @click="store.publish"
          >发布已审核内容</button
        >
        <button
          class="btn"
          :disabled="store.locked"
          @click="store.closeDrawer"
          >关闭</button
        >
      </div></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, ref } from 'vue';
import { useKnowledgeStore } from '../stores/knowledge';
import {
  applyKnowledgeDraft,
  knowledgeClone,
  knowledgeDiff,
} from '../services/knowledge-validation';
import type { KnowledgeEntity, KnowledgeRelation } from '../types/knowledge';
import AppDrawer from './AppDrawer.vue';
import KnowledgeStateBadge from './KnowledgeStateBadge.vue';
import KnowledgePrincipleEditor from './KnowledgePrincipleEditor.vue';
import { describeKnowledgePrinciple } from '../services/knowledge-principle';
import KnowledgeNetworkRuleEditor from './KnowledgeNetworkRuleEditor.vue';
import { describeNetworkRule } from '../services/knowledge-network-rule';
const store = useKnowledgeStore();
const addEntityId = ref(''),
  addRelationId = ref('');
const endpoints = computed(() => [
  ...new Map(
    [...(store.base?.entities ?? []), ...(store.draft?.entities ?? [])].map((e) => [e.id, e]),
  ).values(),
]);
const differences = computed(() =>
  store.base && store.draft
    ? knowledgeDiff(store.base, applyKnowledgeDraft(store.base, store.draft))
    : [],
);
const locked = computed(() => !store.canEdit || store.locked);
const author = computed(() =>
  store.change
    ? store.actorName(store.change.authorId, 'change:' + store.change.id)
    : (auth.identity?.name ?? '未登录'),
);
function addEntity() {
  if (!store.draft || locked.value) return;
  const t = store.catalog.types[0];
  store.draft.entities.push({
    id: 'new:' + crypto.randomUUID(),
    name: '',
    category: t.category,
    type: t.id,
    description: '',
    keywords: [],
    source: '',
    attributes: [],
    modelIds: [],
  });
}
function addRelation() {
  if (!store.draft || locked.value) return;
  store.draft.relations.push({
    id: 'new:' + crypto.randomUUID(),
    head: '',
    tail: '',
    type: store.catalog.relationTypes[0].id,
    weight: null,
    source: '',
  });
}
function editExisting(kind: 'entities' | 'relations', id: string) {
  if (!store.draft || !store.base || !id || locked.value) return;
  if (kind === 'entities') {
    const e = store.base.entities.find((e) => e.id === id);
    if (e && !store.draft.entities.some((x) => x.id === id))
      store.draft.entities.push(knowledgeClone(e));
  } else {
    const r = store.base.relations.find((r) => r.id === id);
    if (r && !store.draft.relations.some((x) => x.id === id))
      store.draft.relations.push(knowledgeClone(r));
  }
  addEntityId.value = '';
  addRelationId.value = '';
}
function changeType(e: KnowledgeEntity, value: string) {
  const t = store.catalog.types.find((t) => t.id === value);
  if (t) {
    e.type = t.id;
    e.category = t.category;
    if (t.category !== '设备知识') e.modelIds = [];
  }
}
function keywords(e: KnowledgeEntity, event: Event) {
  e.keywords = (event.target as HTMLInputElement).value
    .split(/[，,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function models(e: KnowledgeEntity, event: Event) {
  e.modelIds = Array.from((event.target as HTMLSelectElement).selectedOptions).map((o) => o.value);
}
function canRemove(id: string) {
  return ![...(store.baseline?.entities ?? []), ...(store.baseline?.relations ?? [])].some(
    (x) => x.id === id,
  );
}
function remove(kind: 'entities' | 'relations', id: string) {
  if (store.draft && canRemove(id) && !locked.value) {
    if (kind === 'entities') store.draft.entities = store.draft.entities.filter((e) => e.id !== id);
    else store.draft.relations = store.draft.relations.filter((r) => r.id !== id);
  }
}
function describe(row: KnowledgeEntity | KnowledgeRelation | null) {
  if (!row) return '无';
  if ('name' in row)
    return [
      row.name,
      `${row.category} / ${row.type}`,
      row.description,
      describeKnowledgePrinciple(row),
      describeNetworkRule(row),
      '关键词：' + (row.keywords.join('、') || '无'),
      '来源：' + row.source,
      '型号：' + (row.modelIds.join('、') || '无'),
      ...row.attributes.map((a) => `${a.name}：${a.value}${a.unit ? ' ' + a.unit : ''}`),
    ].join('\n');
  return `${row.head} → ${row.type} → ${row.tail}\n权重：${row.weight ?? '未提供'}\n来源：${row.source}`;
}
function locate(id: string) {
  document
    .getElementById('knowledge-row-' + id)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
</script>
<style scoped>
.add-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin: 18px 0;
}
.add-tools select {
  width: 100%;
}
.edit-card {
  margin-top: 15px;
  padding: 13px;
  background: #0e1a2c;
  border: 1px solid #2a3c54;
  border-radius: 7px;
}
.edit-card summary {
  cursor: pointer;
  color: #c6e3f6;
  font-weight: 600;
  margin-bottom: 10px;
}
.edit-card small {
  overflow-wrap: anywhere;
}
.attribute-row {
  display: grid;
  gap: 8px;
  padding: 10px;
  margin-top: 10px;
  border-left: 2px solid #365b7d;
}
.diff-row,
.submission {
  border-top: 1px solid #293c53;
  padding: 12px 0;
}
.diff-row p,
.submission p {
  margin: 8px 0;
  font-size: 12px;
}
.diff-row pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 12px/1.7 inherit;
  background: #101f33;
  padding: 10px;
}
.error {
  color: #ffb1b1;
  margin: 12px 0;
}
.issues {
  padding-left: 15px;
}
.issues li {
  margin: 8px 0;
}
</style>
