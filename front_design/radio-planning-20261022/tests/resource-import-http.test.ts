import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createResourceImportHttp } from '../src/services/resource-import-http';
import { maxResourceImportBytes, resourceXlsxMime } from '../src/services/resource-import-validation';
import { workspaceSource } from '../src/services/resource-workspace-validation';
import { ApiError } from '../src/services/types';
import type { ResourcesData } from '../src/types/domain';
import type { ResourceChanges, ResourceImportRequest, ResourceImportRow, ResourceMeta } from '../src/types/resource-edit';
import type { CandidateLink, CandidateLinkData } from '../src/types/candidate-link';

const old = 'resource-1111111111111111', next = 'resource-2222222222222222', signature = 'a'.repeat(64);
function resources(revision = old): ResourcesData {
  return { version: revision, source: workspaceSource,
    stations: [{ id: 'N1', name: '节点一', echelon: 'I', parentIds: [], coordinate: [114, 37], elevationM: null, region: '', classes: ['HF'], status: null, alert: null, relayCapable: true, key: false, mobility: 'FIXED', origin: 'IMPORT' }],
    devices: [{ id: 'D1', stationId: 'N1', modelId: 'M1', antennaId: 'A1', status: null, alert: null, origin: 'SOURCE', antennaHeightM: null, txPowerDbm: null, workFreqKhz: null, installedAt: '' }],
    models: [{ id: 'M1', name: '型号一', manufacturer: '', deviceClass: 'HF', freqMinKhz: 2000, freqMaxKhz: 30000, txPowerMaxDbm: 50, modulation: [], workMode: [] }], antennas: [{ id: 'A1', name: '天线一' }], interferences: [] };
}
function meta(data: ResourcesData): ResourceMeta {
  return { revision: data.version, resourceEpoch: data.version, stationVersions: Object.fromEntries(data.stations.map(row => [row.id, data.version])),
    deviceVersions: Object.fromEntries(data.devices.map(row => [row.id, data.version])), savedAt: null, changedStationIds: [], changedDeviceIds: [], receipts: [] };
}
function context() {
  const data = resources();
  return { revision: old, baseRevision: old, device: null, stations: data.stations, models: data.models, antennas: data.antennas, resources: data, meta: meta(data), impact: { planIds: [], linkIds: [], description: '保留历史' } };
}
const input = (): ResourceImportRequest => ({ context: 'ledger', baseRevision: old, kind: 'nodes', file: { name: '资源.csv', bytes: new Uint8Array([255, 0, 128, 13, 10]) } });
function preview() {
  return { base_revision: old, context: 'ledger', kind: 'nodes', file_name: '资源.csv', signature, valid: true,
    rows: [{ sheet: 'nodes', row: 2, id: 'N1', action: 'UPDATE', differences: [{ field: 'node_name', before: '旧名称', after: '节点一' }] }],
    issues: [], warnings: [], candidate: resources(), changes: { stations: [{ id: 'N1', name: '节点一' }], devices: [] } };
}
function mutation(changed = true) {
  const data = resources(changed ? next : old);
  return { receipt: { objectId: 'resource-import', changed, revision: data.version, readRevision: data.version, affectedIds: changed ? ['N1'] : [], warnings: [] },
    result: { resources: data, meta: meta(data), changed, warnings: [] } };
}
function service(value: unknown = preview()) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value);
  return { request, api: createResourceImportHttp(request as AuthenticatedRequest) };
}
function body(call: [string, RequestInit?, ('json' | 'blob')?]) { return JSON.parse(String(call[1]?.body)); }

