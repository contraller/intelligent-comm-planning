import { computed, reactive } from 'vue';
import type { SpectrumSourceDraft, SpectrumSourceReceipt, SpectrumSourceRow, SpectrumSourceServices, SpectrumSourceVersion, SpectrumOfflineCheck, SpectrumSourceSave } from '../types/spectrum-source';
import { assertSpectrumSourceDraft, decodeSourceOperation, decodeSourceReceipt, decodeSpectrumSourceConfigFile, spectrumSourceDraftFingerprint } from '../services/spectrum-source-validation';
import { ApiError } from '../services/types';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (reason: unknown) => reason instanceof Error ? reason.message : '来源操作失败';
type PendingSource = { operationType: 'SOURCE_SAVE' | 'SOURCE_CHECK'; requestId: string; save?: SpectrumSourceSave; sourceId: string; configRevision?: string };
export const emptySpectrumSourceDraft = (): SpectrumSourceDraft => ({ name: '', protocolHint: null, endpoint: null,
  intervalSeconds: null, minKhz: null, maxKhz: null, enabled: false, provenanceNote: '' });

export function createSpectrumSourcesStore(services: SpectrumSourceServices, access: () => { canView: boolean; canEdit: boolean }) {
  const state = reactive({ rows: [] as SpectrumSourceRow[], total: 0, page: 1, pageSize: 10, search: '', enabled: undefined as boolean | undefined,
    loading: false, busy: false, error: '', notice: '', stale: false, sourceId: '', baseRevision: null as string | null,
    draft: null as SpectrumSourceDraft | null, original: '', history: [] as SpectrumSourceVersion[], checks: [] as SpectrumOfflineCheck[],
    historyPage: 1, historyTotal: 0, checkPage: 1, checkTotal: 0, receipt: null as SpectrumSourceReceipt | null,
    fileLoading: false, importedFrom: null as { sourceId: string; configRevision: string } | null,
    pending: null as PendingSource | null });
  const dirty = computed(() => !!state.draft && JSON.stringify(state.draft) !== state.original);
  let epoch = 0, fileSerial = 0, pendingProof = '';
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
  function setDraft(row?: SpectrumSourceVersion) {
    for (const channel of ['versions', 'checks']) { readers.get(channel)?.controller.abort(); readers.delete(channel); }
    state.sourceId = row?.sourceId ?? ''; state.baseRevision = row?.configRevision ?? null;
    state.draft = copy(row?.draft ?? emptySpectrumSourceDraft()); state.original = row ? JSON.stringify(state.draft) : '';
    state.history = []; state.checks = []; state.historyPage = 1; state.checkPage = 1;
    state.historyTotal = 0; state.checkTotal = 0; state.error = ''; state.notice = ''; state.importedFrom = null;
  }
  function edit(row?: SpectrumSourceVersion) { if (!state.busy && !state.pending && !state.fileLoading) setDraft(row); }
  function discard() { if (!state.busy && !state.pending && !state.fileLoading) { state.draft = null; state.original = ''; state.importedFrom = null; } }
  async function fillConfig(value: unknown) {
    let file;
    try { file = copy(decodeSpectrumSourceConfigFile(value)); } catch (reason) { state.error = message(reason); return false; }
    if (!access().canView || !access().canEdit || state.busy || state.pending || state.fileLoading || dirty.value) { state.error = '请先处理当前草稿或待核实操作'; return false; }
    const serial = ++fileSerial; let accepted = false; state.fileLoading = true;
    try {
      await read('config-file', async signal => {
        try { return await services.getSource({ sourceId: file.sourceId, signal }); }
        catch (reason) { if (reason instanceof ApiError && reason.status === 404 && reason.code === 1002) return null; throw reason; }
      }, current => {
        if (serial !== fileSerial || !access().canView || !access().canEdit || state.busy || state.pending || dirty.value) return;
        setDraft(current ?? undefined); state.sourceId = file.sourceId; state.draft = copy(file.draft);
        state.importedFrom = { sourceId: file.sourceId, configRevision: file.configRevision };
        state.notice = '配置文件已回填草稿，尚未保存'; accepted = true;
      });
    } finally { if (serial === fileSerial) state.fileLoading = false; }
    return accepted;
  }
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
  function fingerprint(pending: PendingSource) {
    return JSON.stringify({ operationType: pending.operationType, requestId: pending.requestId, sourceId: pending.sourceId,
      configRevision: pending.configRevision ?? null, save: pending.save ? { requestId: pending.save.requestId,
        sourceId: pending.save.sourceId, baseConfigRevision: pending.save.baseConfigRevision,
        draft: spectrumSourceDraftFingerprint(pending.save.draft) } : null });
  }
  function assertPending(pending: PendingSource) {
    if (!pendingProof || !state.pending || fingerprint(state.pending) !== pendingProof || fingerprint(pending) !== pendingProof)
      throw new Error('待核实请求内容已变化，禁止替换原请求或接受回执');
  }
  function committed(receipt: SpectrumSourceReceipt, pending: PendingSource) {
    assertPending(pending);
    decodeSourceReceipt(receipt, { requestId: pending.requestId, operationType: pending.operationType,
      sourceId: pending.sourceId, ...(pending.operationType === 'SOURCE_CHECK' ? { configRevision: pending.configRevision } : {}) });
    if (pending.operationType === 'SOURCE_SAVE' && (!pending.save || pending.save.sourceId !== pending.sourceId
      || pending.save.requestId !== pending.requestId || !receipt.source
      || spectrumSourceDraftFingerprint(receipt.source.draft) !== spectrumSourceDraftFingerprint(pending.save.draft)
      || receipt.changed !== (receipt.configRevision !== pending.save.baseConfigRevision))) throw new Error('来源保存回执与冻结配置或基线不一致');
    state.receipt = receipt; state.pending = null; pendingProof = ''; state.notice = '操作已持久化';
    if (receipt.source) { state.sourceId = receipt.sourceId; state.baseRevision = receipt.configRevision; state.draft = copy(receipt.source.draft); state.original = JSON.stringify(state.draft); }
  }
  async function run() {
    if (!state.pending || state.busy || state.fileLoading || !access().canEdit) return;
    const pending = copy(state.pending), generation = epoch; state.busy = true; state.error = ''; state.notice = '';
    try {
      assertPending(pending);
      const receipt = pending.operationType === 'SOURCE_SAVE' ? await services.saveSource(pending.save!) :
        await services.checkSource({ requestId: pending.requestId, sourceId: pending.sourceId, configRevision: pending.configRevision! });
      if (generation !== epoch) return; committed(receipt, pending); await load();
      if (state.error) state.notice = '操作已持久化；列表刷新失败，回执已保留';
    } catch (reason) { if (generation === epoch) {
      if (reason instanceof ApiError && [400, 401, 403, 404, 409, 413, 422].includes(reason.status ?? 0)) { state.pending = null; pendingProof = ''; state.error = message(reason) + '；服务器明确拒绝，草稿已保留'; }
      else state.error = message(reason) + '；请求号已保留，请核实回执或原号重试';
    } }
    finally { if (generation === epoch) state.busy = false; }
  }
  async function save() {
    if (state.pending || state.busy || state.fileLoading || !state.draft || !access().canEdit) return;
    try { assertSpectrumSourceDraft(state.draft); if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(state.sourceId)) throw new Error('来源编号无效'); }
    catch (reason) { state.error = message(reason); return; }
    const requestId = 'source-save-' + crypto.randomUUID();
    state.pending = { requestId, operationType: 'SOURCE_SAVE', sourceId: state.sourceId,
      save: { requestId, sourceId: state.sourceId, baseConfigRevision: state.baseRevision, draft: copy(state.draft) } };
    pendingProof = fingerprint(state.pending);
    await run();
  }
  async function check(row: SpectrumSourceVersion) {
    if (state.pending || state.busy || state.fileLoading || !access().canEdit) return;
    state.pending = { operationType: 'SOURCE_CHECK', requestId: 'source-check-' + crypto.randomUUID(), sourceId: row.sourceId, configRevision: row.configRevision };
    pendingProof = fingerprint(state.pending); await run();
  }
  async function verify() {
    if (!state.pending || state.busy || !access().canView) return;
    const pending = copy(state.pending), generation = epoch; state.busy = true; state.error = '';
    try {
      assertPending(pending);
      const value = await services.getSourceReceipt({ requestId: pending.requestId, operationType: pending.operationType });
      if (generation !== epoch) return;
      decodeSourceOperation(value, pending);
      if (value.receipt) { committed(value.receipt, pending); await load(); }
      else state.notice = '暂未查询到回执，不等于服务器已取消；可保留原号重试';
    } catch (reason) { if (generation === epoch) state.error = message(reason); }
    finally { if (generation === epoch) state.busy = false; }
  }
  function stop() { for (const item of readers.values()) item.controller.abort(); readers.clear(); state.loading = false; fileSerial++; state.fileLoading = false; }
  function clearForSession() { epoch++; stop(); state.rows = []; state.total = 0; state.draft = null; state.pending = null;
    state.receipt = null; state.history = []; state.checks = []; state.error = ''; state.notice = ''; state.busy = false; state.stale = false;
    state.sourceId = ''; state.baseRevision = null; state.original = ''; state.historyTotal = 0; state.checkTotal = 0; state.importedFrom = null; pendingProof = ''; }
  return reactive({ state, dirty, load, edit, discard, fillConfig, history, checks, save, check, verify, retry: run, stop, clearForSession });
}
