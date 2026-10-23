import { computed, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { useAuthStore } from './auth';
import { ApiError } from '../services/types';
import type { createDeviceConfigurationHttp } from '../services/device-configuration-http';
import { deviceConfigurationSchema, type ConfigurationAcceptanceContext, type ConfigurationAcceptanceHistory,
  type ConfigurationSystemAcceptance, type ConfigurationRequestInput, type ConfigurationSubmissionInput } from '../services/device-configuration-decode';
import { readPendingConfiguration, savePendingConfiguration, clearPendingConfiguration, type PendingStorage } from '../services/device-configuration-pending';

export type DeviceConfigurationClient = ReturnType<typeof createDeviceConfigurationHttp>;
export interface ConfigurationTarget { deviceId: string; resourceRevision: string; editable: boolean; disabledReason?: string }
export const useDeviceConfigurationAcceptanceStore = defineStore('device-configuration-acceptance', () => {
  const auth = useAuthStore();
  const visible = ref(false), target = ref<ConfigurationTarget | null>(null), data = ref<ConfigurationAcceptanceContext | null>(null);
  const power = ref(''), frequency = ref(''), busy = ref(false), error = ref(''), notice = ref(''), validated = ref(false);
  const pending = ref<ConfigurationSubmissionInput | null>(null), notFound = ref(false);
  const acceptance = ref<ConfigurationSystemAcceptance | null>(null), history = ref<ConfigurationAcceptanceHistory | null>(null), acceptedEvent = ref(0);
  const services = shallowRef<DeviceConfigurationClient | null>(null);
  const draftBaseline = ref({ power: '', frequency: '' });
  let store: PendingStorage | undefined, serial = 0, control: AbortController | null = null;
  const readable = computed(() => auth.can('resources.view'));
  const editable = computed(() => readable.value && auth.can('resources.device.edit') && !!target.value?.editable && !!data.value);
  const locked = computed(() => busy.value || !!pending.value || !editable.value);
  const dirty = computed(() => visible.value && !!data.value && (power.value !== draftBaseline.value.power || frequency.value !== draftBaseline.value.frequency));
  const message = (e: unknown) => e instanceof Error ? e.message : '配置受理请求失败';
  const actor = () => auth.identity?.id ?? '';
  function cancel() { serial++; control?.abort(); control = null; busy.value = false; validated.value = false; }
  function restorePending() {
    pending.value = null; notFound.value = false;
    if (!actor()) return;
    try { pending.value = readPendingConfiguration(actor(), store); } catch (e) { error.value = message(e); }
  }
  watch([() => auth.identity?.id, () => auth.identity?.sessionId], () => {
    cancel(); data.value = null; history.value = null; acceptance.value = null; power.value = ''; frequency.value = ''; restorePending();
  }, { flush: 'sync' });
  watch(() => auth.generation, cancel, { flush: 'sync' });
  watch(readable, value => { if (!value) { cancel(); data.value = null; history.value = null; acceptance.value = null; } }, { flush: 'sync' });
  watch([power, frequency], () => { validated.value = false; }, { flush: 'sync' });
  function bind(client: DeviceConfigurationClient | null, storage?: PendingStorage) { cancel(); services.value = client; store = storage; restorePending(); }
  async function run(operation: (client: DeviceConfigurationClient, signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (!services.value || !readable.value || busy.value) return;
    const token = ++serial, generation = auth.generation;
    control = new AbortController(); busy.value = true; error.value = '';
    const current = () => serial === token && auth.generation === generation && readable.value;
    try { await operation(services.value, control.signal, current); }
    catch (e) { if (current()) error.value = message(e); }
    finally { if (serial === token) { busy.value = false; control = null; } }
  }
  async function open(value: ConfigurationTarget, client?: DeviceConfigurationClient) {
    if (visible.value && (busy.value || !!pending.value || dirty.value)) {
      notice.value = '当前请求或输入尚未处理，请先核实原号或明确放弃未提交输入。'; return false;
    }
    cancel(); if (client) services.value = client;
    target.value = { ...value }; visible.value = true; data.value = null; acceptance.value = null; history.value = null;
    power.value = ''; frequency.value = ''; error.value = ''; notice.value = ''; restorePending();
    await refreshContext();
    return true;
  }
  async function refreshContext() {
    if (dirty.value || pending.value && data.value) { notice.value = '请先处理当前输入或待核实原号，再重新读取来源。'; return; }
    const selected = target.value;
    if (!selected) return;
    await run(async (client, signal, current) => {
      const result = await client.loadContext({ context: 'ledger', device_id: selected.deviceId, revision: selected.resourceRevision }, { signal });
      if (!current()) return;
      data.value = result; validated.value = false;
      const saved = pending.value?.device_id === selected.deviceId && pending.value.base_revision === selected.resourceRevision ? pending.value.values : result.device.source_values;
      power.value = saved.tx_power_dbm?.toString() ?? '';
      frequency.value = saved.work_freq_khz?.toString() ?? '';
      draftBaseline.value = { power: power.value, frequency: frequency.value };
    });
  }
  function input(): ConfigurationRequestInput {
    if (!data.value || !target.value || !power.value.trim() || !frequency.value.trim()) throw new ApiError('请提供功率和频率', 'VALIDATION_ERROR');
    const values = { tx_power_dbm: Number(power.value), work_freq_khz: Number(frequency.value) };
    if (!Number.isFinite(values.tx_power_dbm) || !Number.isFinite(values.work_freq_khz) || values.work_freq_khz <= 0) throw new ApiError('功率和频率必须为有效数值', 'VALIDATION_ERROR');
    return { schema_version: deviceConfigurationSchema, context: 'ledger', base_revision: data.value.resource_revision,
      device_id: data.value.device.device_id, model_id: data.value.device.model_id, values };
  }
  let validatedInput = '';
  async function validate() {
    if (locked.value) return;
    await run(async (client, signal, current) => {
      const request = input(), fingerprint = JSON.stringify(request);
      await client.validateRequest(request, { signal });
      if (current() && JSON.stringify(input()) === fingerprint) { validatedInput = fingerprint; validated.value = true; }
    });
  }
  function receive(result: ConfigurationSystemAcceptance, account: string) {
    if (result.actor.account_id !== account) throw new ApiError('回执账号不符', 'INVALID_CONFIGURATION_RESPONSE');
    const expected = pending.value;
    if (!expected || result.request_id !== expected.request_id || result.device_id !== expected.device_id || result.model_id !== expected.model_id
      || result.base_revision !== expected.base_revision || result.requested_values.tx_power_dbm !== expected.values.tx_power_dbm
      || result.requested_values.work_freq_khz !== expected.values.work_freq_khz) throw new ApiError('原号回执与已保留请求不符', 'INVALID_CONFIGURATION_RESPONSE');
    clearPendingConfiguration(account, result.request_id, store);
    if (target.value?.deviceId === expected.device_id && target.value.resourceRevision === expected.base_revision
      && Number(power.value) === expected.values.tx_power_dbm && Number(frequency.value) === expected.values.work_freq_khz) {
      draftBaseline.value = { power: power.value, frequency: frequency.value };
    }
    pending.value = null; notFound.value = false; acceptance.value = result;
    acceptedEvent.value++;
    notice.value = result.message; validated.value = false;
  }
  async function send(request: ConfigurationSubmissionInput) {
    const account = actor();
    await run(async (client, signal, current) => {
      // 持久化失败即不发 POST；关闭等待也保留原号，不能据此认定未受理。
      savePendingConfiguration(account, request, store); pending.value = structuredClone(request); notFound.value = false;
      try {
        const result = await client.submitRequest(request, { signal });
        if (current()) receive(result, account);
      } catch (e) { if (current()) notice.value = '结果尚未核实，请查询原请求编号；未确认前不创建新请求。'; throw e; }
    });
  }
  async function submit() {
    if (locked.value || !validated.value) return;
    try {
      const request = input();
      if (JSON.stringify(request) !== validatedInput) { validated.value = false; return; }
      await send({ ...request, request_id: 'DCUI-' + crypto.randomUUID() });
    } catch (e) { error.value = message(e); }
  }
  async function verify() {
    const request = pending.value, account = actor(); if (!request) return;
    await run(async (client, signal, current) => {
      notFound.value = false;
      try {
        const result = await client.getRequest({ context: 'ledger', request_id: request.request_id }, { signal });
        if (current()) receive(result, account);
      } catch (e) {
        if (current() && e instanceof ApiError && (e.code === 'CONFIGURATION_NOT_FOUND' || e.code === 1002)) {
          notFound.value = true; notice.value = '服务端未查到原请求，可同号同内容重发，或放弃本地草稿。'; return;
        }
        throw e;
      }
    });
  }
  async function resend() {
    const request = pending.value;
    if (!request || !notFound.value || !editable.value || request.base_revision !== target.value?.resourceRevision || request.device_id !== target.value?.deviceId) return;
    await send({ ...request, values: { ...request.values } });
  }
  function discardNotFound() {
    if (!pending.value || !notFound.value || busy.value) return;
    try { clearPendingConfiguration(actor(), pending.value.request_id, store); pending.value = null; notFound.value = false; notice.value = '仅放弃本地未查到请求；未删除任何服务端历史。'; }
    catch (e) { error.value = message(e); }
  }
  async function queryHistory(page = 1) {
    const device = target.value?.deviceId; if (!device) return;
    await run(async (client, signal, current) => {
      const result = await client.queryHistory({ context: 'ledger', device_id: device, page, page_size: 20 }, { signal });
      if (current()) history.value = result;
    });
  }
  async function select(requestId: string) {
    const device = target.value?.deviceId;
    await run(async (client, signal, current) => {
      const result = await client.getRequest({ context: 'ledger', request_id: requestId }, { signal });
      if (result.device_id !== device || result.actor.account_id !== actor()) throw new ApiError('历史记录关联不符', 'INVALID_CONFIGURATION_RESPONSE');
      if (current()) acceptance.value = result;
    });
  }
  function discardDraft() {
    if (busy.value || pending.value) return false;
    power.value = draftBaseline.value.power; frequency.value = draftBaseline.value.frequency;
    validated.value = false; notice.value = '仅放弃本地未提交输入，不修改台账或受理历史。'; return true;
  }
  function close() {
    if (!visible.value) return true;
    if (busy.value || pending.value || dirty.value) {
      notice.value = '当前仍有请求等待、待核实原号或未提交输入，尚未关闭。'; return false;
    }
    cancel(); visible.value = false; return true;
  }
  function closeKeepingPending() {
    if (busy.value || !pending.value) return false;
    if (dirty.value && (Number(power.value) !== pending.value.values.tx_power_dbm || Number(frequency.value) !== pending.value.values.work_freq_khz)) {
      notice.value = '另有未提交输入，原号保留不能代替该输入的离开保护。'; return false;
    }
    try {
      savePendingConfiguration(actor(), pending.value, store);
      notice.value = '原号和完整请求已保留；停止等待不代表取消受理，下次打开请先核实原号。';
      cancel(); visible.value = false; return true;
    } catch (e) { error.value = message(e); return false; }
  }
  return { visible, target, data, power, frequency, busy, error, notice, validated, pending, notFound, acceptance, history, acceptedEvent,
    readable, editable, locked, dirty, bind, open, refreshContext, validate, submit, verify, resend, discardNotFound, queryHistory, select,
    discardDraft, close, closeKeepingPending, cancel };
});
