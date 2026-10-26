import { computed, onScopeDispose, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { decodeRuntimeParameters } from '../services/runtime-parameters-http';
import { ApiError } from '../services/types';
import type { RuntimeParameterApplication, RuntimeParametersServices, RuntimeParametersSnapshot } from '../types/runtime-parameters';

const text = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const same = (a: RuntimeParametersSnapshot, b: RuntimeParametersSnapshot) => a.epoch === b.epoch
  && a.revision === b.revision && a.values['PAR-01'] === b.values['PAR-01'] && a.values['PAR-02'] === b.values['PAR-02'];

// AppShell单点绑定；消费者只读取同一实例，不在这里创建身份或定时刷新。
export const useRuntimeParametersStore = defineStore('runtime-parameters', () => {
  const current = shallowRef<RuntimeParametersSnapshot | null>(null), pending = shallowRef(false), failure = shallowRef<unknown>(null);
  const bound = shallowRef(false), owner = shallowRef<string | null>(null);
  const applied = shallowRef<readonly RuntimeParameterApplication[]>(Object.freeze([]));
  let services: RuntimeParametersServices | null = null, sessionKey: (() => string | null) | null = null;
  let stopSession: (() => void) | undefined, controller: AbortController | undefined, serial = 0;
  let baseline: RuntimeParametersSnapshot | null = null;

  function key() { const value = sessionKey?.(); return text(value, 2048) ? value : null; }
  const snapshot = computed(() => bound.value && owner.value !== null && owner.value === key() ? current.value : null);
  const loading = computed(() => pending.value);
  const error = computed(() => failure.value);
  const applications = computed(() => snapshot.value ? applied.value : Object.freeze([]) as readonly RuntimeParameterApplication[]);

  function cancel() {
    serial++;
    const previous = controller;
    controller = undefined;
    pending.value = false;
    previous?.abort();
  }
  function clearForSession() {
    cancel(); owner.value = null; baseline = null; current.value = null; failure.value = null; applied.value = Object.freeze([]);
  }
  function unbind() {
    stopSession?.(); stopSession = undefined;
    clearForSession(); bound.value = false; services = null; sessionKey = null;
  }
  function bind(client: RuntimeParametersServices, readSessionKey: () => string | null) {
    if (services !== null) throw new ApiError('运行参数实例已经绑定', 'RUNTIME_PARAMETERS_ALREADY_BOUND');
    if (!client || typeof client.getRuntimeParameters !== 'function' || typeof readSessionKey !== 'function') {
      throw new ApiError('运行参数绑定无效', 'INVALID_RUNTIME_PARAMETERS_BINDING');
    }
    clearForSession(); services = client; sessionKey = readSessionKey; bound.value = true;
    stopSession = watch(readSessionKey, clearForSession, { flush: 'sync' });
  }
  async function refresh(): Promise<RuntimeParametersSnapshot | null> {
    const captured = key(), client = services;
    if (!captured || !client) { clearForSession(); return null; }
    if (owner.value !== captured) clearForSession();
    cancel();
    owner.value = captured;
    const token = serial, active = new AbortController();
    controller = active; pending.value = true; failure.value = null;
    const valid = () => serial === token && services === client && key() === captured && !active.signal.aborted;
    try {
      const result = decodeRuntimeParameters(await client.getRuntimeParameters({ signal: active.signal }));
      if (!valid()) return null;
      if (baseline?.epoch === result.epoch && (Number(result.revision.slice(4)) < Number(baseline.revision.slice(4))
        || result.revision === baseline.revision && !same(result, baseline))) {
        throw new ApiError('运行参数版本不一致', 'INVALID_RUNTIME_PARAMETERS_RESPONSE');
      }
      if (!baseline || !same(baseline, result)) applied.value = Object.freeze([]);
      baseline = result; current.value = result;
      return result;
    } catch (reason) {
      if (!valid()) return null;
      current.value = null; applied.value = Object.freeze([]); failure.value = reason;
      throw reason;
    } finally {
      if (serial === token) { controller = undefined; pending.value = false; }
    }
  }
  function reportApplied(consumer: string, epoch: string, revision: string) {
    const value = snapshot.value;
    if (!value || pending.value || failure.value || !text(consumer, 80) || value.epoch !== epoch || value.revision !== revision) return false;
    applied.value = Object.freeze([...applied.value.filter(item => item.consumer !== consumer), Object.freeze({ consumer, epoch, revision })]);
    return true;
  }
  function clearApplied(consumer: string) { applied.value = Object.freeze(applied.value.filter(item => item.consumer !== consumer)); }
  onScopeDispose(unbind);
  return { snapshot, loading, error, applications, bind, refresh, cancel, clearForSession, unbind, reportApplied, clearApplied };
});
