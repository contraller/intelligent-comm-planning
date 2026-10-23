import { savedRequest,taskMeta } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { toRaw } from 'vue';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useAuthStore } from '../src/stores/auth';
import { applyChanges, assertValid, validateResources } from '../src/services/resource-validation';
import type { ResourceChanges } from '../src/types/resource-edit';
import { TestStorage } from './helpers/storage';
import { createPlanningMock } from '../src/services/planning-mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { PLANNING_STORAGE_KEY } from '../src/config/demo';

let storage: TestStorage;
beforeEach(() => {
  vi.restoreAllMocks();
  setActivePinia(createPinia()); authorizeStore();
  storage = new TestStorage();
  const service = createMockService(() => storage);
  vi.spyOn(previewService, 'loadPreview').mockImplementation(service.loadPreview);
  vi.spyOn(previewService, 'commitResources').mockImplementation(service.commitResources);
  vi.spyOn(previewService, 'resetResources').mockImplementation(service.resetResources);
});
async function setup(mode: 'gis' | 'ledger' = 'gis') {
  const preview = usePreviewStore();
  await preview.load();
  const editor = useResourceEditStore();
  editor.begin(mode);
  return { preview, editor };
}

// 取点仅填表单，应用、历史和保存由原工作流完成。
describe('GIS 吸附回填与来源提示', () => {
  it.each(['station', 'interference'] as const)('%s 只改坐标并保留六位小数，应用后才进入撤销历史', async kind => {
    const { editor } = await setup();
    const rows = kind === 'station' ? editor.resources.stations : editor.resources.interferences!;
    await editor.openForm(kind, rows[0]!.id, 'gis');
    const form = editor.form!, fields = { ...form.fields }, before = JSON.stringify(editor.resources);
    const point: [number, number] = [114.6500004, 37.5000004]; editor.picking = true;
    editor.pickGis(point, form, { kind: 'station', id: 'REF', name: '参考点', coordinate: point });
    expect(form.fields).toEqual({ ...fields, longitude: '114.650000', latitude: '37.500000' });
    expect(editor.pickNotice).toContain('REF'); expect(editor.pickNotice).toContain('尚未应用');
    expect(editor.picking).toBe(false); expect(editor.undoStack).toHaveLength(0);
    expect(JSON.stringify(editor.resources)).toBe(before); expect(storage.writes).toBe(0);
    expect(editor.applyForm(), editor.error).toBe(true); expect(editor.pickNotice).toBe('');
    expect(editor.undoStack).toHaveLength(1); const applied = JSON.stringify(editor.resources);
    await editor.moveHistory('undo'); expect(JSON.stringify(editor.resources)).toBe(before);
    await editor.moveHistory('redo'); expect(JSON.stringify(editor.resources)).toBe(applied);
  });
  it.each(['manual', 'repick', 'form', 'session', 'close'] as const)('%s 清理旧来源提示', async reason => {
    const { editor } = await setup(); await editor.openForm('station', 'ND-0001', 'gis'); editor.picking = true;
    editor.pickGis([114.65, 37.5], editor.form!, { kind: 'station', id: 'R', name: '参考', coordinate: [114.65, 37.5] });
    expect(editor.pickNotice).not.toBe('');
    if (reason === 'manual') editor.form!.fields.longitude = '114.66';
    if (reason === 'repick') editor.picking = true;
    if (reason === 'form') editor.form = { ...editor.form! };
    if (reason === 'session') useAuthStore().identity!.sessionId = 'new-session';
    if (reason === 'close') editor.clearSession();
    expect(editor.pickNotice).toBe('');
  });
  it('旧表单实例、失权、忙碌、非法坐标均不能写入；取消不改变字段', async () => {
    const { editor, preview } = await setup(); await editor.openForm('station', 'ND-0001', 'gis');
    const old = editor.form!; editor.form = { ...old, fields: { ...old.fields } }; editor.picking = true;
    const before = { ...editor.form!.fields };
    editor.pickGis([114.65, 37.5], old); editor.pickGis([NaN, 37], editor.form!);
    preview.busy = true; editor.pickGis([114.65, 37.5], editor.form!); preview.busy = false;
    useAuthStore().identity!.permissions = []; editor.pickGis([114.65, 37.5], editor.form!);
    editor.picking = false; expect(editor.form!.fields).toEqual(before); expect(editor.pickNotice).toBe('');
  });
  it('自由取点不钳制区域外坐标，保存失败保留原输入和历史', async () => {
    const { editor } = await setup(); await editor.openForm('station', 'ND-0001', 'gis'); editor.picking = true;
    editor.pickGis([10, 10], editor.form!);
    expect(editor.form!.fields.longitude).toBe('10.000000'); expect(editor.pickNotice).toBe('');
    expect(await editor.save()).toBe(false); expect(editor.form!.fields.latitude).toBe('10.000000');
    expect(editor.undoStack).toHaveLength(0); expect(storage.writes).toBe(0);
  });
});

