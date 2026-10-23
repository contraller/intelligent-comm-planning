import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useFrequencyResourceStore } from '../src/stores/frequency-resource';
import { ApiError } from '../src/services/types';
import type { FrequencyDisableReceipt, FrequencyDisableValidation, FrequencyResourceItem,
  FrequencyResourcePage, FrequencyPageQuery } from '../src/types/frequency-resource';

const base = 'resource-1111111111111111', next = 'resource-2222222222222222', later = 'resource-3333333333333333';
const item = (id: string, available = true): FrequencyResourceItem => ({ freqId: id, deviceClass: 'HF', centerFreqKhz: 3000,
  bandwidthKhz: null, channelNo: null, isAvailable: available, occupiedBy: null, reuseMinDistanceM: null, adjacentGuardKhz: null, note: null });
const page = (request: FrequencyPageQuery): FrequencyResourcePage => ({ revision: request.revision, baseRevision: request.revision,
  contentHash: 'a'.repeat(64), dataOrigin: 'SYNTHETIC_INTEGRATION', source: '构造资源', page: request.page,
  pageSize: request.pageSize, total: 2, items: [item('FQ-0001'), item('FQ-0002')] });
const preview = (): FrequencyDisableValidation => ({ ...page({ context: 'ledger', revision: base, page: 1, pageSize: 10 }),
  selectedIds: ['FQ-0001'], wouldDisable: ['FQ-0001'], unchanged: [], items: [item('FQ-0001')],
  impact: { resourceRevisionWillChange: true, historicalResourcesPreserved: true, savedPlansRequireRecompute: true, linkImpact: 'UNKNOWN' } });
