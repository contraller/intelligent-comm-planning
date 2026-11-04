import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { diagnosisHistory } from '../src/mocks/diagnosis-history';
import type { DiagnosisDraft, DiagnosisReceipt, DiagnosisVersionDetail } from '../src/types/diagnosis';
import { authorizeStore } from './helpers/auth';

type Action = 'submit' | 'archive' | 'import';
const actions: Action[] = ['submit', 'archive', 'import'];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
let pinia: ReturnType<typeof createPinia> | undefined, store: ReturnType<typeof useDiagnosisStore> | undefined;
afterEach(() => { store?.clearForSession(); store = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); });

function fixture() {
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore(), network = clone(diagnosisHistory[0].network);
  store = useDiagnosisStore();
  const target = store;
  const scenarios = vi.spyOn(previewService, 'queryDiagnosisScenarios').mockResolvedValue({ items: [], total: 0, pageNum: 1, pageSize: 20 });
  const history = vi.spyOn(previewService, 'queryDiagnosisHistory').mockResolvedValue({ items: [], total: 0, pageNum: 1, pageSize: 20 });
  const progress = vi.spyOn(previewService, 'getDiagnosisProgress').mockImplementation(async ({ id }) => ({ id, state: 'PENDING', progress: 0, phases: [], diagnosisReady: false, impactReady: false, error: null, source: { state: 'CURRENT', reasons: [] }, resultVersion: 'RV-' + id }));
  vi.spyOn(previewService, 'getDiagnosisDetail').mockImplementation(async ({ id }) => ({ id, state: 'PENDING', progress: 0, phases: [], diagnosisReady: false, impactReady: false, error: null, source: { state: 'CURRENT', reasons: [] }, resultVersion: 'RV-' + id, run: {
    id, diagnoseTaskId: 'task-' + id, impactTaskId: null, startedAt: 1, cancelledAt: null, presetId: 'owned', presetVersion: 'owned-v1',
    scenario: { id: 'FSV-' + id, scenarioId: 'FS-' + id, version: 1, savedAt: '2026-11-04T00:00:00Z', name: id, description: '', planId: network.id, faults: [], network },
  } }));
  const writes = {
    submit: vi.spyOn(previewService, 'submitDiagnosisReceipt'),
    archive: vi.spyOn(previewService, 'archiveDiagnosisReceipt'),
    import: vi.spyOn(previewService, 'importDiagnosisReceipt'),
  };
  function scene(name: string, revision = 'SR5-1') {
    const draft: DiagnosisDraft = { name, description: '构造回执隔离测试', planId: network.id, faults: [{ objectType: 'DEVICE', objectId: 'device-owned', faultType: 'HW_FAILURE', symptomIds: ['SY-0001'], occurTime: null, interferenceId: null }] };
    target.workspace = { revision, scenarios: [], runs: [] };
    target.sources = { plans: [clone(network)], error: null };
    target.draft = draft; target.baseline = clone(draft); target.scenarioId = 'FS-' + name; target.versionId = 'FSV-' + name;
    target.importPreview = { fileName: name + '.csv', drafts: [clone(draft)], issues: [], matches: [false] };
  }
  function prepare(action: Action) { if (action !== 'import') target.importPreview = null; }
  async function begin(action: Action) {
    prepare(action);
    const done = action === 'submit' ? target.submit() : action === 'archive' ? target.archive(target.scenarioId!, true) : target.commitImport();
    if (action === 'archive') { await settle(); expect(target.decision?.title).toBe('归档场景'); target.answer('save'); }
    await settle();
    return { done };
  }
  function replace() {
    auth.accept({ ...auth.identity!, sessionId: 'new-session' }); target.clearForSession(); scene('new', 'SR5-50');
  }
  scene('old');
  return { store: target, auth, scene, prepare, begin, replace, writes, scenarios, history, progress, network };
}
function receipt(action: Action, name: string, revision: string): DiagnosisReceipt {
  const objectId = (action === 'submit' ? 'FR-' : 'FS-') + name;
  return { objectId, entityIds: [objectId], changed: true, revision };
}

