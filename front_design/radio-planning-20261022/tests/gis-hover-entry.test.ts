import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import type View from 'ol/View';
import type Feature from 'ol/Feature';
import type BaseLayer from 'ol/layer/Base';
import VectorLayer from 'ol/layer/Vector';
import Cluster from 'ol/source/Cluster';
import { get as projection, fromLonLat } from 'ol/proj';
import MapCanvas from '../src/components/MapCanvas.vue';
import GisHoverPreview from '../src/components/GisHoverPreview.vue';
import { initialResources } from '../src/mocks/resource-presets';
import { gisDevicePoints, defaultGisDeviceSettings, type GisDeviceMapFrame } from '../src/maps/gis-device-display';
import type { GisHoverContext } from '../src/maps/gis-hover';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { usePreviewStore } from '../src/stores/preview';
import { useAuthStore } from '../src/stores/auth';
import { bindMonitoring, settleMonitoring } from './helpers/monitoring';
// 仅复用模板编译，原有特殊宿主和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';
import { coverageV5Case } from './helpers/frozen-coverage';
import type { FrozenCoverageOverlay } from '../src/types/frozen-coverage';

interface MapEvent { pixel: number[]; coordinate: number[]; dragging?: boolean }
interface Probe { view: View; layers: BaseLayer[]; picked?: Feature; coordinate?:number[]; handlers: Map<string, ((event: MapEvent) => void)[]>; dispose: ReturnType<typeof vi.fn> }
const probes = vi.hoisted(() => ({ maps: [] as Probe[], resize: undefined as (() => void) | undefined }));
// 仅替换依赖 DOM 的地图外壳；真实聚合源、要素、View 和客户端模板参与验证。
vi.mock('ol/Map', () => ({ default: class implements Probe {
  view: View; layers: BaseLayer[] = []; picked?: Feature; coordinate?:number[]; handlers = new Map<string, ((event: MapEvent) => void)[]>();
  dispose = vi.fn();
  constructor(options: { view: View }) { this.view = options.view; vi.spyOn(this.view, 'fit').mockImplementation(() => {}); probes.maps.push(this); }
  getView() { return this.view; } getSize() { return [960, 640]; } updateSize() {}
  getCoordinateFromPixel() { return this.coordinate??[0,0]; }
  getViewport() { return { addEventListener() {}, removeEventListener() {} }; }
  setLayers(layers: BaseLayer[]) { this.layers = layers; }
  getLayers() { return {getArray:()=>this.layers}; }
  addLayer(layer: BaseLayer) { this.layers.push(layer); }
  removeLayer(layer: BaseLayer) { this.layers=this.layers.filter(value=>value!==layer); }
  on(type: string, fn: (event: MapEvent) => void) { this.handlers.set(type, [...this.handlers.get(type) ?? [], fn]); }
  forEachFeatureAtPixel(_pixel: number[], fn: (feature: Feature,layer?:BaseLayer) => unknown) { if (this.picked) return fn(this.picked,this.layers.find(layer=>layer instanceof VectorLayer&&layer.getSource()?.hasFeature(this.picked!))); }
} }));
vi.mock('ol/control', () => ({ defaults: () => ({ extend: () => [] }), ScaleLine: class {} }));
await clientTemplate(MapCanvas, 'src/components/MapCanvas.vue', 'hover-render.ts');
await clientTemplate(GisHoverPreview, 'src/components/GisHoverPreview.vue', 'hover-render.ts');
interface HostNode { tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[]; props: Record<string, unknown>; style: Record<string, string>; addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document }
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {}, addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) { remove(child); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, child); }
const renderer = createRenderer<HostNode, HostNode>({ insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});

let pageComponent: Component | undefined;
async function mountPage() {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) }));
  class TestDocument extends EventTarget { hidden = false; activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  if (!pageComponent) {
    // 页面接线与地图事件分别验证；此处仅隔离无关侧栏，保留真实页面来源和权限判断。
    const source = readFileSync('src/views/SituationView.vue', 'utf8');
    for (const match of source.matchAll(/from ['"]\.\.\/components\/([^'"]+\.vue)['"]/g)) {
      const path = '../src/components/' + match[1];
      vi.doMock(path, () => ({ default: Vue.defineComponent({ inheritAttrs: false, props: ['hoverPreview'], setup(props, { attrs, expose }) {
        expose({ locate() {}, locateResource() {}, fitDeviceCoverage() {} });
        return () => h(match[1] === 'MapCanvas.vue' ? 'page-map' : 'sidebar-probe', { ...attrs, ...props });
      } }) }));
    }
    pageComponent = (await import('../src/views/SituationView.vue')).default;
    await clientTemplate(pageComponent, 'src/views/SituationView.vue', 'hover-render.ts');
  }
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  for (const key of ['loadResourceReadContext', 'queryResourceDevices', 'queryResourceNodes', 'queryResourceInterferences', 'getResourceObject', 'queryResourceMap', 'loadGisResourceDirectory', 'loadGisResourceScene', 'loadGisResourceEditContext', 'loadPreview', 'loadDeviceStatusContext', 'loadInterferenceWorkspace', 'getMonitoringObservation'] as const) vi.spyOn(previewService, key).mockImplementation(raw[key] as never);
  bindMonitoring(raw);
  await usePreviewStore().load(); const read = useResourceReadStore(); await read.activate('gis');
  const gis = useGisWorkspaceStore(); await gis.loadScene();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/gis-workbench', component: pageComponent }] });
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  await router.push('/gis-workbench'); await router.isReady(); const root = node('root'); app.mount(root); await settleMonitoring();
  gis.mapMode = 'resource'; await nextTick();
  const map = () => find(root, n => n.tag === 'page-map')!.props;
  return { root, map, read, gis, auth, storage, editor: useResourceEditStore() };
}

