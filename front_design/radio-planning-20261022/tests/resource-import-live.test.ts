import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { createAuthHttp } from '../src/services/auth-http';
import { createResourceImportHttp } from '../src/services/resource-import-http';
import { createResourceWorkspaceHttp } from '../src/services/resource-workspace-http';
import { resourceImportBody, resourceXlsxMime } from '../src/services/resource-import-validation';
import { workspaceSource } from '../src/services/resource-workspace-validation';
import type { ResourcesData } from '../src/types/domain';
import type { ResourceImportRequest, ResourceSaveResult } from '../src/types/resource-edit';

const liveUrl = process.env.RESOURCE_IMPORT_URL;
const isolated = process.env.RESOURCE_IMPORT_ISOLATED === '1';
const marker = 'P1R2-SYNTHETIC-RESOURCE-IMPORT-LIVE';

function isolatedBase(): URL {
  if (!isolated || !liveUrl || liveUrl !== liveUrl.trim()) throw new Error('必须显式设置 RESOURCE_IMPORT_ISOLATED=1 和 RESOURCE_IMPORT_URL');
  const base = new URL(liveUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.11' || !['5311', '8111'].includes(base.port)
    || base.username || base.password || base.search || base.hash || !['/', '/api/v1', '/api/v1/'].includes(base.pathname)) {
    throw new Error('资源导入写测试只允许 P1 R2 新库隔离地址 http://127.0.0.11:5311 或 :8111');
  }
  if (typeof Headers.prototype.getSetCookie !== 'function') throw new Error('真实导入测试需要支持 getSetCookie 的 Node fetch');
  return base;
}

function cookieFetch(base: URL): typeof fetch {
  const cookies = new Map<string, string>();
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/api/v1/') || url.username || url.password || url.hash) {
      throw new Error('拒绝访问 P1 R2 隔离 API 以外的地址');
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (cookies.size) headers.set('Cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    else headers.delete('Cookie');
    const response = await fetch(input instanceof Request ? new Request(url, input) : url, { ...init, headers, redirect: 'error' });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0], equals = pair.indexOf('=');
      if (equals <= 0) throw new Error('服务端 Set-Cookie 格式无效');
      const name = pair.slice(0, equals).trim(), content = pair.slice(equals + 1);
      if (!content || /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(value)) cookies.delete(name);
      else cookies.set(name, content);
    }
    if (!response.ok) console.info(marker, JSON.stringify({ method: init?.method ?? 'GET', path: url.pathname,
      status: response.status, contentType: response.headers.get('Content-Type'), body: (await response.clone().text()).slice(0, 512) }));
    return response;
  };
}

function counts(resources: ResourcesData) {
  return { stations: resources.stations.length, devices: resources.devices.length, models: resources.models.length,
    antennas: resources.antennas.length, interferences: resources.interferences?.length ?? null, candidates: resources.candidateLinks?.length ?? null };
}
function parseCsv(bytes: Uint8Array): string[][] {
  const parsed = Papa.parse<string[]>(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { delimiter: ',', skipEmptyLines: 'greedy' });
  expect(parsed.errors).toEqual([]);
  if (parsed.data.length < 2 || !parsed.data.every(row => row.length === parsed.data[0].length)) throw new Error('真实设备模板缺少完整表头或业务行');
  if (new Set(parsed.data[0]).size !== parsed.data[0].length) throw new Error('真实设备模板表头重复');
  return parsed.data;
}
function csvRequest(rows: string[][], baseRevision: string): ResourceImportRequest {
  return { context: 'ledger', baseRevision, kind: 'devices', file: { name: `${marker}-${randomUUID()}.csv`,
    bytes: new TextEncoder().encode(Papa.unparse(rows, { newline: '\r\n' })) } };
}
function id(prefix: string): string { return `${marker}-${prefix}-${randomUUID()}`; }

