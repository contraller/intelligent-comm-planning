<template>
  <div class="page knowledge-page" :class="{ 'kg-light': embedded }">
    <div class="page-heading">
      <h1>知识图谱</h1>
      <div class="toolbar kg-heading-tools">
        <span class="chip cyan">当前账号</span>
        <span class="chip">{{ auth.identity?.name }} · {{ auth.identity?.roleName }}</span>
        <button class="btn" :disabled="store.locked || !store.workspace || !auth.can('knowledge.edit')" @click="caseBuilderOpen = true">
          <i class="pi pi-sitemap" />结构化构建
        </button>
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
        v-if="demoResetEnabled && auth.can('knowledge.reset')"
        class="text-link"
        :disabled="store.locked || !auth.can('knowledge.reset')"
        @click="store.reset"
        >重置知识数据</button
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
      class="panel knowledge-panel"
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
        :class="{ 'details-open': detailVisible }"
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
            ><small>{{ store.counts[name] }}</small></label
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
                >{{ typeName(t.id) }}</option
              ></select
            ></label
          >
          <form
            class="kg-search"
            @submit.prevent="submitSearch"
            ><label
              >检索已发布知识<input
                v-model="searchInput"
                placeholder="名称、关键词、参数或步骤" /></label
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
            @click="selectEntity(e.id)"
            ><strong>{{ knowledgeEntityName(e) }}</strong
            ><small>{{ typeName(e.type) }} · {{ e.id }}</small></button
          >
          <div
            v-if="store.search && !store.search.total"
            class="empty-inline"
            >未找到匹配实体<template v-if="store.search.similar.length"
              ><p>相似知识推荐</p
              ><button
                v-for="e in store.search.similar"
                :key="e.id"
                class="kg-entity"
                @click="selectEntity(e.id)"
                >{{ knowledgeEntityName(e) }}</button
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
              {{
                Math.max(1, Math.ceil((store.search?.total ?? 0) / (store.search?.pageSize ?? 20)))
              }}</span
            ><button
              class="btn small"
              :disabled="
                store.page * (store.search?.pageSize ?? 20) >= (store.search?.total ?? 0) ||
                store.querying
              "
              @click="turnPage(1)"
              >下一页</button
            ></div
          >
        </aside>
        <div class="kg-stage">
          <div class="kg-graph-toolbar"
            ><button
              class="btn small"
              :disabled="
                !store.selectedId || store.querying || store.expandedIds.includes(store.selectedId)
              "
              title="选择尚未展开的关联节点，可继续查看一跳关系"
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
              >返回概览</button
            ><button
              v-if="hasSelection"
              class="btn small kg-detail-toggle"
              :aria-expanded="detailVisible"
              aria-controls="knowledge-detail-panel"
              @click="detailOpen = !detailOpen"
              >{{ detailVisible ? '收起详情' : '查看详情' }}</button
            ></div
          >
          <p
            v-if="store.queryError"
            class="kg-error"
            role="alert"
            >{{ store.queryError
            }}<button
              class="text-link"
              @click="store.retryBrowse"
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
            >匹配 {{ store.search?.total }} 个实体，命中已高亮，其余节点弱化；点击实体查看详情。</p
          >
          <KnowledgeGraphPanel
            v-if="store.graph"
            ref="graphPanel"
            :graph="store.graph"
            :selected-id="store.selectedId"
            :matched-ids="store.matchedIds"
            :catalog="store.catalog"
            :theme="embedded ? 'light' : 'dark'"
            @entity="selectEntity($event, false, true)"
            @relation="selectRelation"
          />
          <div
            v-else
            class="empty-inline"
            >选择图谱或重新查询</div
          >
          <p class="kg-graph-note"
            ><i class="pi pi-info-circle" />点击节点查看知识详情，点击连线查看关联关系。</p
          >
        </div>
        <aside v-if="detailVisible" id="knowledge-detail-panel" class="kg-detail" aria-label="知识详情">
          <div class="kg-detail-heading">
            <strong>知识详情</strong>
            <button class="text-link" aria-label="收起知识详情" @click="detailOpen = false">收起</button>
          </div>
          <template v-if="selectedRelation"
            ><p class="eyebrow">关联关系</p><h3>{{ relationName(selectedRelation.type) }}</h3
            ><dl class="kv section-gap"
              ><dt>关系编号</dt><dd>{{ selectedRelation.id }}</dd
              ><dt>头实体</dt
              ><dd
                ><button
                  class="text-link"
                  @click="selectEntity(selectedRelation.head, true)"
                  >{{ entityName(selectedRelation!.head) }}</button
                ></dd
              ><dt>尾实体</dt
              ><dd
                ><button
                  class="text-link"
                  @click="selectEntity(selectedRelation.tail, true)"
                  >{{ entityName(selectedRelation!.tail) }}</button
                ></dd
              ><dt>权重</dt><dd>{{ selectedRelation.weight ?? '未提供' }}</dd
              ><dt>来源</dt><dd>{{ knowledgeSource(selectedRelation.source) }}</dd></dl
            ><button
              class="btn small section-gap"
              :disabled="!auth.can('knowledge.edit')"
              @click="store.newChange(undefined, selectedRelation)"
              >新建关系变更</button
            ></template
          >
          <template v-else-if="store.detail"
            ><p class="eyebrow">{{ store.detail.entity.category }}</p
            ><h3>{{ knowledgeEntityName(store.detail.entity) }}</h3
            ><small>{{ store.detail.entity.id }}</small
            ><figure v-if="detailPhoto && !photoFailed" class="knowledge-photo">
              <img :src="detailPhoto.url" :alt="detailPhoto.label" @error="photoFailed = true" />
              <figcaption>{{ detailPhoto.label }}<small>{{ detailPhoto.credit }}</small></figcaption>
            </figure
            ><dl class="kv section-gap"
              ><dt>类型</dt><dd>{{ typeName(store.detail.entity.type) }}</dd
              ><dt>发布快照</dt><dd>{{ store.detail.versionId }}</dd
              ><dt>关键词</dt><dd>{{ store.detail.entity.keywords.map(knowledgeText).join('、') || '未提供' }}</dd
              ><dt>来源</dt><dd>{{ knowledgeSource(store.detail.entity.source) }}</dd></dl
            ><h4 class="section-gap">知识说明</h4
            ><p class="kg-description">{{ knowledgeText(store.detail.entity.description) || '未提供' }}</p
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
                ><dt>{{ knowledgeAttributeName(a.name) }}</dt
                ><dd>{{ knowledgeAttributeValue(a.value, a.name) || '未提供' }} {{ a.unit }}</dd></template
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
                @click="selectRelation(relation.id)"
                >{{ relationName(relation.type) }}</button
              ><button
                class="text-link"
                @click="
                  selectEntity(
                    relation.head === store.selectedId ? relation.tail : relation.head,
                    true,
                  )
                "
                >{{ knowledgeEntityName(neighbor) }}</button
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
        <p
          v-if="store.openingChangeId"
          class="panel-body muted"
          role="status"
          aria-live="polite"
          >{{ store.openingChangeStage === 'base' ? '正在读取对照版本…' : '正在读取变更内容…' }}</p
        >
        <AppTable
          :rows="changes"
          :paginator="false"
          :page-size="20"
          :columns="changeColumns"
          @select="store.openChange"
          ><template #state="{ row }"
            ><KnowledgeStateBadge
              :state="row.state"
              :stale="row.state !== 'PUBLISHED' && row.base !== store.current?.id" /></template
          ><template #actions="{ row }"
            ><button
              class="text-link"
              :disabled="store.locked"
              @click.stop="store.openChange(row)"
              >{{ store.openingChangeId === row.id ? '正在打开…' : '查看 / 处理' }}</button
            ></template
          ></AppTable
        >
        <div class="panel-body toolbar"
          ><span>共 {{ store.historyTotal }} 条</span
          ><button
            class="btn small"
            :disabled="store.historyPage <= 1"
            @click="
              store.historyPage--;
              store.refreshTab();
            "
            >上页</button
          ><span>第 {{ store.historyPage }} 页</span
          ><button
            class="btn small"
            :disabled="store.historyPage * 20 >= store.historyTotal"
            @click="
              store.historyPage++;
              store.refreshTab();
            "
            >下页</button
          ></div
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
          :paginator="false"
          :page-size="20"
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
        <div class="panel-body toolbar"
          ><span>共 {{ store.historyTotal }} 个版本</span
          ><button
            class="btn small"
            :disabled="store.historyPage <= 1"
            @click="
              store.historyPage--;
              store.refreshTab();
            "
            >上页</button
          ><span>第 {{ store.historyPage }} 页</span
          ><button
            class="btn small"
            :disabled="store.historyPage * 20 >= store.historyTotal"
            @click="
              store.historyPage++;
              store.refreshTab();
            "
            >下页</button
          ></div
        >
        <div class="panel-body"
          ><h3>知识操作日志</h3
          ><p class="muted section-gap">记录知识维护、审核、发布与回滚操作。</p></div
        >
        <AppTable
          :rows="logs"
          :paginator="false"
          :page-size="20"
          :columns="logColumns"
        /><div class="panel-body toolbar"
          ><span>共 {{ store.logTotal }} 条日志</span
          ><button
            class="btn small"
            :disabled="store.logPage <= 1"
            @click="store.queryLogs(store.logPage - 1)"
            >上页</button
          ><span>第 {{ store.logPage }} 页</span
          ><button
            class="btn small"
            :disabled="store.logPage * 20 >= store.logTotal"
            @click="store.queryLogs(store.logPage + 1)"
            >下页</button
          ></div
        >
      </template>
    </section>
    <KnowledgeCaseBuilderDialog ref="caseBuilder" :visible="caseBuilderOpen" @close="caseBuilderOpen = false" />
    <KnowledgeChangeDrawer /><KnowledgeVersionDrawer /><DecisionDialog
      :request="store.decision"
      @answer="store.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
