import { describe, expect, it, vi } from 'vitest';
import { createSpectrumSourcesStore } from '../src/stores/spectrum-sources';
import type { SpectrumSourceServices } from '../src/types/spectrum-source';
import { ApiError } from '../src/services/types';
const draft = { name: '构造来源', protocolHint: null, endpoint: null, intervalSeconds: null, minKhz: null, maxKhz: null, enabled: false, provenanceNote: '独立测试，非实测' };
describe('来源表单状态机', () => {
  it('超时保留原号和原内容，阻止重复保存；查无回执不伪报取消', async () => {
    const saveSource = vi.fn().mockRejectedValue(new Error('超时')), getSourceReceipt = vi.fn().mockResolvedValue({ status: 'NOT_FOUND', receipt: null });
    const store = createSpectrumSourcesStore({ saveSource, getSourceReceipt } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft);
    await store.save(); const requestId = store.state.pending!.requestId;
    await store.save(); expect(saveSource).toHaveBeenCalledTimes(1);
    await store.verify(); expect(store.state.pending?.requestId).toBe(requestId); expect(store.state.notice).toContain('不等于');
    await store.retry(); expect(saveSource.mock.calls[1][0]).toEqual(saveSource.mock.calls[0][0]);
    store.clearForSession(); expect(store.state.pending).toBeNull(); expect(store.state.draft).toBeNull();
  });
  it('成功回执与写后刷新失败分开，不重发写入', async () => {
    const source = { sourceId: 'source-A', configRevision: 'SPV-' + 'a'.repeat(64), draft };
    const saveSource = vi.fn().mockResolvedValue({ requestId: 'receipt-A', operationType: 'SOURCE_SAVE', sourceId: source.sourceId, configRevision: source.configRevision, source });
    const store = createSpectrumSourcesStore({ saveSource, querySources: vi.fn().mockRejectedValue(new Error('刷新失败')) } as unknown as SpectrumSourceServices, () => ({ canView: true, canEdit: true }));
    store.edit(); store.state.sourceId = 'source-A'; Object.assign(store.state.draft!, draft); await store.save();
    expect(store.state.receipt?.requestId).toBe('receipt-A'); expect(store.state.pending).toBeNull(); expect(store.dirty).toBe(false);
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
});
