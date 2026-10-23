import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App, type ComponentOptions } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import type View from 'ol/View';
import type BaseLayer from 'ol/layer/Base';
import ImageLayer from 'ol/layer/Image';
import MapCanvas from '../src/components/MapCanvas.vue';
import PlanningPage from '../src/views/PlanningApiView.vue';
import * as terrainService from '../src/services/terrain-basemap';
import type { ResourceReadWorkspace } from '../src/types/resource-read';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { clientTemplate, renderer, node, textOf, find } from './helpers/vue-client';

interface Probe { layers: BaseLayer[]; view: View; dispose: ReturnType<typeof vi.fn> }
const probes = vi.hoisted(() => ({ maps: [] as Probe[] }));
// 仅替换画布宿主；图层、事件、投影和地图模板实际执行。
vi.mock('ol/Map', () => ({ default: class {
  layers: BaseLayer[] = []; view: View; dispose = vi.fn();
  constructor(options: { view: View }) {
    this.view = options.view;
    vi.spyOn(this.view, 'fit').mockImplementation(() => {});
    probes.maps.push(this);
  }
  setLayers(layers: BaseLayer[]) { this.layers = layers; }
  getView() { return this.view; } getSize() { return [960,640]; }
  updateSize() {} on() {} forEachFeatureAtPixel() {}
} }));
vi.mock('ol/control', () => ({ defaults: () => ({ extend: () => [] }), ScaleLine: class {} }));
vi.mock('vue-router', async original => {
  const m = await original<typeof import('vue-router')>(); return { ...m, createWebHashHistory: m.createMemoryHistory };
});
await clientTemplate(MapCanvas, 'src/components/MapCanvas.vue', 'terrain-map-render.ts');
let app: App | undefined, pinia: ReturnType<typeof createPinia> | undefined;
function prepare() {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: true }) }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Image', class { addEventListener() {} removeEventListener() {} });
  pinia = createPinia(); setActivePinia(pinia);
}
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); probes.maps.length = 0;
});
const terrain = (id = 'one'): terrainService.TerrainBasemap => ({ url: 'blob:' + id, extent: [113,36,115,38], source: '构造地形', dispose: vi.fn() });
const workspace = (id = 'a'): ResourceReadWorkspace => ({ revision: id, bounds: [113,36,115,38], source: '构造联调', updatedAt: '2026-10-22T00:00:00Z',
  stats: { nodes: 0, devices: 0, models: 0, interferences: 0, hf: 0, vuhf: 0, alerts: null, unknownAlerts: null, active: null, offShelf: null, unknownAvailability: null },
  terrain: { sourceSha256: id.repeat(64), bounds: [113,36,115,38], source: '构造地形' } });

