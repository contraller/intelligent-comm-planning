import { computed, reactive } from 'vue';
import type { ObservationDataset, ObservationFrameResult, ObservationImportFile, ObservationImportOperation, ObservationImportPreview, ObservationImportReceipt, ObservationSelection, ObservationServices, ObservationFrame, ObservationDeviceStatusRefWire, ObservationImportSubmission } from '../types/observation';
import { createMonitoringPlayback, initialPlaybackState } from '../services/monitoring-playback';
import { decodeObservationImportFile, sameObservationStatusRef } from '../services/observation-validation';
import { ApiError } from '../services/types';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (reason: unknown) => reason instanceof Error ? reason.message : '观测操作失败';
const rejected = (reason: unknown) => reason instanceof ApiError && [400, 401, 403, 404, 409, 413, 422].includes(reason.status ?? 0);
export function createSpectrumObservationsStore(services: ObservationServices, canView: () => boolean, accepted?: (frame: ObservationFrame) => void) {
  const state = reactive({ rows: [] as ObservationDataset[], total: 0, page: 1, pageSize: 10, loading: false, error: '', stale: false,
    selected: null as ObservationDataset | null, result: null as ObservationFrameResult | null, frameRows: [] as ObservationFrame[],
    framePage: 1, framePageSize: 10, frameTotal: 0, frameLoading: false, playback: initialPlaybackState(),
    statusRef: null as ObservationDeviceStatusRefWire | null, statusRefState: 'unread' as 'unread' | 'loading' | 'unbound' | 'bound' | 'error', statusRefError: '' });
  state.playback.intervalSeconds = 1;
  let epoch = 0, listSerial = 0, frameSerial = 0, seekSerial = 0, refSerial = 0;
  const controllers = new Map<string, AbortController>();
  function controller(channel: string) { controllers.get(channel)?.abort(); const value = new AbortController(); controllers.set(channel, value); return value; }
  async function fetchFrame(index: number) {
    if (!canView() || !state.selected) throw new Error('请选择观测集');
    const current = controller('frame'), selected = state.selected, serial = ++frameSerial, generation = epoch;
    const result = await services.getObservationFrame({ datasetId: selected.datasetId, datasetRevision: selected.datasetRevision, index, signal: current.signal });
    if (current.signal.aborted || serial !== frameSerial || epoch !== generation || selected !== state.selected) throw new Error('过期观测读取已丢弃');
    return result;
  }
  function accept(value: ObservationFrameResult) { state.result = value; state.stale = false; state.error = ''; accepted?.(value.frame); }
  const player = createMonitoringPlayback(state.playback, fetchFrame, accept, reason => { state.error = message(reason); state.stale = !!state.result; });
  function pause() { player.setActive(false); controllers.get('frame')?.abort(); frameSerial++; seekSerial++; state.playback.busy = false; }
  function stop() { pause(); for (const item of controllers.values()) item.abort(); controllers.clear(); listSerial++; refSerial++; state.loading = false; state.frameLoading = false; if (state.statusRefState === 'loading') state.statusRefState = 'unread'; }
  async function readStatusRef() {
    if (!canView() || !state.selected) return;
    const current = controller('status-ref'), generation = epoch, selected = state.selected, serial = ++refSerial;
    state.statusRef = null; state.statusRefState = 'loading'; state.statusRefError = '';
    try {
      const value = await services.getObservationDeviceStatusRef({ datasetId: selected.datasetId, datasetRevision: selected.datasetRevision, signal: current.signal });
      if (epoch !== generation || serial !== refSerial || selected !== state.selected || current.signal.aborted) return;
      if (value.datasetId !== selected.datasetId || value.datasetRevision !== selected.datasetRevision || value.resourceRevision !== selected.resourceRevision) throw new Error('关联观测或资源版本不符');
      state.statusRef = value.deviceStatusRef; state.statusRefState = value.deviceStatusRef === null ? 'unbound' : 'bound';
    } catch (reason) { if (epoch === generation && serial === refSerial && selected === state.selected && !current.signal.aborted) { state.statusRefState = 'error'; state.statusRefError = message(reason); } }
  }
  async function load(page = state.page) {
    if (!canView()) return;
    const current = controller('list'), serial = ++listSerial, generation = epoch; state.loading = true; state.error = '';
    try { const value = await services.queryObservationDatasets({ page, pageSize: state.pageSize, signal: current.signal });
      if (serial !== listSerial || epoch !== generation || current.signal.aborted) return;
      state.rows = value.items; state.total = value.total; state.page = page;
    } catch (reason) { if (serial === listSerial && epoch === generation && !current.signal.aborted) { state.error = message(reason); state.stale = !!state.result; } }
    finally { if (serial === listSerial && epoch === generation) state.loading = false; }
  }
  async function frames(page = 1) {
    if (!canView() || !state.selected) return;
    const current = controller('frames'), generation = epoch, selected = state.selected; state.frameLoading = true;
    try { const value = await services.queryObservationFrames({ datasetId: selected.datasetId, datasetRevision: selected.datasetRevision, page, pageSize: state.framePageSize, signal: current.signal });
      if (epoch !== generation || selected !== state.selected || current.signal.aborted) return;
      state.frameRows = value.items; state.framePage = page; state.frameTotal = value.total;
    } catch (reason) { if (epoch === generation && !current.signal.aborted) state.error = message(reason); }
    finally { if (epoch === generation && controllers.get('frames') === current) state.frameLoading = false; }
  }
  async function seek(index: number) {
    pause(); state.playback.busy = true;
    const generation = epoch, selected = state.selected, serial = ++seekSerial;
    try { const value = await fetchFrame(index); if (epoch === generation && selected === state.selected && serial === seekSerial) {
      accept(value); state.playback.index = index; state.playback.finished = !value.hasNext; state.playback.error = '';
    } } catch (reason) { if (epoch === generation && selected === state.selected && serial === seekSerial && index >= 0) { state.error = message(reason); state.stale = !!state.result; } }
    finally { if (epoch === generation && selected === state.selected && serial === seekSerial) state.playback.busy = false; }
  }
  async function select(input: ObservationSelection) {
    if (!canView()) return;
    pause(); controllers.get('frames')?.abort(); controllers.get('status-ref')?.abort(); refSerial++; state.statusRef = null; state.statusRefState = 'unread'; state.statusRefError = ''; player.reset(); state.selected = null; state.result = null; state.frameRows = []; state.frameTotal = 0; state.frameLoading = false; state.error = '';
    const current = controller('selection'), generation = epoch;
    try { const context = await services.loadObservationContext({ ...input, signal: current.signal });
      if (epoch !== generation || current.signal.aborted) return;
      state.selected = context.selected; player.configure(context.selected?.frameCount ?? 0, state.playback.intervalSeconds);
      if (state.selected) { await Promise.all([seek(0), frames(), readStatusRef()]); }
    } catch (reason) { if (epoch === generation && !current.signal.aborted) state.error = message(reason); }
  }
  function play() { if (canView() && state.selected && !state.playback.busy && !state.playback.finished) { state.playback.error = ''; player.setActive(true); } }
  function interval(value: number) { if (Number.isInteger(value) && value >= 1 && value <= 30) player.configure(state.selected?.frameCount ?? 0, value); }
  function clearForSession() { epoch++; stop(); player.clear(); state.playback.intervalSeconds = 1; state.selected = null;
    state.rows = []; state.total = 0; state.result = null; state.frameRows = []; state.error = ''; state.stale = false; state.statusRef = null; state.statusRefState = 'unread'; state.statusRefError = ''; }
  return reactive({ state, load, select, frames, seek, play, pause, stop, interval, clearForSession, readStatusRef,
    restart: () => seek(0), next: () => state.selected && !state.playback.finished ? seek(state.playback.index + 1) : Promise.resolve() });
}

