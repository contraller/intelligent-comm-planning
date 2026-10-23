import { computed, reactive } from 'vue';
import type { SpectrumSourceDraft, SpectrumSourceReceipt, SpectrumSourceRow, SpectrumSourceServices, SpectrumSourceVersion, SpectrumOfflineCheck, SpectrumSourceSave } from '../types/spectrum-source';
import { assertSpectrumSourceDraft } from '../services/spectrum-source-validation';
import { ApiError } from '../services/types';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (reason: unknown) => reason instanceof Error ? reason.message : '来源操作失败';
export const emptySpectrumSourceDraft = (): SpectrumSourceDraft => ({ name: '', protocolHint: null, endpoint: null,
  intervalSeconds: null, minKhz: null, maxKhz: null, enabled: false, provenanceNote: '' });

export function createSpectrumSourcesStore(services: SpectrumSourceServices, access: () => { canView: boolean; canEdit: boolean }) {
  const state = reactive({ rows: [] as SpectrumSourceRow[], total: 0, page: 1, pageSize: 10, search: '', enabled: undefined as boolean | undefined,
    loading: false, busy: false, error: '', notice: '', stale: false, sourceId: '', baseRevision: null as string | null,
    draft: null as SpectrumSourceDraft | null, original: '', history: [] as SpectrumSourceVersion[], checks: [] as SpectrumOfflineCheck[],
    historyPage: 1, historyTotal: 0, checkPage: 1, checkTotal: 0, receipt: null as SpectrumSourceReceipt | null,
    pending: null as { operationType: 'SOURCE_SAVE' | 'SOURCE_CHECK'; requestId: string; save?: SpectrumSourceSave; sourceId: string; configRevision?: string } | null });
  const dirty = computed(() => !!state.draft && JSON.stringify(state.draft) !== state.original);
  let epoch = 0;
  const readers = new Map<string, { controller: AbortController; token: symbol }>();
  async function read<T>(channel: string, fetch: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) {
    if (!access().canView) return;
    readers.get(channel)?.controller.abort();
    const current = { controller: new AbortController(), token: Symbol() }, generation = epoch;
    readers.set(channel, current); state.error = '';
    if (channel === 'list') state.loading = true;
    try { const value = await fetch(current.controller.signal); if (epoch === generation && readers.get(channel) === current) accept(value); }
    catch (reason) { if (epoch === generation && readers.get(channel) === current && !current.controller.signal.aborted) { state.error = message(reason); state.stale = state.rows.length > 0; } }
    finally { if (readers.get(channel) === current) { readers.delete(channel); if (channel === 'list') state.loading = false; } }
  }
  async function load(page = state.page) {
    const query = { page, pageSize: state.pageSize, search: state.search, enabled: state.enabled };
    await read('list', signal => services.querySources({ ...query, signal }), value => {
      state.rows = value.items; state.total = value.total; state.page = value.page; state.stale = false;
    });
  }
  function edit(row?: SpectrumSourceVersion) {
    if (state.busy || state.pending) return;
    state.sourceId = row?.sourceId ?? ''; state.baseRevision = row?.configRevision ?? null;
    state.draft = copy(row?.draft ?? emptySpectrumSourceDraft()); state.original = row ? JSON.stringify(state.draft) : '';
    state.history = []; state.checks = []; state.historyPage = 1; state.checkPage = 1;
    state.historyTotal = 0; state.checkTotal = 0; state.error = ''; state.notice = '';
  }
  function discard() { if (!state.busy && !state.pending) { state.draft = null; state.original = ''; } }
  async function history(page = 1) {
    if (!state.baseRevision || !state.sourceId) return;
    const sourceId = state.sourceId;
    await read('versions', signal => services.queryVersions({ sourceId, page, pageSize: 10, signal }), value => {
      if (sourceId !== state.sourceId) return; state.history = value.items; state.historyPage = page; state.historyTotal = value.total;
    });
  }
  async function checks(page = 1) {
    if (!state.baseRevision || !state.sourceId) return;
    const sourceId = state.sourceId, configRevision = state.baseRevision;
    await read('checks', signal => services.queryChecks({ sourceId, configRevision, page, pageSize: 10, signal }), value => {
      if (sourceId !== state.sourceId || configRevision !== state.baseRevision) return;
      state.checks = value.items; state.checkPage = page; state.checkTotal = value.total;
    });
  }
  function committed(receipt: SpectrumSourceReceipt) {
    state.receipt = receipt; state.pending = null; state.notice = '操作已持久化';
    if (receipt.source) { state.sourceId = receipt.sourceId; state.baseRevision = receipt.configRevision; state.draft = copy(receipt.source.draft); state.original = JSON.stringify(state.draft); }
  }
  async function run() {
    if (!state.pending || state.busy || !access().canEdit) return;
    const pending = copy(state.pending), generation = epoch; state.busy = true; state.error = ''; state.notice = '';
    try {
      const receipt = pending.operationType === 'SOURCE_SAVE' ? await services.saveSource(pending.save!) :
        await services.checkSource({ requestId: pending.requestId, sourceId: pending.sourceId, configRevision: pending.configRevision! });
      if (generation !== epoch) return; committed(receipt); await load();
      if (state.error) state.notice = '操作已持久化；列表刷新失败，回执已保留';
    } catch (reason) { if (generation === epoch) {
      if (reason instanceof ApiError && [400, 401, 403, 404, 409, 413, 422].includes(reason.status ?? 0)) { state.pending = null; state.error = message(reason) + '；服务器明确拒绝，草稿已保留'; }
      else state.error = message(reason) + '；请求号已保留，请核实回执或原号重试';
    } }
    finally { if (generation === epoch) state.busy = false; }
  }
  async function save() {
    if (state.pending || state.busy || !state.draft || !access().canEdit) return;
    try { assertSpectrumSourceDraft(state.draft); if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(state.sourceId)) throw new Error('来源编号无效'); }
    catch (reason) { state.error = message(reason); return; }
    const requestId = 'source-save-' + crypto.randomUUID();
    state.pending = { requestId, operationType: 'SOURCE_SAVE', sourceId: state.sourceId,
      save: { requestId, sourceId: state.sourceId, baseConfigRevision: state.baseRevision, draft: copy(state.draft) } };
    await run();
  }
  async function check(row: SpectrumSourceVersion) {
    if (state.pending || state.busy || !access().canEdit) return;
    state.pending = { operationType: 'SOURCE_CHECK', requestId: 'source-check-' + crypto.randomUUID(), sourceId: row.sourceId, configRevision: row.configRevision }; await run();
  }
  async function verify() {
    if (!state.pending || state.busy || !access().canView) return;
    const pending = copy(state.pending), generation = epoch; state.busy = true; state.error = '';
    try {
      const value = await services.getSourceReceipt({ requestId: pending.requestId, operationType: pending.operationType });
      if (generation !== epoch) return;
      if (value.receipt) { committed(value.receipt); await load(); }
      else state.notice = '暂未查询到回执，不等于服务器已取消；可保留原号重试';
    } catch (reason) { if (generation === epoch) state.error = message(reason); }
    finally { if (generation === epoch) state.busy = false; }
  }
  function stop() { for (const item of readers.values()) item.controller.abort(); readers.clear(); state.loading = false; }
  function clearForSession() { epoch++; stop(); state.rows = []; state.total = 0; state.draft = null; state.pending = null;
    state.receipt = null; state.history = []; state.checks = []; state.error = ''; state.notice = ''; state.busy = false; state.stale = false;
    state.sourceId = ''; state.baseRevision = null; state.original = ''; state.historyTotal = 0; state.checkTotal = 0; }
  return reactive({ state, dirty, load, edit, discard, history, checks, save, check, verify, retry: run, stop, clearForSession });
}