describe('规划地图地形入口', () => {
  it.each([false, true])('地形位于道路和业务层下；失败、换版和卸载清理监听 richScene=%s', async richScene => {
    prepare();
    const props = reactive({ stations: [], resourceRead: true, richScene, showRoads: false,
      resourceFrame: { revision: 'r1', bbox: [113,36,115,38], zoom: 9, points: [{ kind: 'node', id: 'N1', name: '节点', coordinate: [114,37], status: 'NORMAL', alert: null, active: null }], clusters: [], totalNodes: 1, totalInterferences: 0 },
      terrainBasemap: terrain() });
    app = renderer.createApp({ render: () => h(MapCanvas, props as any) });
    app.use(pinia!); app.provide(ssrContextKey, {}); const root = node('root'); app.mount(root); await nextTick();
    const map = probes.maps[0]!, layer = map.layers[0] as ImageLayer<any>, source = layer.getSource()!;
    expect(layer).toBeInstanceOf(ImageLayer);
    expect(source.getProjection().getCode()).toBe('EPSG:4326');
    expect(source.getImageExtent()).toEqual([113,36,115,38]);
    expect(map.layers.length).toBeGreaterThan(2);
    const business = map.layers.slice(1);
    source.dispatchEvent('imageloaderror'); await nextTick();
    expect(layer.getVisible()).toBe(false);
    expect(map.layers.slice(1)).toEqual(business);
    expect(textOf(root)).toContain('地形图片显示失败');
    props.terrainBasemap = terrain('two'); await nextTick();
    const current = map.layers[0] as ImageLayer<any>;
    expect(current).not.toBe(layer);
    source.dispatchEvent('imageloaderror'); await nextTick();
    expect(current.getVisible()).toBe(true);
    expect(textOf(root)).not.toContain('地形图片显示失败');
    const currentSource = current.getSource()!;
    app.unmount(); app = undefined;
    expect(currentSource.hasListener('imageloaderror')).toBe(false);
    expect(map.dispose).toHaveBeenCalledOnce();
  });

  async function mountLifecycle(initial: ResourceReadWorkspace | null = workspace()) {
    prepare();
    const resources = useResourceReadStore(pinia!); resources.workspace = initial;
    vi.spyOn(resources, 'activate').mockResolvedValue(false);
    vi.spyOn(useTaskInputStore(pinia!), 'initialize').mockResolvedValue(undefined);
    vi.spyOn(usePlanningApiStore(pinia!), 'start').mockImplementation(() => {});
    // 单测只探测页面脚本的异步所有权；真实模板/按钮仍需浏览器验收。
    const page = { ...PlanningPage, render(_ctx: unknown, _cache: unknown, _props: unknown, setup: any) {
      return h('terrain-probe', { terrain: setup.terrainBasemap, message: setup.terrainMessage });
    } } as ComponentOptions;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: page }] });
    await router.push('/planning');
    app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia!); app.use(router); app.provide(ssrContextKey, {});
    const root = node('root'); app.mount(root); await nextTick();
    const state = () => find(root, n => n.tag === 'terrain-probe')!.props;
    return { resources, state };
  }
  it('换版取消旧请求，迟到结果释放，离页取消并释放当前图', async () => {
    let resolveOld!: (value: terrainService.TerrainBasemap) => void;
    const old = terrain('old'), current = terrain('current');
    const load = vi.spyOn(terrainService, 'loadTerrainBasemap').mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(current);
    const s = await mountLifecycle();
    s.resources.workspace = workspace('b'); await nextTick(); await nextTick();
    expect(load.mock.calls[0][3]?.aborted).toBe(true);
    expect(s.state().terrain).toBe(current);
    resolveOld(old); await nextTick(); await nextTick();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(s.state().terrain).toBe(current);
    app!.unmount(); app = undefined;
    expect(current.dispose).toHaveBeenCalledOnce();
    expect(load.mock.calls[1][3]?.aborted).toBe(true);
  });
  it('加载失败保留页面，缺少元数据时不回退旧图', async () => {
    const load = vi.spyOn(terrainService, 'loadTerrainBasemap').mockRejectedValue(new Error('地形校验失败'));
    const s = await mountLifecycle(); await nextTick();
    expect(s.state().terrain).toBeNull(); expect(s.state().message).toContain('地形校验失败');
    s.resources.workspace = { ...workspace('b'), terrain: null }; await nextTick();
    expect(s.state().message).toContain('未提供'); expect(load).toHaveBeenCalledTimes(1);
  });
  it('初次资源响应省略可选字段时，也明确显示缺失状态', async () => {
    const load = vi.spyOn(terrainService, 'loadTerrainBasemap');
    const s = await mountLifecycle(null);
    s.resources.workspace = { ...workspace(), terrain: undefined }; await nextTick();
    expect(s.state().message).toContain('未提供'); expect(load).not.toHaveBeenCalled();
  });
  it('离页后才完成的图片仍释放，不更新已卸载页面', async () => {
    let resolve!: (value: terrainService.TerrainBasemap) => void;
    const image = terrain('late');
    vi.spyOn(terrainService, 'loadTerrainBasemap').mockImplementation(() => new Promise(done => { resolve = done; }));
    await mountLifecycle(); app!.unmount(); app = undefined;
    resolve(image); await nextTick(); await nextTick();
    expect(image.dispose).toHaveBeenCalledOnce();
  });
});
