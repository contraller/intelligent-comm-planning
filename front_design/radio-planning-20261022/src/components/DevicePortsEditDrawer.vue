<template>
  <AppDrawer
    :visible="visible"
    title="维护实例端口"
    :subtitle="context === 'gis' ? '应用到草稿后统一保存。' : '明确保存当前设备；状态和身份只读。'"
    @update:visible="!$event && $emit('close')"
  >
    <template v-if="form"
      ><p>设备 {{ form.id }} · 勾选同一设备的端口，可批量修改同一属性。</p>
      <p v-if="!editable">当前只读，输入仍保留。</p>
      <fieldset :disabled="!editable || busy"
        ><legend>批量编辑</legend
        ><label
          >维护字段<select v-model="batchField"
            ><option
              v-for="key in portFields"
              :key="key"
              :value="key"
              >{{ labels[key] }}</option
            ></select
          ></label
        ><label
          >批量值（留空表示未提供）<input
            type="number"
            step="any"
            aria-label="端口批量值"
            @input="batch(($event.target as HTMLInputElement).value)" /></label
        ><p>已选 {{ selected.length }} 个；批量修改后须统一校验保存。</p>
        <article
          v-for="port in ports"
          :key="port.id"
          ><label
            ><input
              v-model="selected"
              type="checkbox"
              :value="port.id"
            />{{ port.number }} ·
            {{ port.type === 'RF' ? '射频' : '业务' }}（编号、类型只读）</label
          >
          <label
            v-for="key in portFields.filter((key) => port.type === 'RF' || key === 'rateKbps')"
            :key="key"
            >{{ labels[key]
            }}<input
              type="number"
              step="any"
              :aria-label="port.number + ' ' + labels[key]"
              :value="port[key] ?? ''"
              @input="change([port.id], key, ($event.target as HTMLInputElement).value)"
          /></label>
        </article> </fieldset
      ><p v-if="!ports.length">未提供可维护的实例端口。</p>
      <p
        v-if="error"
        role="alert"
        >{{ error }}</p
      ><ul
        ><li
          v-for="issue in issues"
          :key="issue.field + issue.message"
          >{{ issue.message }}</li
        ></ul
      ><p role="status">{{ message }}</p>
      <button
        class="btn primary"
        :disabled="!editable || busy || !ports.length"
        @click="$emit('submit')"
        >{{ busy ? '处理中…' : context === 'gis' ? '应用到草稿' : '保存当前设备' }}</button
      >
    </template>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { portFields } from '../services/device-maintenance';
import type { DevicePort } from '../types/device-maintenance';
import type { EditForm, ResourceIssue } from '../types/resource-edit';
const props = defineProps<{
  visible: boolean;
  form: EditForm | null;
  context: 'gis' | 'ledger';
  editable: boolean;
  busy: boolean;
  error: string;
  message: string;
  issues: ResourceIssue[];
}>();
const emit = defineEmits<{ close: []; submit: []; ports: [ports: DevicePort[]] }>();
const ports = computed<DevicePort[]>(() => {
    try {
      return JSON.parse(props.form?.fields.ports || '[]');
    } catch {
      return [];
    }
  }),
  selected = ref<string[]>([]),
  batchField = ref<(typeof portFields)[number]>('rateKbps');
watch(
  () => props.form?.id,
  () => {
    selected.value = [];
  },
);
const labels: Record<(typeof portFields)[number], string> = {
  freqMinKhz: '频段下限 kHz',
  freqMaxKhz: '频段上限 kHz',
  rateKbps: '速率 kbps',
  gainDbi: '天线增益 dBi',
  heightM: '天线高度 m',
  azimuthDeg: '方位角 °',
  tiltDeg: '俯仰角 °',
};
// 每次输入立即交原编辑 store，尚未保存的批量值同样触发离页保护。
function change(ids: string[], field: (typeof portFields)[number], raw: string) {
  if (!props.editable || props.busy) return;
  const value = raw === '' ? null : Number(raw);
  if (value !== null && !Number.isFinite(value)) return;
  emit(
    'ports',
    ports.value.map((port) => (ids.includes(port.id) ? { ...port, [field]: value } : port)),
  );
}
function batch(raw: string) {
  change(selected.value, batchField.value, raw);
}
</script>
<style scoped>
fieldset {
  border: 1px solid var(--line);
  padding: 12px;
}
article {
  border-top: 1px solid var(--line);
  margin-top: 14px;
  padding-top: 10px;
}
label {
  display: block;
  margin: 10px 0;
  font-size: 12px;
}
input:not([type='checkbox']),
select {
  width: 100%;
  margin-top: 5px;
  padding: 8px;
}
p {
  overflow-wrap: anywhere;
  font-size: 12px;
}
</style>
