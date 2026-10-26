import { describe, expect, it, vi } from 'vitest';
import { createSpectrumSourceHttp } from '../src/services/spectrum-source-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { decodeSpectrumSourceConfigFile, spectrumSourceDraftFingerprint } from '../src/services/spectrum-source-validation';
const stamp = '2026-10-05T01:00:00.000000Z', revision = 'SPV-' + 'a'.repeat(64);
const draft = () => ({ name: '构造来源', protocolHint: null, endpoint: null, intervalSeconds: null, minKhz: 6000, maxKhz: 8000, enabled: false, provenanceNote: '测试构造，非实测' });
const version = () => ({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'source-A', configRevision: revision, contentHash: 'a'.repeat(64), draft: draft(), createdAt: stamp, actorId: 'test-editor' });
describe('来源已认证HTTP契约', () => {
  it('配置文件严格六字段、构造标签与版本，逐字段摘要不受对象键序影响', () => {
    const file = { schemaVersion: 1, fileKind: 'SPECTRUM_SOURCE_CONFIG', dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'source-A', configRevision: revision, draft: draft() };
    expect(decodeSpectrumSourceConfigFile(file)).toBe(file);
    for (const value of [{ ...file, extra: true }, { ...file, schemaVersion: true }, { ...file, dataOrigin: 'MEASURED' }, { ...file, configRevision: 'guessed' }, { ...file, draft: { ...draft(), extra: true } }]) expect(() => decodeSpectrumSourceConfigFile(value)).toThrow();
    expect(spectrumSourceDraftFingerprint(draft())).toBe(spectrumSourceDraftFingerprint(Object.fromEntries(Object.entries(draft()).reverse())));
    for (const key of ['name', 'protocolHint', 'endpoint', 'intervalSeconds', 'minKhz', 'maxKhz', 'enabled', 'provenanceNote']) {
      const changes: Record<string, unknown> = { name: '新名称', protocolHint: 'HTTP_JSON', endpoint: 'https://offline.invalid/config', intervalSeconds: 10, minKhz: 6100, maxKhz: 8100, enabled: true, provenanceNote: '其他构造说明' };
      expect(spectrumSourceDraftFingerprint({ ...draft(), [key]: changes[key] })).not.toBe(spectrumSourceDraftFingerprint(draft()));
    }
  });
  it('配置导出也严格检查文件身份/额外字段与原始体积', async () => {
    const file = { schemaVersion: 1, fileKind: 'SPECTRUM_SOURCE_CONFIG', dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'source-A', configRevision: revision, draft: draft() };
    const request = vi.fn().mockResolvedValue(new Blob([JSON.stringify(file)])), api = createSpectrumSourceHttp(request as AuthenticatedRequest);
    const input = { sourceId: 'source-A', configRevision: revision };
    expect(await api.exportSource(input)).toBeInstanceOf(Blob);
    for (const value of [{ ...file, extra: true }, { ...file, sourceId: 'source-B' }]) {
      request.mockResolvedValueOnce(new Blob([JSON.stringify(value)])); await expect(api.exportSource(input)).rejects.toBeDefined();
    }
    request.mockResolvedValueOnce(new Blob([' '.repeat(2 * 1024 * 1024 + 1)])); await expect(api.exportSource(input)).rejects.toBeDefined();
  });
  it('分页发起副本不受await期间调用者突变影响，signal不克隆', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(resolve => { finish = resolve; }));
    const api = createSpectrumSourceHttp(request as AuthenticatedRequest), controller = new AbortController();
    const query = { page: 1, pageSize: 10, signal: controller.signal };
    const result = api.querySources(query); query.page = 2;
    finish({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', page: 1, pageSize: 10, total: 1, items: [{ ...version(), latestOfflineCheck: null }] });
    expect((await result).page).toBe(1); expect(request.mock.calls[0]).toEqual(['/spectrum/sources?page=1&page_size=10', { method: 'GET', signal: controller.signal }]);
  });
  it('保存冻结draft，并核对回执实际内容', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(resolve => { finish = resolve; }));
    const api = createSpectrumSourceHttp(request as AuthenticatedRequest), input = { requestId: 'save-A', sourceId: 'source-A', baseConfigRevision: null, draft: draft() };
    const result = api.saveSource(input); input.draft.name = '晚到突变';
    finish({ requestId: 'save-A', operationType: 'SOURCE_SAVE', sourceId: 'source-A', configRevision: revision, changed: true, actorId: 'test-editor', committedAt: stamp, source: version(), check: null });
    expect((await result).source?.draft.name).toBe('构造来源');
    expect(JSON.parse((request.mock.calls[0]?.[1] as RequestInit).body as string).draft.name).toBe('构造来源');
  });
  it('非法频段和伪连接成功不得通过', async () => {
    const request = vi.fn(); const api = createSpectrumSourceHttp(request as AuthenticatedRequest);
    await expect(api.saveSource({ requestId: 'save-A', sourceId: 'source-A', baseConfigRevision: null, draft: { ...draft(), minKhz: null } })).rejects.toBeDefined();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ requestId: 'check-A', operationType: 'SOURCE_CHECK', sourceId: 'source-A', configRevision: revision, changed: false, actorId: 'test-editor', committedAt: stamp, source: null,
      check: { checkId: 'check-A', sourceId: 'source-A', configRevision: revision, checkedAt: stamp, validation: 'VALID', connection: 'SUCCESS', validationMode: 'OFFLINE_ONLY', issues: [] } });
    await expect(api.checkSource({ requestId: 'check-A', sourceId: 'source-A', configRevision: revision })).rejects.toBeDefined();
  });
});
