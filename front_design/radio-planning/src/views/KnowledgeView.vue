<template>
  <div class="page">
    <div class="page-heading">
      <div
        ><p class="eyebrow">KNOWLEDGE GRAPH</p><h1>知识图谱</h1
        ><p class="subtitle">三类知识统一浏览 · 变更审核后发布 · 完整版本可追溯</p></div
      >
      <div class="toolbar kg-heading-tools">
        <span class="chip cyan">演示身份</span>
        <span class="chip">{{ auth.identity?.name }} · {{ auth.identity?.roleName }}</span>
        <button
          class="btn primary"
          :disabled="store.locked || !store.workspace || !auth.can('knowledge.edit')"
          @click="store.newChange()"
          ><i class="pi pi-plus" />新增知识变更</button
        >
      </div>
    </div>
    <div class="kg-context"
      ><span class="chip">{{
        store.current ? '当前已发布 v' + store.current.number : '知识工作区'
      }}</span
      ><span>审核通过后仍须单独发布；操作身份来自当前登录账号。</span
      ><button
        class="text-link"
        :disabled="store.locked"
        @click="store.load"
        >重新加载</button
      ><button
        class="text-link"
        :disabled="store.locked || !auth.can('knowledge.reset')"
        @click="store.reset"
        >重置知识演示数据</button
      ></div
    >
    <p
      v-if="store.notice"
      class="notice"
      role="status"
      >{{ store.notice }}</p
    ><p
      v-if="store.error && !store.drawerOpen"
      class="kg-error"
      role="alert"
      >{{ store.error }}</p
    >
    <RequestState
      v-if="store.loading && !store.workspace"
      state="loading"
    />
    <RequestState
      v-else-if="store.loadError"
      state="error"
      :message="store.loadError"
      @retry="store.load"
    />
    <section
      v-else-if="store.workspace"
      class="panel"
    >
      <div class="tabs"
        ><button
          v-for="name in ['图谱浏览', '知识维护', '版本记录']"
          :key="name"
          :class="{ active: tab === name }"
          @click="tab = name"
          >{{ name }}</button
        ></div
      >
      <div
        v-if="tab === '图谱浏览'"
        class="kg-workspace"
      >
        <aside class="kg-filters">
          <h3>图谱与检索</h3
          ><label
            v-for="{ name, icon } in graphCategories"
            :key="name"
            class="kg-category"
            ><input
              type="checkbox"
              :checked="store.categories.includes(name)"
              @change="categoryChanged(name, ($event.target as HTMLInputElement).checked)"
            /><i
              class="pi"
              :class="icon"
            /><span class="kg-category-name">{{ name }}</span
            ><small>{{
              store.current?.entities.filter((e) => e.category === name).length
            }}</small></label
          >
          <label class="section-gap"
            >实体类型<select
              v-model="store.type"
              @change="filtersChanged"
              ><option value="">全部类型</option
              ><option
                v-for="t in store.catalog.types.filter((t) =>
                  store.categories.includes(t.category),
                )"
                :key="t.id"
                :value="t.id"
                >{{ t.name }}</option
              ></select
            ></label
          >
          <form
            class="kg-search"
            @submit.prevent="submitSearch"
            ><label
              >检索已发布知识<input
                v-model="searchInput"
                placeholder="名称、编号、关键词、描述或步骤" /></label
            ><button
              class="btn small"
              :disabled="store.querying"
              >检索</button
            ></form
          >
          <p
            v-if="searchInput !== store.query"
            class="kg-search-note"
            >输入尚未检索，当前结果仍按已提交条件显示。</p
          >
          <div class="kg-list-heading"
            ><span v-if="store.search">匹配 {{ store.search.total }} 个实体</span
            ><span v-else>{{ store.querying ? '正在检索…' : '检索结果未就绪' }}</span
            ><small>每页 20 条</small></div
          >
          <button
            v-for="e in store.search?.items"
            :key="e.id"
            class="kg-entity"
            :class="{ selected: e.id === store.selectedId }"
            @click="store.selectEntity(e.id)"
            ><strong>{{ e.name }}</strong
            ><small>{{ typeName(e.type) }} · {{ e.id }}</small></button
          >
          <div
            v-if="store.search && !store.search.total"
            class="empty-inline"
            >未找到匹配实体<template v-if="store.search.similar.length"
              ><p>相似知识推荐 · 预设</p
              ><button
                v-for="e in store.search.similar"
                :key="e.id"
                class="kg-entity"
                @click="store.selectEntity(e.id)"
                >{{ e.name }}</button
              ></template
            ><p v-else>暂无相似推荐</p></div
          >
          <div class="kg-pager"
            ><button
              class="btn small"
              :disabled="store.page <= 1 || store.querying"
              @click="turnPage(-1)"
              >上一页</button
            ><span
              >{{ store.page }} /
              {{ Math.max(1, Math.ceil((store.search?.total ?? 0) / 20)) }}</span
            ><button
              class="btn small"
              :disabled="store.page * 20 >= (store.search?.total ?? 0) || store.querying"
              @click="turnPage(1)"
              >下一页</button
            ></div
          >
        </aside>
        <div class="kg-stage">
          <div class="kg-graph-toolbar"
            ><button
              class="btn small"
              :disabled="!store.selectedId || store.querying"
              @click="store.expand"
              >展开选中实体一跳</button
            ><button
              class="btn small"
              :disabled="!store.expandedIds.length || store.querying"
              @click="store.collapse"
              >收起上次展开</button
            ><button
              class="btn small"
              @click="resetView"
              >返回概览 / 重置视图</button
            ></div
          >
          <p
            v-if="store.queryError"
            class="kg-error"
            role="alert"
            >{{ store.queryError
            }}<button
              class="text-link"
              @click="store.refreshBrowse"
              >重试</button
            ></p
          >
          <p
            v-if="store.querying"
            class="kg-progress"
            role="status"
            >正在读取发布快照…</p
          >
          <p
            v-if="
              !store.querying && !store.selectedId && !store.relationId && store.matchedIds.length
            "
            class="kg-search-note"
            role="status"
            >匹配 {{ store.search?.total }} 个实体，已高亮当前显示的命中节点；点击实体查看详情。</p
          >
          <KnowledgeGraphPanel
            v-if="store.graph"
            ref="graphPanel"
            :graph="store.graph"
            :selected-id="store.selectedId"
            :matched-ids="store.matchedIds"
            :catalog="store.catalog"
            @entity="store.selectEntity($event, false, true)"
            @relation="store.selectRelation"
          />
          <div
            v-else
            class="empty-inline"
            >选择图谱或重新查询</div
          >
          <p class="kg-graph-note"
            ><i class="pi pi-info-circle" />关系、阈值与表达式仅作知识展示，不执行推理。</p
          >
        </div>
        <aside class="kg-detail">
          <template v-if="selectedRelation"
            ><p class="eyebrow">RELATION</p><h3>{{ relationName(selectedRelation.type) }}</h3
            ><dl class="kv section-gap"
              ><dt>关系 ID</dt><dd>{{ selectedRelation.id }}</dd
              ><dt>头实体</dt
              ><dd
                ><button
                  class="text-link"
                  @click="store.selectEntity(selectedRelation.head, true)"
                  >{{
                    store.current?.entities.find((e) => e.id === selectedRelation!.head)?.name
                  }}</button
                ></dd
              ><dt>尾实体</dt
              ><dd
                ><button
                  class="text-link"
                  @click="store.selectEntity(selectedRelation.tail, true)"
                  >{{
                    store.current?.entities.find((e) => e.id === selectedRelation!.tail)?.name
                  }}</button
                ></dd
              ><dt>权重</dt><dd>{{ selectedRelation.weight ?? '未提供' }}</dd
              ><dt>来源</dt><dd>{{ selectedRelation.source }}</dd></dl
            ><button
              class="btn small section-gap"
              :disabled="!auth.can('knowledge.edit')"
              @click="store.newChange(undefined, selectedRelation)"
              >新建关系变更</button
            ></template
          >
          <template v-else-if="store.detail"
            ><p class="eyebrow">{{ store.detail.entity.category }}</p
            ><h3>{{ store.detail.entity.name }}</h3
            ><small>{{ store.detail.entity.id }}</small
            ><dl class="kv section-gap"
              ><dt>类型</dt><dd>{{ typeName(store.detail.entity.type) }}</dd
              ><dt>发布快照</dt><dd>{{ store.detail.versionId }}</dd
              ><dt>关键词</dt><dd>{{ store.detail.entity.keywords.join('、') || '未提供' }}</dd
              ><dt>来源</dt><dd>{{ store.detail.entity.source }}</dd></dl
            ><h4 class="section-gap">知识说明</h4
            ><p class="kg-description">{{ store.detail.entity.description || '未提供' }}</p
            ><KnowledgePrincipleFlow
              :entity="store.detail.entity"
              :context="'已发布 · ' + store.detail.versionId"
            /><KnowledgeNetworkRulePanel
              :entity="store.detail.entity"
              :context="'已发布 · ' + store.detail.versionId"
            /><dl
              v-if="store.detail.entity.attributes.length"
              class="kv"
              ><template
                v-for="(a, i) in store.detail.entity.attributes"
                :key="i"
                ><dt>{{ a.name }}</dt
                ><dd>{{ a.value }} {{ a.unit }}</dd></template
              ></dl
            ><p
              v-if="store.detail.entity.modelIds.length"
              class="kg-description"
              >适用型号：{{ applicableModelText }}</p
            ><button
              class="btn small"
              :disabled="!auth.can('knowledge.edit')"
              @click="store.newChange(store.detail.entity)"
              >新建实体变更</button
            ><h4 class="section-gap">关联关系</h4
            ><div
              v-for="{ relation, neighbor } in relatedRows"
              :key="relation.id"
              class="kg-related"
              ><button
                class="text-link"
                @click="store.selectRelation(relation.id)"
                >{{ relationName(relation.type) }}</button
              ><button
                class="text-link"
                @click="
                  store.selectEntity(
                    relation.head === store.selectedId ? relation.tail : relation.head,
                    true,
                  )
                "
                >{{ neighbor?.name }}</button
              ><small v-if="!store.categories.includes(neighbor!.category)"
                >跨类关系 · 点击后包含所属图谱</small
              ></div
            ><p
              v-if="!store.detail.relations.length"
              class="muted"
              >暂无关联关系</p
            ></template
          >
          <div
            v-else
            class="empty-inline"
            >选择实体或关系查看详情</div
          >
        </aside>
      </div>
      <template v-else-if="tab === '知识维护'">
        <div class="panel-body toolbar spread"
          ><span class="muted">草稿与送审内容独立于发布库；旧基线变更需重新新建并送审。</span
          ><select
            v-model="stateFilter"
            aria-label="按知识变更状态筛选"
            ><option value="">全部状态</option
            ><option value="DRAFT">草稿</option
            ><option value="PENDING">待审核</option
            ><option value="APPROVED">审核通过</option
            ><option value="REJECTED">已驳回</option
            ><option value="PUBLISHED">已发布</option></select
          ></div
        >
        <AppTable
          :rows="changes"
          :columns="changeColumns"
          @select="store.openChange"
          ><template #state="{ row }"
            ><KnowledgeStateBadge
              :state="row.state"
              :stale="
                row.state !== 'PUBLISHED' && row.content.baseVersionId !== store.current?.id
              " /></template
          ><template #actions="{ row }"
            ><button
              class="text-link"
              @click.stop="store.openChange(row)"
              >查看 / 处理</button
            ></template
          ></AppTable
        >
      </template>
      <template v-else>
        <div class="panel-body toolbar spread"
          ><span class="muted">每次发布只合入一份已审核变更，三类实体与关系统一保存快照。</span
          ><button
            class="btn small"
            :disabled="!auth.can('knowledge.rollback') || !store.current?.parentId"
            @click="store.current && store.showVersion(store.current)"
            >回滚当前版本</button
          ></div
        >
        <AppTable
          :rows="versions"
          :columns="versionColumns"
          @select="store.showVersion"
          ><template #actions="{ row }"
            ><button
              class="text-link"
              @click.stop="store.showVersion(row)"
              >快照与差异</button
            ></template
          ></AppTable
        >
        <div class="panel-body"
          ><h3>知识操作日志</h3
          ><p class="muted section-gap">仅记录本知识工作区的成功操作，非服务端审计。</p></div
        >
        <AppTable
          :rows="logs"
          :columns="logColumns"
        />
      </template>
    </section>
    <div class="kg-source"
      ><span>小规模教学知识 · 不代表正式知识库规模或算法结果</span
      ><button
        class="text-link"
        :disabled="!store.catalog.legacy.entities.length"
        @click="store.showLegacy"
        >查看原知识预览记录</button
      ></div
    >
    <KnowledgeChangeDrawer /><KnowledgeVersionDrawer /><DecisionDialog
      :request="store.decision"
      @answer="store.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useKnowledgeStore } from '../stores/knowledge';
