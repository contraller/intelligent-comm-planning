<template>
  <!-- 已有页签负责切换，知识正文直接呈现，内部分类仍可折叠。 -->
  <section class="device-knowledge">
    <h4 class="knowledge-heading"
      ><i class="pi pi-book" />运维知识
      <small>{{ store.current ? '已发布 v' + store.current.number : '独立知识库' }}</small></h4
    >
    <p class="muted">按设备型号 {{ modelId }} 关联 · 知识说明不修改设备参数</p>
    <form
      v-if="auth.can('knowledge.view')"
      class="search-row"
      @submit.prevent="load"
    >
      <input
        v-model="query"
        aria-label="检索设备运维知识"
        placeholder="搜索名称、关键词、描述或步骤"
      /><button class="btn small">检索</button>
    </form>
    <p
      v-if="!auth.can('knowledge.view')"
      class="muted"
      >当前角色没有知识查看权限。</p
    >
    <div
      v-else-if="store.loadError || error"
      class="error"
      role="alert"
      >{{ store.loadError || error
      }}<button
        class="text-link"
        @click="retry"
        >重试</button
      ></div
    >
    <p
      v-else-if="loading || store.loading"
      class="muted"
      >正在读取已发布知识…</p
    >
    <p
      v-else-if="!data?.items.length"
      class="empty-inline"
      >暂无匹配的已发布型号知识</p
    >
    <template v-else>
      <details
        v-for="group in groups"
        :key="group.type"
        class="group"
        open
      >
        <summary>{{ group.name }} · {{ group.items.length }} 项</summary>
        <article
          v-for="item in group.items"
          :key="item.entity.id"
        >
          <strong>{{ item.entity.name }}</strong
          ><p>{{ item.entity.description }}</p>
          <!-- 图与文字来自同一次型号知识查询；重查卸载旧全屏。 -->
          <KnowledgePrincipleFlow
            :entity="item.entity"
            :context="'已发布 · ' + data!.versionId"
          />
          <p
            v-for="a in item.entity.attributes"
            :key="a.name"
            >{{ a.name }}：{{ a.value }} {{ a.unit }}</p
          >
          <small>来源：{{ item.entity.source }}</small>
          <p
            v-for="r in applicableRelations(item)"
            :key="r.id"
            class="related"
            >{{ store.catalog.relationTypes.find((t) => t.id === r.type)?.name }} ·
            {{
              item.neighbors.find((n) => n.id === (r.head === item.entity.id ? r.tail : r.head))
                ?.name
            }}</p
          >
          <RouterLink
            class="text-link"
            :to="{ path: '/knowledge', query: { entityId: item.entity.id } }"
            >在知识图谱查看</RouterLink
          >
        </article>
      </details>
      <small class="version">发布快照：{{ data.versionId }}</small>
    </template>
  </section>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useKnowledgeStore } from '../stores/knowledge';
import { previewService } from '../services';
import type { DeviceKnowledge, KnowledgeDetail } from '../types/knowledge';
import KnowledgePrincipleFlow from './KnowledgePrincipleFlow.vue';
const props = defineProps<{ modelId: string }>();
const store = useKnowledgeStore();
const query = ref(''),
  data = ref<DeviceKnowledge | null>(null),
  error = ref(''),
  loading = ref(false);
let generation = 0;
const groups = computed(() =>
  [...new Set(data.value?.items.map((x) => x.entity.type) ?? [])].map((type) => ({
    type,
    name: store.catalog.types.find((t) => t.id === type)?.name ?? type,
    items: data.value!.items.filter((x) => x.entity.type === type),
  })),
);
// 与型号摘要沿用同一适用范围；整库详情仍保留完整邻居，通用关联可继续展示。
function applicableRelations(item: KnowledgeDetail) {
  return item.relations.filter((relation) => {
    const neighbor = item.neighbors.find(
      (entity) => entity.id === (relation.head === item.entity.id ? relation.tail : relation.head),
    );
    return neighbor && (!neighbor.modelIds.length || neighbor.modelIds.includes(props.modelId));
  });
}
async function load() {
  const token = ++generation;
  data.value = null;
  error.value = '';
  loading.value = false;
  if (!auth.can('knowledge.view') || !store.current || store.loadError) return;
  loading.value = true;
  try {
    const result = await previewService.getDeviceKnowledge({
      versionId: store.current.id,
      modelId: props.modelId,
      search: query.value,
    });
    if (token === generation) data.value = result;
  } catch (e) {
    if (token === generation) error.value = e instanceof Error ? e.message : '知识查询失败';
  } finally {
    if (token === generation) loading.value = false;
  }
}
async function retry() {
  if (!auth.can('knowledge.view')) return;
  await store.ensureMetadata();
  await load();
}
watch(() => [props.modelId, store.current?.id, store.loadError, auth.generation], load, {
  immediate: true,
});
// 独立查询错误不阻断设备信息；发布指针变化后只刷新知识区域。
onMounted(() => {
  if (auth.can('knowledge.view') && !store.workspace && !store.loading) void store.ensureMetadata();
  window.addEventListener('focus', retry);
});
onBeforeUnmount(() => {
  generation++;
  window.removeEventListener('focus', retry);
});
</script>
<style scoped>
.knowledge-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #bbd8ee;
  font-size: 12px;
  font-weight: 600;
}
.knowledge-heading small {
  margin-left: auto;
  font-weight: 400;
}
.device-knowledge > p {
  font-size: 11px;
  line-height: 1.7;
  margin: 12px 0;
}
.search-row {
  display: flex;
  gap: 6px;
  margin: 12px 0;
}
.search-row input {
  min-width: 0;
}
.group {
  margin: 12px 0;
  padding: 10px;
  background: #101e30;
  border: 1px solid #263a52;
  border-radius: 5px;
}
.group > summary {
  cursor: pointer;
  color: #92bddc;
  font-size: 12px;
}
article {
  padding: 12px 0;
  border-bottom: 1px solid #2a3a50;
}
article:last-child {
  border-bottom: 0;
}
article p {
  font-size: 12px;
  margin: 9px 0;
  line-height: 1.7;
  white-space: pre-wrap;
}
.related,
small.version {
  color: #809db7;
  font-size: 10px;
}
.error {
  color: #ffb4b4;
  line-height: 1.6;
}
.error button {
  display: block;
  margin-top: 8px;
}
.version {
  overflow-wrap: anywhere;
}
</style>
