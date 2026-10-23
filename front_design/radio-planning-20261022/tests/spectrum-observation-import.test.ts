import { describe, expect, it, vi } from 'vitest';
import { createObservationImportStore } from '../src/stores/spectrum-observations';
import { decodeObservationImportFile } from '../src/services/observation-validation';
import type { ObservationImportFile, ObservationServices } from '../src/types/observation';
import { ApiError } from '../src/services/types';
function file(): ObservationImportFile { return { schemaVersion: 1, fileKind: 'SPECTRUM_OBSERVATION_DATASET', dataOrigin: 'SYNTHETIC_INTEGRATION', dataset: { datasetId: 'obs-A', provenanceNote: '测试构造导入，非实测', resourceRevision: 'resource-A', deviceStatusSnapshotId: null,
  source: { sourceId: 'source-A', configRevision: 'declared-v1', name: '测试来源', minKhz: 6000, maxKhz: 8000, intervalSeconds: null }, frames: [{ frameId: 'frame-A', index: 0, label: '未知构造帧', observedAt: null, occupancyPercent: null, abnormalBandCount: null, unknownReasons: ['无资料'], bins: [{ binId: 'bin-A', minKhz: 6000, maxKhz: 7000, occupancyPercent: null, powerDbm: null, abnormal: null, reason: null, unknownReasons: ['无资料'] }] }] } }; }
describe('显式导入预检/确认/回执', () => {
  it('预检不调用导入，选择后更改内容必须重新预检', async () => {
    const api = { previewObservationImport: vi.fn(async () => ({ datasetId: 'obs-A', previewHash: 'a'.repeat(64) })), importObservation: vi.fn() } as unknown as ObservationServices;
    const store = createObservationImportStore(api, () => true); store.choose(file()); await store.preview(); expect(api.importObservation).not.toHaveBeenCalled();
    store.state.file!.dataset.provenanceNote = '更改资料'; await store.submit(); expect(api.importObservation).not.toHaveBeenCalled(); expect(store.state.preview).toBeNull();
  });
  it('超时保留原请求，不把NOT_FOUND当服务器取消', async () => {
    const api = { previewObservationImport: vi.fn(async () => ({ datasetId: 'obs-A', previewHash: 'a'.repeat(64) })), importObservation: vi.fn().mockRejectedValue(new Error('超时')),
      getObservationImportReceipt: vi.fn(async () => ({ status: 'NOT_FOUND', receipt: null })) } as unknown as ObservationServices;
    const store = createObservationImportStore(api, () => true); store.choose(file()); await store.preview(); await store.submit(); const id = store.state.pending?.requestId;
    await store.submit(); expect(api.importObservation).toHaveBeenCalledTimes(1); await store.verify(); expect(store.state.pending?.requestId).toBe(id);
    await store.retry(); expect(vi.mocked(api.importObservation).mock.calls[1][0]).toEqual(vi.mocked(api.importObservation).mock.calls[0][0]); store.clearForSession(); expect(store.dirty).toBe(false);
  });
  it('拒绝伪实测/非空状态引用，保留带时区原文和nullable', () => {
    const input = file(); input.dataset.frames[0].observedAt = '2026-10-05T09:00:00.123456+08:00'; expect(decodeObservationImportFile(input)).toBe(input);
    expect(input.dataset.frames[0].observedAt).toContain('+08:00');
    expect(() => decodeObservationImportFile({ ...input, dataOrigin: 'MEASURED' })).toThrow();
    expect(() => decodeObservationImportFile({ ...input, dataset: { ...input.dataset, deviceStatusSnapshotId: 'guessed' } })).toThrow();
  });
  it('明确版本拒绝保留文件并失效预检，允许重新预检', async () => {
    const api = { previewObservationImport: vi.fn(async () => ({ datasetId: 'obs-A', previewHash: 'a'.repeat(64) })), importObservation: vi.fn().mockRejectedValue(new ApiError('资源版本变化', 1205, null, undefined, 409)) } as unknown as ObservationServices;
    const store = createObservationImportStore(api, () => true); store.choose(file()); await store.preview(); await store.submit();
    expect(store.state.pending).toBeNull(); expect(store.state.preview).toBeNull(); expect(store.state.file?.dataset.datasetId).toBe('obs-A');
  });
});
