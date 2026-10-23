import { beforeAll, describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { createAuthHttp } from '../src/services/auth-http';
import { createResourceExportHttp } from '../src/services/resource-export-http';
import { createResourceReadHttp } from '../src/services/resource-read-http';
import type { ResourceExportRequest } from '../src/types/resource-edit';

const liveUrl = process.env.RESOURCE_EXPORT_URL;
// 仅连接 P01 隔离服务，不访问 5183 或主运行数据库。
describe.skipIf(!liveUrl)('P01 资源导出真实 HTTP', () => {
  let exporter: ReturnType<typeof createResourceExportHttp>;
  let reader: ReturnType<typeof createResourceReadHttp>;
  let revision: string;
  beforeAll(async () => {
    const base = new URL(liveUrl!);
    if (base.hostname !== '127.0.0.11' || !['5311', '8111'].includes(base.port)
      || process.env.RESOURCE_EXPORT_ISOLATED !== '1') throw new Error('只允许 P01 显式隔离服务');
    const fetcher: typeof fetch = (input, init) => fetch(new URL(input instanceof Request ? input.url : String(input), base), init);
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher, timeoutMs: 30000 });
    expect((await auth.getSession())?.permissions).toContain('resources.view');
    exporter = createResourceExportHttp(auth.authenticatedRequest);
    reader = createResourceReadHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher });
    revision = (await reader.loadResourceReadContext({ context: 'ledger' })).revision;
  });

  function request(): ResourceExportRequest {
    return { context: 'ledger', format: 'csv', kinds: ['devices'], ledger: { revision, range: 'all' } };
  }

  it('全部 CSV 与服务端全库计数一致', async () => {
    const preview = await exporter.previewResourceExport(request());
    const page = await reader.queryResourceDevices({ context: 'ledger', revision, pageNum: 1, pageSize: 5 });
    const file = await exporter.exportResources(request());
    const rows = Papa.parse(new TextDecoder().decode(file.bytes), { header: true, skipEmptyLines: true });
    expect(rows.errors).toEqual([]);
    expect(rows.data.length).toBe(page.total);
    expect(preview.tables[0]!.count).toBe(page.total);
    expect(page.total).toBe(414);
  });

  it('HF 导出包含全部匹配设备而不只是当前页', async () => {
    const q: ResourceExportRequest = { ...request(), ledger: { revision, range: 'filtered', filter: { deviceClass: 'HF' } } };
    const preview = await exporter.previewResourceExport(q);
    const page = await reader.queryResourceDevices({ context: 'ledger', revision, pageNum: 1, pageSize: 5, deviceClass: 'HF' });
    expect(page.items.every(row => row.deviceClass === 'HF')).toBe(true);
    expect(page.total).toBe(174);
    expect(preview.tables[0]!.count).toBe(174);
    const file = await exporter.exportResources(q);
    expect(Papa.parse(new TextDecoder().decode(file.bytes), { header: true, skipEmptyLines: true }).data).toHaveLength(174);
  });

  it('选中 XLSX 带关联节点，错版本明确失败', async () => {
    const q: ResourceExportRequest = { context: 'ledger', format: 'xlsx', kinds: ['devices', 'nodes'],
      ledger: { revision, range: 'selected', selectedIds: ['DV-0001'] } };
    const preview = await exporter.previewResourceExport(q), file = await exporter.exportResources(q);
    const Excel = (await import('exceljs')).default;
    const book = new Excel.Workbook();
    await book.xlsx.load(new Uint8Array(file.bytes).buffer);
    expect(book.getWorksheet('devices')!.rowCount).toBe(2);
    expect(book.getWorksheet('nodes')!.rowCount).toBe(preview.added + 1);
    expect(book.getWorksheet('说明')!.getCell('B1').value).toBe(revision);
    await expect(exporter.previewResourceExport({ ...request(), ledger: { revision: 'resource-ffffffffffffffff', range: 'all' } }))
      .rejects.toMatchObject({ code: 'RESOURCE_VERSION_CHANGED' });
  }, 60000);
});
