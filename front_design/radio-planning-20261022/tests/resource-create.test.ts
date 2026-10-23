import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { initialResources } from '../src/mocks/resource-presets';
import { createNewForm, formChanges, validateResources } from '../src/services/resource-validation';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

let pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });

describe('R2 资源创建与服务端导入入口', () => {
  it.each(['station', 'device'] as const)('新建 %s 不产生正常、离线或无告警观测结论', kind => {
    const source = initialResources(), form = createNewForm(kind, source);
    if (kind === 'station') Object.assign(form.fields, { name: '新固定站', longitude: '114.5', latitude: '37.5' });
    else Object.assign(form.fields, { stationId: source.stations[0]!.id, modelId: source.models[0]!.id,
      antennaId: source.antennas[0]!.id, antennaHeightM: '10', txPowerDbm: '10' });
    const changes = formChanges(form), row = kind === 'station' ? changes.newStations![0]! : changes.newDevices![0]!;
    expect(row.status).toBeNull(); expect(row.alert).toBeNull(); expect(row.origin).toBe('MANUAL');
  });

  it('完整校验保留合法未知状态，但拒绝任意状态文本', () => {
    const source = initialResources(); source.stations[0]!.status = null; source.stations[0]!.alert = null;
    source.devices[0]!.status = null; source.devices[0]!.alert = null;
    const same = validateResources(source, source, source);
    expect(same.issues.filter(issue => issue.field === 'status')).toEqual([]);
    const bad = structuredClone(source);
    Object.assign(bad.devices[0]!, { status: 'UNKNOWN_TEXT' });
    expect(validateResources(bad, source, source).issues.some(issue => issue.field === 'status')).toBe(true);
  });

  it('仅导入权限可打开导入，但不能打开已有参数表单或新增设备', async () => {
    pinia = createPinia(); setActivePinia(pinia);
    const auth = authorizeStore(); auth.accept({ ...auth.identity!, permissions: ['resources.view', 'resources.import'] });
    const service = createMockService(() => new TestStorage());
    vi.spyOn(previewService, 'loadResourceReadContext').mockImplementation(service.loadResourceReadContext);
    vi.spyOn(previewService, 'queryResourceDevices').mockImplementation(service.queryResourceDevices);
    const read = useResourceReadStore(); await read.activate('ledger');
    const editor = useResourceLedgerEditStore();
    expect(editor.canImport).toBe(true); expect(editor.canEdit).toBe(false); expect(editor.canCreate).toBe(false);
    expect(await editor.openImport()).toBe(true);
    expect(await editor.openForm('DV-0001')).toBe(false);
    expect(await editor.openForm()).toBe(false);
  });

  it('GIS 导入调用后端整批提交，成功移动基线，不只修改浏览器草稿', async () => {
    pinia = createPinia(); setActivePinia(pinia); authorizeStore();
    const storage = new TestStorage(), service = createMockService(() => storage);
    const source = await service.loadResourceReadContext({ context: 'gis' });
    const baseline = await service.loadGisResourceEditContext({ context: 'gis', revision: source.revision });
    const read = useResourceReadStore(); read.workspace = source;
    const editor = useResourceEditStore(); editor.acceptGisContext(baseline); editor.begin();
    const file = { name: 'nodes.csv', bytes: new TextEncoder().encode('server-owned-fixture') };
    vi.spyOn(previewService, 'previewResourceImport').mockImplementation(async request => ({ request,
      signature: 'a'.repeat(64), rows: [], issues: [], warnings: [], candidate: baseline.resources, changes: { stations: [], devices: [] } }));
    const revision = 'resource-1234567890abcdef', saved = structuredClone(baseline.resources); saved.version = revision;
    const commit = vi.spyOn(previewService, 'commitResourceImport').mockResolvedValue({ resources: saved,
      meta: { ...baseline.resourceMeta, revision, resourceEpoch: revision }, changed: true, warnings: [] });
    vi.spyOn(read, 'refresh').mockResolvedValue(true);
    editor.importOpen = true; await editor.previewImport(file);
    expect(await editor.confirmImport(), editor.error).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![0].preview.request.file.bytes).toEqual(file.bytes);
    expect(editor.saved?.revision).toBe(revision); expect(editor.saved?.validationSource.version).toBe(revision);
    expect(editor.baseRevision).toBe(revision); expect(editor.draftDirty).toBe(false); expect(editor.importFile).toBeNull();
  });
});