describe('GIS 页面悬浮来源接线', () => {
  it('普通浏览与编辑开放，结果视图和取点关闭；切来源不会清空输入', async () => {
    const s = await mountPage();
    expect(s.map().hoverPreview).toMatchObject({ source: '已保存资源', models: expect.arrayContaining([expect.objectContaining({ id: 'DM-0004' })]) });
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.txPowerDbm = '19'; await nextTick();
    expect(s.map().hoverPreview).toMatchObject({ source: '当前 GIS 草稿（已应用）' });
    const before = JSON.stringify(s.editor.form);
    for (const mode of ['monitoring', 'analysis', 'diagnosis'] as const) {
      s.gis.mapMode = mode; await nextTick(); expect(s.map().hoverPreview).toBeUndefined();
      expect(JSON.stringify(s.editor.form)).toBe(before);
    }
    s.gis.mapMode = 'resource'; s.editor.picking = true; await nextTick(); expect(s.map().hoverPreview).toBeUndefined();
    s.editor.picking = false; await nextTick(); expect(s.map().hoverPreview).toBeDefined();
    s.auth.identity!.permissions = s.auth.identity!.permissions.filter(p => p !== 'situation.view'); await nextTick();
    expect(s.map().hoverPreview).toBeUndefined(); expect(s.storage.writes).toBe(0);
  });
});
const textOf = (root: HostNode): string => (root.tag === '#comment' ? '' : root.text.replace(/<[^>]+>/g, '')) + root.children.map(textOf).join('');
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined { if (predicate(root)) return root; for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; } }
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); probes.maps.length = 0; probes.resize = undefined; });
async function mountMap(enabled = true, count = 1) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: true }) }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('ResizeObserver', class { constructor(fn: () => void) { probes.resize = fn; } observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  pinia = createPinia(); setActivePinia(pinia);
  const raw = initialResources(), points = gisDevicePoints(raw).points.slice(0, count);
  points.forEach(row => { row.coordinate = [114.65, 37.5]; });
  const props = reactive({ stations: raw.stations, richScene: true, gisSurface: true, showNodes: true, picking: false,
    hoverPreview: enabled ? { key: 'resource/1', source: '已保存资源', models: raw.models } as GisHoverContext : undefined,
    gisDeviceFrame: { points, settings: defaultGisDeviceSettings(), selectedDeviceId: '', version: 1 } as GisDeviceMapFrame });
  const select = vi.fn(), cluster = vi.fn(), station = vi.fn(), detail = vi.spyOn(previewService, 'getResourceObject'), save = vi.spyOn(previewService, 'commitResources'), planning = vi.spyOn(previewService, 'submitPlanning');
  const canvas=Vue.ref<InstanceType<typeof MapCanvas>>();
  app = renderer.createApp({ render: () => h(MapCanvas, { ...props,ref:canvas, onSelectDevice: select, onSelectDeviceCluster: cluster, onSelect: station }) });
  app.use(pinia); app.provide(ssrContextKey, {}); const root = node('root'); app.mount(root); await nextTick();
  const map = probes.maps[0]!, event: MapEvent = { pixel: [940, 620], coordinate: [0, 0] };
  const refresh = () => {
    for (const layer of map.layers) if (layer instanceof VectorLayer && layer.getSource() instanceof Cluster) layer.getSource()!.loadFeatures([-Infinity, -Infinity, Infinity, Infinity], map.view.getResolution()!, projection('EPSG:3857')!);
    const features = map.layers.flatMap(layer => layer instanceof VectorLayer && layer.getSource() instanceof Cluster ? layer.getSource()!.getFeatures() : []);
    map.picked = features.find(f => f.get('kind') === 'gis-device-cluster');
  };
  refresh();
  const fire = (type: string, e = event) => map.handlers.get(type)?.forEach(fn => fn(e));
  const hover = async (duration = 200) => { fire('pointermove'); await vi.advanceTimersByTimeAsync(duration); await nextTick(); };
  const tooltip = () => find(root, n => n.props.role === 'tooltip');
  const host = () => find(root, n => n.props.class === 'map-host')!;
  return { props, map, root, fire, hover, tooltip, host, refresh, select, cluster, station, detail, save, planning,canvas };
}

describe('GIS 实际地图悬浮入口', () => {
  it('单设备聚焦隐藏无关网络、保留比例，悬停含未达标原值，返回全网恢复节点',async()=>{
    const s=await mountMap(),f=coverageV5Case();f.anchor.engine_version='V01-6';f.result.provenance.engine_version='V01-6';
    const device=f.result.devices[0]!,part=device.computations[0]!;
    part.sampling_grid={origin:[114,37.5],cell_m:2000,radius_m:10000,samples:[[0,0,40,30,null,-44,false],[1,0,60,50,null,null,true],[0,1,20,10,null,null,true],[1,1,0,-10,null,-44,false]]};
    const network={identity:{...f.anchor,state:'SAVED',source_changed:false,source:'SR4',data_origin:'SYNTHETIC_INTEGRATION'},nodes:[{id:'N1',name:'冻结台站',coordinate:[114,37.5],status:null,alert:null}],devices:[{id:'D1',station_id:'N1',model_id:'M1',device_class:'VUHF',frequency_khz:30000,tx_power_dbm:30,antenna_height_m:10}],links:[],demands:[],routes:[],paths_state:'missing',paths_message:''};
    const overlay:FrozenCoverageOverlay={anchor:f.anchor,result:f.result,deviceId:'D1',frequencyKhz:30000,display:'field',terrainReference:false};
    const features=()=>s.map.layers.flatMap(layer=>layer instanceof VectorLayer?layer.getSource()!.getFeatures():[]);
    Object.assign(s.props,{resourceRead:true,richScene:false,readonlySituation:true,frozenNetwork:network,frozenCoverage:overlay});await nextTick();
    vi.mocked(s.map.view.fit).mockClear();expect(s.canvas.value!.fitFrozenCoverage(true)).toBe(true);expect(s.map.view.fit).toHaveBeenCalledOnce();vi.mocked(s.map.view.fit).mockClear();
    expect(features().some(f=>f.get('kind')==='frozen-plan-node')).toBe(false);
    expect(features().filter(f=>f.get('kind')==='frozen-coverage-device')).toHaveLength(1);
    expect(features().some(f=>f.get('kind')==='frozen-coverage-isoline')).toBe(true);
    s.map.picked=undefined;s.map.coordinate=fromLonLat([114+2000/(111320*Math.cos(37.5*Math.PI/180)),37.5+2000/111320]);
    await s.hover();expect(textOf(s.root)).toContain('原始采样 0.0 dBμV/m');expect(textOf(s.root)).toContain('未达标');expect(textOf(s.root)).toContain('最小净空 -44.0 m');
    const animate=vi.spyOn(s.map.view,'animate').mockImplementation(()=>{});
    Object.assign(s.props,{frozenCoverage:{...overlay}});await nextTick();expect(s.canvas.value!.fitFrozenCoverage(true)).toBe(true);
    expect(s.map.view.fit).not.toHaveBeenCalled();expect(animate).toHaveBeenLastCalledWith(expect.not.objectContaining({zoom:expect.anything()}));
    s.canvas.value!.fit();expect(s.map.view.fit).toHaveBeenCalledOnce();expect(features().some(f=>f.get('kind')==='frozen-plan-node')).toBe(true);
    expect(s.save).not.toHaveBeenCalled();expect(s.planning).not.toHaveBeenCalled();
    Object.assign(s.props,{frozenCoverage:null,interferenceProjection:{taskId:'T',planId:'P',sceneVersionId:'I',runId:'run',sourceHash:'hash',phase:'BEFORE',nodes:[{node_id:'X',lon:113,lat:36},{node_id:'Y',lon:113.2,lat:36.1}],links:[],sources:[],impact:{affected_nodes:[],affected_links:[],affected_area:{type:'FeatureCollection',features:[]}}}});await nextTick();
    const a=fromLonLat([113,36]),b=fromLonLat([113.2,36.1]);expect(vi.mocked(s.map.view.fit).mock.lastCall![0]).toEqual([a[0],a[1],b[0],b[1]]);
  });
  it('停留 200ms 展示单设备摘要，移动不抢选中项、不发详情或计算请求', async () => {
    const s = await mountMap(), layerCount = s.map.layers.length;
    await s.hover(199); expect(s.tooltip()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await nextTick(); expect(textOf(s.tooltip()!)).toContain(s.props.gisDeviceFrame.points[0].id);
    expect(s.tooltip()!.props.style).toMatchObject({ left: '646px', top: '386px' });
    s.fire('pointermove'); await nextTick(); expect(s.tooltip()).toBeDefined(); expect(s.map.layers).toHaveLength(layerCount);
    expect(s.select).not.toHaveBeenCalled(); expect(s.cluster).not.toHaveBeenCalled(); expect(s.station).not.toHaveBeenCalled();
    expect(s.detail).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled(); expect(s.planning).not.toHaveBeenCalled();
  });
  it.each([1, 3])('预览 %i 台对象后点击仍走原单设备或聚合入口', async count => {
    const s = await mountMap(true, count); await s.hover(); expect(s.tooltip()).toBeDefined();
    if (count > 1) expect(textOf(s.tooltip()!)).toContain('设备聚合（3 台）');
    (s.host().props.onPointerdownCapture as () => void)(); s.fire('click'); s.fire('singleclick'); await nextTick();
    expect(s.tooltip()).toBeUndefined();
    if (count === 1) expect(s.select).toHaveBeenCalledWith(s.props.gisDeviceFrame.points[0].id, 1);
    else expect(s.cluster).toHaveBeenCalledWith(s.props.gisDeviceFrame.points.map(p => p.id), 1);
  });
  it.each(['leave', 'drag', 'move', 'zoom', 'center', 'rotate', 'resize', 'escape', 'context', 'version', 'filter', 'picking', 'disabled'] as const)('%s 关闭已显示摘要并取消迟到提示', async reason => {
    const s = await mountMap(); await s.hover(); expect(s.tooltip()).toBeDefined();
    let resizeHeight = 640;
    const clear = async () => {
      if (reason === 'leave') (s.host().props.onPointerleave as () => void)();
      if (reason === 'drag') s.fire('pointermove', { pixel: [100, 100], coordinate: [0, 0], dragging: true });
      if (reason === 'move') s.fire('movestart');
      if (reason === 'zoom') s.map.view.setZoom((s.map.view.getZoom() ?? 10) + 1);
      if (reason === 'center') s.map.view.setCenter([s.map.view.getCenter()![0] + 100, 100]);
      if (reason === 'rotate') s.map.view.setRotation(s.map.view.getRotation() + 0.1);
      if (reason === 'resize') {
        Object.assign(s.host(), { clientWidth: 960, clientHeight: ++resizeHeight });
        probes.resize!(); await vi.advanceTimersByTimeAsync(16);
      }
      if (reason === 'escape') window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
      if (reason === 'context') s.props.hoverPreview!.key += '/new';
      if (reason === 'version') s.props.gisDeviceFrame.version++;
      if (reason === 'filter') s.props.gisDeviceFrame.points = [];
      if (reason === 'picking') s.props.picking = true;
      if (reason === 'disabled') s.props.hoverPreview = undefined;
      await nextTick();
    };
    await clear(); expect(s.tooltip()).toBeUndefined();
    await s.hover(100); await clear(); await vi.advanceTimersByTimeAsync(300); await nextTick(); expect(s.tooltip()).toBeUndefined();
  });
  it('未接入地图默认关闭，移到空白或卸载后旧回调不能显示摘要', async () => {
    const s = await mountMap(false); await s.hover(); expect(s.tooltip()).toBeUndefined();
    s.props.hoverPreview = { key: 'resource/2', source: '草稿', models: [] }; await nextTick(); await s.hover(100);
    const picked = s.map.picked; s.map.picked = undefined; await s.hover(200); expect(s.tooltip()).toBeUndefined();
    s.map.picked = picked; await s.hover(100); app!.unmount(); app = undefined;
    s.fire('pointermove'); await vi.advanceTimersByTimeAsync(300); expect(s.map.dispose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('预览不清空真实 GIS 设备表单的未保存输入', async () => {
    const s = await mountMap(); authorizeStore();
    const storage = new TestStorage(), raw = createMockService(() => storage), editor = useResourceEditStore();
    const read = await raw.loadResourceReadContext({ context: 'gis' });
    const context = await raw.loadGisResourceEditContext({ context: 'gis', revision: read.revision }); editor.acceptGisContext(context); editor.begin();
    await editor.openForm('device', context.resources.devices[0].id); editor.form!.fields.txPowerDbm = '19';
    const before = JSON.stringify([editor.form, editor.draft, editor.undoStack, editor.redoStack]);
    await s.hover(); expect(s.tooltip()).toBeDefined();
    (s.host().props.onPointerleave as () => void)(); await nextTick();
    expect(JSON.stringify([editor.form, editor.draft, editor.undoStack, editor.redoStack])).toBe(before);
    expect(s.save).not.toHaveBeenCalled(); expect(s.detail).not.toHaveBeenCalled();
  });
});
