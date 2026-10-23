import { afterEach, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createSSRApp, h, nextTick } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import { createMockService } from '../src/services/mock';
import { httpService } from '../src/services/http';
import { previewService } from '../src/services';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { env } from '../src/config/env';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

const initialMode = env.mode;
let pinia: ReturnType<typeof createPinia>;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); (env as { mode: string }).mode = initialMode; });
function fixture() {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const storage = new TestStorage(), service = createMockService(() => storage);
  for (const key of ['loadResourceReadContext', 'queryResourceDevices', 'queryResourceNodes', 'queryResourceInterferences',
    'getResourceObject', 'queryResourceMap', 'loadGisResourceDirectory','loadGisResourceScene', 'loadGisResourceEditContext', 'saveResourceChanges', 'getGisLinkDetails'] as const) {
    vi.spyOn(previewService, key).mockImplementation(service[key].bind(service) as never);
  }
  return { storage, service, read: useResourceReadStore(), gis: useGisWorkspaceStore(), editor: useResourceEditStore() };
}

it('历史恢复只应用原 GIS 草稿，一步撤销重做并统一保存为新版本',async()=>{
  const s=fixture();
  const first=await s.service.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_FIXED'}]});
  const second=await s.service.saveResourceChanges({baseRevision:first.revision,stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_HOPPING'}]});
  await s.read.activate('gis');s.gis.start();await vi.waitFor(()=>expect(s.gis.sceneLoading).toBe(false));await s.gis.begin();
  const query={context:'gis' as const,deviceId:'DV-0001',revision:second.readRevision},history=await s.service.queryDeviceHistory({...query,pageNum:1,pageSize:20}),target=history.items[1].id;
  const value=await s.service.previewDeviceRestore({...query,historyId:target});expect(await s.editor.applyRestore(query.deviceId,value)).toBe(true);expect(s.storage.writes).toBe(2);expect(s.gis.undoStack).toHaveLength(1);
  await s.gis.moveHistory('undo');expect(s.editor.resources.devices[0].currentWorkMode).toBe('MOCK_HOPPING');
  await s.gis.moveHistory('redo');expect(s.editor.resources.devices[0].currentWorkMode).toBe('MOCK_FIXED');
  expect(await s.gis.save()).toBe(true);expect(s.storage.writes).toBe(3);
  const current=await s.service.loadResourceReadContext({context:'gis'}),saved=await s.service.queryDeviceHistory({...query,revision:current.revision,pageNum:1,pageSize:20});
  expect(saved.total).toBe(4);expect(saved.items[0].restoredFrom).toBe(target);expect(saved.items[0].source).toBe('历史恢复');
});

it('轻目录、独立地图与完整编辑绑定同一版本，详情按 ID 读取且不写存储', async () => {
  const s = fixture(); await s.read.activate('gis'); const revision = s.read.workspace!.revision;
  const scene = await s.service.loadGisResourceScene({ context: 'gis', revision });
  const edit = await s.service.loadGisResourceEditContext({ context: 'gis', revision });
  const directory = await s.service.loadGisResourceDirectory({ context: 'gis', revision });
  expect(directory.resources.devices.map(row => row.id)).toEqual(edit.resources.devices.map(row => row.id));
  expect(directory.resources.devices[0]).not.toHaveProperty('txPowerDbm');
  expect(scene).not.toHaveProperty('resources'); expect(scene).not.toHaveProperty('deviceDetails');
  expect(scene.map.devices).toHaveLength(edit.resources.devices.length);
  expect(scene.map.devices[0]).not.toHaveProperty('txPowerDbm');
  const detail = await s.service.getResourceObject({ context: 'gis', revision, kind: 'device', id: directory.resources.devices[0].id });
  expect(detail.object).toHaveProperty('txPowerDbm', edit.resources.devices[0].txPowerDbm);
  expect(edit.baseRevision).toBe(scene.resourceMeta.revision);
  expect(edit.resources.devices.length).toBeGreaterThan(10); expect(s.storage.writes).toBe(0);
  await s.service.commitResources({ context: 'gis', baseRevision: edit.baseRevision, requestId: 'context-change', stations: [{ id: 'ND-0001', name: '新保存名称' }], devices: [] });
  await expect(s.service.loadGisResourceEditContext({ context: 'gis', revision })).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CHANGED' });
});

it('富资料读取失败保留公共浏览，独立完整编辑基线仍能加载', async () => {
  const s = fixture(); await s.read.activate('gis');
  vi.spyOn(previewService, 'loadGisResourceScene').mockRejectedValue(new Error('展示资料不可用'));
  await s.gis.loadScene(); expect(s.gis.sceneError).toBe('展示资料不可用'); expect(s.gis.scene).toBeNull();
  expect(s.read.frame).not.toBeNull(); expect(s.read.workspace).not.toBeNull();
  expect(await s.gis.begin()).toBe(true); expect(s.editor.base!.devices.length).toBeGreaterThan(10);
  expect(previewService.queryResourceNodes).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(0);
});

it('清理后迟到的完整上下文不能进入新会话', async () => {
  const s = fixture(); await s.read.activate('gis');
  const scene = await s.service.loadGisResourceScene({ context: 'gis', revision: s.read.workspace!.revision });
  let resolve!: (value: typeof scene) => void;
  vi.spyOn(previewService, 'loadGisResourceScene').mockImplementation(() => new Promise(done => { resolve = done; }));
  const loading = s.gis.loadScene(); s.gis.clearForSession(); resolve(scene); await loading;
  expect(s.gis.scene).toBeNull(); expect(s.gis.sceneLoading).toBe(false);
});

it('保存已提交但刷新期间清理会话时，不批准旧离开决定', async () => {
  const s = fixture(); await s.read.activate('gis'); await s.gis.begin();
  s.editor.resources.stations[0].name = '已保存的新名称';
  let resolve!: (value: boolean) => void;
  vi.spyOn(s.read, 'refresh').mockImplementation(() => new Promise(done => { resolve = done; }));
  const saving = s.gis.save(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  s.gis.clearForSession(); resolve(false);
  expect(await saving).toBe(false); expect(s.storage.writes).toBe(1);
});

it('HTTP 未接入的完整服务显式失败，不调用 Mock 或替换基础数据', async () => {
  const s = fixture(); await s.read.activate('gis'); const request = { context: 'gis' as const, revision: s.read.workspace!.revision };
  await expect(httpService.loadGisResourceDirectory(request)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  await expect(httpService.loadGisResourceScene(request)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  await expect(httpService.loadGisResourceEditContext(request)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  expect(previewService.loadGisResourceScene).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(0);
});

// 用同一业务响应渲染真实模板，验证来源切换不改变控件和操作入口。
it('绑定相同业务数据时，Mock 与 HTTP 渲染相同 GIS 页面', async () => {
  const outputs: string[] = [];
  for (const mode of ['mock', 'http']) {
    (env as { mode: string }).mode = mode;
    const s = fixture(); await s.read.activate('gis'); await s.gis.loadScene(); await nextTick();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/situation', component: SituationView }] });
    await router.push('/situation');
    outputs.push(await renderToString(createSSRApp({ render: () => h(RouterView) }).use(pinia).use(router)));
    disposePinia(pinia); vi.restoreAllMocks();
  }
  expect(outputs[0]).toBe(outputs[1]);
  for (const label of ['编辑资源', '分类筛选', '任务查看', '故障标绘', '图层管理']) expect(outputs[0]).toContain(label);
});