const candidateHeader = 'link_id,node_a_id,node_b_id,device_a_id,device_b_id,device_class,freq_khz,bandwidth_khz,distance_m,path_loss_db,rx_power_dbm,link_margin_db,is_available,link_state,is_backup';
function candidateRequest(name = '候选.csv'): ResourceImportRequest {
  return { context: 'gis', kind: 'topology_links', baseRevision: old, file: { name,
    bytes: name.endsWith('.csv') ? new TextEncoder().encode(candidateHeader + '\nC1,N1,N2,D1,D2,HF,,,0,,,,false,,\n') : new Uint8Array([80, 75, 3, 4]) } };
}
function importedCandidate(evaluated = true, name = '候选.csv'): CandidateLink {
  const data: CandidateLinkData = { id: 'C1', nodeAId: 'N1', nodeBId: 'N2', deviceAId: 'D1', deviceBId: 'D2', deviceClass: 'HF',
    freqKhz: null, bandwidthKhz: null, isBackup: null, distanceM: evaluated ? 0 : null, pathLossDb: null, rxPowerDbm: null, linkMarginDb: null,
    isAvailable: evaluated ? false : null, linkState: null };
  const source = { kind: 'IMPORT' as const, file: name, row: 2 };
  return { ...data, source, assessmentState: evaluated ? 'REFERENCE' : 'PENDING', reference: evaluated ? { data: { ...data }, source: { ...source } } : null, notices: [] };
}
function candidateResources(links: CandidateLink[] = [], revision = old): ResourcesData {
  const data = resources(revision);
  data.stations.push({ ...structuredClone(data.stations[0]), id: 'N2' });
  data.devices.push({ ...structuredClone(data.devices[0]), id: 'D2', stationId: 'N2' });
  data.candidateLinks = structuredClone(links);
  return data;
}
function candidateContext() {
  const data = candidateResources(), metadata = meta(data);
  return { ...context(), stations: data.stations, models: data.models, antennas: data.antennas, resources: data, meta: metadata,
    resourceMeta: structuredClone(metadata), validationSource: structuredClone(data),
    situation: { title: '候选资源编辑上下文', snapshotId: old, updatedAt: '2026-10-23T00:00:00Z', links: [], candidateLinks: [], regions: [], alerts: [], spectrum: [] } };
}
function candidatePreview(evaluated = true, name = '候选.csv') {
  const link = importedCandidate(evaluated, name), changes: ResourceChanges = { stations: [], devices: [], newCandidateLinks: [link] };
  const rows: ResourceImportRow[] = [{ sheet: 'topology_links', row: 2, id: 'C1', action: 'NEW', differences: [{ field: 'link_id', before: null, after: 'C1' }] }];
  return { base_revision: old, context: 'gis', kind: 'topology_links', file_name: name, signature, valid: true, rows, issues: [], warnings: [],
    candidate: candidateResources([link]), changes };
}
function candidateMutation(links: CandidateLink[], changed = true) {
  const data = candidateResources(links, changed ? next : old);
  return { receipt: { objectId: 'resource-import', changed, revision: data.version, readRevision: data.version, affectedIds: changed ? ['C1'] : [], warnings: [] },
    result: { resources: data, meta: meta(data), changed, warnings: [] } };
}

