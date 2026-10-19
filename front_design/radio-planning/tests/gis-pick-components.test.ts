import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import type View from 'ol/View';
import type Feature from 'ol/Feature';
import type BaseLayer from 'ol/layer/Base';
import VectorLayer from 'ol/layer/Vector';
import Cluster from 'ol/source/Cluster';
import { get as projection } from 'ol/proj';
import { projectCoordinate, unprojectCoordinate } from '../src/maps/layers';
import { initialResources } from '../src/mocks/resource-presets';
import type { GisPickContext, GisPickTarget } from '../src/types/gis-pick';
import MapCanvas from '../src/components/MapCanvas.vue';
import { previewService } from '../src/services';

interface MapEvent { pixel: number[]; coordinate: number[]; originalEvent?: object; dragging?: boolean }
interface Probe {
  view: View; layers: BaseLayer[]; handlers: Map<string, (event: MapEvent) => void>;
  setLayers: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
  getPixelFromCoordinate: (coordinate: number[]) => number[]; picked?: Feature;
}
const probes = vi.hoisted(() => ({ maps: [] as Probe[] }));
// 仅替换需要 DOM 的地图外壳；实际 View、聚合源、投影、要素和 Vue 模板均运行。
vi.mock('ol/Map', () => ({ default: class implements Probe {
  view: View; layers: BaseLayer[] = []; picked?: Feature;
  handlers = new Map<string, (event: MapEvent) => void>();
  setLayers = vi.fn((layers: BaseLayer[]) => { this.layers = layers; });
  dispose = vi.fn();
  constructor(options: { view: View }) {
    this.view = options.view;
    vi.spyOn(this.view, 'fit').mockImplementation(() => {});
    vi.spyOn(this.view, 'animate').mockImplementation(() => {});
    probes.maps.push(this);
  }
  getView() { return this.view; } getSize() { return [960, 640]; } updateSize() {}
  getPixelFromCoordinate(point: number[]) {
    const center = this.view.getCenter()!, resolution = this.view.getResolution()!;
    return [480 + (point[0]! - center[0]!) / resolution, 320 - (point[1]! - center[1]!) / resolution];
  }
  on(type: string, fn: (event: MapEvent) => void) { this.handlers.set(type, fn); }
  forEachFeatureAtPixel(_pixel: number[], fn: (feature: Feature) => unknown) { if (this.picked) return fn(this.picked); }
} }));
vi.mock('ol/control', () => ({ defaults: () => ({ extend: () => [] }), ScaleLine: class {} }));
const filename = 'src/components/MapCanvas.vue';
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
const bindings = compileScript(descriptor, { id: filename }).bindings;
const template = compileTemplate({ source: descriptor.template!.content, filename, id: filename,
  compilerOptions: { mode: 'function', bindingMetadata: bindings } });
if (template.errors.length) throw new Error(template.errors.map(String).join('\n'));
const { code } = await transformWithEsbuild(`function createRender(Vue) { ${template.code} }`, 'map-render.ts', { loader: 'ts' });
(MapCanvas as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);

interface HostNode { tag: string; text: string; parent: HostNode | null; children: HostNode[]; props: Record<string, unknown> }
const node = (tag: string, text = ''): HostNode => ({ tag, text, parent: null, children: [], props: {} });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
const textOf = (root: HostNode): string => (root.tag === '#comment' ? '' : root.text.replace(/<[^>]+>/g, '')) + root.children.map(textOf).join('');

