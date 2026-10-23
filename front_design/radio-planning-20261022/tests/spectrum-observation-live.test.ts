import { describe, expect, it } from 'vitest';
import { createObservationHttp } from '../src/services/observation-http';
import { createSpectrumSourceHttp } from '../src/services/spectrum-source-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import type { ObservationImportFile } from '../src/types/observation';

// 默认完全不访问网络；显式启用仅允许本组R2新库环境，不清理测试历史。
describe('P07 R2真实HTTP定向闭环（需宿主迁移/认证接线）', () => {
  it.skipIf(process.env.P07_R2_LIVE !== '1')('来源→离线校验→预检→提交→回读→导出', async () => {
    const base = process.env.P07_R2_BASE, db = process.env.P07_R2_DATABASE?.replaceAll('\\', '/');
    expect(base).toBe('http://127.0.0.17:8117/api/v1');
    expect(db).toBe('F:/work/project2026-1/data/runtime/collab/wt/p7-observation/data/runtime/r2.sqlite');
    const session = process.env.P07_R2_SESSION, csrf = process.env.P07_R2_CSRF, cookie = process.env.P07_R2_COOKIE;
    if (!session || !csrf || !cookie || !process.env.P07_R2_RESOURCE_REVISION) throw new Error('未提供已认证R2会话/资源来源，禁止降级');
    const request: AuthenticatedRequest = async <T>(path: string, init?: RequestInit, responseType?: 'json' | 'blob') => {
      const response = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', 'X-Session-Id': session, 'X-CSRF-Token': csrf, Cookie: cookie } });
      if (!response.ok) throw new Error(await response.text());
      if (responseType === 'blob') return await response.blob() as T;
      const value = await response.json(); expect(value.code).toBe(0); return value.data as T;
    };
    const sources = createSpectrumSourceHttp(request), observations = createObservationHttp({ baseUrl: () => base!, authenticatedRequest: request });
    const id = 'live-' + crypto.randomUUID(), draft = { name: '显式HTTP构造验证', protocolHint: null, endpoint: null, minKhz: 6000, maxKhz: 7000, intervalSeconds: null, enabled: false, provenanceNote: '定向HTTP测试，非真实采集' };
    const saved = await sources.saveSource({ requestId: id + '-save', sourceId: id, baseConfigRevision: null, draft });
    const checked = await sources.checkSource({ requestId: id + '-check', sourceId: id, configRevision: saved.configRevision }); expect(checked.check?.connection).toBe('NOT_ATTEMPTED');
    const file: ObservationImportFile = { schemaVersion: 1, fileKind: 'SPECTRUM_OBSERVATION_DATASET', dataOrigin: 'SYNTHETIC_INTEGRATION', dataset: { datasetId: id,
      provenanceNote: '显式HTTP测试未知帧，不生成实测值', resourceRevision: process.env.P07_R2_RESOURCE_REVISION!, deviceStatusSnapshotId: null,
      source: { sourceId: id, configRevision: saved.configRevision, name: draft.name, minKhz: 6000, maxKhz: 7000, intervalSeconds: null },
      frames: [{ frameId: id + '-frame', index: 0, observedAt: null, label: '无实测资料', occupancyPercent: null, abnormalBandCount: null, unknownReasons: ['测试未提供实测'],
        bins: [{ binId: id + '-bin', minKhz: 6000, maxKhz: 7000, occupancyPercent: null, powerDbm: null, abnormal: null, reason: null, unknownReasons: ['测试未提供实测'] }] }] } };
    const preview = await observations.previewObservationImport({ file }); expect(preview.sourceBinding).toBe('REGISTERED_VERSION');
    const command = { requestId: id + '-import', previewHash: preview.previewHash, file }, result = await observations.importObservation(command);
    expect(await observations.importObservation(command)).toEqual(result); expect(await observations.getObservationImportReceipt({ requestId: command.requestId })).toEqual(result);
    const selection = { datasetId: id, datasetRevision: result.receipt!.datasetRevision };
    expect((await observations.getObservationFrame({ ...selection, index: 0 })).hasNext).toBe(false);
    expect((await observations.exportObservationDataset(selection)).size).toBeGreaterThan(0);
  }, 120000);
});