import { useKnowledgeLeaveGuard } from '../composables/useKnowledgeLeaveGuard';
import type { KnowledgeCategory } from '../types/knowledge';
import AppTable from '../components/AppTable.vue';
import RequestState from '../components/RequestState.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import KnowledgeGraphPanel from '../components/KnowledgeGraphPanel.vue';
import KnowledgeChangeDrawer from '../components/KnowledgeChangeDrawer.vue';
import KnowledgeVersionDrawer from '../components/KnowledgeVersionDrawer.vue';
import KnowledgeStateBadge from '../components/KnowledgeStateBadge.vue';
// 与设备面板共用流程图，避免同一知识在不同入口呈现不同步骤。
import KnowledgePrincipleFlow from '../components/KnowledgePrincipleFlow.vue';
// 网络规则按当前详情的发布版本展示。
import KnowledgeNetworkRulePanel from '../components/KnowledgeNetworkRulePanel.vue';

// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
const store = useKnowledgeStore();
const route = useRoute();
useKnowledgeLeaveGuard();
const tab = ref('图谱浏览');
const stateFilter = ref('');
const graphPanel = ref<InstanceType<typeof KnowledgeGraphPanel>>();
// 输入中的文字不参与翻页或展开查询，只有明确提交才更新检索条件。
const searchInput = ref(store.query);
watch(
  () => store.query,
  (value) => {
    searchInput.value = value;
  },
);
// 分类与图标成对维护，调整顺序时不再依赖另一份数组的下标。
const graphCategories: { name: KnowledgeCategory; icon: string }[] = [
  { name: '设备知识', icon: 'pi-server' },
  { name: '网络态势知识', icon: 'pi-sitemap' },
  { name: '故障运维知识', icon: 'pi-wrench' },
];
// 知识维护、版本记录和日志的列配置留在本页，便于按用途修改。
const changeColumns = [
  { field: 'summary', header: '变更摘要' },
  { field: 'author', header: '作者' },
  { field: 'revision', header: '修订' },
  { field: 'base', header: '基线版本' },
  { field: 'state', header: '状态' },
  { field: 'updatedAt', header: '更新时间' },
];
const versionColumns = [
  { field: 'label', header: '版本' },
  { field: 'summary', header: '变更摘要' },
  { field: 'state', header: '状态' },
  { field: 'kindLabel', header: '类型' },
  { field: 'author', header: '发布人' },
  { field: 'time', header: '发布时间' },
];
const logColumns = [
  { field: 'time', header: '时间' },
  { field: 'author', header: '操作者' },
  { field: 'actionName', header: '操作' },
  { field: 'objectId', header: '对象' },
  { field: 'versionId', header: '关联版本' },
  { field: 'opinion', header: '意见 / 原因' },
];
const selectedRelation = computed(() =>
  store.current?.relations.find((r) => r.id === store.relationId),
);
// 保留型号顺序、重复项和未知 ID 回退，空名称仍按原值展示。
const applicableModelText = computed(() => {
  if (!store.detail) return '';
  return store.detail.entity.modelIds
    .map((id) => store.catalog.models.find((m) => m.id === id)?.name ?? id)
    .join('、');
});
// 邻居只缓存用于展示；点击目标仍在事件触发时根据当前 selectedId 计算。
const relatedRows = computed(() => {
  const detail = store.detail;
  if (!detail) return [];
  return detail.relations.map((relation) => {
    const neighborId = relation.head === store.selectedId ? relation.tail : relation.head;
    const neighbor = detail.neighbors.find((e) => e.id === neighborId);
    return { relation, neighbor };
  });
});
const changes = computed(() =>
  (store.workspace?.changes ?? [])
    .filter((c) => !stateFilter.value || c.state === stateFilter.value)
    .map((c) => ({
      ...c,
      summary: c.content.summary,
      author: store.actorName(c.authorId, 'change:' + c.id),
      base: c.content.baseVersionId,
    }))
    .reverse(),
);
const versions = computed(() =>
  (store.workspace?.versions ?? [])
    .map((v) => ({
      ...v,
      label: 'v' + v.number,
      state: v.id === store.current?.id ? '当前已发布' : '历史已发布',
      kindLabel:
        v.kind === 'ROLLBACK' ? '回滚发布' : v.kind === 'BASELINE' ? '教学基线' : '审核发布',
      author: store.actorName(v.actorId, 'version:' + v.id),
    }))
    .reverse(),
);
const actionNames: Record<string, string> = {
  SAVE: '保存草稿',
  SUBMIT: '送审',
  WITHDRAW: '撤回',
  APPROVE: '审核通过',
  REJECT: '驳回',
  PUBLISH: '发布',
  ROLLBACK: '回滚',
  RESET: '重置',
};
const logs = computed(() =>
  (store.workspace?.logs ?? [])
    .map((l) => ({
      ...l,
      author: store.actorName(l.actorId, 'log:' + l.id),
      actionName: actionNames[l.action] ?? l.action,
    }))
    .reverse(),
);
const typeName = (id: string) => store.catalog.types.find((t) => t.id === id)?.name ?? id;
const relationName = (id: string) =>
  store.catalog.relationTypes.find((t) => t.id === id)?.name ?? id;
