<template>
  <AppDrawer :visible="visible" :title="mode === 'ADD' ? '新增构造频点' : '编辑构造频点'" @update:visible="!$event && emit('close')">
    <p class="notice">人工构造，非正式频率授权</p>
    <p v-if="error || localError" role="alert" class="error">{{ localError || error }}</p>
    <form class="frequency-edit" @submit.prevent="submit">
      <fieldset :disabled="busy || !editable">
        <label>频点编号<input v-model="form.freqId" maxlength="120" :disabled="mode === 'PATCH'" aria-label="构造频点编号" required /></label>
        <label>类别<select v-model="form.deviceClass" :disabled="mode === 'PATCH'"><option value="HF">HF</option><option value="VUHF">VUHF</option></select></label>
        <label v-for="field in numericFields" :key="field.key">{{ field.label }}
          <input v-model="form[field.key]" type="number" min="0" :step="field.key === 'channelNo' ? 1 : 'any'"
            :required="field.key === 'centerFreqKhz'" :aria-label="field.label" />
        </label>
        <label class="frequency-note">备注<textarea v-model="form.note" maxlength="2000" rows="3" aria-label="构造频点备注" /></label>
        <div class="toolbar frequency-note">
          <button class="btn primary" type="submit"><i class="pi pi-check" aria-hidden="true" />预检变更</button>
          <button class="btn" type="button" @click="emit('close')">取消</button>
        </div>
      </fieldset>
    </form>
  </AppDrawer>
</template>
<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import type { FrequencyAction, FrequencyNewItem, FrequencyPatchFields, FrequencyResourceItem } from '../types/frequency-resource';

const props = defineProps<{ visible: boolean; mode: 'ADD' | 'PATCH'; item: FrequencyResourceItem | null;
  busy: boolean; editable: boolean; error: string }>();
const emit = defineEmits<{ close: []; preview: [action: FrequencyAction]; dirtyChange: [dirty: boolean] }>();
const form = reactive<Record<string, string>>({}), localError = ref('');
const numericFields = [{ key: 'centerFreqKhz', label: '中心频率 / kHz' }, { key: 'bandwidthKhz', label: '带宽 / kHz' },
  { key: 'channelNo', label: '信道号' }, { key: 'reuseMinDistanceM', label: '复用间距 / m' }, { key: 'adjacentGuardKhz', label: '邻道间隔 / kHz' }];
let original = '';
watch(() => [props.visible, props.mode, props.item], () => {
  if (!props.visible) return;
  const item = props.mode === 'PATCH' ? props.item : null;
  const values: Record<string, string> = { freqId: item?.freqId ?? '', deviceClass: item?.deviceClass ?? 'HF', note: item?.note ?? '' };
  for (const field of numericFields) values[field.key] = item?.[field.key as keyof FrequencyResourceItem] == null ? '' : String(item[field.key as keyof FrequencyResourceItem]);
  original = JSON.stringify(values); Object.assign(form, values); localError.value = ''; emit('dirtyChange', false);
}, { immediate: true });
watch(form, () => { if (props.visible) emit('dirtyChange', JSON.stringify(form) !== original); });
function submit() {
  if (props.busy || !props.editable) return;
  localError.value = '';
  try {
    if (!form.freqId || form.freqId.length > 120 || /\s|[\u0000-\u001f\u007f]/u.test(form.freqId)) throw new Error('频点编号无效');
    const values: Record<string, unknown> = { deviceClass: form.deviceClass, note: form.note === '' ? null : form.note };
    if (!['HF', 'VUHF'].includes(form.deviceClass) || form.note.length > 2000) throw new Error('类别或备注无效');
    for (const field of numericFields) {
      const raw = form[field.key], value = raw === '' ? null : Number(raw);
      if (value === null ? field.key === 'centerFreqKhz' : !Number.isFinite(value) || value < 0
        || ['centerFreqKhz', 'bandwidthKhz'].includes(field.key) && value === 0 || field.key === 'channelNo' && !Number.isSafeInteger(value)) throw new Error(field.label + '无效');
      values[field.key] = value;
    }
    if (props.mode === 'ADD') emit('preview', { kind: 'ADD', freqId: form.freqId, item: values as unknown as FrequencyNewItem });
    else {
      if (!props.item || props.item.freqId !== form.freqId || props.item.deviceClass !== values.deviceClass) throw new Error('编辑对象已变化');
      const fields: FrequencyPatchFields = {};
      for (const [key, value] of Object.entries(values)) if (key !== 'deviceClass' && props.item[key as keyof FrequencyResourceItem] !== value) Object.assign(fields, { [key]: value });
      if (!Object.keys(fields).length) { localError.value = '没有需要修改的字段'; return; }
      emit('preview', { kind: 'PATCH', freqId: form.freqId, fields });
    }
  } catch (reason) { localError.value = reason instanceof Error ? reason.message : '构造频点输入无效'; }
}
</script>
<style scoped>
.frequency-edit fieldset { border: 0; margin: 0; padding: 12px 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.frequency-edit label { display: grid; gap: 6px; min-width: 0; font-size: 13px; }
.frequency-edit input, .frequency-edit select, .frequency-edit textarea { width: 100%; min-width: 0; }
.frequency-note { grid-column: 1 / -1; }
@media (max-width: 480px) { .frequency-edit fieldset { grid-template-columns: minmax(0, 1fr); } }
</style>