const receipt = (): FrequencyDisableReceipt => ({ objectId: 'resource-frequency-disable', requestId: 'fixed-request', baseRevision: base,
  revision: next, readRevision: next, changed: true, selectedIds: ['FQ-0001'], updated: ['FQ-0001'], unchanged: [], affectedIds: ['FQ-0001'],
  items: [item('FQ-0001', false)], dataOrigin: 'SYNTHETIC_INTEGRATION', source: '构造资源', warnings: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
let pinia: ReturnType<typeof createPinia>;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
async function fixture() {
  pinia = createPinia(); setActivePinia(pinia);
  const services = { loadFrequencyResources: vi.fn(), queryFrequencyResources: vi.fn().mockImplementation(async input => page(input)),
    validateFrequencyDisable: vi.fn().mockResolvedValue(preview()), disableFrequencyResources: vi.fn().mockResolvedValue(receipt()),
    queryFrequencyOperations: vi.fn().mockResolvedValue({ page: 1, pageSize: 10, total: 0, items: [] }),
    getFrequencyOperation: vi.fn().mockResolvedValue({ operation: 'FREQUENCY_DISABLE', requestId: 'fixed-request', createdAt: '2026-10-23T00:00:00Z', receipt: receipt() }) };
  const options = { services, loadContext: vi.fn().mockResolvedValue({ revision: base }), requestId: () => 'fixed-request',
    session: { accountId: 'actor', generation: 1, readable: true, canDisable: true, canMaintain: false }, onResourceChanged: vi.fn() };
  const store = useFrequencyResourceStore(); store.configure(options); await store.refresh();
  return { store, services, options };
}

describe('规划频点独立工作区', () => {
  it('按服务器总数显示，筛选清选择，分页保留同版选择', async () => {
    const { store, services } = await fixture();
    store.select('FQ-0001', true); await store.loadPage({ page: 2 });
    expect(store.selectedIds).toEqual(['FQ-0001']); expect(store.page?.total).toBe(2);
    await store.applyFilters({ deviceClass: 'HF', availability: 'AVAILABLE', search: 'FQ', minKhz: 3000 });
    expect(store.selectedIds).toEqual([]);
    expect(services.queryFrequencyResources.mock.lastCall?.[0]).toMatchObject({ revision: base, page: 1, deviceClass: 'HF', search: 'FQ' });
  });
  it('选择最多50项，禁止注入未在本页的频点', async () => {
    const { store } = await fixture();
    store.page!.items = Array.from({ length: 51 }, (_, n) => item('FQ-' + String(n).padStart(4, '0')));
    store.selectPage(true); expect(store.selectedIds).toHaveLength(0); expect(store.error).toContain('50');
    for (const row of store.page!.items.slice(0, 50)) store.select(row.freqId, true);
    store.select(store.page!.items[50].freqId, true); store.select('not-in-page', true);
    expect(store.selectedIds).toHaveLength(50);
  });
  it('预检取消不提交，确认后回读当前上下文而不是倒退到回执版本', async () => {
    const { store, services, options } = await fixture();
    store.select('FQ-0001', true); await store.prepareDisable(); await store.answer('cancel');
    expect(services.disableFrequencyResources).not.toHaveBeenCalled(); expect(store.preview).toBeNull();
    await store.prepareDisable(); options.loadContext.mockResolvedValue({ revision: later }); await store.answer('save');
    expect(services.disableFrequencyResources.mock.calls[0][0]).toEqual({ context: 'ledger', baseRevision: base, requestId: 'fixed-request', ids: ['FQ-0001'] });
    expect(store.revision).toBe(later); expect(store.receipt?.revision).toBe(next); expect(store.pending).toBeNull();
    expect(options.onResourceChanged).toHaveBeenCalledWith({ previousRevision: base, revision: next, readRevision: next, requestId: 'fixed-request', changed: true });
  });
  it('无变化回执不假造新版本', async () => {
    const { store, services } = await fixture();
    services.disableFrequencyResources.mockResolvedValue({ ...receipt(), changed: false, revision: base, readRevision: base,
      updated: [], affectedIds: [], unchanged: ['FQ-0001'] });
    store.select('FQ-0001', true); await store.prepareDisable(); await store.answer('save');
    expect(store.notice).toContain('无变化'); expect(store.revision).toBe(base);
  });
  it('超时保留同请求，404不代表失败，重试不生成新请求号', async () => {
    const { store, services } = await fixture();
    services.disableFrequencyResources.mockRejectedValueOnce(new ApiError('超时', 'REQUEST_TIMEOUT'));
    store.select('FQ-0001', true); await store.prepareDisable(); await store.answer('save');
    expect(store.phase).toBe('RESULT_UNKNOWN'); expect(store.pending?.requestId).toBe('fixed-request');
    services.getFrequencyOperation.mockRejectedValueOnce(new ApiError('尚未查到', 1002, null, undefined, 404));
    await store.inspectOperation('fixed-request'); expect(store.pending).not.toBeNull();
    await store.retryPending(); expect(store.pending).toBeNull();
    expect(services.disableFrequencyResources.mock.calls[1][0]).toEqual(services.disableFrequencyResources.mock.calls[0][0]);
  });
  it('核实原回执后刷新；回读其他历史不改当前资源或发变更事件', async () => {
    const { store, services, options } = await fixture();
    await store.inspectOperation('history-request'); expect(options.onResourceChanged).not.toHaveBeenCalled(); expect(store.revision).toBe(base);
    services.disableFrequencyResources.mockRejectedValueOnce(new ApiError('断线', 'REQUEST_TIMEOUT'));
    store.select('FQ-0001', true); await store.prepareDisable(); await store.answer('save');
    options.loadContext.mockResolvedValue({ revision: next }); await store.inspectOperation('fixed-request');
    expect(store.phase).toBe('RESOLVED'); expect(store.revision).toBe(next); expect(store.pending).toBeNull();
  });
  it('1205清旧选择和预检，保留旧显示且禁用写入', async () => {
    const { store, services } = await fixture();
    store.select('FQ-0001', true);
    services.validateFrequencyDisable.mockRejectedValueOnce(new ApiError('过期', 1205, null, undefined, 409));
    await store.prepareDisable(); expect(store.stale).toBe(true); expect(store.selectedIds).toEqual([]); expect(store.page).not.toBeNull();
    expect(store.canSelect).toBe(false);
  });
  it('晚到的列表与停止后的响应不能覆盖新查询', async () => {
    const { store, services } = await fixture();
    const old = deferred<FrequencyResourcePage>(); services.queryFrequencyResources.mockReturnValueOnce(old.promise);
    const pending = store.loadPage({ page: 2 }); await store.loadPage({ page: 3 });
    old.resolve(page({ context: 'ledger', revision: base, page: 2, pageSize: 10 })); await pending;
    expect(store.page?.page).toBe(3);
    const stopped = deferred<FrequencyResourcePage>(); services.queryFrequencyResources.mockReturnValueOnce(stopped.promise);
    const read = store.loadPage({ page: 4 }); store.stopReading(); stopped.resolve(page({ context: 'ledger', revision: base, page: 4, pageSize: 10 })); await read;
    expect(store.page?.page).toBe(3);
  });
  it('会话更换清除旧身份回执，旧保存响应不泄露给新身份', async () => {
    const { store, services, options } = await fixture();
    const saving = deferred<FrequencyDisableReceipt>(); services.disableFrequencyResources.mockReturnValueOnce(saving.promise);
    store.select('FQ-0001', true); await store.prepareDisable(); const pending = store.answer('save');
    store.query.search = 'actor-filter'; store.historyQuery.search = 'actor-request';
    store.configure({ ...options, session: { ...options.session, accountId: 'other', generation: 2 } });
    saving.resolve(receipt()); await pending;
    expect(store.receipt).toBeNull(); expect(store.pending).toBeNull(); expect(options.onResourceChanged).not.toHaveBeenCalled();
    expect(store.query).toEqual({ page: 1, pageSize: 10 }); expect(store.historyQuery).toEqual({ context: 'ledger', page: 1, pageSize: 10 });
  });
  it('保存中防重复与离开；停止读取只转结果未知，不假装回滚', async () => {
    const { store, services } = await fixture();
    const saving = deferred<FrequencyDisableReceipt>(); services.disableFrequencyResources.mockReturnValueOnce(saving.promise);
    store.select('FQ-0001', true); await store.prepareDisable(); const pending = store.answer('save');
    expect(await store.requestLeave()).toBe(false); await store.retryPending(); expect(services.disableFrequencyResources).toHaveBeenCalledOnce();
    store.stopReading(); expect(store.phase).toBe('RESULT_UNKNOWN'); expect(store.pending).not.toBeNull();
    saving.resolve(receipt()); await pending; expect(store.pending).not.toBeNull();
  });
  it('本地选择可放弃；未知请求离开后仍保留，不物理清理', async () => {
    const { store, services } = await fixture();
    store.select('FQ-0001', true); const leave = store.requestLeave(); await store.answer('discard');
    expect(await leave).toBe(true); expect(store.selectedIds).toEqual([]);
    services.disableFrequencyResources.mockRejectedValueOnce(new ApiError('断线', 'REQUEST_TIMEOUT'));
    store.select('FQ-0001', true); await store.prepareDisable(); await store.answer('save');
    const unknownLeave = store.requestLeave(); await store.answer('discard');
    expect(await unknownLeave).toBe(true); expect(store.pending?.requestId).toBe('fixed-request');
  });
  it('只读身份可加载但不能选择或提交', async () => {
    const { store, services, options } = await fixture();
    store.configure({ ...options, session: { ...options.session, canDisable: false } });
    await store.refresh(); store.selectPage(true); await store.prepareDisable();
    expect(store.page).not.toBeNull(); expect(store.selectedIds).toEqual([]); expect(services.validateFrequencyDisable).not.toHaveBeenCalled();
  });
  it('读取失败保留最后成功页，但不能以新筛选操作旧行', async () => {
    const { store, services } = await fixture();
    services.queryFrequencyResources.mockRejectedValueOnce(new ApiError('读取超时', 'REQUEST_TIMEOUT'));
    await store.applyFilters({ deviceClass: 'VUHF' });
    expect(store.page?.items[0].deviceClass).toBe('HF'); expect(store.listFailed).toBe(true); expect(store.canSelect).toBe(false);
    store.selectPage(true); expect(store.selectedIds).toEqual([]);
    await store.refresh(); expect(store.listFailed).toBe(false);
  });
  it('离开时取消尚在途的只读预检，晚响应不能覆盖离开决定', async () => {
    const { store, services } = await fixture();
    const validation = deferred<FrequencyDisableValidation>(); services.validateFrequencyDisable.mockReturnValueOnce(validation.promise);
    store.select('FQ-0001', true); const pending = store.prepareDisable();
    const leave = store.requestLeave(); validation.resolve(preview()); await pending;
    expect(store.decision?.title).toBe('离开规划频点'); await store.answer('discard');
    expect(await leave).toBe(true); expect(services.disableFrequencyResources).not.toHaveBeenCalled();
  });
  it('共享宿主通知失败不把已确认提交误判为结果未知', async () => {
    const { store, options } = await fixture();
    options.onResourceChanged.mockImplementation(() => { throw new Error('宿主异常'); });
    store.select('FQ-0001', true); await store.prepareDisable(); await store.answer('save');
    expect(store.phase).toBe('RESOLVED'); expect(store.pending).toBeNull(); expect(store.receipt?.requestId).toBe('fixed-request');
    expect(store.error).toContain('保存已确认');
  });
});
