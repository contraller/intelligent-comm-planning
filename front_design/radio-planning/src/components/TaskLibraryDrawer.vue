<template>
  <AppDrawer
    :visible="visible"
    title="已保存任务"
    subtitle="打开后可继续编辑；规划运行记录与方案快照单独保留。"
    @update:visible="emit('update:visible', $event)"
  >
    <input
      v-model="query"
      placeholder="搜索任务名称或 ID"
      aria-label="搜索已保存任务"
    />
    <p
      v-if="!rows.length"
      class="muted"
      >暂无匹配任务</p
    >
    <article
      v-for="task in rows"
      :key="task.id"
      class="task-row"
      ><strong>{{ task.versions.at(-1)!.input.name }}</strong
      ><small
        >{{ task.id }} · 输入 V{{ task.versions.length }} ·
        {{ task.versions.at(-1)!.savedAt }}</small
      ><button
        class="btn small"
        :disabled="planning.locked || gis.busy"
        @click="open(task.id)"
        >打开任务</button
      ></article
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import AppDrawer from './AppDrawer.vue';
import { ref, computed } from 'vue';
import { usePlanningStore } from '../stores/planning';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
const props = defineProps<{ visible: boolean; context: 'gis' | 'planning' }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const planning = usePlanningStore(),
  gis = useGisWorkspaceStore(),
  query = ref('');
const rows = computed(() =>
  planning.tasks.tasks.filter((t) =>
    (t.id + ' ' + t.versions.at(-1)!.input.name).includes(query.value),
  ),
);
async function open(id: string) {
  // GIS 切换任务前先处理整体草稿，不能只保存其中一部分。
  if (props.context === 'gis' && !(await gis.leave())) return;
  if (await planning.openTask(id)) emit('update:visible', false);
}
</script>
<style scoped>
.task-row {
  display: grid;
  gap: 10px;
  padding: 16px 0;
  border-bottom: 1px solid #29415a;
}
small {
  color: #8ea7c2;
  overflow-wrap: anywhere;
}
</style>