export function createObservationImportStore(services: ObservationServices, canImport: () => boolean, committed?: (receipt: ObservationImportReceipt) => void) {
  const state = reactive({ file: null as ObservationImportFile | null, preview: null as ObservationImportPreview | null,
    busy: false, error: '', notice: '', receipt: null as ObservationImportReceipt | null,
    pending: null as ObservationImportSubmission | null });
  let epoch = 0, reader: AbortController | undefined, previewInput = '';
  const dirty = computed(() => !!state.file && !state.receipt);
  function invalidatePreview() {
    if (state.pending) return;
    epoch++; reader?.abort(); state.busy = false; state.preview = null; previewInput = '';
  }
  function choose(value: unknown) {
    if (state.busy || state.pending) return;
    reader?.abort(); epoch++; state.preview = null; previewInput = ''; state.receipt = null; state.notice = ''; state.error = ''; state.file = null;
    try { state.file = copy(decodeObservationImportFile(value)); } catch (reason) { state.error = message(reason); }
  }
  async function preview() {
    if (!state.file || state.busy || state.pending || !canImport()) return;
    const file = copy(state.file), generation = epoch; reader?.abort(); reader = new AbortController(); state.busy = true; state.error = '';
    try { const value = await services.previewObservationImport({ file, signal: reader.signal });
      if (epoch === generation) { state.preview = value; previewInput = JSON.stringify(file); }
    } catch (reason) { if (epoch === generation) { state.error = message(reason); state.preview = null; } }
    finally { if (epoch === generation) state.busy = false; }
  }
  function accept(value: ObservationImportOperation, pending: ObservationImportSubmission) {
    if (value.receipt) {
      const receipt = value.receipt, file = pending.file;
      if (value.requestId !== pending.requestId || receipt.requestId !== pending.requestId || value.schemaVersion !== file.schemaVersion || receipt.datasetId !== file.dataset.datasetId
        || receipt.resourceRevision !== file.dataset.resourceRevision || receipt.frameCount !== file.dataset.frames.length
        || receipt.datasetRevision !== 'observation-' + (file.schemaVersion === 2 ? pending.datasetContentHash : pending.previewHash)
        || file.schemaVersion === 2 && (value.schemaVersion !== 2 || !value.deviceStatusRef || !sameObservationStatusRef(value.deviceStatusRef, file.deviceStatusRef))) throw new Error('回执正文或冻结关联与待核实请求不符');
      state.receipt = receipt; state.pending = null; state.notice = '导入已持久化'; committed?.(receipt);
    }
    else state.notice = '暂未查询到回执，不等于服务器已取消；请保留原号核实或重试';
  }
  async function send(lookup = false) {
    if (!state.pending || state.busy || !canImport()) return;
    const pending = copy(state.pending), generation = epoch; state.busy = true; state.error = '';
    try { const value = lookup ? await services.getObservationImportReceipt({ requestId: pending.requestId, ...(pending.file.schemaVersion === 2 ? { includeDeviceStatusRef: true } : {}) }) : await services.importObservation(pending);
      if (epoch === generation) accept(value, pending);
    } catch (reason) { if (epoch === generation) {
      if (!lookup && rejected(reason)) { state.pending = null; state.preview = null; previewInput = ''; state.error = message(reason) + '；服务器明确拒绝，输入已保留'; }
      else state.error = message(reason) + '；结果待核实，未声明服务器取消';
    } }
    finally { if (epoch === generation) state.busy = false; }
  }
  async function submit() {
    if (!state.preview || !state.file || state.pending || state.busy || !canImport()) return;
    // 提交只使用这次预检输入，不能沿用更改内容之前的hash。
    if (previewInput !== JSON.stringify(state.file)) { state.preview = null; previewInput = ''; state.error = '文件内容已变化，请重新预检'; return; }
    const requestId = 'observation-import-' + crypto.randomUUID(), previewHash = state.preview.previewHash, file = copy(state.file);
    if (file.schemaVersion === 2) {
      if (state.preview.schemaVersion !== 2 || !sameObservationStatusRef(file.deviceStatusRef, state.preview.deviceStatusRef)) { state.preview = null; state.error = '关联预检不匹配，请重新预检'; return; }
      state.pending = { requestId, previewHash, file, datasetContentHash: state.preview.datasetContentHash };
    } else state.pending = { requestId, previewHash, file };
    await send();
  }
  function clearForSession() { epoch++; reader?.abort(); state.file = null; state.preview = null; state.pending = null;
    state.receipt = null; state.busy = false; state.error = ''; state.notice = ''; previewInput = ''; }
  return reactive({ state, dirty, choose, preview, invalidatePreview, submit, retry: () => send(), verify: () => send(true), clearForSession });
}
