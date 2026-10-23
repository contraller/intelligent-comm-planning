import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { usePreviewStore } from '../src/stores/preview';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

let pinia: ReturnType<typeof createPinia>;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
async function setup() {
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore(), storage = new TestStorage(), service = createMockService(() => storage);
  for (const name of ['loadResourceReadContext', 'queryResourceDevices', 'getResourceObject', 'loadResourceMaintenanceContext', 'saveResourceChanges', 'updateDeviceAvailability', 'previewResourceImport', 'applyResourceImport'] as const)
    vi.spyOn(previewService, name).mockImplementation(service[name] as never);
  const read = useResourceReadStore(); await read.activate('ledger');
  return { auth, storage, service, read, editor: useResourceLedgerEditStore(), preview: usePreviewStore() };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('台账独立维护工作区', () => {
  // 台账保存使旧缓存失效；GIS 显式重读同版基线，历史结果仍保持冻结。
  it('仅修改当前设备，GIS 重读可见，其他资源及历史快照保持原样', async () => {
    const { editor, service, preview, storage } = await setup();
    const before = await service.loadPreview(); preview.data = structuredClone(before);
    await editor.openForm('DV-0001'); editor.form!.fields.antennaHeightM = '15';
    expect(await editor.save(), editor.error).toBe(true); expect(preview.data).toBeNull();
    const restored = await service.loadPreview();
    expect(restored.resources.devices[0].antennaHeightM).toBe(15);
    expect(restored.resources.devices.slice(1)).toEqual(before.resources.devices.slice(1));
    expect(restored.resources.stations).toEqual(before.resources.stations);
    expect(restored.planning.plans[0].sourceChanged).toBe(true);
    for (const [index, plan] of restored.planning.plans.entries())
      expect({ ...plan, sourceChanged: before.planning.plans[index].sourceChanged }).toEqual(before.planning.plans[index]);
    expect(restored.diagnosis).toEqual(before.diagnosis);
    await editor.closeForm();
    const context = await service.loadResourceReadContext({ context: 'gis' }), gis = useResourceEditStore();
    gis.acceptGisContext(await service.loadGisResourceEditContext({ context: 'gis', revision: context.revision })); gis.begin();
    expect(gis.resources.devices[0].antennaHeightM).toBe(15);
    expect((await createMockService(() => storage).loadPreview()).planning).toEqual(restored.planning);
  });
  it('无变化保存不升资源版本，关闭选择保存只提交当前设备', async () => {
    const { editor, storage, service } = await setup(); await editor.openForm('DV-0001');
    const revision = editor.context!.baseRevision, before = await service.loadPreview();
    expect(await editor.save()).toBe(true); expect(editor.message).toBe('没有需要保存的修改');
    expect(editor.context!.baseRevision).toBe(revision);
    expect((await service.loadPreview()).resources).toEqual(before.resources);
    // 显式无变化请求可以保存幂等回执；原请求重放不能再次写入。
    const writes = storage.writes; expect(await editor.save()).toBe(true); expect(storage.writes).toBe(writes);
    editor.form!.fields.antennaHeightM = '14'; const closing = editor.closeForm();
    await vi.waitFor(() => expect(editor.decision).not.toBeNull()); editor.answer('save');
    expect(await closing).toBe(true); expect(editor.form).toBeNull(); expect(editor.visible).toBe(false);
    const restored = await service.loadPreview(); expect(restored.resources.devices[0].antennaHeightM).toBe(14);
    expect(restored.resources.devices.slice(1)).toEqual(before.resources.devices.slice(1));
    expect(storage.writes).toBe(writes + 1);
  });
  it('导入失败保留文件与预检，重放原请求成功且不重复新增', async () => {
    const { editor, service, storage } = await setup(); await editor.openImport();
    await editor.previewImport(await service.getResourceTemplate('xlsx'));
    const file = editor.importFile, preview = editor.importPreview; storage.failWrite = true;
    expect(await editor.confirmImport()).toBe(false); expect(editor.importFile).toBe(file); expect(editor.importPreview).toBe(preview);
    expect((await service.loadPreview()).resources.stations).toHaveLength(132);
    const request = vi.mocked(previewService.applyResourceImport).mock.lastCall![0]; storage.failWrite = false;
    expect(await editor.confirmImport(), editor.error).toBe(true);
    expect(vi.mocked(previewService.applyResourceImport).mock.lastCall![0].requestId).toBe(request.requestId);
    expect((await service.loadPreview()).resources.stations).toHaveLength(133); expect(editor.importFile).toBeNull(); expect(storage.writes).toBe(1);
    expect(await editor.confirmImport()).toBe(false); expect(vi.mocked(previewService.applyResourceImport)).toHaveBeenCalledTimes(2);
    expect(storage.writes).toBe(1);
  });
  it('恢复读取迟到时不能覆盖新会话另一设备的表单',async()=>{
    const {editor,service,read,auth}=await setup();
    const request={context:'ledger' as const,revision:read.workspace!.revision,deviceId:'DV-0001'};
    let finish!:(value:Awaited<ReturnType<typeof service.loadResourceMaintenanceContext>>)=>void;
    vi.mocked(previewService.loadResourceMaintenanceContext).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const pending=editor.applyRestore('DV-0001',{historyId:'old',revision:request.revision,compatible:true,reasons:[],values:{currentWorkMode:'MOCK_FIXED'},changes:[]});
    await vi.waitFor(()=>expect(editor.loading).toBe(true));
    editor.clearForSession();auth.accept({...auth.identity!,sessionId:'new-restore-session'});
    await editor.openForm('DV-0002');const original={...editor.form!.fields};
    finish(await service.loadResourceMaintenanceContext(request));expect(await pending).toBe(false);
    expect(editor.form!.id).toBe('DV-0002');expect(editor.form!.fields).toEqual(original);expect(editor.form!.restoreFrom).toBeUndefined();
  });
  it('新增无修改可直接关闭；字段或下拉变化受保护，完全还原则无需提示', async () => {
    const { editor, storage, preview } = await setup();
    expect(preview.data).toBeNull(); await editor.openForm(); expect(editor.formDirty).toBe(false);
    expect(await editor.closeForm()).toBe(true); expect(editor.decision).toBeNull();
    await editor.openForm(); const id = editor.form!.id;
    editor.form!.fields.stationId = 'ND-0001'; const closing = editor.closeForm(); await tick();
    expect(editor.decision?.title).toBe('设备参数尚未保存'); editor.answer('cancel'); expect(await closing).toBe(false);
    expect(editor.form!.id).toBe(id); editor.form!.fields.stationId = '';
    expect(await editor.closeForm()).toBe(true); expect(storage.writes).toBe(0);
  });
  it('保存失败保留字段并复用请求；成功使旧 GIS 缓存失效并刷新分页', async () => {
    const { editor, service, preview, read } = await setup(); preview.data = await service.loadPreview();
    await editor.openForm('DV-0001'); editor.form!.fields.antennaHeightM = '19';
    vi.mocked(previewService.saveResourceChanges).mockRejectedValueOnce(new Error('临时失败'));
    expect(await editor.save()).toBe(false); expect(editor.form!.fields.antennaHeightM).toBe('19');
    const request = vi.mocked(previewService.saveResourceChanges).mock.lastCall![0];
    expect(await editor.save()).toBe(true);
    expect(vi.mocked(previewService.saveResourceChanges).mock.lastCall![0].requestId).toBe(request.requestId);
    expect(editor.formDirty).toBe(false); expect(read.ledger!.items[0].antennaHeightM).toBe(19);
    expect(preview.data).toBeNull();
  });
  it('批量仅接受当前页目标；取消不写，确认复用原子回执并清楚汇总', async () => {
    const { editor, read, storage } = await setup();
    expect(await editor.setAvailability(['DV-0020'], 'OFF_SHELF')).toBe(false);
    const cancel = editor.setAvailability(['DV-0001', 'DV-0002'], 'OFF_SHELF'); await tick(); editor.answer('cancel'); await cancel;
    expect(storage.writes).toBe(0); expect(editor.message).toContain('2 台未执行');
    const save = editor.setAvailability(['DV-0001', 'DV-0002'], 'OFF_SHELF'); await tick(); editor.answer('save'); expect(await save).toBe(true);
    expect(read.ledger!.items.slice(0, 2).every(d => d.availability === 'OFF_SHELF')).toBe(true);
    expect(editor.message).toBe('成功变更 2 台，失败 0 台，无变化 0 台');
    const unchanged = editor.setAvailability(['DV-0001', 'DV-0002'], 'OFF_SHELF'); await tick(); editor.answer('save'); expect(await unchanged).toBe(true);
    expect(editor.lastChanged).toBe(false); expect(editor.message).toBe('成功变更 0 台，失败 0 台，无变化 2 台');
  });
  it('同一入口显示上下文失败；旧账号迟到结果不能带回表单', async () => {
    const { editor, service, auth } = await setup();
    vi.mocked(previewService.loadResourceMaintenanceContext).mockRejectedValueOnce(new Error('服务未接入'));
    await editor.openForm(); expect(editor.visible).toBe(true); expect(editor.form).toBeNull(); expect(editor.error).toBe('服务未接入');
    let finish!: (value: Awaited<ReturnType<typeof service.loadResourceMaintenanceContext>>) => void;
    vi.mocked(previewService.loadResourceMaintenanceContext).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = editor.retryForm(), request = vi.mocked(previewService.loadResourceMaintenanceContext).mock.lastCall![0];
    editor.stop(); auth.accept({ ...auth.identity!, sessionId: 'other-session' });
    finish(await service.loadResourceMaintenanceContext(request)); await pending;
    expect(editor.form).toBeNull(); expect(editor.error).toBe('');
  });
  it('批量已保存但响应丢失时，重试原事务取回原计数而非再次变更', async () => {
    const { editor, service, storage } = await setup();
    vi.mocked(previewService.updateDeviceAvailability).mockImplementationOnce(async request => { await service.updateDeviceAvailability(request); throw new Error('响应丢失'); });
    const first = editor.setAvailability(['DV-0001'], 'OFF_SHELF'); await tick(); editor.answer('save'); expect(await first).toBe(false);
    const request = vi.mocked(previewService.updateDeviceAvailability).mock.lastCall![0], writes = storage.writes;
    const retry = editor.setAvailability(['DV-0001'], 'OFF_SHELF'); await tick(); editor.answer('save'); expect(await retry).toBe(true);
    expect(vi.mocked(previewService.updateDeviceAvailability).mock.lastCall![0]).toEqual(request);
    expect(storage.writes).toBe(writes); expect(editor.message).toBe('成功变更 1 台，失败 0 台，无变化 0 台');
  });
  it('保存后的迟到刷新不能回写已清理会话，延后放弃也保留表单现场', async () => {
    const { editor, read } = await setup(); await editor.openForm('DV-0001'); editor.form!.fields.antennaHeightM = '19';
    const leaving = editor.leave(true); await tick(); editor.answer('discard'); expect(await leaving).toBe(true); expect(editor.form!.fields.antennaHeightM).toBe('19');
    let finish!: (value: boolean) => void;
    vi.spyOn(read, 'refresh').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = editor.save(); await vi.waitFor(() => expect(read.refresh).toHaveBeenCalled());
    editor.clearForSession(); finish(false); expect(await saving).toBe(false); expect(editor.message).toBe(''); expect(editor.form).toBeNull();
  });
});