import { env } from '../config/env';
import { computed, inject, ref, watch } from 'vue';
import { useRoute, onBeforeRouteUpdate } from 'vue-router';
import { isModuleTab } from '../config/module-tabs';
import { useKnowledgeStore } from '../stores/knowledge';
import { useKnowledgeLeaveGuard } from '../composables/useKnowledgeLeaveGuard';
import { knowledgeEntityName, knowledgeTypeName, knowledgeRelationName, knowledgeText,
  knowledgeAttributeName, knowledgeAttributeValue, knowledgeSource } from '../services/knowledge-display';
import type { KnowledgeCategory, KnowledgeState } from '../types/knowledge';
import AppTable from '../components/AppTable.vue';
import RequestState from '../components/RequestState.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import KnowledgeGraphPanel from '../components/KnowledgeGraphPanel.vue';
import KnowledgeChangeDrawer from '../components/KnowledgeChangeDrawer.vue';
import KnowledgeVersionDrawer from '../components/KnowledgeVersionDrawer.vue';
import KnowledgeStateBadge from '../components/KnowledgeStateBadge.vue';
import KnowledgeCaseBuilderDialog from '../components/KnowledgeCaseBuilderDialog.vue';
import { knowledgeMedia } from '../config/knowledge-media';
// 与设备面板共用流程图，避免同一知识在不同入口呈现不同步骤。
import KnowledgePrincipleFlow from '../components/KnowledgePrincipleFlow.vue';
// 网络规则按当前详情的发布版本展示。
import KnowledgeNetworkRulePanel from '../components/KnowledgeNetworkRulePanel.vue';

// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
// 教学清空仅适用于本地Mock；HTTP知识历史通过发布/回滚保留，不暴露物理重置。
const demoResetEnabled = env.mode === 'mock' && env.sampleData;
const store = useKnowledgeStore();
const embedded = inject('embeddedModule', false);
const detailOpen = ref(false);
const hasSelection = computed(() => !!(store.selectedId || store.relationId));
const detailVisible = computed(() => detailOpen.value && hasSelection.value);
// 自动聚焦和深链选择也可打开详情；手动收起不清理选中或重新查询图谱。
watch(() => [store.selectedId, store.relationId], () => {
  detailOpen.value = hasSelection.value;
}, { immediate: true });
function selectEntity(id: string, revealCategory = false, keepGraph = false) {
  detailOpen.value = true;
  return store.selectEntity(id, revealCategory, keepGraph);
}
function selectRelation(id: string) {
  detailOpen.value = true;
  store.selectRelation(id);
}
const caseBuilderOpen = ref(false);
const caseBuilder = ref<InstanceType<typeof KnowledgeCaseBuilderDialog>>();
const photoFailed = ref(false);
const detailPhoto = computed(() => store.detail ? knowledgeMedia(store.detail.entity) : null);
watch(() => detailPhoto.value?.url, () => { photoFailed.value = false; });
const route = useRoute();
// An explicit module link selects its tab before the existing mounted loader runs.
if (isModuleTab('knowledge', route.query.tab)) store.activeTab = route.query.tab;
useKnowledgeLeaveGuard(() => caseBuilder.value?.requestLeave() ?? Promise.resolve(true));
onBeforeRouteUpdate(async (to, from) => {
  if (to.query.tab === from.query.tab) return true;
  const next = isModuleTab('knowledge', to.query.tab) ? to.query.tab : 'browse';
  if (next === store.activeTab) return true;
  await auth.check();
  if (auth.blocked || !(await (caseBuilder.value?.requestLeave() ?? Promise.resolve(true))) || !(await store.allowLeave())) return false;
  await store.changeTab(next);
  return !auth.blocked;
});
// 页签与维护筛选只保留一份状态，离开再返回时显示与读取目标一致。
const tab = computed<string>({
  get: () =>
    store.activeTab === 'browse'
      ? '图谱浏览'
      : store.activeTab === 'changes'
        ? '知识维护'
        : '版本记录',
  set: (value: string) => {
    void store.changeTab(
      value === '图谱浏览' ? 'browse' : value === '知识维护' ? 'changes' : 'versions',
    );
  },
});
const stateFilter = computed({
  get: () => store.changeState ?? '',
  set: (state: string) => {
    store.changeState = state ? (state as KnowledgeState) : undefined;
    store.historyPage = 1;
    void store.refreshTab();
  },
});
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
const selectedRelation = computed(
  () =>
    store.graph?.relations.find((r) => r.id === store.relationId) ??
    store.detail?.relations.find((r) => r.id === store.relationId),
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
  (store.workspace?.changes ?? []).map((c) => ({
    ...c,
    summary: knowledgeText('content' in c ? c.content.summary : c.summary),
    author: knowledgeText(store.actorName(c.authorId, 'change:' + c.id)),
    base: 'content' in c ? c.content.baseVersionId : c.baseVersionId,
  })),
);
const versions = computed(() =>
  (store.workspace?.versions ?? []).map((v) => ({
    ...v,
    summary: knowledgeText(v.summary),
    label: 'v' + v.number,
    state: v.id === store.current?.id ? '当前已发布' : '历史已发布',
    kindLabel: v.kind === 'ROLLBACK' ? '回滚发布' : v.kind === 'BASELINE' ? '初始基线' : '审核发布',
    author: knowledgeText(store.actorName(v.actorId, 'version:' + v.id)),
  })),
);
const actionNames: Record<string, string> = {
  REVIEW: '审核',
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
  (store.workspace?.logs ?? []).map((l) => ({
    ...l,
    opinion: knowledgeAttributeValue(l.opinion),
    author: knowledgeText(store.actorName(l.actorId, 'log:' + l.id)),
    actionName: actionNames[l.action] ?? knowledgeText(l.action),
  })),
);
const entityName = (id: string) =>
  knowledgeEntityName(store.graph?.entities.find((e) => e.id === id) ??
  store.detail?.neighbors.find((e) => e.id === id) ?? { name: id, type: '' });
