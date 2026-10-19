<template>
  <section class="task-workspace">
    <div class="toolbar"
      ><button
        class="btn small"
        :disabled="locked || !auth.can('planning.execute')"
        @click="newTask"
        >新建任务</button
      ><button
        class="btn small"
        :disabled="locked"
        @click="library = true"
        >打开任务</button
      ><button
        class="btn small"
        :disabled="locked || !auth.can('planning.execute')"
        @click="openImport"
        >导入任务</button
      ><button
        class="btn primary small"
        :disabled="locked || !auth.can('planning.execute')"
        @click="context === 'gis' ? gis.save() : planning.saveTask()"
        >{{ context === 'gis' ? '整体保存' : '保存任务' }}</button
      ></div
    >
    <div
      v-if="context === 'gis'"
      class="toolbar"
      ><button
        class="btn small"
        :disabled="locked || !gis.undoStack.length"
        @click="gis.moveHistory('undo')"
        >撤销编辑</button
      ><button
        class="btn small"
        :disabled="locked || !gis.redoStack.length"
        @click="gis.moveHistory('redo')"
        >重做编辑</button
      ></div
    >
    <p class="muted"
      >{{ planning.taskId ?? '新任务' }} ·
      {{ planning.needsTaskSave ? '任务尚未保存' : '任务已保存'
      }}<span v-if="planning.savedTask"> · V{{ planning.savedTask.number }}</span></p
    >
    <p
      v-if="planning.error"
      role="alert"
      class="error"
      >{{ planning.error }}</p
    ><p
      v-if="planning.notice"
      class="muted"
      >{{ planning.notice }}</p
    >
    <PlanningTaskForm
      ref="formRef"
      :gis-validation="context === 'gis'"
      @locate-issue="emit('locateIssue', $event)"
      v-if="planning.draft"
      :key="planning.taskId ?? 'new'"
      :model-value="planning.draft"
      :resources="resources"
      :presets="planning.presets"
      :locked="locked"
      :issues="context === 'gis' ? gis.taskIssues : planning.issues"
      :show-submit="context === 'planning'"
      :submit-disabled="planning.needsTaskSave || planning.formDirty || !!planning.importRequest"
      :selected-demand-id="selectedDemandId"
      @update:model-value="planning.updateDraft"
      @preset="planning.applyPreset"
      @remove="remove"
      @submit="planning.submit"
      @pending="planning.formDirty = $event"
    />
    <TaskLibraryDrawer
      v-model:visible="library"
      :context="context"
    /><TaskImportDrawer
      :context="context"
      :changes="changes"
    />
  </section>
</template>
<script setup lang="ts">
import { ref, computed, toRaw } from 'vue';
import { usePlanningStore } from '../stores/planning';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useAuthStore } from '../stores/auth';
import type { PlanningIssue } from '../types/planning';
import type { ResourcesData } from '../types/domain';
import type { ResourceChanges } from '../types/resource-edit';
import PlanningTaskForm from './PlanningTaskForm.vue';
import TaskLibraryDrawer from './TaskLibraryDrawer.vue';
import TaskImportDrawer from './TaskImportDrawer.vue';
const props = defineProps<{
  context: 'gis' | 'planning';
  resources: ResourcesData;
  changes?: ResourceChanges;
  selectedDemandId?: string;
}>();
// 独立规划页不启用 GIS 错误定位；表单仍由原组件持有。
const emit = defineEmits<{ locateIssue: [issue: PlanningIssue] }>();
const formRef = ref<InstanceType<typeof PlanningTaskForm>>();
defineExpose({
  validationReason: (issue: PlanningIssue) =>
    formRef.value?.validationReason(issue) ?? '任务输入尚未加载',
  focusValidationIssue: (issue: PlanningIssue) =>
    formRef.value?.focusValidationIssue(issue) ?? Promise.resolve(false),
});
const planning = usePlanningStore(),
  gis = useGisWorkspaceStore(),
  auth = useAuthStore(),
  library = ref(false);
const locked = computed(() => planning.locked || gis.busy);
async function newTask() {
  if (props.context === 'gis' && !(await gis.leave())) return;
  await planning.newTask();
}
async function remove(id: string) {
  if (locked.value || !planning.draft) return;
  if (
    (await planning.ask({
      title: '移除通联需求',
      message: '只修改当前任务草稿，保存前不会影响已有方案。',
      saveLabel: '确认移除',
    })) !== 'save'
  )
    return;
  // 移除需求时也保留尚未完成的数值，避免 JSON 将 NaN 变成空值。
  planning.updateDraft({
    ...structuredClone(toRaw(planning.draft)),
    demands: planning.draft.demands.filter((d) => d.id !== id),
  });
}
async function openImport() {
  if (planning.formDirty) {
    try {
      planning.prepareTask();
    } catch {
      return;
    }
  }
  planning.importOpen = true;
}
</script>
<style scoped>
.task-workspace {
  min-width: 0;
  padding: 12px;
  overflow: auto;
}
.toolbar {
  flex-wrap: wrap;
  gap: 8px;
}
.muted {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.error {
  color: #f2b28c;
  font-size: 12px;
}
</style>