function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; }
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); probes.maps.length = 0;
});
async function mountMap(integrated = true) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => Object.assign(new EventTarget(), { matches: true }) }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const raw = initialResources();
  const stations = [{ ...raw.stations[0]!, coordinate: [114.65, 37.5] as [number, number] }];
  const interferences = [{ ...raw.interferences![0]!, coordinate: [114.75, 37.5] as [number, number], active: false }];
  const targets: GisPickTarget[] = [
    ...stations.map(row => ({ kind: 'station' as const, id: row.id, name: row.name, coordinate: row.coordinate })),
    ...interferences.map(row => ({ kind: 'interference' as const, id: row.id, name: row.name, coordinate: row.coordinate })),
  ];
  const props = reactive({ stations, interferences, resourceMarkers: true, showNodes: true, showInterferences: true, picking: true,
    gisPick: integrated ? { key: 'page/1', active: true, enabled: true, owner: { kind: 'station', id: 'NEW' }, targets } as GisPickContext : undefined });
  const pick = vi.fn(), legacy = vi.fn(), cancel = vi.fn(), toggle = vi.fn(), select = vi.fn(), legacyCancel = vi.fn();
  const submit = vi.spyOn(previewService, 'submitPlanning'), save = vi.spyOn(previewService, 'commitGisWorkspace');
  pinia = createPinia(); setActivePinia(pinia);
  app = renderer.createApp({ render: () => h(MapCanvas, { ...props, onGisPick: pick, onPick: legacy,
    onGisPickCancel: cancel, onGisPickToggle: toggle, onSelect: select, onCancelPick: legacyCancel }) });
  app.use(pinia); app.provide(ssrContextKey, {}); const root = node('root'); app.mount(root); await nextTick();
  const map = probes.maps[0]!;
  const clusterSource = () => (map.layers.find(layer => layer instanceof VectorLayer && layer.getSource() instanceof Cluster) as VectorLayer<Cluster>).getSource()!;
  const refresh = () => clusterSource().loadFeatures([-Infinity, -Infinity, Infinity, Infinity], map.view.getResolution()!, projection('EPSG:3857')!);
  refresh(); await nextTick();
  const point = (coordinate: [number, number], offset = 0): MapEvent => {
    const projected = projectCoordinate(coordinate), pixel = map.getPixelFromCoordinate(projected);
    return { pixel: [pixel[0]! + offset, pixel[1]!], coordinate: [projected[0]! + offset * map.view.getResolution()!, projected[1]!], originalEvent: {} };
  };
  const hover = async (coordinate = props.stations[0]!.coordinate) => { map.handlers.get('pointermove')!(point(coordinate)); await nextTick(); };
  const press = (event: MapEvent) => {
    (find(root, n => n.props.class === 'map-host')!.props.onPointerdownCapture as () => void)();
    map.handlers.get('click')?.(event);
  };
  const single = (event: MapEvent) => map.handlers.get('singleclick')!(event);
  const click = async (coordinate = props.stations[0]!.coordinate, offset = 0) => { const event = point(coordinate, offset); press(event); single(event); await nextTick(); return event; };
  const highlight = () => (map.layers.find(layer => layer.getZIndex() === 40) as VectorLayer).getSource()!.getFeatures();
  return { props, map, root, pick, legacy, cancel, legacyCancel, toggle, select, submit, save, clusterSource, refresh, point, press, single, hover, click, highlight };
}
describe('GIS 取点实际地图模板与图层', () => {
  it('悬停提示包含身份，轻量高亮不重绘业务层；点击采用原坐标而非鼠标偏移', async () => {
    const s = await mountMap(), paints = s.map.setLayers.mock.calls.length, fits = vi.mocked(s.map.view.fit).mock.calls.length;
    await s.hover(); expect(s.highlight()).toHaveLength(1); expect(textOf(s.root)).toContain('点击使用该位置');
    expect(textOf(s.root)).toContain(s.props.stations[0]!.id);
    await s.click(s.props.stations[0]!.coordinate, 10);
    expect(s.pick).toHaveBeenCalledWith(expect.objectContaining({ key: 'page/1', coordinate: s.props.stations[0]!.coordinate, target: expect.objectContaining({ kind: 'station' }) }));
    expect(s.legacy).not.toHaveBeenCalled(); expect(s.select).not.toHaveBeenCalled();
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints); expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled();
  });
  it('实际聚合中心和成员都排除，放大解聚合后才可吸附', async () => {
    const s = await mountMap();
    const second = { ...s.props.stations[0]!, id: 'SECOND', coordinate: [114.651, 37.5] as [number, number] };
    s.props.stations.push(second); s.props.gisPick!.targets.push({ kind: 'station', id: second.id, name: second.name, coordinate: second.coordinate });
    await nextTick(); s.refresh(); await s.hover();
    expect(s.clusterSource().getFeatures()[0]!.get('features')).toHaveLength(2);
    expect(s.highlight()).toHaveLength(0); expect(textOf(s.root)).toContain('聚合站点请放大');
    await s.click(); expect(s.pick.mock.calls.at(-1)![0].target).toBeUndefined();
    s.map.view.setZoom(17); s.refresh(); await s.hover();
    expect(s.clusterSource().getFeatures()).toHaveLength(2); expect(s.highlight()).toHaveLength(1);
    await s.click(); expect(s.pick.mock.calls.at(-1)![0].target.id).toBe(s.props.stations[0]!.id);
  });
  it('隐藏参考站点不能吸附；停用但可见的干扰源仍可参考，隐藏后排除', async () => {
    const s = await mountMap(); s.props.showNodes = false; await nextTick(); s.refresh();
    await s.click(); expect(s.pick.mock.calls.at(-1)![0].target).toBeUndefined();
    await s.click(s.props.interferences[0]!.coordinate); expect(s.pick.mock.calls.at(-1)![0].target.kind).toBe('interference');
    expect(s.props.interferences[0]!.active).toBe(false);
    s.props.showInterferences = false; await nextTick(); await s.click(s.props.interferences[0]!.coordinate);
    expect(s.pick.mock.calls.at(-1)![0].target).toBeUndefined();
  });
  it('开关、取消和 Esc 使用当前代次；关闭吸附仍按原反投影自由取点', async () => {
    const s = await mountMap(), checkbox = find(s.root, n => n.tag === 'input')!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    expect(s.toggle).toHaveBeenCalledWith({ key: 'page/1', enabled: false });
    s.props.gisPick!.enabled = false; await nextTick(); await s.hover(); expect(s.highlight()).toHaveLength(0);
    const event = await s.click(s.props.stations[0]!.coordinate, 5);
    expect(s.pick.mock.calls.at(-1)![0]).toEqual({ key: 'page/1', coordinate: unprojectCoordinate(event.coordinate) });
    (find(s.root, n => n.tag === 'button' && textOf(n).includes('取消取点'))!.props.onClick as () => void)();
    window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(s.cancel.mock.calls).toEqual([['page/1'], ['page/1']]);
  });
  it.each(['zoom', 'drag', 'leave', 'context', 'target'] as const)('%s 清空高亮并使迟到点击失效', async reason => {
    const s = await mountMap(); await s.hover(); const event = s.point(s.props.stations[0]!.coordinate); s.press(event);
    if (reason === 'zoom') s.map.view.setZoom(13);
    if (reason === 'drag') s.map.handlers.get('pointerdrag')!(event);
    if (reason === 'leave') (find(s.root, n => n.props.class === 'map-host')!.props.onPointerleave as () => void)();
    if (reason === 'context') s.props.gisPick!.key = 'page/2';
    if (reason === 'target') s.props.gisPick!.targets = [];
    await nextTick(); expect(s.highlight()).toHaveLength(0); s.single(event);
    expect(s.pick).not.toHaveBeenCalled(); expect(s.legacy).not.toHaveBeenCalled();
  });
  it('按下之后才切换表单，抬起及延迟 singleclick 都不能写入新表单', async () => {
    const s = await mountMap(), event = s.point(s.props.stations[0]!.coordinate);
    (find(s.root, n => n.props.class === 'map-host')!.props.onPointerdownCapture as () => void)();
    s.props.gisPick!.key = 'page/2'; await nextTick(); s.map.handlers.get('click')!(event); s.single(event);
    expect(s.pick).not.toHaveBeenCalled();
  });
  it('旧控件、停用上下文和卸载后的回调不能取点或取消新表单', async () => {
    const s = await mountMap(), checkbox = find(s.root, n => n.tag === 'input')!;
    const toggle = checkbox.props.onChange as (event: unknown) => void;
    const cancel = find(s.root, n => n.tag === 'button' && textOf(n).includes('取消取点'))!.props.onClick as () => void;
    s.props.gisPick!.key = 'page/2'; await nextTick(); toggle({ target: { checked: false } }); cancel();
    expect(s.toggle).not.toHaveBeenCalled(); expect(s.cancel).not.toHaveBeenCalled();
    s.props.gisPick!.active = false; await nextTick(); await s.click(); expect(s.pick).not.toHaveBeenCalled();
    expect(s.legacy).not.toHaveBeenCalled(); app!.unmount(); app = undefined;
    s.map.handlers.get('pointermove')!(s.point(s.props.stations[0]!.coordinate)); cancel(); expect(s.pick).not.toHaveBeenCalled();
  });
  it('未显式接入的页面仍走旧取点、取消与普通对象点选', async () => {
    const s = await mountMap(false), event = s.point(s.props.stations[0]!.coordinate);
    s.single(event); expect(s.legacy).toHaveBeenCalledWith(unprojectCoordinate(event.coordinate));
    expect(find(s.root, n => n.tag === 'input')).toBeUndefined();
    (find(s.root, n => n.tag === 'button' && textOf(n).includes('取消取点'))!.props.onClick as () => void)();
    expect(s.legacyCancel).toHaveBeenCalledOnce();
    s.props.picking = false; await nextTick(); s.map.picked = s.clusterSource().getFeatures()[0]; s.single(event);
    expect(s.select).toHaveBeenCalledWith(s.props.stations[0]!.id);
  });
});

