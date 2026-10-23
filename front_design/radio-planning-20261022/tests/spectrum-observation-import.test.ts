import { describe, expect, it, vi } from 'vitest';
import { createObservationImportStore } from '../src/stores/spectrum-observations';
import { decodeObservationImportFile } from '../src/services/observation-validation';
import type { ObservationImportFile, ObservationImportFileV2, ObservationServices, ObservationImportOperation } from '../src/types/observation';
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
  it('上传原文件的历史R在选择和预检中保持原值，不补成current', async () => {
    const input = file(); input.dataset.resourceRevision = 'resource-uploaded-historical';
    const previewObservationImport = vi.fn(async () => ({ datasetId: 'obs-A', previewHash: 'a'.repeat(64) }));
    const store = createObservationImportStore({ previewObservationImport } as unknown as ObservationServices, () => true);
    store.choose(input); await store.preview();
    expect(store.state.file?.dataset.resourceRevision).toBe('resource-uploaded-historical');
    expect(previewObservationImport).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ dataset: expect.objectContaining({ resourceRevision: 'resource-uploaded-historical' }) }) }));
    expect(input.dataset.resourceRevision).toBe('resource-uploaded-historical');
  });
  it('V2独立正文hash、完整ref核实；跨协议/错绑定回执不解锁', async () => {
    const input: ObservationImportFileV2 = { ...file(), schemaVersion: 2, deviceStatusRef: { snapshotId: 'DSS-' + 'a'.repeat(32), snapshotRevision: 'device-status-' + 'b'.repeat(64), resourceRevision: 'resource-A', deviceIds: ['device-B', 'device-A'] } };
    const wire = { ...input.deviceStatusRef, deviceIds: ['device-A', 'device-B'], refRevision: 'OSR-' + 'c'.repeat(64), contentHash: 'c'.repeat(64) };
    const api = { previewObservationImport: vi.fn(async () => ({ schemaVersion: 2, datasetId: 'obs-A', previewHash: 'd'.repeat(64), datasetContentHash: 'a'.repeat(64), deviceStatusRef: wire })), importObservation: vi.fn().mockRejectedValue(new Error('timeout')),
      getObservationImportReceipt: vi.fn() } as unknown as ObservationServices;
    const store = createObservationImportStore(api, () => true); store.choose(input); await store.preview(); await store.submit();
    const pending = store.state.pending!; expect(pending.datasetContentHash).toBe('a'.repeat(64)); expect(pending.previewHash).toBe('d'.repeat(64));
    const receipt = { requestId: pending.requestId, actorId: 'actor', datasetId: 'obs-A', datasetRevision: 'observation-' + 'a'.repeat(64), dataOrigin: 'SYNTHETIC_INTEGRATION' as const, resourceRevision: 'resource-A', frameCount: 1, changed: true, importedAt: '2026-10-05T00:00:00.000000Z' };
    const operation: ObservationImportOperation = { schemaVersion: 2, dataOrigin: 'SYNTHETIC_INTEGRATION', operationType: 'OBSERVATION_IMPORT', requestId: pending.requestId, status: 'COMMITTED', receipt, deviceStatusRef: wire };
    vi.mocked(api.getObservationImportReceipt).mockResolvedValueOnce({ ...operation, schemaVersion: 1 } as ObservationImportOperation);
    await store.verify(); expect(store.state.pending).not.toBeNull(); expect(store.state.receipt).toBeNull();
    vi.mocked(api.getObservationImportReceipt).mockResolvedValueOnce({ ...operation, deviceStatusRef: { ...wire, deviceIds: ['device-A'] } });
    await store.verify(); expect(store.state.pending).not.toBeNull();
    vi.mocked(api.getObservationImportReceipt).mockResolvedValueOnce(operation); await store.verify();
    expect(api.getObservationImportReceipt).toHaveBeenLastCalledWith({ requestId: pending.requestId, includeDeviceStatusRef: true });
    expect(store.state.pending).toBeNull(); expect(store.state.receipt?.datasetRevision).toBe(receipt.datasetRevision);
  });
  it('V2成员改变使预检失效，上传原R/Ref不被替换', async () => {
    const input: ObservationImportFileV2 = { ...file(), schemaVersion: 2, deviceStatusRef: { snapshotId: 'DSS-' + 'a'.repeat(32), snapshotRevision: 'device-status-' + 'b'.repeat(64), resourceRevision: 'resource-A', deviceIds: ['device-A'] } };
    const api = { previewObservationImport: vi.fn(async () => ({ schemaVersion: 2, previewHash: 'a'.repeat(64) })), importObservation: vi.fn() } as unknown as ObservationServices;
    const store = createObservationImportStore(api, () => true); store.choose(input); await store.preview();
    expect(store.state.file).toEqual(input); if (store.state.file?.schemaVersion === 2) store.state.file.deviceStatusRef.deviceIds.push('device-B');
    await store.submit(); expect(api.importObservation).not.toHaveBeenCalled(); expect(store.state.preview).toBeNull(); expect(input.deviceStatusRef.deviceIds).toEqual(['device-A']);
  });
  it('预检过程中宿主Ref变化可取消旧预检，不接受晚到hash', async () => {
    let finish!: (value: Awaited<ReturnType<ObservationServices['previewObservationImport']>>) => void;
    const api = { previewObservationImport: vi.fn(() => new Promise(done => { finish = done; })) } as unknown as ObservationServices;
    const store = createObservationImportStore(api, () => true); store.choose(file()); const pending = store.preview();
    const signal = vi.mocked(api.previewObservationImport).mock.calls[0][0].signal; store.invalidatePreview(); expect(signal?.aborted).toBe(true);
    finish({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', previewHash: 'a'.repeat(64), datasetId: 'obs-A', resourceRevision: 'resource-A', source: file().dataset.source, frameCount: 1, sourceBinding: 'DECLARED_ONLY', warnings: ['构造'] });
    await pending; expect(store.state.preview).toBeNull(); expect(store.state.busy).toBe(false);
  });
});