async function filtersChanged() {
  await store.applyFilters();
}
async function submitSearch() {
  searchInput.value = searchInput.value.trim();
  await store.applyFilters(searchInput.value);
}
async function categoryChanged(category: KnowledgeCategory, checked: boolean) {
  store.categories = checked
    ? [...store.categories, category]
    : store.categories.filter((c) => c !== category);
  if (
    store.type &&
    !store.catalog.types.some((t) => t.id === store.type && store.categories.includes(t.category))
  )
    store.type = '';
  await filtersChanged();
}
async function resetView() {
  await store.resetGraph();
  graphPanel.value?.resetView();
}
async function turnPage(direction: number) {
  store.page += direction;
  await store.refreshBrowse();
}
// 路由参数引用当前发布实体；找不到时保留明确错误，不替换成其他对象。
watch(
  () => [route.query.entityId, store.current?.id],
  () => {
    if (store.current && typeof route.query.entityId === 'string')
      void store.selectEntity(route.query.entityId, true);
  },
  { immediate: true },
);
</script>
<style scoped>
.kg-search-note {
  padding: 8px 14px;
  color: #9fb7ce;
  font-size: 12px;
  line-height: 1.7;
}
.kg-heading-tools {
  flex-wrap: wrap;
}
.kg-heading-tools select {
  width: 145px;
}
.kg-context {
  display: flex;
  align-items: center;
  gap: 15px;
  margin-bottom: 18px;
  color: #8fa9c3;
  font-size: 12px;
  flex-wrap: wrap;
}
.kg-context button:first-of-type {
  margin-left: auto;
}
.kg-workspace {
  display: grid;
  grid-template-columns: 265px minmax(0, 1fr) 310px;
  min-height: 650px;
}
.kg-filters {
  padding: 20px 14px;
  background: #0d1929;
  border-right: 1px solid #283c54;
}
.kg-filters h3 {
  margin-bottom: 14px;
}
/* 分类是横向选择行；表单标签仍沿用原有纵向布局。 */
.kg-category {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 9px;
  margin: 6px 0;
  padding: 10px 8px;
  border: 1px solid #263d56;
  border-radius: 5px;
  background: #102136;
  cursor: pointer;
  font-size: 12px;
}
.kg-category:hover {
  background: #17304a;
}
.kg-category-name {
  flex: 1;
  min-width: 0;
}
.kg-category > .pi {
  flex-shrink: 0;
  color: #82bde8;
}
.kg-category input {
  width: 15px;
  height: 15px;
  margin: 0;
  flex-shrink: 0;
  accent-color: #62b5ed;
}
.kg-category small {
  margin-left: auto;
  min-width: 22px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: #7396b3;
}
.kg-filters > .section-gap {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid #293d52;
  font-size: 12px;
}
.kg-search {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 18px 0;
}
.kg-search label {
  width: 100%;
  font-size: 12px;
}
.kg-search button {
  margin-left: auto;
}
.kg-list-heading {
  display: flex;
  justify-content: space-between;
  border-top: 1px solid #293d52;
  padding: 14px 0;
  font-size: 12px;
  color: #9fb7ce;
}
.kg-entity {
  display: block;
  width: 100%;
  padding: 12px;
  text-align: left;
  background: transparent;
  color: #bed3e6;
  border: 1px solid transparent;
  border-radius: 5px;
  margin: 5px 0;
}
.kg-entity:hover {
  background: #152a40;
}
.kg-entity.selected {
  background: #173753;
  border-color: #39749c;
}
.kg-entity strong {
  font-size: 12px;
}
.kg-entity small {
  display: block;
  font-size: 10px;
  color: #789ab7;
  margin-top: 7px;
  overflow-wrap: anywhere;
}
.kg-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  margin-top: 18px;
  gap: 6px;
}
.kg-pager button {
  font-size: 10px;
  padding: 6px;
}
.kg-stage {
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.kg-stage > .knowledge-canvas {
  flex: 1;
}
.kg-graph-toolbar {
  display: flex;
  gap: 8px;
  padding: 13px 16px;
  border-bottom: 1px solid #283a51;
  flex-wrap: wrap;
}
.kg-graph-note {
  font-size: 11px;
  color: #789ab5;
  padding: 12px 16px;
  border-top: 1px solid #283a51;
}
.kg-graph-note i {
  margin-right: 6px;
}
.kg-detail {
  padding: 22px 18px;
  background: #101d30;
  border-left: 1px solid #293d53;
  overflow-wrap: anywhere;
}
.kg-detail > small {
  display: block;
  color: #7c9bb9;
  margin-top: 10px;
}
.kg-detail h3 {
  font-size: 17px;
  line-height: 1.6;
}
.kg-description {
  font-size: 12px;
  line-height: 1.85;
  color: #a8bfd4;
  margin: 14px 0;
  white-space: pre-wrap;
}
.kg-related {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid #293c51;
}
.kg-related small {
  font-size: 10px;
  color: #c4a97c;
}
.kg-error {
  margin: 14px;
  padding: 12px;
  color: #ffb6b6;
  background: #3c2534;
  border-radius: 5px;
  line-height: 1.7;
}
.kg-progress {
  position: absolute;
  top: 63px;
  left: 16px;
  z-index: 1;
  font-size: 11px;
  color: #a8d3ee;
}
.kg-source {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  margin: 18px 0;
  color: #7594ae;
  font-size: 11px;
}
.toolbar.spread select {
  width: 165px;
}
.kg-detail .kv dd {
  white-space: pre-wrap;
}
@media (max-width: 1250px) {
  .kg-workspace {
    grid-template-columns: 225px minmax(0, 1fr) 265px;
  }
  .kg-heading-tools {
    gap: 8px;
  }
}
@media (max-width: 950px) {
  .kg-workspace {
    grid-template-columns: 210px minmax(0, 1fr);
  }
  .kg-detail {
    grid-column: 1/-1;
    border-left: 0;
    border-top: 1px solid #293d53;
  }
}
</style>
<style scoped>
.kg-workspace {
  height: calc(100vh - 335px);
  min-height: 630px;
}
.kg-filters,
.kg-detail {
  overflow-y: auto;
}
.kg-stage {
  min-height: 0;
}
.kg-stage > .knowledge-canvas {
  min-height: 0;
  height: auto;
}
@media (max-width: 950px) {
  .kg-workspace {
    height: auto;
  }
  .kg-filters,
  .kg-detail {
    max-height: 650px;
  }
}
</style>