describe('字段与原始差异校验', () => {
  it('识别全部 373 条来源差异；修改其他字段仍可保存，空频率仍为空', async () => {
    const { preview, editor } = await setup('ledger');
    const source = toRaw(preview.data!.resources);
    expect(validateResources(source, source, source).warnings).toHaveLength(373);
    expect(validateResources(source, source, source).issues).toEqual([]);
    await editor.openForm('device', 'DV-0001', 'ledger');
    editor.form!.fields.antennaHeightM = '11';
    expect(await editor.save(),editor.error).toBe(true);
    expect(preview.data!.resources.devices[0]).toMatchObject({
      antennaHeightM: 11,
      txPowerDbm: 51.8,
      workFreqKhz: null,
    });
  });
  it('修改功率不能超过上限；保存合法值后不能恢复超限来源值', async () => {
    const { preview, editor } = await setup('ledger');
    await editor.openForm('device', 'DV-0001', 'ledger');
    editor.form!.fields.txPowerDbm = '51.79';
    expect(await editor.save()).toBe(false);
    expect(editor.issues).toContainEqual(
      expect.objectContaining({ objectId: 'DV-0001', field: 'txPowerDbm' }),
    );
    editor.form!.fields.txPowerDbm = '51.76';
    expect(await editor.save()).toBe(true);
    editor.form!.fields.txPowerDbm = '51.8';
    expect(await editor.save()).toBe(false);
    expect(preview.data!.resources.devices[0].txPowerDbm).toBe(51.76);
  });
  it.each([
    ['antennaHeightM', ''],
    ['antennaHeightM', '-1'],
    ['antennaHeightM', 'Infinity'],
    ['txPowerDbm', ''],
    ['workFreqKhz', '0'],
    ['workFreqKhz', 'NaN'],
    ['workFreqKhz', '999999999'],
  ])('设备非法字段 %s=%s 保留输入并阻止保存', async (key, value) => {
    const { preview, editor } = await setup('ledger');
    await editor.openForm('device', 'DV-0001', 'ledger');
    editor.form!.fields[key] = value;
    expect(await editor.save()).toBe(false);
    expect(editor.form!.fields[key]).toBe(value);
    expect(editor.issues.some((issue) => issue.field === key)).toBe(true);
    expect(preview.data!.resourceMeta.revision).toBe('initial');
    expect(storage.writes).toBe(0);
  });
  it('不虚构最小功率，合法负值与非空频率允许保存', async () => {
    const { preview, editor } = await setup('ledger');
    await editor.openForm('device', 'DV-0001', 'ledger');
    const device = preview.data!.resources.devices[0];
    const model = preview.data!.resources.models.find((row) => row.id === device.modelId)!;
    editor.form!.fields.txPowerDbm = '-1';
    editor.form!.fields.workFreqKhz = String(model.freqMinKhz);
    expect(await editor.save()).toBe(true);
    expect(preview.data!.resources.devices[0].txPowerDbm).toBe(-1);
    expect(preview.data!.resources.devices[0].workFreqKhz).toBe(model.freqMinKhz);
  });
  it.each([
    ['name', '   '],
    ['name', '名'.repeat(61)],
    ['region', '区'.repeat(61)],
    ['longitude', ''],
    ['longitude', '114.0464999'],
    ['latitude', '40'],
    ['elevationM', 'NaN'],
  ])('节点非法字段 %s 阻止应用和保存', async (key, value) => {
    const { editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields[key] = value;
    expect(editor.applyForm()).toBe(false);
    expect(await editor.save()).toBe(false);
    expect(editor.undoStack).toHaveLength(0);
    expect(storage.writes).toBe(0);
  });
  it('名称去空白、六位坐标、可空高程/区域，不改变身份', async () => {
    const { preview, editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    Object.assign(editor.form!.fields, {
      name: ' 新名称 ',
      longitude: '114.12345678',
      latitude: '37.12345678',
      elevationM: '',
      region: '',
    });
    expect(await editor.save()).toBe(true);
    expect(preview.data!.resources.stations[0]).toMatchObject({
      id: 'ND-0001',
      name: '新名称',
      coordinate: [114.123457, 37.123457],
      elevationM: null,
      region: '',
    });
  });
  it('拒绝未知/重复 ID、只读字段、关联替换，完整集合仍校验', async () => {
    const { preview } = await setup();
    const source = toRaw(preview.data!.resources);
    for (const devices of [
      [{ id: 'BAD', antennaHeightM: 1 }],
      [{ id: 'DV-0001', stationId: 'ND-0002' }],
      [{ id: 'DV-0001' }, { id: 'DV-0001' }],
    ]) {
      expect(() => applyChanges(source, { stations: [], devices } as ResourceChanges)).toThrow();
    }
    const invalid = structuredClone(source);
    invalid.devices[10].modelId = 'MISSING';
    expect(() => assertValid(invalid, source, source)).toThrow();
  });
});


describe('GIS 校验错误表单定位保护',()=>{
  it('当前表单直接聚焦，不校验或覆盖非法输入，错误清单保留',async()=>{
    const {editor}=await setup();await editor.openForm('device','DV-0001','gis');
    editor.form!.fields.antennaHeightM='错误';expect(editor.applyForm()).toBe(false);
    const before=JSON.stringify(editor.form),issues=JSON.stringify(editor.issues);
    expect(await editor.focusGisIssue('device','DV-0001','antennaHeightM')).toBe(true);
    expect(JSON.stringify(editor.form)).toBe(before);expect(JSON.stringify(editor.issues)).toBe(issues);
    expect(editor.issueFocus).toMatchObject({id:'DV-0001',field:'antennaHeightM'});expect(editor.decision).toBeNull();
  });
  it('尚未应用的新建对象保留同一表单，退出取点后可以修正字段',async()=>{
    const {editor}=await setup();await editor.newForm('station','gis');const id=editor.form!.id;
    const before=JSON.stringify(editor.form);expect(await editor.focusGisIssue('station',id,'longitude')).toBe(true);
    expect(JSON.stringify(editor.form)).toBe(before);expect(editor.picking).toBe(false);
    expect(editor.resources.stations.some(row=>row.id===id)).toBe(false);
  });
  it.each(['cancel','save','discard'] as const)('切换对象处理原输入：%s',async(choice)=>{
    const {editor}=await setup();await editor.openForm('device','DV-0001','gis');editor.form!.fields.antennaHeightM='18';
    const pending=editor.focusGisIssue('device','DV-0002','txPowerDbm');
    expect(editor.decision).not.toBeNull();editor.answer(choice);
    expect(await pending).toBe(choice!=='cancel');
    expect(editor.form!.id).toBe(choice==='cancel'?'DV-0001':'DV-0002');
    if(choice==='cancel'){expect(editor.form!.fields.antennaHeightM).toBe('18');expect(editor.issueFocus).toBeNull();}
    expect(editor.resources.devices[0]!.antennaHeightM===18).toBe(choice==='save');
  });
  it('应用失败保留原表单，不能跳到另一设备',async()=>{
    const {editor}=await setup();await editor.openForm('device','DV-0001','gis');editor.form!.fields.antennaHeightM='bad';
    const pending=editor.focusGisIssue('device','DV-0002','txPowerDbm');editor.answer('save');
    expect(await pending).toBe(false);expect(editor.form!.id).toBe('DV-0001');expect(editor.issueFocus).toBeNull();
  });
  it('确认期间定位意图失效时不打开目标，原草稿保存选择仍按用户决定处理',async()=>{
    const {editor}=await setup();await editor.openForm('device','DV-0001','gis');editor.form!.fields.antennaHeightM='18';
    let current=true;const pending=editor.focusGisIssue('device','DV-0002','txPowerDbm',()=>current);
    current=false;editor.answer('discard');expect(await pending).toBe(false);expect(editor.form!.id).toBe('DV-0001');
  });
  it('台账不接受 GIS 定位入口；关闭与清理使旧聚焦请求失效',async()=>{
    const {editor}=await setup('ledger');await editor.openForm('device','DV-0001','ledger');
    expect(await editor.focusGisIssue('device','DV-0001','txPowerDbm')).toBe(false);expect(editor.issueFocus).toBeNull();
    editor.clearSession();editor.begin('gis');await editor.openForm('device','DV-0001','gis');
    await editor.focusGisIssue('device','DV-0001','txPowerDbm');await editor.closeForm();expect(editor.issueFocus).toBeNull();
  });
});

describe('草稿、单条保存与关联历史', () => {
  it('应用两对象逐步撤销/重做；无变化不加历史；撤销后编辑清空重做', async () => {
    const { preview, editor } = await setup();
    const initial = preview.data!.resources.stations[0].name;
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '节点草稿';
    expect(editor.applyForm()).toBe(true);
    expect(editor.applyForm()).toBe(true);
    expect(editor.undoStack).toHaveLength(1);
    expect(preview.data!.resources.stations[0].name).toBe(initial);
    await editor.openForm('device', 'DV-0001', 'gis');
    editor.form!.fields.antennaHeightM = '11';
    editor.applyForm();
    expect(editor.undoStack).toHaveLength(2);
    await editor.moveHistory('undo');
    expect(editor.resources.devices[0].antennaHeightM).toBe(
      preview.data!.resources.devices[0].antennaHeightM,
    );
    await editor.moveHistory('redo');
    expect(editor.resources.devices[0].antennaHeightM).toBe(11);
    await editor.moveHistory('undo');
    editor.form!.fields.antennaHeightM = '12';
    editor.applyForm();
    expect(editor.redoStack).toHaveLength(0);
    expect(await editor.save()).toBe(true);
    expect(editor.undoStack).toHaveLength(0);
    expect(preview.data!.resources.devices[0].antennaHeightM).toBe(12);
    expect(preview.data!.resources.stations[0].name).toBe('节点草稿');
  });
  it('整批保存包含未应用表单；任一字段失败则全部不提交并保留历史', async () => {
    const { preview, editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '待存节点';
    editor.applyForm();
    await editor.openForm('device', 'DV-0001', 'gis');
    editor.form!.fields.antennaHeightM = '-1';
    expect(await editor.save()).toBe(false);
    expect(preview.data!.resourceMeta.revision).toBe('initial');
    expect(editor.undoStack).toHaveLength(1);
    expect(editor.draftDirty).toBe(true);
    expect(editor.formDirty).toBe(true);
    editor.form!.fields.antennaHeightM = '13';
    expect(await editor.save()).toBe(true);
    expect(storage.writes).toBe(1);
    expect(preview.data!.resources.stations[0].name).toBe('待存节点');
    expect(preview.data!.resources.devices[0].antennaHeightM).toBe(13);
    expect(editor.dirty).toBe(false);
  });
  it('失败保存保留未应用输入、已应用草稿、历史和版本；可修复后重试', async () => {
    const { preview, editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '草稿';
    editor.applyForm();
    editor.form!.fields.region = '尚未应用';
    const snapshot = JSON.stringify({
      draft: editor.draft,
      form: editor.form,
      undo: editor.undoStack,
    });
    storage.failWrite = true;
    expect(await editor.save()).toBe(false);
    expect(JSON.stringify({ draft: editor.draft, form: editor.form, undo: editor.undoStack })).toBe(
      snapshot,
    );
    expect(preview.data!.resourceMeta.revision).toBe('initial');
    expect(editor.error).toContain('存储');
    storage.failWrite = false;
    expect(await editor.save()).toBe(true);
  });
  it('台账仅修改当前设备，立即共享给 GIS，历史快照和诊断保持原样', async () => {
    const { preview, editor } = await setup('ledger');
    const before = structuredClone(toRaw(preview.data!));
    await editor.openForm('device', 'DV-0001', 'ledger');
    editor.form!.fields.antennaHeightM = '15';
    expect(await editor.save()).toBe(true);
    expect(preview.data!.resources.devices.slice(1)).toEqual(before.resources.devices.slice(1));
    expect(preview.data!.resources.stations).toEqual(before.resources.stations);
    expect(preview.data!.planning.plans[0].sourceChanged).toBe(true);
    for (const [index, plan] of preview.data!.planning.plans.entries())
      expect({ ...plan, sourceChanged: before.planning.plans[index].sourceChanged }).toEqual(
        before.planning.plans[index],
      );
    expect(preview.data!.diagnosis).toEqual(before.diagnosis);
    await editor.closeForm();
    editor.begin('gis');
    expect(editor.resources.devices[0].antennaHeightM).toBe(15);
    const restored = await createMockService(() => storage).loadPreview();
    expect(restored.planning).toEqual(preview.data!.planning);
  });
  it('无关资源不新增方案影响，已存在标记保留，手工改回仍保留影响', async () => {
    const { preview, editor } = await setup();
    const original = preview.data!.resources.stations[0].name;
    await editor.openForm('station', 'ND-0132', 'gis');
    editor.form!.fields.region = '无关对象';
    await editor.save();
    expect(preview.data!.planning.plans.map((p) => p.sourceChanged)).toEqual([false, true]);
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '关联对象';
    await editor.save();
    editor.form!.fields.name = original;
    await editor.save();
    expect(preview.data!.planning.plans[0].sourceChanged).toBe(true);
    expect(preview.data!.resourceMeta.changedStationIds).toContain('ND-0001');
    await preview.reset();
    editor.clearSession();
    expect(preview.data!.planning.plans.map((p) => p.sourceChanged)).toEqual([false, true]);
    expect(preview.data!.resourceMeta.changedStationIds).toEqual([]);
  });
  it('保存中的重复提交被拦截，只写一次', async () => {
    const { editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '一次';
    const first = editor.save();
    const second = editor.save();
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(storage.writes).toBe(1);
  });
  it('版本冲突保留表单和草稿，外部记录不被覆盖', async () => {
    const { preview, editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '旧输入';
    await createMockService(() => storage).commitResources({
      baseRevision: 'initial',
      stations: [{ id: 'ND-0001', name: '另一标签' }],
      devices: [],
    });
    expect(await editor.save()).toBe(false);
    expect(editor.error).toContain('重新加载');
    expect(editor.form!.fields.name).toBe('旧输入');
    expect(preview.data!.resourceMeta.revision).toBe('initial');
    expect(storage.writes).toBe(1);
  });
});

describe('未保存决定与重置保护', () => {
  it('资源 store 保存和重置使新方案失效，但保留规划记录与诊断快照', async () => {
    const { preview, editor } = await setup();
    let time = 1000;
    const service = createPlanningMock(
      () => storage,
      () => ({
        resources: toRaw(preview.data!.resources),
        meta: {...toRaw(preview.data!.resourceMeta),taskWorkspace:taskMeta(storage)},
      }),
      () => time,
    );
    const submitted = await service.submitPlanning(await savedRequest(storage,{
      baseRevision: 'initial',
      requestId: 'input',
      taskId: null,
      parentPlanVersionId: null,
      input: structuredClone(planningPresets[0].input),
    }));
    time += 10000;
    const saved = await service.savePlanVersion({
      baseRevision: submitted.workspace.revision,
      requestId: 'save',
      jobId: submitted.view.job.id,
      name: '新方案',
      note: '',
    });
    preview.data!.resourceMeta.taskWorkspace=taskMeta(storage);
    preview.mergePlanning(saved.workspace.plans);
    const sourceSnapshot = JSON.stringify(preview.data!.planning.plans.at(-1)!.inputSnapshot);
    const diagnosisSnapshot = JSON.stringify(preview.data!.diagnosis);
    const planningRecord = storage.getItem(PLANNING_STORAGE_KEY);
    await editor.openForm('station', 'ND-0132', 'gis');
    editor.form!.fields.name = '无关对象';
    await editor.save();
    expect(preview.data!.planning.plans.at(-1)!.sourceChanged).toBe(false);
    await editor.openForm('device', 'DV-0001', 'gis');
    editor.form!.fields.antennaHeightM = '13';
    await editor.save();
    expect(preview.data!.planning.plans.at(-1)!.sourceChanged).toBe(true);
    await preview.reset();
    editor.clearSession();
    expect(preview.data!.planning.plans.map((p) => p.sourceChanged)).toEqual([false, true, true]);
    expect(storage.getItem(PLANNING_STORAGE_KEY)).toBe(planningRecord);
    expect(JSON.stringify(preview.data!.planning.plans.at(-1)!.inputSnapshot)).toBe(sourceSnapshot);
    expect(JSON.stringify(preview.data!.diagnosis)).toBe(diagnosisSnapshot);
  });
  it('关闭表单取消/放弃仅处理当前输入，保留已应用 GIS 草稿', async () => {
    const { editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '已应用';
    editor.applyForm();
    editor.form!.fields.name = '未应用';
    const cancel = editor.closeForm();
    editor.answer('cancel');
    expect(await cancel).toBe(false);
    expect(editor.form!.fields.name).toBe('未应用');
    const discard = editor.closeForm();
    editor.answer('discard');
    expect(await discard).toBe(true);
    expect(editor.form).toBeNull();
    expect(editor.resources.stations[0].name).toBe('已应用');
    expect(editor.undoStack).toHaveLength(1);
  });
  it('切换对象前应用输入，校验失败保持原对象；撤销前可放弃输入', async () => {
    const { editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '';
    const failed = editor.openForm('device', 'DV-0001', 'gis');
    editor.answer('save');
    expect(await failed).toBe(false);
    expect(editor.form!.id).toBe('ND-0001');
    editor.form!.fields.name = '已应用';
    const next = editor.openForm('device', 'DV-0001', 'gis');
    editor.answer('save');
    expect(await next).toBe(true);
    editor.form!.fields.antennaHeightM = '17';
    const undo = editor.moveHistory('undo');
    editor.answer('discard');
    await undo;
    expect(editor.undoStack).toHaveLength(0);
    expect(editor.redoStack).toHaveLength(1);
    expect(editor.dirty).toBe(false);
  });
  it('离开时保存包括未应用输入；写入失败留在编辑，放弃不改已存资源', async () => {
    const { preview, editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '离开保存';
    storage.failWrite = true;
    const fail = editor.leave();
    editor.answer('save');
    expect(await fail).toBe(false);
    expect(editor.context).toBe('gis');
    storage.failWrite = false;
    const success = editor.leave();
    editor.answer('save');
    expect(await success).toBe(true);
    expect(preview.data!.resources.stations[0].name).toBe('离开保存');
    expect(editor.context).toBeNull();
    editor.begin('gis');
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '丢弃';
    const discard = editor.leave();
    editor.answer('discard');
    expect(await discard).toBe(true);
    expect(preview.data!.resources.stations[0].name).toBe('离开保存');
  });
  it('台账关闭选择保存仅提交当前设备，无修改保存不升版', async () => {
    const { editor, preview } = await setup('ledger');
    await editor.openForm('device', 'DV-0001', 'ledger');
    expect(await editor.save()).toBe(true);
    expect(editor.message).toBe('没有需要保存的修改');
    expect(storage.writes).toBe(0);
    editor.form!.fields.antennaHeightM = '14';
    const close = editor.closeForm();
    editor.answer('save');
    expect(await close).toBe(true);
    expect(preview.data!.resources.devices[0].antennaHeightM).toBe(14);
    expect(editor.context).toBeNull();
    expect(storage.writes).toBe(1);
  });
  it('重置失败保持表单历史；成功恢复资源且保留其他模块对象内容', async () => {
    const { editor, preview } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '草稿';
    editor.applyForm();
    preview.data!.knowledge.entities[0].description = '其他模块状态';
    storage.failWrite = true;
    await expect(preview.reset()).rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED' });
    expect(editor.resources.stations[0].name).toBe('草稿');
    expect(editor.undoStack).toHaveLength(1);
    storage.failWrite = false;
    await preview.reset();
    editor.clearSession();
    expect(editor.dirty).toBe(false);
    expect(preview.data!.knowledge.entities[0].description).toBe('其他模块状态');
  });
  it('未保存草稿不写入存储；刷新只恢复成功保存的数据', async () => {
    const { preview, editor } = await setup();
    await editor.openForm('station', 'ND-0001', 'gis');
    editor.form!.fields.name = '不持久化';
    editor.applyForm();
    const reloaded = await createMockService(() => storage).loadPreview();
    expect(reloaded.resources).toEqual(preview.data!.resources);
    expect(storage.writes).toBe(0);
  });
});

// 新对象表单共享旧草稿事务，不为每次应用另建身份。
describe('新建资源草稿',()=>{
  it('候选编辑保留服务结果到保存，草稿撤销重做不暂停旧结果',async()=>{
    const {editor,preview}=await setup(),before=structuredClone(toRaw(preview.data!)),link=before.resources.candidateLinks![0]!;
    expect(await editor.openForm('candidate',link.id,'gis')).toBe(true);
    editor.form!.fields.bandwidthKhz=String((link.bandwidthKhz??1)+1);
    expect(editor.dirty).toBe(true);expect(editor.resultsDirty).toBe(false);
    expect(editor.applyForm(),editor.error).toBe(true);
    expect(editor.resources.candidateLinks![0]!.assessmentState).toBe('REFERENCE');
    expect(editor.resources.candidateLinks![0]!.distanceM).toBe(link.distanceM);
    await editor.moveHistory('undo');expect(editor.resources.candidateLinks![0]).toEqual(link);
    await editor.moveHistory('redo');expect(editor.resultsDirty).toBe(false);
    storage.failWrite=true;const draft=JSON.stringify(editor.draft);
    expect(await editor.save()).toBe(false);expect(JSON.stringify(editor.draft)).toBe(draft);
    storage.failWrite=false;expect(await editor.save(),editor.error).toBe(true);
    expect(preview.data!.resources.candidateLinks![0]).toMatchObject({assessmentState:'PENDING',distanceM:null,reference:link.reference});
    expect(preview.data!.planning).toEqual(before.planning);expect(preview.data!.diagnosis).toEqual(before.diagnosis);
    expect(preview.data!.resourceMeta.resourceEpoch).toBe(before.resourceMeta.resourceEpoch);
    expect(editor.dirty).toBe(false);
  });
  it('新候选只填写配置，不进入地图取点，台账拒绝候选表单',async()=>{
    const {editor}=await setup();expect(await editor.newForm('candidate','gis')).toBe(true);
    expect(editor.picking).toBe(false);expect(editor.form!.fields).not.toHaveProperty('distanceM');
    const id=editor.form!.id;expect(editor.applyForm()).toBe(false);expect(editor.form!.id).toBe(id);
    editor.clearSession();editor.begin('ledger');
    expect(await editor.newForm('candidate','ledger')).toBe(false);
    expect(await editor.openForm('candidate','LK-0001','ledger')).toBe(false);
  });
  it('取点后空站点应用、撤销关闭失效表单，重做恢复同一 ID',async()=>{
    const {editor,preview}=await setup();
    expect(await editor.newForm('station','gis')).toBe(true);
    const id=editor.form!.id;expect(editor.picking).toBe(true);
    editor.pick([114.65,37.5]);editor.form!.fields.name='空站点';
    expect(editor.picking).toBe(false);expect(editor.applyForm()).toBe(true);
    expect(editor.resources.stations.at(-1)?.id).toBe(id);expect(editor.formDirty).toBe(false);
    await editor.moveHistory('undo');expect(editor.form).toBeNull();expect(editor.resources.stations.some(s=>s.id===id)).toBe(false);
    await editor.moveHistory('redo');expect(editor.resources.stations.at(-1)?.id).toBe(id);
    expect(await editor.save(),editor.error).toBe(true);expect(preview.data!.resources.stations.at(-1)?.id).toBe(id);
  });
  it('干扰源必填失败保留输入；应用后可撤销并更新干扰版本',async()=>{
    const {editor,preview}=await setup();await editor.newForm('interference','gis');
    const id=editor.form!.id;editor.pick([114.6,37.5]);editor.form!.fields.name='新干扰源';
    expect(editor.applyForm()).toBe(false);expect(editor.form!.id).toBe(id);
    Object.assign(editor.form!.fields,{antennaHeightM:'2',centerFreqKhz:'5000',bandwidthKhz:'10',txPowerDbm:'20'});
    expect(editor.applyForm()).toBe(true);expect(editor.resources.interferences).toHaveLength(17);
    await editor.moveHistory('undo');expect(editor.resources.interferences).toHaveLength(16);
    await editor.moveHistory('redo');expect(await editor.save(),editor.error).toBe(true);
    expect(preview.data!.resourceMeta.changedInterferenceIds).toContain(id);
  });
});