const typeName = (id: string) => knowledgeTypeName(id, store.catalog.types.find((t) => t.id === id)?.name);
const relationName = (id: string) =>
  knowledgeRelationName(id, store.catalog.relationTypes.find((t) => t.id === id)?.name);
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
// 入口只消费一次；版本刷新沿用用户当前选择，不重放旧 URL 覆盖后续检索。
let consumedEntityId: string | undefined;
watch(
  () => [route.query.entityId, store.current?.id],
  () => {
    const id = route.query.entityId;
    if (typeof id !== 'string') {
      consumedEntityId = undefined;
      return;
    }
    if (!store.current || consumedEntityId === id) return;
    consumedEntityId = id;
    store.activeTab = 'browse';
    void store.selectEntity(id, true);
  },
  { immediate: true },
);
</script>
<style scoped>
.knowledge-page {
  --kg-surface: #0d1929;
  --kg-detail-surface: #101d30;
  --kg-border: #293d53;
  --kg-text: #bed3e6;
  --kg-muted: #8fa9c3;
  --kg-hover: #152a40;
  --kg-selection: #173753;
  --kg-selection-border: #39749c;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.knowledge-page.kg-light {
  --kg-surface: #fff;
  --kg-detail-surface: #fff;
  --kg-border: #dce5ef;
  --kg-text: #29415d;
  --kg-muted: #647a92;
  --kg-hover: #f0f5fc;
  --kg-selection: #eaf1ff;
  --kg-selection-border: #a8c4ff;
}
.knowledge-page .page-heading { min-height: 36px; margin-bottom: 8px; }
.knowledge-page .page-heading h1 { margin: 0; font-size: 20px; }
.knowledge-page > :not(.knowledge-panel),
.knowledge-panel > .tabs { flex-shrink: 0; }
.knowledge-panel {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: visible;
  overflow-anchor: none;
}
.kg-heading-tools { flex-wrap: wrap; gap: 8px; }
.kg-heading-tools .chip { font-size: var(--font-secondary); padding: 4px 8px; }
.kg-heading-tools .btn { font-size: var(--font-control); padding: 7px 10px; }
.kg-context {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--kg-muted);
  font-size: var(--font-secondary);
  line-height: 1.5;
  flex-wrap: wrap;
}
.kg-context button:first-of-type { margin-left: auto; }
.kg-workspace {
  display: grid;
  grid-template-columns: 212px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1 1 0;
  min-height: 430px;
}
.kg-workspace.details-open { grid-template-columns: 212px minmax(0, 1fr) 280px; }
.kg-filters,
.kg-detail { min-width: 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.kg-filters {
  padding: 12px 10px;
  background: var(--kg-surface);
  border-right: 1px solid var(--kg-border);
}
.kg-filters h3 { margin: 0 0 8px; font-size: var(--font-body); }
.kg-category {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 6px;
  border: 1px solid var(--kg-border);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  font-size: var(--font-secondary);
}
.kg-category:hover,
.kg-entity:hover { background: var(--kg-hover); }
.kg-category-name { flex: 1; min-width: 0; }
.kg-category > .pi { flex-shrink: 0; color: var(--kg-muted); }
.kg-category input { width: 14px; height: 14px; margin: 0; flex-shrink: 0; accent-color: #3b82f6; }
.kg-category small { margin-left: auto; min-width: 22px; text-align: right; font-variant-numeric: tabular-nums; color: var(--kg-muted); }
.kg-filters > .section-gap { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--kg-border); font-size: var(--font-secondary); }
.kg-filters select,
.kg-filters input:not([type='checkbox']) { min-width: 0; width: 100%; font-size: var(--font-control); padding: 7px 8px; }
.kg-search { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.kg-search label { width: 100%; font-size: var(--font-secondary); }
.kg-search button { margin-left: auto; }
.kg-search-note { padding: 6px 10px; color: var(--kg-muted); font-size: var(--font-secondary); line-height: 1.5; }
.kg-list-heading { display: flex; justify-content: space-between; gap: 6px; border-top: 1px solid var(--kg-border); padding: 9px 0; font-size: var(--font-secondary); color: var(--kg-muted); }
.kg-entity {
  display: block;
  width: 100%;
  padding: 7px 8px;
  text-align: left;
  background: transparent;
  color: var(--kg-text);
  border: 1px solid transparent;
  border-radius: 5px;
  margin: 3px 0;
}
.kg-entity.selected { background: var(--kg-selection); border-color: var(--kg-selection-border); }
.kg-entity strong { font-size: var(--font-control); line-height: 1.6; }
.kg-entity small { display: block; font-size: var(--font-caption); color: var(--kg-muted); margin-top: 3px; overflow-wrap: anywhere; }
.kg-pager { display: flex; align-items: center; justify-content: space-between; font-size: var(--font-caption); margin-top: 10px; gap: 6px; }
.kg-pager button { font-size: var(--font-control); padding: 5px 7px; }
.kg-stage { min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
.kg-stage > .knowledge-canvas { flex: 1 1 0; min-height: 0; height: auto; }
.kg-graph-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--kg-border); flex-wrap: wrap; }
.kg-graph-toolbar .btn { font-size: var(--font-control); padding: 6px 8px; }
.kg-detail-toggle { margin-left: auto; }
.kg-graph-note { margin: 0; font-size: var(--font-secondary); color: var(--kg-muted); padding: 7px 10px; border-top: 1px solid var(--kg-border); }
.kg-graph-note i { margin-right: 6px; }
.kg-detail { padding: 12px 14px; background: var(--kg-detail-surface); border-left: 1px solid var(--kg-border); overflow-wrap: anywhere; }
.kg-detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 9px; margin-bottom: 10px; border-bottom: 1px solid var(--kg-border); font-size: var(--font-control); }
.kg-detail-heading button { font-size: var(--font-secondary); }
.kg-detail > small { display: block; color: var(--kg-muted); margin-top: 5px; font-size: var(--font-caption); }
.kg-detail .eyebrow { margin: 0 0 5px; font-size: var(--font-caption); color: var(--kg-muted); }
.kg-detail h3 { margin: 0; font-size: 14px; line-height: 1.5; }
.kg-detail h4 { font-size: var(--font-control); }
.kg-detail .section-gap { margin-top: 12px; }
.kg-detail .kv { grid-template-columns: 84px minmax(0, 1fr); gap: 8px 10px; font-size: var(--font-control); }
.kg-detail .kv dd { margin: 0; white-space: pre-wrap; }
.kg-description { font-size: var(--font-control); line-height: 1.7; color: var(--kg-text); margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.kg-related { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 9px 0; border-bottom: 1px solid var(--kg-border); }
.kg-related small { font-size: var(--font-caption); color: var(--kg-muted); }
.knowledge-photo { margin: 10px 0; padding: 9px; background: #f5f7fa; border-radius: 6px; color: #304963; }
.knowledge-photo img { width: 100%; max-height: 120px; object-fit: contain; }
.knowledge-photo figcaption { margin-top: 6px; font-size: var(--font-caption); line-height: 1.5; }
.knowledge-photo small { display: block; font-size: var(--font-caption); color: #60758a; }
.kg-error { margin: 10px; padding: 10px; color: #ffb6b6; background: #3c2534; border-radius: 5px; line-height: 1.6; }
.kg-progress { position: absolute; top: 48px; left: 12px; z-index: 1; font-size: var(--font-secondary); color: var(--kg-muted); }
.toolbar.spread select { width: 165px; }
@media (max-width: 1100px) {
  .kg-workspace { grid-template-columns: 190px minmax(0, 1fr); }
  .kg-workspace.details-open { grid-template-columns: 190px minmax(0, 1fr) 260px; }
}
@media (max-width: 950px) {
  .knowledge-page { height: auto; min-height: 100%; }
  .knowledge-panel { flex: none; }
  .kg-workspace,
  .kg-workspace.details-open { flex: none; min-height: 0; grid-template-columns: 190px minmax(0, 1fr); grid-template-rows: auto; align-items: start; }
  .kg-filters { max-height: 560px; }
  .kg-detail { grid-column: 1 / -1; max-height: none; overflow-y: visible; border-left: 0; border-top: 1px solid var(--kg-border); }
  .kg-stage > .knowledge-canvas { flex: none; height: auto; }
  .kg-stage > .knowledge-canvas :deep(.canvas) { flex: 0 0 360px; height: 360px; min-height: 360px; }
}
@media (max-width: 600px) {
  .kg-workspace,
  .kg-workspace.details-open { grid-template-columns: minmax(0, 1fr); min-height: 0; }
  .kg-filters { max-height: 300px; border-right: 0; border-bottom: 1px solid var(--kg-border); }
  .kg-detail { grid-column: auto; }
}
</style>
