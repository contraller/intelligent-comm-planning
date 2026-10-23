<template>
  <AppDrawer :visible="config.visible" title="设备配置请求" width="560px" @update:visible="!$event && close()">
    <p v-if="!services" class="notice" role="status">配置服务未接入，当前只读。</p>
    <p v-if="config.error" role="alert" class="notice warn">{{ config.error }}</p>
    <p v-if="config.notice" role="status" class="notice">{{ config.notice }}</p>
    <p v-if="config.busy" role="status">正在读取或核验…</p>
    <button v-if="config.busy" class="btn" @click="stopWaiting">停止等待（保留原号）</button>
    <button v-if="config.dirty && !config.pending" class="btn" :disabled="config.busy" @click="config.discardDraft">放弃未提交输入</button>
    <p v-if="disabledReason || !config.editable" class="notice">{{ disabledReason || '当前设备或账号仅可读取记录。' }}</p>
    <section v-if="config.pending" aria-label="待核实配置">
      <h3>请求待核实</h3>
      <p>{{ config.pending.device_id }} · {{ config.pending.request_id }}</p>
      <p>{{ config.pending.values.tx_power_dbm }} dBm / {{ config.pending.values.work_freq_khz }} kHz</p>
      <div class="toolbar">
        <button class="btn" :disabled="config.busy || !config.readable" @click="config.verify">核实原号</button>
        <button class="btn" :disabled="config.busy" @click="closeKeepingPending">保留原号并关闭</button>
        <button v-if="config.notFound" class="btn" :disabled="config.busy || !config.editable" @click="config.resend">原号重发</button>
        <button v-if="config.notFound" class="btn" :disabled="config.busy" @click="config.discardNotFound">放弃本地草稿</button>
      </div>
    </section>
    <section v-if="config.data" aria-label="配置参数">
      <h3>{{ config.data.device.device_id }} · {{ config.data.model.model_id }}</h3>
      <details><summary>资源来源</summary><p>{{ config.data.provenance.resource_source }}</p><p class="identifier">{{ config.data.resource_revision }}</p></details>
      <dl class="kv">
        <dt>台账功率</dt><dd>{{ config.data.device.source_values.tx_power_dbm ?? '未知' }} dBm</dd>
        <dt>台账频率</dt><dd>{{ config.data.device.source_values.work_freq_khz ?? '未知' }} kHz</dd>
        <dt>型号频率范围</dt><dd>{{ config.data.model.freq_min_khz }} - {{ config.data.model.freq_max_khz }} kHz</dd>
        <dt>功率上限</dt><dd>{{ config.data.model.tx_power_max_dbm }} dBm</dd>
        <dt>模式／端口协议</dt><dd>待确认</dd>
      </dl>
      <label>请求功率（dBm）<input :value="config.power" @input="updateValue('power', $event)" aria-label="请求功率" type="number" step="any" :disabled="config.locked" /></label>
      <label>请求频率（kHz）<input :value="config.frequency" @input="updateValue('frequency', $event)" aria-label="请求频率" type="number" step="any" :disabled="config.locked" /></label>
      <div class="toolbar">
        <button class="btn" :disabled="config.busy || !!config.pending || !config.readable" @click="config.refreshContext">重新读取来源</button>
        <button class="btn" :disabled="config.locked" @click="config.validate">校验</button>
        <button class="btn primary" :disabled="config.locked || !config.validated" @click="config.submit">提交系统受理</button>
      </div>
    </section>
    <section v-if="config.acceptance" aria-label="系统受理回执">
      <h3>系统已受理 · 未下发</h3>
      <p>{{ config.acceptance.message }}</p>
      <dl class="kv">
        <dt>请求编号</dt><dd class="identifier">{{ config.acceptance.request_id }}</dd>
        <dt>请求值</dt><dd>{{ config.acceptance.requested_values.tx_power_dbm }} dBm / {{ config.acceptance.requested_values.work_freq_khz }} kHz</dd>
        <dt>受理时间</dt><dd>{{ config.acceptance.accepted_at }}</dd>
        <dt>执行／生效／在线</dt><dd>未知／未知／未知</dd>
      </dl>
    </section>
    <section aria-label="配置受理历史">
      <h3>配置受理历史</h3>
      <button class="btn" :disabled="config.busy || !config.readable" @click="config.queryHistory(1)">读取历史</button>
      <template v-if="config.history">
        <p v-if="!config.history.total">暂无受理记录</p>
        <ul class="history">
          <li v-for="item in config.history.items" :key="item.request_id">
            <button class="btn" :disabled="config.busy" @click="config.select(item.request_id)">{{ item.request_id }}</button>
            <span>{{ item.accepted_at }} · 系统受理／未下发</span>
          </li>
        </ul>
        <div class="toolbar">
          <button class="btn" :disabled="config.busy || config.history.page <= 1" @click="config.queryHistory(config.history.page - 1)">上一页</button>
          <span>{{ config.history.page }} · 共 {{ config.history.total }} 条</span>
          <button class="btn" :disabled="config.busy || config.history.page * config.history.page_size >= config.history.total" @click="config.queryHistory(config.history.page + 1)">下一页</button>
        </div>
      </template>
    </section>
  </AppDrawer>
