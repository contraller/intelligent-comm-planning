import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError } from '../services/types';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { FrequencyDisableInput, FrequencyDisableReceipt, FrequencyDisableValidation,
  FrequencyHistoryQuery, FrequencyOperation, FrequencyOperationPage, FrequencyPageQuery,
  FrequencyResourceChange, FrequencyResourceHostContext, FrequencyResourceItem,
  FrequencyResourcePage, FrequencyResourceServices } from '../types/frequency-resource';

export interface FrequencyWorkspaceOptions {
  services: FrequencyResourceServices;
  loadContext: (signal?: AbortSignal) => Promise<{ revision: string }>;
  session: FrequencyResourceHostContext;
  onResourceChanged?: (value: FrequencyResourceChange) => void;
  requestId?: () => string;
}
type Filter = Pick<FrequencyPageQuery, 'search' | 'deviceClass' | 'availability' | 'minKhz' | 'maxKhz'>;
const code = (reason: unknown) => reason instanceof ApiError ? String(reason.code) : '';
const message = (reason: unknown) => reason instanceof Error ? reason.message : '频点操作失败';

export const useFrequencyResourceStore = defineStore('frequency-resource', () => {
  const session = ref<FrequencyResourceHostContext | null>(null), revision = ref('');
  const page = ref<FrequencyResourcePage | null>(null), history = ref<FrequencyOperationPage | null>(null);
  const query = ref<Omit<FrequencyPageQuery, 'context' | 'revision'>>({ page: 1, pageSize: 10 });
  const historyQuery = ref<FrequencyHistoryQuery>({ context: 'ledger', page: 1, pageSize: 10 });
  const selectedIds = ref<string[]>([]), detail = ref<FrequencyResourceItem | null>(null);
  const preview = ref<FrequencyDisableValidation | null>(null), receipt = ref<FrequencyDisableReceipt | null>(null);
  const operation = ref<FrequencyOperation | null>(null), pending = ref<FrequencyDisableInput | null>(null);
  const phase = ref<'IDLE' | 'SAVING' | 'RESULT_UNKNOWN' | 'RESOLVED' | 'REJECTED'>('IDLE');
  const error = ref(''), notice = ref(''), stale = ref(false), listFailed = ref(false), decision = ref<DecisionRequest | null>(null);
  const loading = ref<Record<string, boolean>>({});
  const busy = computed(() => phase.value === 'SAVING' || Object.values(loading.value).some(Boolean));
  const locked = computed(() => !!pending.value || stale.value || !!loading.value.preview);
  const canSelect = computed(() => !!session.value?.readable && !!session.value.canDisable && !locked.value
    && !listFailed.value && !loading.value.list && !loading.value.context);
  let options: FrequencyWorkspaceOptions | null = null, generation = 0;
  const controllers = new Map<string, AbortController>();
  let leaveAnswer: ((value: boolean) => void) | null = null;
  let decisionKind: 'disable' | 'leave' | null = null;

  function closeDecision() {
    decision.value = null; decisionKind = null;
    leaveAnswer?.(false); leaveAnswer = null;
  }
  function stopReading() {
    if (phase.value === 'SAVING' && pending.value) {
      phase.value = 'RESULT_UNKNOWN'; notice.value = '读取已停止，保存结果仍待核实，未撤销服务端事务。';
    }
    generation++;
    controllers.forEach(controller => controller.abort()); controllers.clear(); loading.value = {};
    closeDecision();
  }
  function configure(next: FrequencyWorkspaceOptions) {
    const changed = session.value?.accountId !== next.session.accountId || session.value?.generation !== next.session.generation;
    options = next;
    if (changed) {
      stopReading(); revision.value = ''; page.value = null; history.value = null; selectedIds.value = [];
      preview.value = null; receipt.value = null; operation.value = null; detail.value = null;
      pending.value = null; phase.value = 'IDLE'; stale.value = false; listFailed.value = false; error.value = ''; notice.value = '';
      query.value = { page: 1, pageSize: 10 }; historyQuery.value = { context: 'ledger', page: 1, pageSize: 10 };
    }
    session.value = { ...next.session };
    if (!next.session.canDisable) { selectedIds.value = []; preview.value = null; closeDecision(); }
    if (!next.session.readable) { stopReading(); page.value = null; history.value = null; operation.value = null; receipt.value = null; }
  }
  function failure(reason: unknown) {
    error.value = message(reason);
    if (['1205', 'RESOURCE_VERSION_CHANGED'].includes(code(reason))) {
      stale.value = true; selectedIds.value = []; preview.value = null; closeDecision();
      notice.value = '资源版本已变化，请刷新后重新选择；历史任务和方案需要按当前资源重新保存或计算。';
    }
  }
  async function read<T>(key: string, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!options || !session.value?.readable) return;
    controllers.get(key)?.abort();
    const controller = new AbortController(), token = generation;
    controllers.set(key, controller); loading.value[key] = true;
    const current = () => token === generation && controllers.get(key) === controller && !controller.signal.aborted;
    try { const result = await action(controller.signal); return current() ? result : undefined; }
    catch (reason) {
      if (current() && !['REQUEST_ABORTED', 'SESSION_CHANGED'].includes(code(reason))) {
        if (key === 'list' || key === 'context') listFailed.value = true;
        failure(reason);
      }
    }
    finally { if (controllers.get(key) === controller) { controllers.delete(key); loading.value[key] = false; } }
  }
  async function loadPage(input: Partial<typeof query.value> = {}) {
    if (!options || !revision.value || stale.value || pending.value || phase.value === 'SAVING') return;
    closeDecision(); preview.value = null; detail.value = null;
    query.value = { ...query.value, ...input };
    const request: FrequencyPageQuery = { ...query.value, context: 'ledger', revision: revision.value };
    error.value = '';
    const value = await read('list', signal => options!.services.queryFrequencyResources(request, signal));
    if (value) { page.value = value; listFailed.value = false; }
  }
  async function loadHistory(input: Partial<FrequencyHistoryQuery> = {}) {
    if (!options) return;
    historyQuery.value = { ...historyQuery.value, ...input, context: 'ledger' };
    const request = { ...historyQuery.value };
    const value = await read('history', signal => options!.services.queryFrequencyOperations(request, signal));
    if (value) history.value = value;
  }
  async function refresh() {
    if (!options || phase.value === 'SAVING' || pending.value) return;
    stopReading(); listFailed.value = true; selectedIds.value = []; preview.value = null; detail.value = null; error.value = '';
    const value = await read('context', signal => options!.loadContext(signal));
    if (!value) return;
    if (typeof value.revision !== 'string' || !/^resource-[0-9a-f]{16}$/.test(value.revision) || value.revision.length !== 25) {
      failure(new ApiError('资源上下文版本无效', 'INVALID_FREQUENCY_RESOURCE_RESPONSE')); return;
    }
    revision.value = value.revision; stale.value = false;
    await Promise.all([loadPage(), loadHistory()]);
  }
  async function applyFilters(filters: Filter) {
    if (locked.value || phase.value === 'SAVING') return;
    selectedIds.value = []; query.value = { page: 1, pageSize: query.value.pageSize, ...filters };
    await loadPage();
  }
  function select(id: string, checked: boolean) {
    if (!canSelect.value || !page.value?.items.some(item => item.freqId === id)) return;
    closeDecision(); preview.value = null;
    const ids = new Set(selectedIds.value);
    if (checked) ids.add(id); else ids.delete(id);
    if (ids.size > 50) { error.value = '每次最多选择 50 个频点'; return; }
    selectedIds.value = [...ids].sort();
  }
  function selectPage(checked: boolean) {
    if (!canSelect.value || !page.value) return;
    const ids = new Set(selectedIds.value);
    for (const row of page.value.items) { if (checked) ids.add(row.freqId); else ids.delete(row.freqId); }
    if (ids.size > 50) { error.value = '每次最多选择 50 个频点'; return; }
    closeDecision(); preview.value = null; selectedIds.value = [...ids].sort();
  }
  function clearSelection() { if (!locked.value && phase.value !== 'SAVING') { selectedIds.value = []; preview.value = null; closeDecision(); } }
  async function prepareDisable() {
    if (!options || !canSelect.value || selectedIds.value.length === 0 || busy.value) return;
    const request = { context: 'ledger' as const, revision: revision.value, ids: [...selectedIds.value] };
    error.value = '';
    const value = await read('preview', signal => options!.services.validateFrequencyDisable(request, signal));
    if (!value || request.revision !== revision.value || request.ids.join() !== selectedIds.value.join()) return;
    preview.value = value; decisionKind = 'disable';
    decision.value = { title: '确认停用规划频点', message: `将停用 ${value.wouldDisable.length} 项，${value.unchanged.length} 项无变化。资源变化后旧任务和方案需重算；链路级影响未提供。`,
      saveLabel: '确认停用', cancelLabel: '取消' };
  }
  async function acceptReceipt(value: FrequencyDisableReceipt) {
    receipt.value = value; pending.value = null; preview.value = null; selectedIds.value = []; phase.value = 'RESOLVED';
    notice.value = value.changed ? '停用已保存。历史任务和方案保留，使用当前资源前需重新保存或计算。' : '所选频点已停用，本次无变化，未生成新资源版本。';
    let notificationError = '';
    try {
      options?.onResourceChanged?.({ previousRevision: value.baseRevision, revision: value.revision,
        readRevision: value.readRevision, requestId: value.requestId, changed: value.changed });
    } catch (reason) { notificationError = '保存已确认，共享页面通知失败：' + message(reason); }
    await refresh();
    if (notificationError) error.value = notificationError;
  }
  async function sendPending() {
    if (!options || !pending.value || !session.value?.canDisable || phase.value === 'SAVING') return;
    const request = { ...pending.value, ids: [...pending.value.ids] }, token = generation;
    phase.value = 'SAVING'; error.value = '';
    try {
      const result = await options.services.disableFrequencyResources(request);
      if (token === generation) await acceptReceipt(result);
    } catch (reason) {
      if (token !== generation) return;
      if (reason instanceof ApiError && ((reason.status !== undefined && reason.status >= 400 && reason.status < 500)
        || ['1001', '1002', '1101', '1102', '1103', '1104', '1105', '1106', '1205', '1206', 'VALIDATION_ERROR',
        'FORBIDDEN', 'AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_DISABLED', 'SESSION_REPLACED', 'SESSION_CHANGED',
        'HTTP_AUTH_BUSY', 'CSRF_REJECTED', 'RESOURCE_VERSION_CHANGED'].includes(code(reason)))) {
        phase.value = 'REJECTED'; pending.value = null; failure(reason);
      } else {
        phase.value = 'RESULT_UNKNOWN'; error.value = message(reason);
        notice.value = '提交结果待核实。请核实原请求回执或重试同一请求号，关闭页面不代表保存已取消。';
      }
    }
  }
  async function commit() {
    if (!preview.value || !options || !session.value?.canDisable || pending.value || stale.value
      || preview.value.revision !== revision.value || preview.value.selectedIds.join() !== selectedIds.value.join()) return;
    const request: FrequencyDisableInput = { context: 'ledger', baseRevision: preview.value.revision,
      requestId: options.requestId?.() ?? `frequency-disable-${globalThis.crypto.randomUUID()}`,
      ids: [...preview.value.selectedIds] };
    Object.freeze(request.ids); pending.value = Object.freeze(request);
    await sendPending();
  }
  async function inspectOperation(requestId: string) {
    if (!options || !requestId || phase.value === 'SAVING') return;
    const token = generation;
    const value = await read('operation', signal => options!.services.getFrequencyOperation({ context: 'ledger', requestId }, signal));
    if (!value || token !== generation) return;
    operation.value = value;
    if (pending.value?.requestId === requestId) {
      const original = pending.value;
      if (value.receipt.baseRevision !== original.baseRevision || value.receipt.selectedIds.join() !== original.ids.join()) {
        failure(new ApiError('原请求回执与冻结输入不一致', 'INVALID_FREQUENCY_RESOURCE_RESPONSE')); return;
      }
      await acceptReceipt(value.receipt);
    }
  }
  async function requestLeave(): Promise<boolean> {
    if (phase.value === 'SAVING') { notice.value = '正在保存，请等待结果；关闭请求不能撤销已提交事务。'; return false; }
    if (loading.value.preview) { stopReading(); preview.value = null; }
    if (!pending.value && selectedIds.value.length === 0 && !preview.value) return true;
    closeDecision(); decisionKind = 'leave';
    decision.value = pending.value
      ? { title: '操作结果待核实', message: `请求 ${pending.value.requestId} 尚待核实。离开后仍可通过本人历史或原请求号核实，离开不会撤销保存。`,
        saveLabel: '核实回执', discardLabel: '保留请求并离开', cancelLabel: '留在此页' }
      : { title: '离开规划频点', message: '当前选择及预检尚未提交，是否放弃本地选择？', discardLabel: '放弃选择并离开', cancelLabel: '继续选择' };
    return new Promise(resolve => { leaveAnswer = resolve; });
  }
  async function answer(value: Decision) {
    const kind = decisionKind, callback = leaveAnswer;
    leaveAnswer = null; decision.value = null; decisionKind = null;
    if (kind === 'disable') { if (value === 'save') await commit(); else preview.value = null; }
    else if (kind === 'leave') {
      if (value === 'discard') { if (!pending.value) { selectedIds.value = []; preview.value = null; } callback?.(true); }
      else { callback?.(false); if (value === 'save' && pending.value) await inspectOperation(pending.value.requestId); }
    }
  }
  return { session, revision, page, history, query, historyQuery, selectedIds, detail, preview, receipt, operation,
    pending, phase, error, notice, stale, listFailed, decision, loading, busy, locked, canSelect, configure, stopReading,
    refresh, loadPage, loadHistory, applyFilters, select, selectPage, clearSelection, prepareDisable, answer,
    inspectOperation, retryPending: sendPending, requestLeave };
});
