<template>
  <div class="read-tree">
    <template v-if="!ancestors.length"
      ><div
        v-if="cluster"
        class="tree-caption"
        >聚合成员 · {{ cluster.count }} 个
        <button
          class="text-link"
          @click="emit('clearCluster')"
          >返回资源树</button
        ></div
      >
      <div
        v-else
        class="tabs"
        ><button
          :class="{ active: kind === 'node' }"
          :disabled="store.frozen"
          @click="mode = 'node'"
          >节点</button
        ><button
          :class="{ active: kind === 'interference' }"
          :disabled="store.frozen"
          @click="mode = 'interference'"
          >干扰源</button
        ></div
      >
    </template>
    <p
      v-if="store.pending[channel]"
      class="tree-caption"
      >正在读取…</p
    >
    <p
      v-if="store.errors[channel]"
      class="tree-caption"
      role="alert"
      >{{ store.errors[channel] }}
      <button
        class="text-link"
        :disabled="store.frozen"
        @click="load"
        >重试</button
      ></p
    >
    <ul
      ><li
        v-for="row in rows"
        :key="row.id"
      >
        <div class="tree-row"
          ><button
            v-if="
              row.kind === 'node' &&
              row.childCount &&
              !ancestors.includes(row.id) &&
              !cluster &&
              !filter.search
            "
            class="expand"
            :disabled="store.frozen"
            :aria-label="(expanded.includes(row.id) ? '收起' : '展开') + row.name"
            @click="
              expanded = expanded.includes(row.id)
                ? expanded.filter((id) => id !== row.id)
                : [...expanded, row.id]
            "
            >{{ expanded.includes(row.id) ? '−' : '+' }}</button
          >
          <button
            class="object"
            :disabled="store.frozen"
            @click="emit('select', row.kind, row.id)"
            ><span>{{ row.name }}</span
            ><small
              >{{ row.id
              }}{{ row.kind === 'node' ? ' · ' + row.deviceCount + ' 台设备' : '' }}</small
            ></button
          ></div
        >
        <p
          v-if="ancestors.includes(row.id)"
          class="tree-caption"
          >循环关联，停止展开。</p
        >
        <ResourceReadTree
          v-else-if="row.kind === 'node' && expanded.includes(row.id)"
          :parent-id="row.id"
          :ancestors="[...ancestors, row.id]"
          :filter="filter"
          @select="(kind, id) => emit('select', kind, id)"
        /> </li
    ></ul>
    <p
      v-if="result && !rows.length && !store.pending[channel]"
      class="tree-caption"
      >暂无匹配资源</p
    >
    <div
      v-if="result && result.revision === store.workspace?.revision"
      class="pager"
      ><button
        class="btn small"
        :disabled="store.frozen || result.page <= 1"
        @click="
          page = result.page - 1;
          load();
        "
        >上页</button
      ><small
        >{{ result.total }} 项 · {{ result.page }}/{{
          Math.max(1, Math.ceil(result.total / 10))
        }}</small
      ><button
        class="btn small"
        :disabled="store.frozen || result.page * 10 >= result.total"
        @click="
          page = result.page + 1;
          load();
        "
        >下页</button
      ></div
    >
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useResourceReadStore } from '../stores/resource-read';
import type {
  ReadInterference,
  ReadNode,
  ResourceMapCluster,
  ResourcePage,
  ResourceReadFilter,
} from '../types/resource-read';
const props = withDefaults(
  defineProps<{
    parentId?: string | null;
    ancestors?: string[];
    filter?: ResourceReadFilter;
    cluster?: ResourceMapCluster | null;
  }>(),
  { parentId: null, ancestors: () => [], filter: () => ({}), cluster: null },
);
const emit = defineEmits<{
  select: [kind: 'node' | 'interference', id: string];
  clearCluster: [];
}>();
const store = useResourceReadStore(),
  mode = ref<'node' | 'interference'>('node'),
  page = ref(1),
  expanded = ref<string[]>([]);
const result = ref<ResourcePage<ReadNode | ReadInterference> | null>(null);
const kind = computed(() => props.cluster?.kind ?? (props.ancestors.length ? 'node' : mode.value));
const channel = computed(() => `tree:${props.ancestors.join('/') || 'root'}:${kind.value}`);
const rows = computed(() =>
  result.value && result.value.revision === store.workspace?.revision ? result.value.items : [],
);
let ticket = 0;
async function load() {
  if (!store.workspace) return;
  const token = ++ticket;
  const query = {
    ...props.filter,
    page: page.value,
    pageSize: 10,
    sort: 'id' as const,
    clusterId: props.cluster?.id,
    parentId: props.cluster || props.filter.search ? undefined : props.parentId,
  };
  const value =
    kind.value === 'node'
      ? await store.fetchNodes(query, channel.value)
      : await store.fetchInterferences({ ...query, parentId: undefined }, channel.value);
  if (value && token === ticket) result.value = value;
}
watch(
  () => [
    store.workspace?.revision,
    store.refreshKey,
    props.filter,
    props.cluster,
    kind.value,
    props.parentId,
  ],
  () => {
    ticket++;
    page.value = 1;
    expanded.value = [];
    void load();
  },
  { immediate: true, deep: true },
);
onBeforeUnmount(() => {
  ticket++;
  store.cancelGroup(channel.value);
});
</script>
<style scoped>
.read-tree ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.read-tree .read-tree {
  padding-left: 12px;
  border-left: 1px solid var(--line);
  margin-left: 8px;
}
.tree-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--line);
}
.object {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text);
  padding: 10px 5px;
  text-align: left;
  cursor: pointer;
}
.object small {
  font-size: 10px;
  color: var(--muted);
}
.object:hover {
  background: #203249;
}
.expand {
  border: 0;
  background: transparent;
  color: #83b7dc;
  font-size: 18px;
  padding: 4px 8px;
  cursor: pointer;
}
.tree-caption {
  font-size: 12px;
  line-height: 1.7;
  padding: 8px;
  color: var(--muted);
}
.pager {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 5px;
  margin: 12px 2px;
}
.pager small {
  font-size: 10px;
}
</style>
