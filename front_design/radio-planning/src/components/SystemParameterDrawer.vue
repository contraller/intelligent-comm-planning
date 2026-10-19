<template>
  <AppDrawer
    :visible="!!store.parameterForm"
    title="演示参数"
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
      >状态采集间隔用于设备与链路态势，下一轮采用新周期。频谱按采集源周期刷新；规划、诊断轮询和 HTTP
      超时保持原规则，设备配置不受影响。WGS84 / EPSG:4326 保持只读。</p
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
        >保存演示值</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { useSystemStore } from '../stores/system';
import AppDrawer from './AppDrawer.vue';
const store = useSystemStore();
// PAR-01 仅控制态势观测播放周期；其他参数仍沿用原演示边界。
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
