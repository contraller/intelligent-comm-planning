import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpectrumObservationsStore } from '../src/stores/spectrum-observations';
import type { ObservationServices, ObservationDataset, ObservationFrameResult } from '../src/types/observation';
afterEach(() => vi.useRealTimers());
const selection = { datasetId: 'obs-A', datasetRevision: 'observation-' + 'a'.repeat(64) };
const summary = { ...selection, resourceRevision: 'resource-A', frameCount: 2 } as ObservationDataset;
function result(index: number) { return { ...selection, index, hasNext: index < 1, frame: { ...selection, index, frameId: 'frame-' + index, occupancyPercent: null } } as ObservationFrameResult; }
function services(getFrame = vi.fn(async ({ index }: { index: number }) => result(index))) {
  return { loadObservationContext: vi.fn(async () => ({ selected: summary })), getObservationFrame: getFrame,
    getObservationDeviceStatusRef: vi.fn(async () => ({ ...selection, resourceRevision: 'resource-A', deviceStatusRef: null })),
    queryObservationFrames: vi.fn(async () => ({ items: [], total: 2 })) } as unknown as ObservationServices;
}
describe('已存频谱有限回放', () => {
  it('首次选择读帧0，末帧停止，不循环补帧；显式重播才回0', async () => {
    vi.useFakeTimers(); const api = services(), store = createSpectrumObservationsStore(api, () => true);
    await store.select(selection); expect(store.state.result?.index).toBe(0); expect(store.state.result?.frame.occupancyPercent).toBeNull();
    store.play(); await vi.advanceTimersByTimeAsync(1000); expect(store.state.playback.finished).toBe(true);
    await vi.advanceTimersByTimeAsync(100000); expect(api.getObservationFrame).toHaveBeenCalledTimes(2);
    await store.restart(); expect(store.state.result?.index).toBe(0); store.stop();
  });
  it('暂停或身份清理丢弃晚到帧', async () => {
    let resolve!: (value: ObservationFrameResult) => void;
    const api = services(); const store = createSpectrumObservationsStore(api, () => true); await store.select(selection);
    vi.mocked(api.getObservationFrame).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = store.seek(1); store.pause(); resolve(result(1)); await pending;
    expect(store.state.result?.index).toBe(0); store.clearForSession(); expect(store.state.result).toBeNull();
  });
  it('权限不足不读取', async () => { const api = services(), store = createSpectrumObservationsStore(api, () => false); await store.select(selection); expect(api.loadObservationContext).not.toHaveBeenCalled(); });
  it('仅真实null为未关联，失败是未核实；不影响原帧', async () => {
    const api = services(), store = createSpectrumObservationsStore(api, () => true);
    expect(store.state.statusRefState).toBe('unread'); await store.select(selection); expect(store.state.statusRefState).toBe('unbound');
    vi.mocked(api.getObservationDeviceStatusRef).mockRejectedValueOnce(new Error('0021未迁移'));
    await store.readStatusRef(); expect(store.state.statusRefState).toBe('error'); expect(store.state.statusRef).toBeNull(); expect(store.state.result?.index).toBe(0);
    store.clearForSession(); expect(store.state.statusRefState).toBe('unread'); expect(store.state.statusRefError).toBe('');
  });
  it('换选集/停止/身份清理后丢弃晚到ref，保留同signal取消', async () => {
    const api = services(), store = createSpectrumObservationsStore(api, () => true); await store.select(selection);
    let finish!: (value: Awaited<ReturnType<ObservationServices['getObservationDeviceStatusRef']>>) => void;
    vi.mocked(api.getObservationDeviceStatusRef).mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const pending = store.readStatusRef(), signal = vi.mocked(api.getObservationDeviceStatusRef).mock.calls.at(-1)![0].signal;
    expect(store.state.statusRefState).toBe('loading'); store.clearForSession(); expect(signal?.aborted).toBe(true);
    finish({ ...selection, schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', resourceRevision: 'resource-A', deviceStatusRef: null });
    await pending; expect(store.state.statusRefState).toBe('unread'); expect(store.state.selected).toBeNull();
  });
});
