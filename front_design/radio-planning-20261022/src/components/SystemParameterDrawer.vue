<template>
  <AppDrawer
    :visible="!!store.parameterForm"
    title="参数配置"
    @update:visible="!$event && store.allowLeave()"
  >
    <fieldset
      v-if="store.parameterForm"
      :disabled="!store.canSave || store.parameterForm.readonly"
      class="parameter-form"
    >
      <h3>{{ store.parameterForm.name }}</h3
      ><p>{{ store.parameterForm.description }}</p>
      <label
        >值（{{ store.parameterForm.unit || '固定坐标系' }}）<input
          v-if="store.parameterForm.readonly"
          :value="store.parameterForm.value"
          readonly /><input
          v-else
          v-model.number="store.parameterForm.value"
          type="number"
          step="1"
          :min="store.parameterForm.min ?? undefined"
          :max="store.parameterForm.max ?? undefined"
      /></label>
      <p v-if="!store.parameterForm.readonly"
        >范围：{{ store.parameterForm.min }}–{{ store.parameterForm.max }}，仅接受整数。</p
      >
    </fieldset>
    <p v-if="store.parameterForm && !store.parameterForm.readonly"
      >保存差异：{{
        store.parameters?.items.find((p) => p.id === store.parameterForm?.id)?.value
      }}
      → {{ store.parameterForm.value }} {{ store.parameterForm.unit }}</p
    >
    <p class="notice"
      >{{ store.parameterForm?.applicationState === 'STORED_ONLY' ? '服务端参数已存储；存储不代表本标签或其他标签已应用。' : store.parameterForm?.applicationState === 'APPLIED' ? '当前参数约定已应用。' : '参数作用域以当前运行配置为准。' }}
      {{ store.parameterForm?.appliesTo }}。WGS84 / EPSG:4326 保持只读。</p
    ><p v-if="localApplication" class="notice" role="status"
      >本标签状态：{{ localApplication.applied ? '本标签已应用' : '本标签未应用' }}。
      <template v-if="localApplication.snapshot">运行快照：{{ localApplication.snapshot.epoch }} / {{ localApplication.snapshot.revision }}，实际值 {{ localApplication.value }} {{ store.parameterForm?.unit }}。</template>
      <template v-else>当前无可核实的运行参数快照。</template>
      不代表其他标签的应用状态。</p
    ><p
      v-if="store.error"
      role="alert"
      >{{ store.error }}</p
    >
    <template #footer
      ><button
        class="btn"
        :disabled="store.busy"
        @click="store.allowLeave()"
        >关闭</button
      ><button
        class="btn primary"
        :disabled="!store.canSave || store.parameterForm?.readonly"
        @click="store.save()"
        >保存参数</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useSystemStore } from '../stores/system';
import { useRuntimeParametersStore } from '../stores/runtime-parameters';
import AppDrawer from './AppDrawer.vue';
const store = useSystemStore();
const runtime = useRuntimeParametersStore();
const localApplication = computed(() => {
  const id = store.parameterForm?.id;
  if (id !== 'PAR-01' && id !== 'PAR-02') return null;
  const snapshot = runtime.snapshot;
  const consumer = id === 'PAR-01' ? 'gis.device-status-directory' : 'http.request-timeout';
  const applied = !!snapshot && !runtime.loading && !runtime.error && runtime.applications.some(item =>
    item.consumer === consumer && item.epoch === snapshot.epoch && item.revision === snapshot.revision);
  return { snapshot, applied, value: snapshot?.values[id] };
});
// 两种数据模式共用参数表单；参数实际生效范围仍以当前说明为准。
</script>
<style scoped>
.parameter-form {
  border: 0;
  padding: 0;
  display: grid;
  gap: 16px;
}
.parameter-form label {
  display: grid;
  gap: 10px;
}
p {
  line-height: 1.8;
}
</style>