describe('诊断写回执归属', () => {
  // 旧POST保持在途，新会话使用真实store再发一次同类写入；旧finally不得解除新写入的锁。
  for (const action of actions) for (const outcome of ['success', 'reject'] as const) {
    it(`${action}旧会话${outcome}不覆盖新草稿/预检/版本，也不解除新写入busy`, async () => {
      const s = fixture(), old = deferred<DiagnosisReceipt>(), current = deferred<DiagnosisReceipt>();
      s.writes[action].mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
      const first = await s.begin(action); expect(s.store.busy).toBe(true);
      s.replace(); const second = await s.begin(action);
      const draft = clone(s.store.draft), preview = clone(s.store.importPreview);
      s.store.notice = '新会话提示'; s.store.error = '新会话错误'; s.store.importError = '新预检提示';
      if (outcome === 'success') old.resolve(receipt(action, 'old', 'SR5-2')); else old.reject(new ApiError('旧写入已拒绝', 1203));
      await first.done;
      expect(s.store.workspace!.revision).toBe('SR5-50'); expect(s.store.draft).toEqual(draft); expect(s.store.importPreview).toEqual(preview);
      expect(s.store.runId).toBe(''); expect(s.store.selectedArchived).toBe(false); expect(s.store.busy).toBe(true);
      expect(s.store.notice).toBe('新会话提示'); expect(s.store.error).toBe('新会话错误'); expect(s.store.importError).toBe('新预检提示');
      expect(s.scenarios).not.toHaveBeenCalled(); expect(s.history).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
      current.resolve(receipt(action, 'new', 'SR5-51')); await second.done;
      expect(s.store.workspace!.revision).toBe('SR5-51'); expect(s.store.busy).toBe(false); expect(s.writes[action]).toHaveBeenCalledTimes(2);
      if (action === 'submit') { expect(s.store.runId).toBe('FR-new'); expect(s.store.draft).toBeNull(); expect(s.progress).toHaveBeenCalledWith(expect.objectContaining({ id: 'FR-new' })); expect(s.history).toHaveBeenCalledOnce(); }
      if (action === 'archive') { expect(s.store.selectedArchived).toBe(true); expect(s.store.draft).toEqual(draft); expect(s.scenarios).toHaveBeenCalledOnce(); }
      if (action === 'import') { expect(s.store.importPreview).toBeNull(); expect(s.store.notice).toContain('全部场景已导入'); expect(s.scenarios).toHaveBeenCalledOnce(); }
    });
  }

  it.each(actions)('%s当前会话明确失败仍显示错误、保留输入并释放本次busy', async action => {
    const s = fixture(), gate = deferred<DiagnosisReceipt>(); s.writes[action].mockImplementationOnce(() => gate.promise);
    const pending = await s.begin(action), draft = clone(s.store.draft), preview = clone(s.store.importPreview);
    gate.reject(new ApiError('当前写入已拒绝', 1203)); await pending.done;
    expect(s.store.busy).toBe(false); expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.store.draft).toEqual(draft); expect(s.store.importPreview).toEqual(preview);
    expect(action === 'import' ? s.store.importError : s.store.error).toBe('当前写入已拒绝');
    expect(s.writes[action]).toHaveBeenCalledOnce(); expect(s.progress).not.toHaveBeenCalled();
  });

  for (const action of actions) for (const outcome of ['success', 'reject'] as const) {
    it(`${action}普通身份超时后旧写入${outcome}释放自身busy，同身份恢复可继续编辑`, async () => {
      const s = fixture(), gate = deferred<DiagnosisReceipt>(), identity = clone(s.auth.identity!);
      s.writes[action].mockImplementationOnce(() => gate.promise);
      const pending = await s.begin(action), workspace = s.store.workspace, draft = clone(s.store.draft), preview = clone(s.store.importPreview);
      s.store.notice = '原现场保留'; s.store.error = '原业务提示'; s.store.importError = '原导入提示';
      // 使用真实auth.check接收与HTTP层相同的超时错误，不直接改auth代次或清理工作区。
      vi.mocked(previewService.getSession).mockRejectedValueOnce(new ApiError('读取使用身份超时，请重试', 'REQUEST_TIMEOUT'));
      expect(await s.auth.check()).toBe(false); expect(s.auth.errorCode).toBe('REQUEST_TIMEOUT'); expect(s.auth.identity).toBeNull();
      s.store.stopPolling(); // 外层失权路径只停止读取，业务草稿、workspace和写入busy仍保留。
      expect(s.store.workspace).toBe(workspace); expect(s.store.busy).toBe(true);
      if (outcome === 'success') gate.resolve(receipt(action, 'old', 'SR5-2')); else gate.reject(new ApiError('身份冻结期间返回的拒绝', 1203));
      await pending.done;
      expect(s.store.busy).toBe(false); expect(s.store.locked).toBe(false);
      expect(s.store.workspace).toBe(workspace); expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.store.draft).toEqual(draft); expect(s.store.importPreview).toEqual(preview);
      expect(s.store.notice).toBe('原现场保留'); expect(s.store.error).toBe('原业务提示'); expect(s.store.importError).toBe('原导入提示'); expect(s.store.runId).toBe('');
      expect(s.scenarios).not.toHaveBeenCalled(); expect(s.history).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
      vi.mocked(previewService.getSession).mockResolvedValueOnce(identity);
      expect(await s.auth.check()).toBe(true); expect(s.store.locked).toBe(false); expect(s.store.canEdit).toBe(true);
      s.store.updateDraft({ ...clone(s.store.draft!), name: '同身份恢复后继续编辑' });
      expect(s.store.draft!.name).toBe('同身份恢复后继续编辑'); expect(s.writes[action]).toHaveBeenCalledOnce();
    });
  }

  it.each(actions)('%s成功后的旧目录刷新失败不覆盖新会话提示或解除新写入', async action => {
    const s = fixture(), directory = deferred<never>(), current = deferred<DiagnosisReceipt>();
    s.writes[action].mockResolvedValueOnce(receipt(action, 'old', 'SR5-2')).mockImplementationOnce(() => current.promise);
    const list = action === 'submit' ? s.history : s.scenarios;
    list.mockImplementationOnce(() => directory.promise);
    const first = await s.begin(action); expect(list).toHaveBeenCalledOnce(); expect(s.store.busy).toBe(true);
    s.replace(); const second = await s.begin(action), draft = clone(s.store.draft), preview = clone(s.store.importPreview);
    s.store.notice = '新会话目录提示'; directory.reject(new Error('旧目录读取失败')); await first.done;
    expect(s.store.notice).toBe('新会话目录提示'); expect(s.store.workspace!.revision).toBe('SR5-50'); expect(s.store.draft).toEqual(draft); expect(s.store.importPreview).toEqual(preview); expect(s.store.busy).toBe(true); expect(s.progress).not.toHaveBeenCalled();
    current.resolve(receipt(action, 'new', 'SR5-51')); await second.done; expect(s.store.busy).toBe(false); expect(s.writes[action]).toHaveBeenCalledTimes(2);
  });

  it('归档的未保存输入确认晚到，不能丢弃新会话草稿或继续弹出归档确认', async () => {
    const s = fixture(); s.prepare('archive'); s.store.draft!.name = '旧未保存输入';
    const pending = s.store.archive('FS-old', true); expect(s.store.decision?.title).toBe('未保存的诊断输入');
    s.auth.accept({ ...s.auth.identity!, sessionId: 'new-session' }); s.scene('new', 'SR5-50'); s.store.draft!.name = '新未保存输入';
    s.store.answer('save'); await pending;
    expect(s.store.draft!.name).toBe('新未保存输入'); expect(s.store.dirty).toBe(true); expect(s.store.decision).toBeNull(); expect(s.writes.archive).not.toHaveBeenCalled();
  });

  it('归档确认期间撤销权限，确认后不发送POST', async () => {
    const s = fixture(); s.prepare('archive'); const pending = s.store.archive('FS-old', true); await settle(); expect(s.store.decision?.title).toBe('归档场景');
    s.auth.accept({ ...s.auth.identity!, permissions: ['diagnosis.view'] }); s.store.answer('save'); await pending;
    expect(s.writes.archive).not.toHaveBeenCalled(); expect(s.store.workspace!.revision).toBe('SR5-1'); expect(s.store.busy).toBe(false);
  });

  it('缺少现象的提交确认期间换会话，不能沿用旧确认提交新场景', async () => {
    const s = fixture(); s.prepare('submit'); s.store.draft!.faults[0].symptomIds = []; s.store.baseline = clone(s.store.draft);
    const pending = s.store.submit(); expect(s.store.decision?.title).toBe('故障现象不足');
    s.auth.accept({ ...s.auth.identity!, sessionId: 'new-session' }); s.scene('new', 'SR5-50'); s.store.answer('save'); await pending;
    expect(s.writes.submit).not.toHaveBeenCalled(); expect(s.store.draft!.name).toBe('new'); expect(s.store.runId).toBe('');
  });

  it('自动保存已受理但详情读取跨会话，不继续提交诊断', async () => {
    const s = fixture(), detail = deferred<DiagnosisVersionDetail>(); s.prepare('submit'); s.store.draft!.name = '待自动保存';
    const saved = vi.spyOn(previewService, 'saveDiagnosisReceipt').mockResolvedValue({ objectId: 'FS-old', entityIds: ['FS-old', 'FSV-saved'], changed: true, revision: 'SR5-2' });
    const getDetail = vi.spyOn(previewService, 'getDiagnosisVersion').mockImplementationOnce(() => detail.promise);
    const pending = s.store.submit(); await settle(); expect(saved).toHaveBeenCalledOnce(); expect(getDetail).toHaveBeenCalledOnce();
    s.replace(); const draft = clone(s.store.draft);
    detail.resolve({ ...clone(draft!), scenarioId: 'FS-old', id: 'FSV-saved', version: 2, savedAt: '2026-11-04T00:00:00Z', network: s.network, scenarioArchived: false }); await pending;
    expect(s.writes.submit).not.toHaveBeenCalled(); expect(s.store.draft).toEqual(draft); expect(s.store.workspace!.revision).toBe('SR5-50'); expect(s.store.runId).toBe('');
  });

  it('同身份明确清理后重建工作区，旧导入回执也不能清除新预检', async () => {
    const s = fixture(), gate = deferred<DiagnosisReceipt>(); s.writes.import.mockImplementationOnce(() => gate.promise);
    const pending = await s.begin('import'); s.store.clearForSession(); s.scene('new', 'SR5-50'); const preview = clone(s.store.importPreview);
    gate.resolve(receipt('import', 'old', 'SR5-2')); await pending.done;
    expect(s.store.workspace!.revision).toBe('SR5-50'); expect(s.store.importPreview).toEqual(preview); expect(s.store.notice).toBe('');
  });
});