</template>
<script setup lang="ts">
import { onScopeDispose, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useDeviceConfigurationAcceptanceStore, type DeviceConfigurationClient } from '../stores/device-configuration-acceptance';
const props = withDefaults(defineProps<{
  visible?: boolean; viewContext?: 'ledger' | 'gis'; deviceId?: string | null; resourceRevision?: string | null;
  editable?: boolean; disabledReason?: string; services?: DeviceConfigurationClient;
}>(), { editable: false });
const emit = defineEmits<{ close: []; accepted: [value: { request_id: string; device_id: string; base_revision: string }]; dirty: [value: boolean]; busy: [value: boolean] }>();
const config = useDeviceConfigurationAcceptanceStore();
// 数字v-model会转number；原生value保留store约定的字符串输入缓冲。
function updateValue(field: 'power' | 'frequency', event: Event) {
  if (!config.locked) config[field] = (event.target as HTMLInputElement).value;
}
watch([() => props.services, () => props.visible, () => props.deviceId, () => props.resourceRevision, () => props.editable, () => props.disabledReason], () => {
  config.bind(props.services ?? null);
  if (props.visible === false) { config.close(); return; }
  if (props.visible && props.deviceId && props.resourceRevision) {
    const target = { deviceId: props.deviceId, resourceRevision: props.resourceRevision, editable: props.editable, disabledReason: props.disabledReason };
    if (config.visible && config.target?.deviceId === target.deviceId && config.target.resourceRevision === target.resourceRevision) {
      // 同目标能力变化不重开表单，保留输入但立即收紧提交权限。
      if (config.target.editable !== target.editable) config.validated = false;
      config.target = target;
      return;
    }
    void config.open(target);
  }
}, { immediate: true });
watch(() => config.acceptedEvent, () => {
  const value = config.acceptance;
  if (value) emit('accepted', { request_id: value.request_id, device_id: value.device_id, base_revision: value.base_revision });
});
watch(() => config.visible && (config.dirty || !!config.pending), value => emit('dirty', value), { immediate: true });
watch(() => config.busy, value => emit('busy', value), { immediate: true });
function close() { if (!config.close()) return false; emit('close'); return true; }
function stopWaiting() { config.cancel(); config.notice = config.pending ? '原号和请求已保留；停止等待不代表服务端取消，请先核实原号。' : '已停止本次读取等待，未提交设备参数。'; }
function closeKeepingPending() { if (config.closeKeepingPending()) emit('close'); }
async function requestLeave(): Promise<boolean> { return close(); }
defineExpose({ requestLeave });
onScopeDispose(config.cancel);
</script>
<style scoped>
section { border-top: 1px solid var(--border-color, #d5d9de); padding: 14px 0; }
h3 { font-size: 15px; margin: 0 0 10px; }
p, dd, .identifier { overflow-wrap: anywhere; }
label { display: grid; gap: 6px; margin: 12px 0; }
input { width: 100%; min-width: 0; }
.kv { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); gap: 8px; }
dd { margin: 0; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.history { padding: 0; list-style: none; }
.history li { display: grid; gap: 6px; padding: 10px 0; }
</style>