// 真实 HTTP 写入只面向显式指定的 P1 R2 新库；默认测试运行跳过本文件。
describe.skipIf(!liveUrl && !isolated)('P01 R2 资源导入真实 HTTP（构造数据）', () => {
  let auth: ReturnType<typeof createAuthHttp>;
  let importer: ReturnType<typeof createResourceImportHttp>;
  let workspace: ReturnType<typeof createResourceWorkspaceHttp>;

  beforeAll(async () => {
    const base = isolatedBase();
    auth = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher: cookieFetch(base), timeoutMs: 30000 });
    expect((await auth.getSession())?.integrationMode).toBe(true);
    const identities = await auth.integrationIdentities(), editor = identities.accounts.find(account => account.role === 'EDITOR');
    if (!editor) throw new Error('P1 R2 服务未提供显式联调编辑者');
    const actor = await auth.switchIntegrationIdentity(editor.id);
    expect(actor.id).toBe(editor.id); expect(actor.integrationMode).toBe(true);
    expect(actor.permissions).toEqual(expect.arrayContaining(['resources.view', 'resources.import', 'resources.workspace.edit']));
    importer = createResourceImportHttp(auth.authenticatedRequest);
    workspace = createResourceWorkspaceHttp(auth.authenticatedRequest);
  }, 60000);

  it('完整引用、模板和只读预检、原子提交、固定历史回放、过期与非法输入、XLSX 只读回读', async () => {
    const baseline = await workspace.loadWorkspace('ledger'), originalCounts = counts(baseline.resources);
    expect(baseline.resources.source).toBe(workspaceSource);
    expect(baseline.resources.version).toBe(baseline.revision); expect(baseline.meta.revision).toBe(baseline.revision);
    expect(baseline.resources.devices.length).toBeGreaterThan(0);
    const nodeIds = new Set(baseline.resources.stations.map(row => row.id)), modelIds = new Set(baseline.resources.models.map(row => row.id));
    const antennaIds = new Set(baseline.resources.antennas.map(row => row.id));
    for (const device of baseline.resources.devices) {
      expect(nodeIds.has(device.stationId)).toBe(true); expect(modelIds.has(device.modelId)).toBe(true); expect(antennaIds.has(device.antennaId)).toBe(true);
    }

    const template = await importer.getResourceTemplate('csv', 'devices');
    expect(template.mime).toBe('text/csv'); expect(template.name).toContain(baseline.revision);
    const noopRequest: ResourceImportRequest = { context: 'ledger', kind: 'devices', baseRevision: baseline.revision, file: { name: template.name, bytes: template.bytes } };
    const noop = await importer.previewResourceImport(noopRequest);
    expect(noop.issues).toEqual([]); expect(noop.rows.length).toBeGreaterThan(0);
    expect(noop.rows.every(row => row.action === 'UNCHANGED')).toBe(true);
    expect(noop.candidate).toEqual(baseline.resources);
    expect(Object.values(noop.changes).every(rows => !rows?.length)).toBe(true);
    expect(await workspace.loadWorkspace('ledger', baseline.revision)).toEqual(baseline);
    const noopResult = await importer.commitResourceImport({ baseRevision: baseline.revision, requestId: id('noop'), preview: noop });
    expect(noopResult.changed).toBe(false); expect(noopResult.resources).toEqual(baseline.resources); expect(noopResult.meta).toEqual(baseline.meta);
    expect((await workspace.loadWorkspace('ledger')).revision).toBe(baseline.revision);

    const csv = parseCsv(template.bytes), header = csv[0], deviceColumn = header.indexOf('device_id');
    const heightColumn = header.indexOf('antenna_height_m'), frequencyColumn = header.indexOf('work_freq_khz');
    if ([deviceColumn, heightColumn, frequencyColumn].some(index => index < 0)) throw new Error('真实设备模板缺少设备编号、高度或频率列');
    const selectedRow = csv.findIndex((row, index) => index > 0 && baseline.resources.devices.some(device => device.id === row[deviceColumn]
      && device.antennaHeightM !== null && Number.isFinite(device.antennaHeightM)));
    if (selectedRow < 1) throw new Error('设备模板未提供可核验原始高度的已有设备');
    const selectedId = csv[selectedRow][deviceColumn], originalDevice = baseline.resources.devices.find(device => device.id === selectedId)!;
    const firstHeight = originalDevice.antennaHeightM! + 1, secondHeight = firstHeight + 1;
    if (!Number.isFinite(secondHeight) || firstHeight === originalDevice.antennaHeightM || secondHeight === firstHeight) throw new Error('设备高度无法构造两次有限增量');
    const firstCsv = csv.map(row => [...row]); firstCsv[selectedRow][heightColumn] = String(firstHeight);
    const firstRequest = csvRequest(firstCsv, baseline.revision), firstPreview = await importer.previewResourceImport(firstRequest);
    expect(firstPreview.issues).toEqual([]); expect(counts(firstPreview.candidate)).toEqual(originalCounts);
    expect(firstPreview.rows.some(row => row.id === selectedId && row.sheet === 'devices' && row.action === 'UPDATE')).toBe(true);
    expect(firstPreview.candidate.devices.find(device => device.id === selectedId)?.antennaHeightM).toBe(firstHeight);
    expect(await workspace.loadWorkspace('ledger', baseline.revision)).toEqual(baseline);
    const firstRequestId = id('height-1');
    const firstResult = await importer.commitResourceImport({ baseRevision: baseline.revision, requestId: firstRequestId, preview: firstPreview });
    const firstRevision = firstResult.meta.revision;
    expect(firstResult.changed).toBe(true); expect(firstRevision).not.toBe(baseline.revision);
    expect(firstResult.resources.version).toBe(firstRevision); expect(counts(firstResult.resources)).toEqual(originalCounts);
    expect(firstResult.resources.devices.find(device => device.id === selectedId)).toEqual({ ...originalDevice, antennaHeightM: firstHeight, origin: 'IMPORT' });
    const firstCurrent = await workspace.loadWorkspace('ledger', firstRevision);
    expect(firstCurrent.resources).toEqual(firstResult.resources); expect(firstCurrent.meta).toEqual(firstResult.meta);
    const replayFirst = () => importer.commitResourceImport({ baseRevision: baseline.revision, requestId: firstRequestId, preview: structuredClone(firstPreview) });
    expect(await replayFirst()).toEqual(firstResult);
    expect((await workspace.loadWorkspace('ledger')).revision).toBe(firstRevision);

    const secondCsv = firstCsv.map(row => [...row]); secondCsv[selectedRow][heightColumn] = String(secondHeight);
    const secondRequest = csvRequest(secondCsv, firstRevision), secondPreview = await importer.previewResourceImport(secondRequest);
    expect(secondPreview.issues).toEqual([]); expect((await workspace.loadWorkspace('ledger')).revision).toBe(firstRevision);
    const secondResult = await importer.commitResourceImport({ baseRevision: firstRevision, requestId: id('height-2'), preview: secondPreview });
    const secondRevision = secondResult.meta.revision;
    expect(secondResult.changed).toBe(true); expect(secondRevision).not.toBe(firstRevision);
    expect(secondResult.resources.version).toBe(secondRevision); expect(counts(secondResult.resources)).toEqual(originalCounts);
    expect(secondResult.resources.devices.find(device => device.id === selectedId)?.antennaHeightM).toBe(secondHeight);
    // 后来提交已改变 current，旧请求仍必须回读自己的不可变资源版本。
    const frozenFirst: ResourceSaveResult = structuredClone(firstResult);
    expect(await replayFirst()).toEqual(frozenFirst);
    expect(await importer.applyResourceImport({ baseRevision: baseline.revision, requestId: firstRequestId, preview: firstPreview }))
      .toMatchObject({ objectId: 'resource-import', changed: true, revision: firstRevision, readRevision: firstRevision, affectedIds: [selectedId] });
    const secondCurrent = await workspace.loadWorkspace('ledger', secondRevision);
    expect(secondCurrent.resources).toEqual(secondResult.resources); expect(secondCurrent.meta).toEqual(secondResult.meta);
    expect(await workspace.loadWorkspace('ledger')).toEqual(secondCurrent);

    await expect(importer.previewResourceImport(firstRequest)).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CHANGED' });
    const invalidCsv = secondCsv.map(row => [...row]); invalidCsv[selectedRow][frequencyColumn] = '0';
    const invalidRequest = csvRequest(invalidCsv, secondRevision), invalid = await importer.previewResourceImport(invalidRequest);
    expect(invalid.issues.length).toBeGreaterThan(0);
    expect(invalid.issues.some(issue => issue.objectId === selectedId && issue.field === 'work_freq_khz')).toBe(true);
    expect(invalid.candidate).toEqual(secondResult.resources);
    expect(invalid.changes).toEqual({ stations: [], devices: [] });
    await expect(importer.commitResourceImport({ baseRevision: secondRevision, requestId: id('invalid-client'), preview: invalid })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 同一签名和原文件绕过页面门控后，服务端重解析也必须拒绝且不写入。
    await expect(auth.authenticatedRequest('/resource/import/commit', { method: 'POST', body: JSON.stringify({
      ...resourceImportBody(invalidRequest), signature: invalid.signature, request_id: id('invalid-server'),
    }) })).rejects.toMatchObject({ code: 1001 });
    expect(await workspace.loadWorkspace('ledger', secondRevision)).toEqual(secondCurrent);

    for (const { expectedSheet, ...file } of [
      { name: `${marker}-malformed.csv`, bytes: new Uint8Array([255]), expectedSheet: 'devices' },
      { name: `${marker}-malformed.xlsx`, bytes: new Uint8Array([80, 75, 0, 0]), expectedSheet: 'file' },
    ]) {
      const malformed = await importer.previewResourceImport({ context: 'ledger', kind: 'devices', baseRevision: secondRevision, file });
      console.info(marker, JSON.stringify({ file: file.name, issues: malformed.issues }));
      expect(malformed.issues.length).toBeGreaterThan(0);
      expect(malformed.issues.every(issue => issue.sheet === expectedSheet && issue.message.length > 0)).toBe(true);
      expect(malformed.rows).toEqual([]); expect(malformed.candidate).toEqual(secondResult.resources);
      expect(malformed.changes).toEqual({ stations: [], devices: [] });
      await expect(importer.commitResourceImport({ baseRevision: secondRevision, requestId: id('malformed-client'), preview: malformed }))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await workspace.loadWorkspace('ledger', secondRevision)).toEqual(secondCurrent);
    }

    const xlsx = await importer.getResourceTemplate('xlsx', 'devices');
    expect(xlsx.mime).toBe(resourceXlsxMime); expect(xlsx.bytes.byteLength).toBeGreaterThan(4); expect(xlsx.name).toContain(secondRevision);
    const xlsxPreview = await importer.previewResourceImport({ context: 'ledger', kind: 'devices', baseRevision: secondRevision, file: { name: xlsx.name, bytes: xlsx.bytes } });
    expect(xlsxPreview.issues).toEqual([]); expect(xlsxPreview.rows.length).toBeGreaterThan(0);
    expect(xlsxPreview.rows.every(row => row.action === 'UNCHANGED')).toBe(true);
    expect(xlsxPreview.candidate).toEqual(secondResult.resources);
    expect(Object.values(xlsxPreview.changes).every(rows => !rows?.length)).toBe(true);
    expect(await workspace.loadWorkspace('ledger', secondRevision)).toEqual(secondCurrent);
    console.info(marker, JSON.stringify({ dataOrigin: 'SYNTHETIC_INTEGRATION', baselineRevision: baseline.revision, firstRevision, secondRevision,
      counts: originalCounts, deviceId: selectedId, originalHeight: originalDevice.antennaHeightM, firstHeight, secondHeight, firstRequestId, xlsxRows: xlsxPreview.rows.length }));
  }, 180000);
});