describe('资源导入 HTTP 请求桩契约', () => {
  it('预检只发送原始 bytes 的 Base64，不解析非法 UTF-8，不上传草稿/候选', async () => {
    const s = service(), original = input(), result = await s.api.previewResourceImport(original);
    expect(s.request.mock.calls[0][0]).toBe('/resource/import/preview');
    expect(body(s.request.mock.calls[0])).toEqual({ context: 'ledger', base_revision: old, kind: 'nodes', file: { name: '资源.csv', base64: '/wCADQo=' } });
    expect(result.request.file.bytes).toEqual(original.file.bytes);
    expect(result.request.file.bytes).not.toBe(original.file.bytes);
    expect(result.candidate.devices[0]).toMatchObject({ workFreqKhz: null, status: null, alert: null, origin: 'SOURCE' });
  });
  it('异步输入被修改仍绑定原始文件名、版本、类型和字节', async () => {
    const s = service(), original = input();
    let resolve: (value: unknown) => void = () => {};
    s.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }) as ReturnType<AuthenticatedRequest>);
    const pending = s.api.previewResourceImport(original);
    original.file.bytes.fill(1); original.file.name = '后来.csv'; original.baseRevision = next; original.kind = 'devices'; original.context = 'gis';
    resolve(preview());
    const result = await pending;
    expect(result.request).toEqual(input());
    s.request.mockResolvedValue(mutation());
    await s.api.applyResourceImport({ baseRevision: old, requestId: 'req-1', preview: structuredClone(result) });
    expect(body(s.request.mock.calls[1]).file.base64).toBe('/wCADQo=');
  });
  it('提交重传原文件、签名和 requestId，apply/commit 分别返回 receipt/result', async () => {
    const s = service(), value = await s.api.previewResourceImport(input());
    s.request.mockResolvedValue(mutation());
    expect(await s.api.applyResourceImport({ baseRevision: old, requestId: 'req-1', preview: value })).toEqual(mutation().receipt);
    expect(body(s.request.mock.calls[1])).toEqual({ context: 'ledger', base_revision: old, kind: 'nodes', file: { name: '资源.csv', base64: '/wCADQo=' }, signature, request_id: 'req-1' });
    expect(s.request.mock.calls[1][0]).toBe('/resource/import/commit');
    expect(await s.api.commitResourceImport({ baseRevision: old, requestId: 'req-1', preview: value })).toEqual(mutation().result);
  });
  it('导入提交拒绝错误对象回执、无关 affectedIds 和较新 current 结果', async () => {
    const s = service(), value = await s.api.previewResourceImport(input());
    for (const patch of [{ ...mutation(), receipt: { ...mutation().receipt, objectId: 'resource-workspace' } },
      { ...mutation(), receipt: { ...mutation().receipt, affectedIds: ['D1'] } },
      { ...mutation(), result: { ...mutation().result, resources: resources('resource-3333333333333333') } }]) {
      s.request.mockResolvedValue(patch);
      await expect(s.api.commitResourceImport({ baseRevision: old, requestId: 'req-1', preview: value })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
  });
  it('GIS 允许空草稿，非空草稿与超过原 bytes 5 MiB 的输入发送前拒绝', async () => {
    const s = service({ ...preview(), context: 'gis' });
    await s.api.previewResourceImport({ ...input(), context: 'gis', draftChanges: { stations: [], devices: [] } });
    expect(body(s.request.mock.calls[0])).not.toHaveProperty('draftChanges');
    s.request.mockClear();
    for (const patch of [{ draftChanges: { stations: [{ id: 'N1', name: '未保存' }], devices: [] } },
      { file: { name: '大文件.xlsx', bytes: new Uint8Array(maxResourceImportBytes + 1) } }, { kind: 'topology_links' },
      { file: { name: '空.csv', bytes: new Uint8Array() } }, { file: { name: '../资源.csv', bytes: input().file.bytes } }, { baseRevision: 'latest' }]) {
      await expect(s.api.previewResourceImport({ ...input(), ...patch } as ResourceImportRequest)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(s.request).not.toHaveBeenCalled();
  });
  it('5 MiB 原始文件不按 Base64 扩容后的大小拒绝', async () => {
    const s = service();
    await s.api.previewResourceImport({ ...input(), file: { name: '资源.csv', bytes: new Uint8Array(maxResourceImportBytes) } });
    expect(body(s.request.mock.calls[0]).file.base64.length).toBe(Math.ceil(maxResourceImportBytes / 3) * 4);
  });
  it('拒绝错版/错文件/错来源、非法签名、缺引用和损坏的 rows/issues', async () => {
    const values = [
      { ...preview(), base_revision: next }, { ...preview(), file_name: '其他.csv' }, { ...preview(), context: 'gis' }, { ...preview(), kind: 'devices' },
      { ...preview(), signature: 'not-a-signature' }, { ...preview(), valid: false }, { ...preview(), candidate: resources(next) },
      { ...preview(), candidate: { ...resources(), source: 'PRODUCTION' } }, { ...preview(), issues: [{}] },
      { ...preview(), rows: [{ ...preview().rows[0], sheet: 'devices' }] }, { ...preview(), rows: [{ ...preview().rows[0], row: 1 }] },
      { ...preview(), rows: [{ ...preview().rows[0], differences: [{ field: 'name', before: NaN, after: 'new' }] }] },
      { ...preview(), rows: [{ ...preview().rows[0], action: 'UNCHANGED' }] }, { ...preview(), rows: [preview().rows[0], preview().rows[0]] },
      { ...preview(), candidate: { ...resources(), devices: [{ ...resources().devices[0], stationId: 'missing' }] } },
      { ...preview(), changes: { stations: [{ id: 'other', name: 'bad' }], devices: [] } },
    ];
    for (const value of values) await expect(service(value).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('issues 非空保留错误和真实差异，只接纳安全候选及空 changes，并阻止提交', async () => {
    const value = { ...preview(), valid: false, issues: [{ sheet: 'nodes', row: 2, objectId: 'N1', field: 'coordinate', message: '坐标无效' }], changes: { stations: [], devices: [] } };
    const s = service(value), result = await s.api.previewResourceImport(input());
    expect(result.rows).toEqual(value.rows); expect(result.issues).toEqual(value.issues);
    await expect(s.api.applyResourceImport({ baseRevision: old, requestId: 'req-1', preview: result })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).toHaveBeenCalledTimes(1);
    await expect(service({ ...value, changes: preview().changes }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it.each([
    { name: '损坏.csv', bytes: new Uint8Array([255]), sheet: 'file', row: 0, field: 'file', message: 'CSV 必须为严格 UTF-8' },
    { name: '损坏.xlsx', bytes: new Uint8Array([80, 75, 0, 0]), sheet: 'file', row: 0, field: 'file', message: 'XLSX 文件损坏或格式不受支持' },
    { name: '非法表.xlsx', bytes: new Uint8Array([80, 75, 3, 4]), sheet: '说明非法名', row: 1, field: 'sheet', message: '不接受未知工作表' },
    { name: '非法表.xlsx', bytes: new Uint8Array([80, 75, 3, 4]), sheet: ' 非法/工作表:1 ', row: 1, field: 'sheet', message: '不接受隐藏工作表' },
  ])('保留损坏文件 $name 的原始诊断标签 $sheet，不伪造 nodes', async ({ name, bytes, ...issue }) => {
    const diagnostic = { ...issue, objectId: 'file' }, warning = { ...diagnostic, message: '服务端保留的来源提示' };
    const data = { ...preview(), file_name: name, valid: false, rows: [], issues: [diagnostic], warnings: [warning], changes: { stations: [], devices: [] } };
    const s = service(data), result = await s.api.previewResourceImport({ ...input(), file: { name, bytes } });
    expect(result.issues).toEqual([diagnostic]); expect(result.warnings).toEqual([warning]);
    expect(result.request.file.bytes).toEqual(bytes); expect(result.rows).toEqual([]);
    expect(result.changes).toEqual({ stations: [], devices: [] });
    await expect(s.api.commitResourceImport({ baseRevision: old, requestId: 'must-not-commit', preview: result })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('诊断 sheet 接受 128 字符边界并拒绝超长、非字符串及 C0/DEL/C1 控制字符', async () => {
    const diagnostic = { sheet: '表'.repeat(128), row: 0, objectId: 'file', field: 'sheet', message: '工作表名称无效' };
    const data = { ...preview(), valid: false, rows: [], issues: [diagnostic], changes: { stations: [], devices: [] } };
    expect((await service(data).api.previewResourceImport(input())).issues[0].sheet).toBe(diagnostic.sheet);
    for (const sheet of [null, 1, {}, '表'.repeat(129), 'bad\u0000sheet', 'bad\tsheet', 'bad\nsheet', 'bad\u007fsheet', 'bad\u0085sheet']) {
      await expect(service({ ...data, issues: [{ ...diagnostic, sheet }] }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
      await expect(service({ ...data, warnings: [{ ...diagnostic, sheet }] }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    await expect(service({ ...data, rows: [{ ...preview().rows[0], sheet: 'file' }] }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it.each([0, 5002, Number.MAX_SAFE_INTEGER])('诊断行号 %s 保留原值，512 字符 objectId 作为显示文本而非业务 ID', async row => {
    const issue = { sheet: 'file', row, objectId: 'id / '.repeat(100) + 'x'.repeat(12), field: 'id', message: '原始编号超长或无效' };
    const data = { ...preview(), valid: false, rows: [], issues: [issue], changes: { stations: [], devices: [] } };
    expect(issue.objectId.length).toBe(512);
    expect((await service(data).api.previewResourceImport(input())).issues).toEqual([issue]);
    expect((await service({ ...data, issues: [{ ...issue, objectId: '' }] }).api.previewResourceImport(input())).issues[0].objectId).toBe('');
  });
  it('诊断拒绝不安全行号及未转义控制字符，保留后端转义后的原始 ID 表示', async () => {
    const issue = { sheet: 'file', row: 5002, objectId: 'file', field: 'id', message: '原始编号包含控制字符' };
    const data = { ...preview(), valid: false, rows: [], issues: [issue], changes: { stations: [], devices: [] } };
    for (const row of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5002', NaN]) {
      await expect(service({ ...data, issues: [{ ...issue, row }] }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    for (const objectId of ['x'.repeat(513), 'bad\u0000id', 'bad\u007fid', null, 1]) {
      await expect(service({ ...data, issues: [{ ...issue, objectId }] }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    const escaped = JSON.stringify('bad\u0000id');
    expect((await service({ ...data, issues: [{ ...issue, objectId: escaped }] }).api.previewResourceImport(input())).issues[0].objectId).toBe(escaped);
  });
  it('诊断标签和行号不放宽 candidate 的业务 ID 或 rows 的实际行号', async () => {
    const data = { ...preview(), valid: false, issues: [{ sheet: '说明非法名', row: 5002, objectId: '显示文本 / 非业务编号', field: 'id', message: '非法记录' }], changes: { stations: [], devices: [] } };
    await expect(service({ ...data, rows: [], candidate: { ...resources(), devices: [{ ...resources().devices[0], id: 'x'.repeat(121) }] } }).api.previewResourceImport(input()))
      .rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    await expect(service({ ...data, rows: [{ ...preview().rows[0], row: 5002 }] }).api.previewResourceImport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('拒绝预检后的 bytes/文件名/签名/候选/版本篡改以及未绑定的伪造预检', async () => {
    const s = service(), value = await s.api.previewResourceImport(input());
    const variants = [structuredClone(value), structuredClone(value), structuredClone(value), structuredClone(value), structuredClone(value)];
    variants[0].request.file.bytes[0] = 2; variants[1].request.file.name = '改名.csv'; variants[2].signature = 'b'.repeat(64);
    variants[3].candidate.source = 'other'; variants[4].request.baseRevision = next;
    for (const preview of variants) await expect(s.api.applyResourceImport({ baseRevision: old, requestId: 'req-1', preview })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(s.api.applyResourceImport({ baseRevision: next, requestId: 'req-1', preview: value })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service().api.applyResourceImport({ baseRevision: old, requestId: 'req-1', preview: value })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it.each([[1001, 'VALIDATION_ERROR'], [1002, 'RESOURCE_NOT_FOUND'], [1205, 'RESOURCE_VERSION_CHANGED'], [1206, 'REQUEST_CONFLICT'], ['REQUEST_TIMEOUT', 'REQUEST_TIMEOUT']])('提交错误 %s 不自动重发，调用方保留原 requestId', async (code, expected) => {
    const s = service(), value = await s.api.previewResourceImport(input());
    s.request.mockRejectedValue(new ApiError('明确失败', code, { detail: 1 }, 'trace', 409));
    await expect(s.api.applyResourceImport({ baseRevision: old, requestId: 'same-id', preview: value })).rejects.toMatchObject({ code: expected, requestId: 'trace' });
    expect(s.request).toHaveBeenCalledTimes(2);
    s.request.mockResolvedValue(mutation());
    await s.api.applyResourceImport({ baseRevision: old, requestId: 'same-id', preview: value });
    expect(body(s.request.mock.calls[2]).request_id).toBe('same-id');
  });
  it('模板先加载 current revision，再以 ledger 和指定类型/格式下载 Blob', async () => {
    const s = service();
    s.request.mockResolvedValueOnce(context()).mockResolvedValueOnce(new Blob(['node_id,node_name\nN1,节点一\n'], { type: 'text/csv;charset=utf-8' }));
    const file = await s.api.getResourceTemplate('csv', 'nodes');
    expect(s.request.mock.calls[0][0]).toBe('/resource/edit-context?context=ledger');
    expect(s.request.mock.calls[1][0]).toBe(`/resource/import/template?context=ledger&revision=${old}&format=csv&kind=nodes`);
    expect(s.request.mock.calls[1][2]).toBe('blob'); expect(file.mime).toBe('text/csv'); expect(file.name).toContain(old);
    s.request.mockResolvedValueOnce(context()).mockResolvedValueOnce(new Blob([new Uint8Array([80, 75, 3, 4])], { type: resourceXlsxMime }));
    expect((await s.api.getResourceTemplate('xlsx', 'devices')).bytes).toEqual(new Uint8Array([80, 75, 3, 4]));
  });
  it('模板拒绝假 Blob、错 MIME、错表头、非法 UTF-8 与损坏的 XLSX', async () => {
    for (const value of [{}, new Blob(['node_id,'], { type: 'text/html' }), new Blob(['device_id,'], { type: 'text/csv' }),
      new Blob([new Uint8Array([255])], { type: 'text/csv' }), new Blob([], { type: 'text/csv' })]) {
      const s = service(); s.request.mockResolvedValueOnce(context()).mockResolvedValueOnce(value);
      await expect(s.api.getResourceTemplate('csv', 'nodes')).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    const s = service(); s.request.mockResolvedValueOnce(context()).mockResolvedValueOnce(new Blob(['fake'], { type: resourceXlsxMime }));
    await expect(s.api.getResourceTemplate('xlsx', 'nodes')).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    const invalid = service(); await expect(invalid.api.getResourceTemplate('csv', 'unsupported' as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(invalid.request).not.toHaveBeenCalled();
  });
  it.each(['csv', 'xlsx'] as const)('候选 %s 模板先读取 GIS 当前版本，再下载独立拓扑表', async format => {
    const s = service(), mime = format === 'csv' ? 'text/csv' : resourceXlsxMime;
    const bytes = format === 'csv' ? new TextEncoder().encode(candidateHeader + '\n') : new Uint8Array([80, 75, 3, 4]);
    s.request.mockResolvedValueOnce(candidateContext()).mockResolvedValueOnce(new Blob([bytes], { type: mime }));
    const file = await s.api.getResourceTemplate(format, 'topology_links');
    expect(s.request.mock.calls[0][0]).toBe('/resource/edit-context?context=gis');
    expect(s.request.mock.calls[1][0]).toBe(`/resource/import/template?context=gis&revision=${old}&format=${format}&kind=topology_links`);
    expect(s.request.mock.calls[1][2]).toBe('blob'); expect(file.mime).toBe(mime); expect(file.bytes).toEqual(bytes);
  });
  it.each(['nodes', 'devices', 'interference_sources'] as const)('原三表 %s 模板继续绑定 ledger', async kind => {
    const s = service(), first = { nodes: 'node_id,', devices: 'device_id,', interference_sources: 'interference_id,' };
    s.request.mockResolvedValueOnce(context()).mockResolvedValueOnce(new Blob([first[kind]], { type: 'text/csv' }));
    await s.api.getResourceTemplate('csv', kind);
    expect(s.request.mock.calls[0][0]).toBe('/resource/edit-context?context=ledger');
    expect(s.request.mock.calls[1][0]).toBe(`/resource/import/template?context=ledger&revision=${old}&format=csv&kind=${kind}`);
  });
  it.each(['csv', 'xlsx'] as const)('GIS 候选 %s 预检和原文件提交保留 canonical 参考及所有未知值', async format => {
    const name = `候选.${format}`, value = candidatePreview(true, name), s = service(value), request = candidateRequest(name);
    const result = await s.api.previewResourceImport(request);
    expect(body(s.request.mock.calls[0])).toEqual({ context: 'gis', base_revision: old, kind: 'topology_links', file: { name, base64: btoa(String.fromCharCode(...request.file.bytes)) } });
    expect(result.rows[0].sheet).toBe('topology_links'); expect(result.changes.newCandidateLinks).toEqual(value.changes.newCandidateLinks);
    expect(result.candidate.candidateLinks![0]).toMatchObject({ freqKhz: null, bandwidthKhz: null, isBackup: null, distanceM: 0, isAvailable: false,
      pathLossDb: null, rxPowerDbm: null, linkMarginDb: null, linkState: null, assessmentState: 'REFERENCE', source: { kind: 'IMPORT', file: name, row: 2 } });
    const saved = candidateMutation(value.candidate.candidateLinks!); s.request.mockResolvedValue(saved);
    expect(await s.api.commitResourceImport({ baseRevision: old, requestId: 'candidate-import-1', preview: structuredClone(result) })).toEqual(saved.result);
    expect(await s.api.applyResourceImport({ baseRevision: old, requestId: 'candidate-import-1', preview: result })).toEqual(saved.receipt);
    expect(body(s.request.mock.calls[1])).toEqual({ ...body(s.request.mock.calls[0]), signature, request_id: 'candidate-import-1' });
    expect(body(s.request.mock.calls[1])).not.toHaveProperty('changes'); expect(body(s.request.mock.calls[1])).not.toHaveProperty('candidate');
  });
  it('六项评估未知的导入候选保持 IMPORT/PENDING/null，不补 0、false 或参考', async () => {
    const value = candidatePreview(false), s = service(value), result = await s.api.previewResourceImport(candidateRequest());
    const link = result.candidate.candidateLinks![0];
    for (const field of ['freqKhz', 'bandwidthKhz', 'isBackup', 'distanceM', 'pathLossDb', 'rxPowerDbm', 'linkMarginDb', 'isAvailable', 'linkState'] as const) expect(link[field]).toBeNull();
    expect(link.assessmentState).toBe('PENDING'); expect(link.reference).toBeNull(); expect(link.source.kind).toBe('IMPORT');
    s.request.mockResolvedValue(candidateMutation([link]));
    expect((await s.api.commitResourceImport({ baseRevision: old, requestId: 'unknown-candidate', preview: result })).resources.candidateLinks).toEqual([link]);
  });
  it('已有候选更新接纳完整 importedCandidateLinks，不转换成配置 patch', async () => {
    const value = candidatePreview(); value.rows[0].action = 'UPDATE';
    value.changes = { stations: [], devices: [], importedCandidateLinks: value.changes.newCandidateLinks };
    const s = service(value), result = await s.api.previewResourceImport(candidateRequest());
    expect(result.changes).toEqual(value.changes); expect(result.changes.candidateLinks).toBeUndefined();
    s.request.mockResolvedValue(candidateMutation(value.candidate.candidateLinks!));
    expect((await s.api.commitResourceImport({ baseRevision: old, requestId: 'update-candidate', preview: result })).resources.candidateLinks).toEqual(value.candidate.candidateLinks);
  });
  it('ledger 候选、未保存草稿和超过 5 MiB 的候选原文件在发请求前拒绝', async () => {
    const s = service(candidatePreview());
    for (const patch of [{ context: 'ledger' }, { file: { name: '候选.csv', bytes: new Uint8Array(maxResourceImportBytes + 1) } },
      { draftChanges: { stations: [], devices: [], candidateLinks: [{ id: 'C1', isBackup: true }] } }]) {
      await expect(s.api.previewResourceImport({ ...candidateRequest(), ...patch } as ResourceImportRequest)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(s.request).not.toHaveBeenCalled();
  });
  it('候选来源必须绑定原 GIS 请求、文件名和行号，不能伪造为 SOURCE 或 MANUAL', async () => {
    for (const source of [{ kind: 'IMPORT', file: 'other.csv', row: 2 }, { kind: 'IMPORT', file: '候选.csv', row: 3 },
      { kind: 'SOURCE', file: '候选.csv', row: 2 }, { kind: 'MANUAL', file: null, row: null }]) {
      const value = candidatePreview(false); Object.assign(value.candidate.candidateLinks![0].source, source);
      await expect(service(value).api.previewResourceImport(candidateRequest())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    await expect(service({ ...candidatePreview(), context: 'ledger' }).api.previewResourceImport(candidateRequest())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('拒绝伪评估、伪冻结参考、错误端点及缺少完整候选集合的响应', async () => {
    const corruptions: ((link: CandidateLink) => void)[] = [
      link => { link.assessmentState = 'PENDING'; }, link => { link.reference = null; },
      link => { link.reference!.data.id = 'other'; }, link => { link.reference!.data.freqKhz = 8000; },
      link => { link.reference!.source.file = 'other.csv'; },
      link => { link.reference!.source = { kind: 'MANUAL', file: null, row: null }; },
      link => { Object.assign(link, { isAvailable: 'false' }); }, link => { link.deviceBId = 'missing'; },
      link => { link.nodeBId = link.nodeAId; }, link => { link.freqKhz = 0; },
    ];
    for (const corrupt of corruptions) {
      const value = candidatePreview(); corrupt(value.candidate.candidateLinks![0]);
      await expect(service(value).api.previewResourceImport(candidateRequest())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    const value = candidatePreview(); delete value.candidate.candidateLinks;
    await expect(service(value).api.previewResourceImport(candidateRequest())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('候选与三表 XLSX 不能混表，候选导入不接受普通资源修改或配置 patch', async () => {
    const value = candidatePreview(true, '候选.xlsx');
    await expect(service({ ...value, rows: [{ ...value.rows[0], sheet: 'nodes' }] }).api.previewResourceImport(candidateRequest('候选.xlsx'))).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    await expect(service({ ...preview(), file_name: '资源.xlsx', rows: value.rows }).api.previewResourceImport({ ...input(), file: { name: '资源.xlsx', bytes: candidateRequest('候选.xlsx').file.bytes } })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    for (const changes of [{ ...value.changes, stations: [{ id: 'N1', name: '偷偷修改' }] },
      { stations: [], devices: [], candidateLinks: [{ id: 'C1', isBackup: true }] },
      { stations: [], devices: [], importedCandidateLinks: value.changes.newCandidateLinks },
      { ...value.changes, importedCandidateLinks: value.changes.newCandidateLinks }]) {
      await expect(service({ ...value, changes }).api.previewResourceImport(candidateRequest('候选.xlsx'))).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    await expect(service({ ...value, rows: [{ ...value.rows[0], row: 5002 }] }).api.previewResourceImport(candidateRequest('候选.xlsx'))).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    await expect(service({ ...value, rows: Array.from({ length: 5001 }, () => value.rows[0]) }).api.previewResourceImport(candidateRequest('候选.xlsx'))).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('候选提交结果必须是原预检的完整 canonical 集合，不能丢行或置换文件来源', async () => {
    const value = candidatePreview(), s = service(value), result = await s.api.previewResourceImport(candidateRequest());
    const saved = candidateMutation(value.candidate.candidateLinks!);
    saved.result.resources.candidateLinks![0].source.file = 'other.csv'; saved.result.resources.candidateLinks![0].reference!.source.file = 'other.csv';
    s.request.mockResolvedValue(saved);
    await expect(s.api.commitResourceImport({ baseRevision: old, requestId: 'wrong-source', preview: result })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    const extra = candidateMutation(value.candidate.candidateLinks!), extraLink = importedCandidate();
    extraLink.id = 'C2'; extraLink.reference!.data.id = 'C2'; extra.result.resources.candidateLinks!.push(extraLink); s.request.mockResolvedValue(extra);
    await expect(s.api.commitResourceImport({ baseRevision: old, requestId: 'extra-row', preview: result })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
  it('候选错误预检保留原完整安全集合和诊断，changes 必须为空且不能提交', async () => {
    const value = { ...candidatePreview(), valid: false, candidate: candidateResources(), changes: { stations: [], devices: [] },
      issues: [{ sheet: 'topology_links', row: 2, objectId: 'C1', field: 'device_b_id', message: '引用不存在' }] };
    const s = service(value), result = await s.api.previewResourceImport(candidateRequest());
    expect(result.candidate.candidateLinks).toEqual([]); expect(result.issues).toEqual(value.issues);
    await expect(s.api.applyResourceImport({ baseRevision: old, requestId: 'invalid-candidate', preview: result })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('候选模板拒绝节点表头和损坏 ZIP，不在前端解析后十四列', async () => {
    for (const value of [new Blob(['node_id,node_name\n'], { type: 'text/csv' }), new Blob([new Uint8Array([255])], { type: 'text/csv' })]) {
      const s = service(); s.request.mockResolvedValueOnce(candidateContext()).mockResolvedValueOnce(value);
      await expect(s.api.getResourceTemplate('csv', 'topology_links')).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
    const s = service(); s.request.mockResolvedValueOnce(candidateContext()).mockResolvedValueOnce(new Blob(['not ZIP'], { type: resourceXlsxMime }));
    await expect(s.api.getResourceTemplate('xlsx', 'topology_links')).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });
});
