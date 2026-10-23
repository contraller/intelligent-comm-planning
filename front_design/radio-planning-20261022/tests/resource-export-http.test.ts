import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createResourceExportHttp } from '../src/services/resource-export-http';
import { ApiError } from '../src/services/types';
import type { ResourceExportRequest } from '../src/types/resource-edit';

const revision = 'resource-0123456789abcdef';
const input = (): ResourceExportRequest => ({ context: 'ledger', format: 'csv', kinds: ['devices'], ledger: { revision, range: 'all' } });
const preview = () => ({ revision, data_origin: 'SYNTHETIC_INTEGRATION', source: '构造联调，非实测', tables: [{ kind: 'devices', count: 414 }], added: 0 });
function fixture(value: unknown = preview()) {
  const request = vi.fn().mockResolvedValue(value);
  return { request, api: createResourceExportHttp(request) };
}

describe('台账导出 HTTP 适配', () => {
  it('全部范围为服务端全库预检，不收集分页 ID', async () => {
    const f = fixture();
    expect(await f.api.previewResourceExport(input())).toEqual({ tables: [{ kind: 'devices', count: 414 }], added: 0 });
    const [path, init, type] = f.request.mock.calls[0]!;
    expect(path).toBe('/resource/export/preview'); expect(type).toBe('json'); expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ context: 'ledger', revision, format: 'csv', kinds: ['devices'], range: 'all' });
  });
  it('筛选条件逐字段映射，显式保留 false 和 0', async () => {
    const f = fixture();
    await f.api.previewResourceExport({ ...input(), ledger: { revision, range: 'filtered', filter: { deviceClass: 'HF', relayCapable: false,
      status: 'UNKNOWN', alert: 'UNKNOWN', mobility: 'FIXED', nodeRole: 'RELAY', frequency: { mode: 'MODEL', presence: 'ALL', minKhz: 0, maxKhz: 3000 } } } });
    expect(JSON.parse(f.request.mock.calls[0]![1].body).filter).toEqual({ device_class: 'HF', relay_capable: false, status: 'UNKNOWN', alert: 'UNKNOWN', mobility: 'FIXED', node_role: 'RELAY',
      frequency: { mode: 'MODEL', presence: 'ALL', min_khz: 0, max_khz: 3000 } });
  });
  it('选中范围只发送所选设备并校验补齐节点数量', async () => {
    const f = fixture({ ...preview(), tables: [{ kind: 'devices', count: 1 }, { kind: 'nodes', count: 2 }], added: 2 });
    const q: ResourceExportRequest = { context: 'ledger', format: 'xlsx', kinds: ['devices', 'nodes'], ledger: { revision, range: 'selected', selectedIds: ['DV-1'] } };
    expect((await f.api.previewResourceExport(q)).added).toBe(2);
    expect(JSON.parse(f.request.mock.calls[0]![1].body).selected_ids).toEqual(['DV-1']);
  });
  it.each([
    { kinds: [] }, { kinds: ['devices', 'devices'] }, { kinds: ['devices', 'nodes'] }, { kinds: ['topology_links'] }, { actor: 'admin' }, { ids: {} },
    { ledger: { revision, range: 'all', filter: {} } }, { ledger: { revision, range: 'selected', selectedIds: [] } },
    { ledger: { revision, range: 'selected', selectedIds: ['D1', 'D1'] } }, { ledger: { revision, range: 'selected', selectedIds: Array(51).fill('D') } },
    { ledger: { revision, range: 'filtered', filter: { relayCapable: 'false' } } },
    { ledger: { revision, range: 'filtered', filter: { frequency: { mode: 'ALL', presence: 'ALL', minKhz: 1, maxKhz: null } } } },
    { ledger: { revision, range: 'filtered', filter: { frequency: { mode: 'MODEL', presence: 'ALL', minKhz: NaN, maxKhz: null } } } },
  ])('非法输入发送前拒绝 %j', async patch => {
    const f = fixture();
    await expect(f.api.previewResourceExport({ ...input(), ...patch } as ResourceExportRequest)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    { revision: 'other' }, { data_origin: 'MEASURED' }, { source: '' }, { tables: [] }, { tables: [{ kind: 'nodes', count: 414 }] },
    { tables: [{ kind: 'devices', count: -1 }] }, { tables: [{ kind: 'devices', count: 1.5 }] }, { added: 1 }, { devices: [] },
  ])('非法预检响应不能显示为成功 %j', async patch => {
    await expect(fixture({ ...preview(), ...patch }).api.previewResourceExport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('未接的 GIS 和观测快照明确拒绝，不静默按台账导出', async () => {
    const f = fixture();
    for (const q of [{ ...input(), context: 'gis' }, { ...input(), ledger: { revision, range: 'filtered', filter: { statusMode: 'observed', observationSnapshotId: 'OBS1' } } }])
      await expect(f.api.previewResourceExport(q as ResourceExportRequest)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it('CSV 文件由后端返回，保留 UTF-8 字节', async () => {
    const data = 'device_id,node_id\r\nDV1,N1\r\n';
    const f = fixture(new Blob([data], { type: 'text/csv; charset=utf-8' }));
    const file = await f.api.exportResources(input());
    expect(new TextDecoder().decode(file.bytes)).toBe(data);
    expect(file.name).toBe(`synthetic-resources-${revision}.csv`);
    expect(f.request.mock.calls[0]![2]).toBe('blob');
  });
  it('XLSX 保留服务端 ZIP 文件，不在前端构造资源', async () => {
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const f = fixture(new Blob([new Uint8Array([80, 75, 3, 4, 1])], { type: mime }));
    expect((await f.api.exportResources({ ...input(), format: 'xlsx' })).mime).toBe(mime);
  });
  it.each([new Blob([], { type: 'text/csv' }), new Blob(['{}'], { type: 'application/json' }),
    new Blob(['wrong header'], { type: 'text/csv' }), new Blob([new Uint8Array([255, 255])], { type: 'text/csv' }),
    new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], { type: 'text/csv' })])('拒绝空文件、错格式或超大内容', async blob => {
    await expect(fixture(blob).api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it.each([[1205, 'RESOURCE_VERSION_CHANGED'], [1002, 'RESOURCE_NOT_FOUND'], [1001, 'VALIDATION_ERROR']])('下载失败仍保留错误 %s', async (code, expected) => {
    const f = fixture(); f.request.mockRejectedValue(new ApiError('失败', code as number, null, 'trace', 409));
    await expect(f.api.exportResources(input())).rejects.toMatchObject({ code: expected, requestId: 'trace' });
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('共享入口确实装配新方法并移除相应占位', () => {
    const source = readFileSync(new URL('../src/services/http.ts', import.meta.url), 'utf8');
    expect(source).toContain('...createResourceExportHttp(authentication.authenticatedRequest)');
    expect(source).not.toContain('async previewResourceExport()');
    expect(source).not.toContain('async exportResources()');
  });
});
