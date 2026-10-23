import { describe, expect, it, vi } from 'vitest';
import { createSpectrumSourcesStore } from '../src/stores/spectrum-sources';
import type { SpectrumSourceServices, SpectrumSourceReceipt, SpectrumSourceVersion } from '../src/types/spectrum-source';
import { ApiError } from '../src/services/types';
const draft = { name: '构造来源', protocolHint: null, endpoint: null, intervalSeconds: null, minKhz: null, maxKhz: null, enabled: false, provenanceNote: '独立测试，非实测' };
const revision = 'SPV-' + 'a'.repeat(64), stamp = '2026-10-05T01:00:00.000000Z';
const version = (): SpectrumSourceVersion => ({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'source-A', configRevision: revision,
  contentHash: 'a'.repeat(64), draft: { ...draft }, createdAt: stamp, actorId: 'test-editor' });
const configFile = () => ({ schemaVersion: 1, fileKind: 'SPECTRUM_SOURCE_CONFIG', dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'source-A', configRevision: 'SPV-' + 'b'.repeat(64), draft: { ...draft, name: '文件中的构造配置' } });
const saved = (requestId: string): SpectrumSourceReceipt => ({ requestId, operationType: 'SOURCE_SAVE', sourceId: 'source-A', configRevision: revision,
  changed: true, actorId: 'test-editor', committedAt: stamp, source: version(), check: null });
const operation = (requestId: string, receipt: SpectrumSourceReceipt | null) => ({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION',
  operationType: 'SOURCE_SAVE', requestId, status: receipt ? 'COMMITTED' : 'NOT_FOUND', receipt });
