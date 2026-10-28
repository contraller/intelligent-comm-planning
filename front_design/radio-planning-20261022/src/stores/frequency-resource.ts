import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError } from '../services/types';
import { assertFrequencyChangesReceipt, compareFrequencyIds } from '../services/frequency-resource-validation';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { FrequencyDisableInput, FrequencyDisableValidation,
  FrequencyHistoryQuery, FrequencyOperation, FrequencyOperationPage, FrequencyPageQuery,
  FrequencyResourceChange, FrequencyResourceHostContext, FrequencyResourceItem,
  FrequencyResourcePage, FrequencyResourceServices } from '../types/frequency-resource';
import type { FrequencyAction, FrequencyChangesInput, FrequencyChangesValidation, FrequencyReceipt } from '../types/frequency-resource';

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
  const preview = ref<FrequencyDisableValidation | null>(null), receipt = ref<FrequencyReceipt | null>(null);
  const operation = ref<FrequencyOperation | null>(null), pending = ref<FrequencyDisableInput | FrequencyChangesInput | null>(null);
  const editor = ref<{ kind: 'ADD' | 'PATCH'; item: FrequencyResourceItem | null } | null>(null), editorDirty = ref(false);
  const changesPreview = ref<FrequencyChangesValidation | null>(null), changeDraft = ref<FrequencyAction[] | null>(null);
  const phase = ref<'IDLE' | 'SAVING' | 'RESULT_UNKNOWN' | 'RESOLVED' | 'REJECTED'>('IDLE');
  const error = ref(''), notice = ref(''), stale = ref(false), listFailed = ref(false), listReady = ref(false), decision = ref<DecisionRequest | null>(null);
  const loading = ref<Record<string, boolean>>({});
  const busy = computed(() => phase.value === 'SAVING' || Object.values(loading.value).some(Boolean));
  const locked = computed(() => !!pending.value || stale.value || !!loading.value.preview || !!changesPreview.value);
  const canSelect = computed(() => !!session.value?.readable && !!(session.value.canDisable || session.value.canMaintain) && !locked.value
    && !editor.value && listReady.value && !listFailed.value && !loading.value.list && !loading.value.context);
  const canMaintain = computed(() => !!session.value?.readable && !!session.value.canMaintain && !locked.value
    && listReady.value && !listFailed.value && !loading.value.list && !loading.value.context && !!page.value);
  let options: FrequencyWorkspaceOptions | null = null, generation = 0;
  const controllers = new Map<string, AbortController>();
  let leaveAnswer: ((value: boolean) => void) | null = null;
  let decisionKind: 'disable' | 'changes' | 'closeEditor' | 'leave' | null = null;

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
    preview.value = null; changesPreview.value = null; changeDraft.value = null;
    if (!pending.value && !editorDirty.value) editor.value = null;
    closeDecision();
  }
  function configure(next: FrequencyWorkspaceOptions) {
    const changed = session.value?.accountId !== next.session.accountId || session.value?.generation !== next.session.generation;
    options = next;
    if (changed) {
      stopReading(); revision.value = ''; page.value = null; history.value = null; selectedIds.value = [];
      preview.value = null; receipt.value = null; operation.value = null; detail.value = null;
      pending.value = null; phase.value = 'IDLE'; stale.value = false; listFailed.value = false; listReady.value = false; error.value = ''; notice.value = '';
      editor.value = null; editorDirty.value = false;
      query.value = { page: 1, pageSize: 10 }; historyQuery.value = { context: 'ledger', page: 1, pageSize: 10 };
    }
    if (!changed && session.value && (session.value.canDisable && !next.session.canDisable
      || session.value.canMaintain && !next.session.canMaintain)) {
      // 撤销写权限只失效只读预检，已提交的原请求仍须保留核实。
      controllers.get('preview')?.abort(); controllers.delete('preview'); loading.value.preview = false;
      preview.value = null; changesPreview.value = null; changeDraft.value = null;
      if (decisionKind === 'disable' || decisionKind === 'changes') closeDecision();
    }
    session.value = { ...next.session };
    if (!next.session.canDisable) { if (!next.session.canMaintain) selectedIds.value = []; preview.value = null; if (decisionKind === 'disable') closeDecision(); }
    if (!next.session.canMaintain) { editor.value = null; editorDirty.value = false; changesPreview.value = null; changeDraft.value = null;
      if (decisionKind === 'changes' || decisionKind === 'closeEditor') closeDecision(); }
    if (!next.session.readable) {
      stopReading(); page.value = null; history.value = null; operation.value = null; receipt.value = null;
      detail.value = null; editor.value = null; editorDirty.value = false; selectedIds.value = []; error.value = '';
      notice.value = pending.value ? '查看权限已撤销，原请求结果仍待核实；未撤销服务端事务。' : '';
    }
  }
  function failure(reason: unknown) {
    error.value = message(reason);
    if (['1205', 'RESOURCE_VERSION_CHANGED'].includes(code(reason))) {
      stale.value = true; selectedIds.value = []; preview.value = null; closeDecision();
      changesPreview.value = null; changeDraft.value = null;
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
    if (!options || !revision.value || stale.value || pending.value || editor.value || phase.value === 'SAVING') return;
    closeDecision(); preview.value = null; detail.value = null;
    query.value = { ...query.value, ...input };
    const request: FrequencyPageQuery = { ...query.value, context: 'ledger', revision: revision.value };
    error.value = ''; listReady.value = false; listFailed.value = false;
    const value = await read('list', signal => options!.services.queryFrequencyResources(request, signal));
    if (value) { page.value = value; listFailed.value = false; listReady.value = true; }
  }
  async function loadHistory(input: Partial<FrequencyHistoryQuery> = {}) {
    if (!options) return;
    historyQuery.value = { ...historyQuery.value, ...input, context: 'ledger' };
    const request = { ...historyQuery.value };
    const value = await read('history', signal => options!.services.queryFrequencyOperations(request, signal));
    if (value) history.value = value;
  }
  async function refresh() {
    if (!options || phase.value === 'SAVING' || pending.value || editor.value) return;
    // 读取中和主动中断都不是失败，但旧列表必须等当前查询成功后才能维护。
    stopReading(); listReady.value = false; listFailed.value = false; selectedIds.value = []; preview.value = null; detail.value = null; error.value = '';
    const token = generation;
    const value = await read('context', signal => options!.loadContext(signal));
    if (!value || token !== generation) return;
    if (typeof value.revision !== 'string' || !/^resource-[0-9a-f]{16}$/.test(value.revision) || value.revision.length !== 25) {
      listFailed.value = true;
      failure(new ApiError('资源上下文版本无效', 'INVALID_FREQUENCY_RESOURCE_RESPONSE')); return;
    }
    revision.value = value.revision; stale.value = false;
    await Promise.all([loadPage(), loadHistory()]);
  }
  async function applyFilters(filters: Filter) {
    if (locked.value || editor.value || phase.value === 'SAVING') return;
    selectedIds.value = []; query.value = { page: 1, pageSize: query.value.pageSize, ...filters };
    await loadPage();
  }
  function select(id: string, checked: boolean) {
    if (!canSelect.value || !page.value?.items.some(item => item.freqId === id)) return;
    closeDecision(); preview.value = null;
    const ids = new Set(selectedIds.value);
    if (checked) ids.add(id); else ids.delete(id);
    if (ids.size > 50) { error.value = '每次最多选择 50 个频点'; return; }
    selectedIds.value = [...ids].sort(compareFrequencyIds);
  }
  function selectPage(checked: boolean) {
    if (!canSelect.value || !page.value) return;
    const ids = new Set(selectedIds.value);
    for (const row of page.value.items) { if (checked) ids.add(row.freqId); else ids.delete(row.freqId); }
    if (ids.size > 50) { error.value = '每次最多选择 50 个频点'; return; }
    closeDecision(); preview.value = null; selectedIds.value = [...ids].sort(compareFrequencyIds);
  }
  function clearSelection() { if (!locked.value && phase.value !== 'SAVING') { selectedIds.value = []; preview.value = null; closeDecision(); } }
  async function prepareDisable() {
    if (!options || !session.value?.canDisable || !canSelect.value || selectedIds.value.length === 0 || busy.value) return;
    const request = { context: 'ledger' as const, revision: revision.value, ids: [...selectedIds.value] };
    error.value = '';
    const value = await read('preview', signal => options!.services.validateFrequencyDisable(request, signal));
    if (!value || request.revision !== revision.value || request.ids.join() !== selectedIds.value.join()) return;
    preview.value = value; decisionKind = 'disable';
    decision.value = { title: '确认停用规划频点', message: `将停用 ${value.wouldDisable.length} 项，${value.unchanged.length} 项无变化。资源变化后旧任务和方案需重算；链路级影响未提供。`,
      saveLabel: '确认停用', cancelLabel: '取消' };
  }
  async function acceptReceipt(value: FrequencyReceipt) {
    receipt.value = value; pending.value = null; preview.value = null; selectedIds.value = []; phase.value = 'RESOLVED';
    editor.value = null; editorDirty.value = false; changesPreview.value = null; changeDraft.value = null;
    notice.value = value.changed ? '资源变更已保存。历史任务和方案保留，使用当前资源前需重新保存或计算。'
      : '本次无变化，未生成新资源版本。';
    let notificationError = '';
    try {
      options?.onResourceChanged?.({ previousRevision: value.baseRevision, revision: value.revision,
        readRevision: value.readRevision, requestId: value.requestId, changed: value.changed });
    } catch (reason) { notificationError = '保存已确认，共享页面通知失败：' + message(reason); }
    await refresh();
    if (notificationError) error.value = notificationError;
  }
  async function sendPending() {
    if (!options || !pending.value || !session.value?.readable || phase.value === 'SAVING'
      || ('changes' in pending.value ? !session.value.canMaintain : !session.value.canDisable)) return;
    const request = pending.value, token = generation;
    phase.value = 'SAVING'; error.value = '';
    try {
      const result = 'changes' in request ? await options.services.commitFrequencyChanges(request)
        : await options.services.disableFrequencyResources(request);
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
      const expectedIds = 'changes' in original ? original.changes.map(action => action.freqId).sort(compareFrequencyIds) : original.ids;
      if (value.receipt.baseRevision !== original.baseRevision || JSON.stringify(value.receipt.selectedIds) !== JSON.stringify(expectedIds)
        || value.receipt.objectId !== ('changes' in original ? 'resource-frequency-changes' : 'resource-frequency-disable')) {
        failure(new ApiError('原请求回执与冻结输入不一致', 'INVALID_FREQUENCY_RESOURCE_RESPONSE')); return;
      }
      if ('changes' in original) {
        try { assertFrequencyChangesReceipt(value.receipt as import('../types/frequency-resource').FrequencyChangeReceipt, original.changes); }
        catch (reason) { failure(reason); return; }
      }
      await acceptReceipt(value.receipt);
    }
  }
  async function requestLeave(): Promise<boolean> {
    if (phase.value === 'SAVING') { notice.value = '正在保存，请等待结果；关闭请求不能撤销已提交事务。'; return false; }
    if (loading.value.preview) { stopReading(); preview.value = null; }
    // 勾选和停用预检只读，不作为未保存修改；构造草稿和已提交请求仍须明确处理。
    if (!pending.value && !changesPreview.value && !editorDirty.value) return true;
    closeDecision(); decisionKind = 'leave';
    decision.value = pending.value
      ? { title: '操作结果待核实', message: `请求 ${pending.value.requestId} 尚待核实。离开后仍可通过本人历史或原请求号核实，离开不会撤销保存。`,
        saveLabel: '核实回执', discardLabel: '保留请求并离开', cancelLabel: '留在此页' }
      : { title: '离开规划频点', message: '构造频点修改尚未保存，是否放弃本地草稿？', discardLabel: '放弃草稿并离开', cancelLabel: '继续编辑' };
    return new Promise(resolve => { leaveAnswer = resolve; });
  }
  async function answer(value: Decision) {
    const kind = decisionKind, callback = leaveAnswer;
    leaveAnswer = null; decision.value = null; decisionKind = null;
    if (kind === 'disable') { if (value === 'save') await commit(); else preview.value = null; }
    else if (kind === 'changes') { if (value === 'save') await commitMaintenance(); else { changesPreview.value = null; changeDraft.value = null; } }
    else if (kind === 'closeEditor') { if (value === 'discard') { editor.value = null; editorDirty.value = false; } }
    else if (kind === 'leave') {
      if (value === 'discard') { if (!pending.value) { selectedIds.value = []; preview.value = null; editor.value = null; editorDirty.value = false; changesPreview.value = null; changeDraft.value = null; } callback?.(true); }
      else {
        callback?.(false);
        if (value === 'save' && pending.value) await inspectOperation(pending.value.requestId);
        // 取消离页后恢复维护确认，避免预检仍锁定草稿却失去保存或取消入口。
        else if (changesPreview.value && changeDraft.value) confirmChanges(changesPreview.value);
      }
    }
  }
  function frozenActions(actions: FrequencyAction[]) {
    const result = actions.map(action => action.kind === 'ENABLE' ? Object.freeze({ ...action })
      : action.kind === 'ADD' ? Object.freeze({ ...action, item: Object.freeze({ ...action.item }) })
        : Object.freeze({ ...action, fields: Object.freeze({ ...action.fields }) }));
    Object.freeze(result); return result;
  }
  function openEditor(kind: 'ADD' | 'PATCH', item?: FrequencyResourceItem) {
    if (!canMaintain.value || busy.value || editor.value || kind === 'PATCH' && !page.value?.items.some(row => row.freqId === item?.freqId)) return;
    closeDecision(); preview.value = null; selectedIds.value = []; error.value = '';
    editor.value = { kind, item: item ? { ...item } : null }; editorDirty.value = false;
  }
  function closeEditor() {
    if (pending.value || loading.value.preview || changesPreview.value || phase.value === 'SAVING') return;
    if (!editorDirty.value) { editor.value = null; return; }
    closeDecision(); decisionKind = 'closeEditor';
    decision.value = { title: '关闭构造草稿', message: '草稿尚未提交。是否放弃本地修改？', discardLabel: '放弃草稿', cancelLabel: '继续编辑' };
  }
  async function prepareChanges(actions: FrequencyAction[]) {
    if (!options || !canMaintain.value || busy.value || !actions.length) return;
    closeDecision(); preview.value = null; error.value = '';
    const changes = frozenActions(actions), requestedRevision = revision.value;
    const value = await read('preview', signal => options!.services.validateFrequencyChanges({ context: 'ledger', revision: requestedRevision, changes }, signal));
    if (!value || requestedRevision !== revision.value) return;
    changesPreview.value = value; changeDraft.value = changes; confirmChanges(value);
  }
  function confirmChanges(value: FrequencyChangesValidation) {
    decisionKind = 'changes';
    decision.value = { title: '确认构造频点维护', message: `将变更 ${value.wouldChange.length} 项，${value.unchanged.length} 项无变化。人工构造不代表正式频率授权；历史方案需重算，链路级影响未提供。`, saveLabel: '确认保存', cancelLabel: '取消' };
  }
  async function commitMaintenance() {
    if (!options || !session.value?.canMaintain || !changesPreview.value || !changeDraft.value || pending.value || stale.value
      || changesPreview.value.revision !== revision.value) return;
    pending.value = Object.freeze({ context: 'ledger', baseRevision: revision.value,
      requestId: options.requestId?.() ?? `frequency-maintain-${globalThis.crypto.randomUUID()}`, changes: frozenActions(changeDraft.value) });
    await sendPending();
  }
  return { session, revision, page, history, query, historyQuery, selectedIds, detail, preview, receipt, operation,
    pending, phase, error, notice, stale, listFailed, listReady, decision, loading, busy, locked, canSelect, canMaintain, editor, editorDirty,
    changesPreview, openEditor, closeEditor, prepareChanges, configure, stopReading,
    refresh, loadPage, loadHistory, applyFilters, select, selectPage, clearSelection, prepareDisable, answer,
    inspectOperation, retryPending: sendPending, requestLeave };
});