describe('来源表单状态机', () => {
  it('超时保留原号和原内容，阻止重复保存；查无回执不伪报取消', async () => {
    const saveSource = vi.fn().mockRejectedValue(new Error('超时')), getSourceReceipt = vi.fn(async ({ requestId }: { requestId: string }) => operation(requestId, null));
    const store = createSpectrumSourcesStore({ saveSource, getSourceReceipt } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft);
    await store.save(); const requestId = store.state.pending!.requestId;
    await store.save(); expect(saveSource).toHaveBeenCalledTimes(1);
    await store.verify(); expect(store.state.pending?.requestId).toBe(requestId); expect(store.state.notice).toContain('不等于');
    await store.retry(); expect(saveSource.mock.calls[1][0]).toEqual(saveSource.mock.calls[0][0]);
    store.clearForSession(); expect(store.state.pending).toBeNull(); expect(store.state.draft).toBeNull();
  });
  it('成功回执与写后刷新失败分开，不重发写入', async () => {
    const saveSource = vi.fn(async ({ requestId }: { requestId: string }) => saved(requestId));
    const store = createSpectrumSourcesStore({ saveSource, querySources: vi.fn().mockRejectedValue(new Error('刷新失败')) } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft); await store.save();
    expect(store.state.receipt?.requestId).toBe(saveSource.mock.calls[0][0].requestId); expect(store.state.pending).toBeNull(); expect(store.dirty).toBe(false);
    expect(store.state.notice).toContain('已持久化'); expect(saveSource).toHaveBeenCalledTimes(1);
  });
  it('会话清理之后的晚到列表不回灌', async () => {
    let resolve!: (value: unknown) => void;
    const store = createSpectrumSourcesStore({ querySources: () => new Promise(done => { resolve = done; }) } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: false }));
    const pending = store.load(); store.clearForSession(); resolve({ items: [{ sourceId: 'old' }], total: 1, page: 1 }); await pending;
    expect(store.state.rows).toEqual([]);
  });
  it('服务器明确拒绝允许修改草稿，不陷入未知提交锁', async () => {
    const store = createSpectrumSourcesStore({ saveSource: vi.fn().mockRejectedValue(new ApiError('配置冲突', 1204, null, undefined, 409)) } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft); await store.save();
    expect(store.state.pending).toBeNull(); expect(store.state.draft?.name).toBe(draft.name); expect(store.dirty).toBe(true);
  });
  it('配置JSON只回填草稿，文件版本保留标源但不冒充CAS基线', async () => {
    const getSource = vi.fn(async () => version()), saveSource = vi.fn();
    const store = createSpectrumSourcesStore({ getSource, saveSource } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    const file = configFile(); expect(await store.fillConfig(file)).toBe(true); file.draft.name = '晚到突变';
    expect(store.state.baseRevision).toBe(revision); expect(store.state.importedFrom?.configRevision).toBe(configFile().configRevision);
    expect(store.state.draft?.name).toBe('文件中的构造配置'); expect(store.dirty).toBe(true); expect(saveSource).not.toHaveBeenCalled();
    expect(getSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'source-A', signal: expect.any(AbortSignal) }));
  });
  it('仅明确404/1002按新来源回填，其他读取失败保留原稿', async () => {
    const getSource = vi.fn().mockRejectedValueOnce(new ApiError('不存在', 1002, null, undefined, 404)).mockRejectedValueOnce(new ApiError('无权', 1104, null, undefined, 403));
    const store = createSpectrumSourcesStore({ getSource } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    expect(await store.fillConfig(configFile())).toBe(true); expect(store.state.baseRevision).toBeNull();
    store.discard(); store.edit(version());
    expect(await store.fillConfig(configFile())).toBe(false); expect(store.state.baseRevision).toBe(revision); expect(store.state.draft).toEqual(draft);
  });
  it('非法配置、dirty或待核实状态均不能覆盖草稿或发读取', async () => {
    const getSource = vi.fn(), saveSource = vi.fn().mockRejectedValue(new Error('timeout'));
    const store = createSpectrumSourcesStore({ getSource, saveSource } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(version());
    expect(await store.fillConfig({ ...configFile(), dataOrigin: 'MEASURED' })).toBe(false);
    store.state.draft!.name = '未保存'; expect(await store.fillConfig(configFile())).toBe(false); expect(store.state.draft!.name).toBe('未保存');
    await store.save(); expect(store.state.pending).not.toBeNull(); expect(await store.fillConfig(configFile())).toBe(false);
    expect(getSource).not.toHaveBeenCalled(); expect(store.state.draft!.name).toBe('未保存');
  });
  it.each(['stop', 'clearForSession'] as const)('配置基线晚到在%s之后不回填', async action => {
    let finish!: (value: SpectrumSourceVersion) => void;
    const getSource = vi.fn((_query: { sourceId: string; signal?: AbortSignal }) => new Promise<SpectrumSourceVersion>(resolve => { finish = resolve; }));
    const store = createSpectrumSourcesStore({ getSource } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    const pending = store.fillConfig(configFile()); expect(store.state.fileLoading).toBe(true);
    store[action](); expect(getSource.mock.calls[0][0].signal?.aborted).toBe(true); finish(version());
    expect(await pending).toBe(false); expect(store.state.draft).toBeNull(); expect(store.state.fileLoading).toBe(false);
  });
  it.each(['source', 'revision', 'draft', 'changed'] as const)('待核实保存回执%s不符不解锁', async field => {
    const getSourceReceipt = vi.fn(), saveSource = vi.fn().mockRejectedValue(new Error('timeout'));
    const store = createSpectrumSourcesStore({ getSourceReceipt, saveSource, querySources: vi.fn(async () => ({ items: [], total: 0, page: 1 })) } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft); await store.save();
    const id = store.state.pending!.requestId, receipt = saved(id);
    if (field === 'source') { receipt.sourceId = 'source-B'; receipt.source!.sourceId = 'source-B'; }
    if (field === 'revision') receipt.source!.configRevision = 'SPV-' + 'b'.repeat(64);
    if (field === 'draft') receipt.source!.draft.enabled = true;
    if (field === 'changed') receipt.changed = false;
    getSourceReceipt.mockResolvedValueOnce(operation(id, receipt)); await store.verify();
    expect(store.state.pending?.requestId).toBe(id); expect(store.state.receipt).toBeNull();
    // 字段顺序不影响逐字段摘要；真实匹配回执才解锁。
    const valid = saved(id); valid.source!.draft = Object.fromEntries(Object.entries(draft).reverse()) as typeof draft;
    getSourceReceipt.mockResolvedValueOnce(operation(id, valid)); await store.verify(); expect(store.state.pending).toBeNull();
  });
  it('读取配置基线期间发生新dirty或权限撤回，晚到不覆盖草稿', async () => {
    let finish!: (value: SpectrumSourceVersion) => void;
    const access = { canView: true, canEdit: true };
    const getSource = vi.fn(() => new Promise<SpectrumSourceVersion>(resolve => { finish = resolve; }));
    const store = createSpectrumSourcesStore({ getSource } as unknown as SpectrumSourceServices, () => access);
    store.edit(version()); const pending = store.fillConfig(configFile()); store.state.draft!.name = '新的未保存编辑'; finish(version());
    expect(await pending).toBe(false); expect(store.state.draft!.name).toBe('新的未保存编辑'); expect(store.state.importedFrom).toBeNull();
    store.discard(); const revoked = store.fillConfig(configFile()); access.canEdit = false; finish(version());
    expect(await revoked).toBe(false); expect(store.state.draft).toBeNull();
  });
  it.each(['sourceId', 'baseConfigRevision', 'draft'] as const)('冻结pending的%s被改动不能重试或清锁', async field => {
    const saveSource = vi.fn().mockRejectedValue(new Error('timeout')), getSourceReceipt = vi.fn();
    const store = createSpectrumSourcesStore({ saveSource, getSourceReceipt } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft); await store.save();
    if (field === 'draft') store.state.pending!.save!.draft.provenanceNote = '突变';
    else store.state.pending!.save![field] = field === 'sourceId' ? 'source-B' : revision;
    await store.retry(); await store.verify(); expect(saveSource).toHaveBeenCalledTimes(1); expect(getSourceReceipt).not.toHaveBeenCalled();
    expect(store.state.pending).not.toBeNull(); expect(store.state.receipt).toBeNull();
  });
  it('发起后pending突变也不能被晚到成功回执清掉', async () => {
    let finish!: (value: SpectrumSourceReceipt) => void;
    const saveSource = vi.fn(() => new Promise<SpectrumSourceReceipt>(resolve => { finish = resolve; }));
    const store = createSpectrumSourcesStore({ saveSource } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft); const request = store.save();
    const id = store.state.pending!.requestId; store.state.pending!.sourceId = 'source-B'; finish(saved(id)); await request;
    expect(store.state.pending).not.toBeNull(); expect(store.state.receipt).toBeNull();
  });
  it('检查回执必须匹配冻结来源与配置版本，不能使用当前列表版本代替', async () => {
    const checkSource = vi.fn().mockRejectedValue(new Error('timeout')), getSourceReceipt = vi.fn();
    const store = createSpectrumSourcesStore({ checkSource, getSourceReceipt } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    await store.check(version()); const pending = store.state.pending!, otherRevision = 'SPV-' + 'b'.repeat(64);
    getSourceReceipt.mockResolvedValue({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', requestId: pending.requestId, operationType: 'SOURCE_CHECK', status: 'COMMITTED',
      receipt: { ...saved(pending.requestId), operationType: 'SOURCE_CHECK', configRevision: otherRevision, changed: false, source: null,
        check: { checkId: 'check-A', sourceId: 'source-A', configRevision: otherRevision, checkedAt: stamp, validation: 'VALID', connection: 'NOT_ATTEMPTED', validationMode: 'OFFLINE_ONLY', issues: [] } } });
    await store.verify(); expect(store.state.pending).not.toBeNull(); expect(store.state.receipt).toBeNull();
  });
});
