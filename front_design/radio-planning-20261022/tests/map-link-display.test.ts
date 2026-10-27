import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import type View from 'ol/View';
import type Feature from 'ol/Feature';
import type BaseLayer from 'ol/layer/Base';
import VectorLayer from 'ol/layer/Vector';
import VectorTileLayer from 'ol/layer/VectorTile';
import ImageLayer from 'ol/layer/Image';
import type ImageSource from 'ol/source/Image';
import type { Style } from 'ol/style';
import { fromLonLat, get as projection } from 'ol/proj';
import Cluster from 'ol/source/Cluster';
import { defaultGisDeviceSettings, gisDevicePoints, type GisDeviceMapFrame } from '../src/maps/gis-device-display';
import { initialResources } from '../src/mocks/resource-presets';
import MapCanvas from '../src/components/MapCanvas.vue';
import { linkLayer } from '../src/maps/layers';
import { candidateEndpoints, candidateLinkLayer } from '../src/maps/candidate-link-layers';
import type { CandidateLink } from '../src/types/candidate-link';
import { interferenceImpactLayers } from '../src/maps/interference-layers';
import { interferenceDemoResult, interferenceScenarios } from '../src/mocks/interference-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { getPresetCoverage } from '../src/services/planning-validation';
import { readCoverage } from '../src/services/coverage-validation';
import { previewService } from '../src/services';
import type { MapRegion, NetworkLink, InterferenceSource } from '../src/types/domain';
import type { InterferenceImpact } from '../src/types/interference';
import type { DiagnosisRegion, FaultInput } from '../src/types/diagnosis';
import type { DeviceCoverageOverlay } from '../src/types/device-coverage';
import { defaultGisResultLayers, type GisResultLayerSettings } from '../src/maps/gis-result-layers';
import { loadDeviceCoverageCatalog } from '../src/services/device-coverage-mock';
import { interferenceFixture } from './helpers/interference';
import { authorizeStore } from './helpers/auth';
import type { CoverageDisplay } from '../src/types/coverage';
import type { PlanningMapOverlay } from '../src/maps/planning-api-layers';
import { coverageDto } from './fixtures/planning-api';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';
import { coverageV5Case } from './helpers/frozen-coverage';
import { frozenCoverageLayer } from '../src/maps/frozen-coverage-layers';

interface MapProbe {
  view: View; layers: BaseLayer[]; setLayers: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>;
  handlers: Map<string, (event: { pixel: number[]; coordinate: number[] }) => void>;
  picked?: Feature;
}
const probes = vi.hoisted(() => ({ maps: [] as MapProbe[] }));
// 仅替换需要真实 DOM/画布的地图宿主；View、图层、要素、样式及业务模板均实际执行。
vi.mock('ol/Map', () => ({ default: class implements MapProbe {
  view: View; layers: BaseLayer[] = []; picked?: Feature;
  handlers = new Map<string, (event: { pixel: number[]; coordinate: number[] }) => void>();
  setLayers = vi.fn((layers: BaseLayer[]) => { this.layers = layers; });
  dispose = vi.fn();
  constructor(options: { view: View }) {
    this.view = options.view;
    // 自动定位的像素/动画留给浏览器；测试用真实 View.setZoom 触发分辨率事件。
    vi.spyOn(this.view, 'fit').mockImplementation(() => {});
    vi.spyOn(this.view, 'animate').mockImplementation(() => {});
    probes.maps.push(this);
  }
  getView() { return this.view; }
  getViewport() { return {addEventListener() {},removeEventListener() {}}; }
  getSize() { return [960, 640]; }
  updateSize() {}
  on(type: string, listener: (event: { pixel: number[]; coordinate: number[] }) => void) { this.handlers.set(type, listener); }
  forEachFeatureAtPixel(_pixel: number[], callback: (feature: Feature) => unknown) { if (this.picked) return callback(this.picked); }
} }));
vi.mock('ol/control', () => ({ defaults: () => ({ extend: () => [] }), ScaleLine: class {} }));

const filename = 'src/components/MapCanvas.vue';
await clientTemplate(MapCanvas, filename, 'map-render.ts');

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
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); probes.maps.length = 0;
});

async function mountMap(options: { reduced?: boolean; resourceRead?: boolean; withCoverage?: boolean; withHttpCoverage?: boolean; gis?: boolean; gisSurface?: boolean; topologyOpacity?: number; collapsibleLegend?: boolean } = {}) {
  // 仅接管动画 interval，避免把 OpenLayers 数据源的零延时通知计作闪烁任务。
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const page = Object.assign(new EventTarget(), { hidden: false });
  const motion = Object.assign(new EventTarget(), { matches: options.reduced ?? false });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => motion }));
  vi.stubGlobal('document', page);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Image', class { addEventListener() {} removeEventListener() {} });
  pinia = createPinia(); setActivePinia(pinia);
  if (options.withHttpCoverage) authorizeStore();
  const props = reactive({
    stations: structuredClone(planningPresets[0].baseline.stations),
    links: planningPresets[0].result!.links.map((link, index) => ({ ...link, isBackbone: index === 0,
      state: index === 1 ? 'FAULT' : link.state })) as NetworkLink[],
    // 夹具只提供当前候选集合，不再依赖退役的结果链路属性。
    candidateWorkset: planningPresets[0].result!.links.map(link=>({
      id:link.id,nodeAId:link.a,nodeBId:link.b,deviceAId:link.deviceA,deviceBId:link.deviceB,
      deviceClass:link.deviceClass,freqKhz:link.frequencyKhz,bandwidthKhz:null,isBackup:false,
      distanceM:null,pathLossDb:null,rxPowerDbm:null,linkMarginDb:null,isAvailable:null,linkState:null,
      assessmentState:'PENDING',reference:null,source:{kind:'MANUAL',file:null,row:null},
    })) as CandidateLink[] | undefined,
    candidateStations: undefined as typeof planningPresets[0]['baseline']['stations'] | undefined,
    selectedCandidateLinkId: '',
    selectedLinkId: '', highlightLinkIds: [] as string[], showLinks: true, showCandidates: true, selectLinks: true,
    topologyOpacity: options.topologyOpacity as number | undefined,
    resourceRead: options.resourceRead ?? false,
    richScene: false,
    frozenCoverage: null as import('../src/types/frozen-coverage').FrozenCoverageOverlay|null,
    resourceFrame: null as import('../src/types/resource-read').ResourceMapFrame | null,
    collapsibleLegend: options.collapsibleLegend ?? false,
    gisSurface: options.gisSurface ?? false, resourceMarkers: false, showInterferences: true,
    gisResultLayers: options.gis ? defaultGisResultLayers() : undefined as GisResultLayerSettings | undefined,
    regions: [] as MapRegion[], interferenceImpact: null as InterferenceImpact | null, interferences: [] as InterferenceSource[],
    diagnosisRegions: [] as DiagnosisRegion[], diagnosisFaults: [] as FaultInput[],
    demands: [] as typeof planningPresets[0]['input']['demands'],
    showCoverage: true, opacity: 0.8, showNodes: true, showRoads: true, gisDeviceFrame: undefined as GisDeviceMapFrame | undefined,
    deviceCoverageActive: false, deviceCoverages: [] as DeviceCoverageOverlay[],
    mockCoverage: options.withCoverage ? getPresetCoverage('balanced') : undefined,
    mockCoverageDisplay: 'auto' as CoverageDisplay, deviceCoverageDisplay: 'auto' as CoverageDisplay, coverageDisplay: 'auto' as CoverageDisplay,
    planningOverlay: (options.withHttpCoverage ? { nodes: [], snapshotId: 'HTTP-S1', coverage: getPresetCoverage('balanced') } : null) as PlanningMapOverlay | null,
  });
  const select = vi.fn(), submit = vi.spyOn(previewService, 'submitPlanning'), image = vi.spyOn(previewService, 'getPlanningCoverageImage');
  const httpSubmit = vi.spyOn(previewService, 'submitPlanningTask'), save = vi.spyOn(previewService, 'savePlanningPlan');
  if (options.withHttpCoverage) image.mockResolvedValue(new Blob(['image-placeholder'], { type: 'image/png' }));
  const selectDevice = vi.fn(), selectDeviceCluster = vi.fn(), selectFault = vi.fn(), selectCandidateLink = vi.fn(), report = vi.spyOn(previewService, 'getDiagnosisReport');
  app = renderer.createApp({ render: () => h(MapCanvas, { ...props, onSelectCandidateLink: selectCandidateLink, onSelectLink: select, onSelectDevice: selectDevice, onSelectDeviceCluster: selectDeviceCluster, onSelectFault: selectFault }) });
  app.use(pinia); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await nextTick();
  const map = probes.maps[0];
  const layer = () => map.layers.find(item => item instanceof VectorLayer && item.getSource()?.getFeatures().some((feature: Feature) => feature.get('kind') === 'planned-link')) as ReturnType<typeof linkLayer>;
  const style = (id: string) => {
    const current = layer(), feature = current.getSource()!.getFeatures().find(item => item.get('objectId') === id)!;
    return current.getStyleFunction()!(feature, map.view.getResolution()!) as Style | Style[] | undefined;
  };
  const lineStyle = (id: string) => { const value = style(id); return Array.isArray(value) ? value.at(-1)! : value!; };
  return { props, map, root, page, motion, layer, style, lineStyle, select, selectCandidateLink, selectDevice, selectDeviceCluster, selectFault, report, submit, image, httpSubmit, save };
}

describe('冻结覆盖全域定位',()=>{
  it('全域适配所选覆盖面而非仅适配站点，关闭后不借用旧覆盖范围',async()=>{
    const s=await mountMap({resourceRead:true,withHttpCoverage:true}),f=coverageV5Case();
    s.props.planningOverlay={nodes:[],snapshotId:f.query.snapshotId};
    s.props.frozenCoverage={anchor:f.anchor,result:f.result,deviceId:'D1'};
    await nextTick();
    const flatten=(root:HostNode):HostNode[]=>[root,...root.children.flatMap(flatten)];
    const control=flatten(s.root).find(row=>row.tag==='button'&&textOf(row).includes('全域'));
    expect(control).toBeDefined();
    vi.mocked(s.map.view.fit).mockClear();(control!.props.onClick as ()=>void)();
    const expected=frozenCoverageLayer({anchor:f.anchor,result:f.result,deviceId:'D1'},f.query.snapshotId).getSource()!.getExtent();
    expect(s.map.view.fit).toHaveBeenCalledWith(expected,expect.objectContaining({maxZoom:13}));
    s.props.frozenCoverage=null;await nextTick();vi.mocked(s.map.view.fit).mockClear();
    (control!.props.onClick as ()=>void)();expect(s.map.view.fit).not.toHaveBeenCalledWith(expected,expect.objectContaining({maxZoom:13}));
  });
});

describe('地图道路后台生命周期', () => {
  // 现行道路使用MVT清单和瓦片请求；仅替换传输，真实地图和管理器仍执行。
  it('道路准备不阻塞业务图层，显隐及离页取消瓦片清单并隔离迟到响应', async () => {
    const requests: { signal: AbortSignal; finish: (value: Response) => void }[] = [];
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(finish => {
      requests.push({ signal: init!.signal as AbortSignal, finish });
    }));
    vi.stubGlobal('fetch', fetcher);
    const s = await mountMap(), roads = s.map.layers[0] as VectorTileLayer;
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(String(fetcher.mock.calls[0]![0])).toContain('demo-roads-tiles/manifest.json');
    expect(textOf(s.root)).toContain('道路加载中');
    expect(roads.getSource()).toBeNull();
    expect(s.layer().getSource()!.getFeatures()).toHaveLength(s.props.links.length);
    s.props.showRoads = false; await nextTick();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(textOf(s.root)).not.toContain('道路加载中');
    s.props.showRoads = true; await nextTick();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]!.signal.aborted).toBe(false);
    app!.unmount(); app = undefined;
    expect(requests[1]!.signal.aborted).toBe(true);
    // 故意让传输忽略abort，确认迟到返回仍不能给已卸载地图重新挂载源。
    const manifest = { format: 'mvt', layer: 'roads', version: 'a'.repeat(16), minZoom: 0, maxZoom: 14, tileSize: 256,
      bounds: [113, 36, 116, 39], ranges: Array.from({ length: 15 }, () => [0, 0, 0, 0]), tiles: `${'a'.repeat(16)}/{z}/{x}/{y}.mvt` };
    for (const request of requests) request.finish(new Response(JSON.stringify(manifest)));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(roads.getSource()).toBeNull();
    expect(s.map.dispose).toHaveBeenCalledOnce();
  });
});

describe('态势页可折叠图例', () => {
  const findNode = (root: HostNode, test: (row: HostNode) => boolean): HostNode | undefined => {
    if (test(root)) return root;
    for (const child of root.children) { const found = findNode(child, test); if (found) return found; }
  };
  const legend = (root: HostNode) => findNode(root, row => String(row.props.class).split(' ').includes('map-legend'));
  const toggle = (root: HostNode) => findNode(root, row => String(row.props.class).split(' ').includes('map-legend-toggle'));
  // 执行真实模板点击，验证只切换说明，不重绘图层或隐式定位、查询业务。
  it('默认只显示入口，展开和收起保留地图图层、视角与选择', async () => {
    const s = await mountMap({ collapsibleLegend: true, withCoverage: true });
    const layers = [...s.map.layers], before = JSON.stringify(s.props);
    const paints = s.map.setLayers.mock.calls.length, fits = vi.mocked(s.map.view.fit).mock.calls.length;
    const moves = vi.mocked(s.map.view.animate).mock.calls.length;
    expect(legend(s.root)).toBeUndefined(); expect(toggle(s.root)!.props['aria-expanded']).toBe(false);
    await (toggle(s.root)!.props.onClick as Function)(); await nextTick();
    expect(toggle(s.root)!.props['aria-expanded']).toBe(true);
    expect(textOf(legend(s.root)!)).toContain('Mock 教学场强图');
    expect(textOf(legend(s.root)!)).toContain('候选链路');
    await (toggle(s.root)!.props.onClick as Function)(); await nextTick();
    expect(legend(s.root)).toBeUndefined(); expect(toggle(s.root)!.props['aria-expanded']).toBe(false);
    expect(s.map.layers).toEqual(layers); expect(s.map.setLayers).toHaveBeenCalledTimes(paints);
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits); expect(s.map.view.animate).toHaveBeenCalledTimes(moves);
    expect(JSON.stringify(s.props)).toBe(before);
    for (const call of [s.submit, s.httpSubmit, s.save, s.image, s.report, s.select]) expect(call).not.toHaveBeenCalled();
  });
  // GIS 展示作用域独立于结果图层开关，避免改写其他地图的兼容测试。
  const deviceFrame = (): GisDeviceMapFrame => {
    const points = gisDevicePoints(initialResources()).points;
    return { points: ['HF', 'VUHF'].map(type => ({ ...points.find(row => row.deviceClass === type)!, manualStation: false })),
      settings: defaultGisDeviceSettings(), selectedDeviceId: '', version: 1 };
  };
  it('GIS 图例用样本和短标签替代说明，折叠不重绘、定位或提交业务', async () => {
    const s = await mountMap({ gisSurface: true, gis: true, collapsibleLegend: true, withCoverage: true });
    s.props.gisDeviceFrame = deviceFrame(); await nextTick();
    const layers = [...s.map.layers], before = JSON.stringify(s.props), paints = s.map.setLayers.mock.calls.length;
    const fits = vi.mocked(s.map.view.fit).mock.calls.length, moves = vi.mocked(s.map.view.animate).mock.calls.length;
    await (toggle(s.root)!.props.onClick as Function)(); await nextTick();
    const text = textOf(legend(s.root)!);
    for (const label of ['站点聚合（个）', '设备聚合（台）', '短波设备 HF', '超短波设备 VUHF']) expect(text).toContain(label);
    for (const removed of ['站点参考圆点：', '设备聚合数字：', '点击查看清单', '设备状态独立于站点', '金色外框：', '重叠色不代表合成场强', '盲区 / 未计算区域保留']) expect(text).not.toContain(removed);
    expect(findNode(legend(s.root)!, row => String(row.props.class).includes('station-cluster'))).toBeDefined();
    expect(findNode(legend(s.root)!, row => String(row.props.class).includes('device-cluster'))).toBeDefined();
    expect(text).not.toContain('人工站点');
    await (toggle(s.root)!.props.onClick as Function)(); await nextTick();
    expect(legend(s.root)).toBeUndefined(); expect(s.map.layers).toEqual(layers);
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints); expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    expect(s.map.view.animate).toHaveBeenCalledTimes(moves); expect(JSON.stringify(s.props)).toBe(before);
    for (const call of [s.submit, s.httpSubmit, s.save, s.image, s.report, s.select]) expect(call).not.toHaveBeenCalled();
  });
  it('GIS 数量、状态与人工图例跟随可见站点及设备，关闭其他图层移除对应项', async () => {
    const s = await mountMap({ gisSurface: true, gis: true }); s.props.gisDeviceFrame = deviceFrame();
    s.props.resourceMarkers = true; await nextTick();
    expect(textOf(legend(s.root)!)).not.toContain('人工站点');
    s.props.stations[0].origin = 'MANUAL'; await nextTick();
    expect(textOf(legend(s.root)!)).toContain('人工站点');
    s.props.showNodes = false; await nextTick();
    expect(textOf(legend(s.root)!)).not.toContain('站点聚合（个）'); expect(textOf(legend(s.root)!)).not.toContain('人工站点');
    expect(textOf(legend(s.root)!)).toContain('设备聚合（台）'); expect(textOf(legend(s.root)!)).toContain('正常');
    s.props.resourceMarkers = false; s.props.gisDeviceFrame.points[0].manualStation = true; await nextTick();
    expect(textOf(legend(s.root)!)).toContain('人工站点');
    s.props.gisDeviceFrame.points = []; s.props.showLinks = false; s.props.showCandidates = false;
    s.props.interferences = (initialResources().interferences ?? []).slice(0, 1); s.props.showInterferences = false; await nextTick();
    for (const label of ['设备聚合（台）', '短波设备 HF', '正常', '人工站点', '链路', '干扰源']) expect(textOf(legend(s.root)!)).not.toContain(label);
    s.props.showInterferences = true; await nextTick(); expect(textOf(legend(s.root)!)).toContain('干扰源');
    expect(s.submit).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled();
  });
  it.each([false, true])('GIS 精简不改变 resourceRead=%s 的其他地图／HTTP 原分支', async resourceRead => {
    const s = await mountMap({ gisSurface: resourceRead, resourceRead }); s.props.gisDeviceFrame = deviceFrame(); await nextTick();
    const text = textOf(legend(s.root)!);
    if (resourceRead) { expect(text).toContain('数字圆点：资源聚合'); expect(text).not.toContain('设备聚合（台）'); }
    else { expect(text).toContain('设备聚合数字：台数 · 点击查看清单'); expect(text).toContain('设备状态独立于站点'); }
  });
  it.each([false, true])('未接入折叠的 resourceRead=%s 地图保留常驻图例', async resourceRead => {
    const s = await mountMap({ resourceRead });
    expect(legend(s.root)).toBeDefined(); expect(toggle(s.root)).toBeUndefined();
  });
});

describe('地图覆盖显示与图片生命周期', () => {
  const rasterOf = (map: MapProbe) => map.layers.find(layer => layer instanceof ImageLayer) as ImageLayer<ImageSource>;
  const contourOf = (map: MapProbe) => map.layers.find(layer => layer instanceof VectorLayer
    && layer.getSource()?.getFeatures().some((feature: Feature) => feature.get('level'))) as VectorLayer;
  const contourStyle = (layer: VectorLayer) => layer.getStyleFunction()!(layer.getSource()!.getFeatures()[0], 1) as Style;
  // 检查真实模板的色块 style，避免只断言传入元数据而漏掉图例串色。
  const backgrounds = (root: HostNode): string[] => [
    ...(root.tag === 'b' && (root.props.style as { background?: string } | undefined)?.background
      ? [(root.props.style as { background: string }).background] : []), ...root.children.flatMap(backgrounds),
  ];
  const rgba = (values: number[]) => `rgba(${values[0]},${values[1]},${values[2]},${values[3] / 255})`;
  it.each([false, true])('当前覆盖图例读取自己的冻结色表（独立色表=%s），显示切换不换图或触发请求', async alternate => {
    const s = await mountMap({ withCoverage: true });
    const coverage = getPresetCoverage('balanced')!, standardColors = coverage.rasterPng!.colormap;
    // 使用当前格式的独立色表，验证渲染读取快照而非套用默认颜色。
    const alternateColors = standardColors.map((color, index) => ({ ...color, rgba: [11 + index * 20, 22, 33, 127] as [number, number, number, number] }));
    if (alternate) coverage.rasterPng!.colormap = alternateColors;
    s.props.mockCoverage = coverage;
    await nextTick();
    const raster = rasterOf(s.map), source = raster.getSource()!;
    expect((source as import('ol/source/ImageStatic').default).getUrl()).toBe('/maps/coverage/demo-v2-balanced.png');
    const expected = coverage.rasterPng!.colormap.map(color => rgba(color.rgba));
    expect(backgrounds(s.root)).toEqual(expected);expect(textOf(s.root)).toContain('弱 20');expect(textOf(s.root)).toContain('中 30');expect(textOf(s.root)).toContain('强 40');
    for (const color of alternate ? standardColors : alternateColors) expect(backgrounds(s.root)).not.toContain(rgba(color.rgba));
    const paints = s.map.setLayers.mock.calls.length, fits = vi.mocked(s.map.view.fit).mock.calls.length, before = JSON.stringify(coverage);
    source.dispatchEvent('imageloadend');await nextTick();s.map.view.setZoom(13);await nextTick();
    s.props.mockCoverageDisplay = 'contour';await nextTick();s.props.mockCoverageDisplay = 'raster';await nextTick();
    expect(backgrounds(s.root)).toEqual(expected);expect(rasterOf(s.map)).toBe(raster);expect(raster.getSource()).toBe(source);
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints);expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    expect(JSON.stringify(s.props.mockCoverage)).toBe(before);expect(s.image).not.toHaveBeenCalled();expect(s.submit).not.toHaveBeenCalled();
  });
  it('HTTP 图例保持后端非教学阈值与 RGBA，不套用强中弱名称或重绘图片', async () => {
    const s = await mountMap({ resourceRead: true, withHttpCoverage: true }), coverage = readCoverage(coverageDto());
    coverage.rasterPng!.colormap = [{ value_dbuvm: 0, rgba: [0,0,0,0] }, { value_dbuvm: 13, rgba: [11,22,33,127] }, { value_dbuvm: 47, rgba: [44,55,66,255] }];
    s.props.planningOverlay = { nodes: [], snapshotId: 'HTTP-S2', coverage };await nextTick();
    await vi.waitFor(() => expect(rasterOf(s.map)).toBeDefined());
    const raster = rasterOf(s.map), source = raster.getSource()!, imageCalls = s.image.mock.calls.length;
    source.dispatchEvent('imageloadend');await nextTick();
    expect(backgrounds(s.root)).toEqual(coverage.rasterPng!.colormap.map(color => rgba(color.rgba)));
    expect(textOf(s.root)).toContain('场强 / dBμV/m');expect(textOf(s.root)).toContain('13');expect(textOf(s.root)).toContain('47');
    expect(textOf(s.root)).not.toContain('弱');expect(textOf(s.root)).not.toContain('中 30');expect(textOf(s.root)).not.toContain('强 40');
    expect(s.image).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotId: 'HTTP-S2', raster: coverage.rasterPng }));
    const before = JSON.stringify(s.props.planningOverlay), paints = s.map.setLayers.mock.calls.length, fits = vi.mocked(s.map.view.fit).mock.calls.length;
    s.props.coverageDisplay = 'contour';await nextTick();s.props.coverageDisplay = 'raster';s.map.view.setZoom(14);await nextTick();
    expect(rasterOf(s.map)).toBe(raster);expect(raster.getSource()).toBe(source);expect(s.image).toHaveBeenCalledTimes(imageCalls);
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints);expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    expect(JSON.stringify(s.props.planningOverlay)).toBe(before);expect(s.httpSubmit).not.toHaveBeenCalled();expect(s.save).not.toHaveBeenCalled();
  });
  it('Mock实际显示切换与缩放复用图层，自动叠边线不填充PNG颜色', async () => {
    const s = await mountMap({ withCoverage: true }), raster = rasterOf(s.map), contour = contourOf(s.map), source = raster.getSource()!;
    const geometry = contour.getSource()!.getFeatures()[0].getGeometry()!.clone();
    const before = JSON.stringify(s.props.mockCoverage), paints = s.map.setLayers.mock.calls.length;
    expect(s.map.layers.indexOf(raster)).toBeLessThan(s.map.layers.indexOf(contour));
    expect(contour.getVisible()).toBe(true);source.dispatchEvent('imageloadend');await nextTick();
    expect(raster.getVisible()).toBe(true);expect(contour.getVisible()).toBe(false);
    s.map.view.setZoom(13);await nextTick();expect(raster.getVisible()).toBe(true);expect(contour.getVisible()).toBe(true);expect(contourStyle(contour).getFill()).toBeNull();
    s.props.mockCoverageDisplay='raster';await nextTick();expect(contour.getVisible()).toBe(false);
    s.map.view.setZoom(9);s.props.mockCoverageDisplay='contour';await nextTick();
    expect(raster.getVisible()).toBe(false);expect(contour.getVisible()).toBe(true);expect(contourStyle(contour).getFill()).not.toBeNull();
    s.map.view.setZoom(15);await nextTick();expect(raster.getVisible()).toBe(false);
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints);expect(raster.getSource()).toBe(source);
    expect(contour.getSource()!.getFeatures()[0].getGeometry()!.getExtent()).toEqual(geometry.getExtent());
    expect(JSON.stringify(s.props.mockCoverage)).toBe(before);expect(s.submit).not.toHaveBeenCalled();expect(s.image).not.toHaveBeenCalled();
  });
  it('HTTP加载成功和失败只切换原图层，手动偏好不触发业务请求，重试读取图片', async () => {
    const s = await mountMap({ resourceRead: true, withHttpCoverage: true });
    await vi.waitFor(()=>expect(rasterOf(s.map)).toBeDefined());
    const raster = rasterOf(s.map), contour = contourOf(s.map), source = raster.getSource()!;
    const before = JSON.stringify(s.props.planningOverlay), paints = s.map.setLayers.mock.calls.length;
    expect(s.map.layers.indexOf(raster)).toBeLessThan(s.map.layers.indexOf(contour));
    source.dispatchEvent('imageloadstart');await nextTick();expect(textOf(s.root)).toContain('覆盖图层加载中');expect(contour.getVisible()).toBe(true);
    source.dispatchEvent('imageloadend');await nextTick();expect(raster.getVisible()).toBe(true);expect(contour.getVisible()).toBe(false);
    s.map.view.setZoom(13);await nextTick();expect(contour.getVisible()).toBe(true);expect(contourStyle(contour).getFill()).toBeNull();
    s.props.coverageDisplay='raster';await nextTick();expect(contour.getVisible()).toBe(false);
    source.dispatchEvent('imageloaderror');await nextTick();expect(raster.getVisible()).toBe(false);expect(contour.getVisible()).toBe(true);expect(textOf(s.root)).toContain('覆盖 PNG 显示失败');
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints);expect(raster.getSource()).toBe(source);expect(s.props.coverageDisplay).toBe('raster');
    const retry = (n: HostNode): HostNode | undefined => n.tag==='button' && textOf(n)==='重试覆盖图片' ? n : n.children.map(retry).find(Boolean);
    (retry(s.root)!.props.onClick as ()=>void)();
    await vi.waitFor(()=>expect(rasterOf(s.map)).not.toBe(raster));
    const current = rasterOf(s.map), currentContour = contourOf(s.map);current.getSource()!.dispatchEvent('imageloadend');await nextTick();
    expect(current.getVisible()).toBe(true);expect(currentContour.getVisible()).toBe(false);
    source.dispatchEvent('imageloaderror');await nextTick();expect(current.getVisible()).toBe(true);expect(textOf(s.root)).not.toContain('覆盖 PNG 显示失败');
    s.props.coverageDisplay='contour';s.map.view.setZoom(9);await nextTick();expect(current.getVisible()).toBe(false);expect(currentContour.getVisible()).toBe(true);
    expect(s.image).toHaveBeenCalledTimes(2);expect(s.httpSubmit).not.toHaveBeenCalled();expect(s.save).not.toHaveBeenCalled();expect(JSON.stringify(s.props.planningOverlay)).toBe(before);
    s.props.planningOverlay={nodes:[]};s.props.coverageDisplay='auto';await nextTick();
    current.getSource()!.dispatchEvent('imageloaderror');await nextTick();expect(textOf(s.root)).not.toContain('覆盖 PNG 显示失败');expect(rasterOf(s.map)).toBeUndefined();
  });
});

describe('地图链路动态展示接入', () => {
  it('规划线点选受开关控制，候选线不触发详情，选中后沿用两端定位', async () => {
    const s = await mountMap(), link = s.props.links[0];
    const click = () => s.map.handlers.get('singleclick')!({ pixel: [1, 1], coordinate: [0, 0] });
    s.map.picked = s.layer().getSource()!.getFeatures().find(feature => feature.get('objectId') === link.id);
    s.props.selectLinks = false; await nextTick(); click(); expect(s.select).not.toHaveBeenCalled();
    s.props.selectLinks = true; await nextTick(); click(); expect(s.select).toHaveBeenCalledExactlyOnceWith(link.id);
    const candidate = s.map.layers.filter(layer => layer instanceof VectorLayer).flatMap(layer => (layer as VectorLayer).getSource()!.getFeatures())
      .find((feature: Feature) => feature.get('kind') === 'candidate-workset-link');
    expect(candidate).toBeDefined(); s.map.picked = candidate; click(); expect(s.select).toHaveBeenCalledTimes(1);
    // 传入选中 ID 即使用原 fit 逻辑，不新增地图定位实现。
    s.props.selectedLinkId = link.id; await nextTick();
    const points = [link.a, link.b].map(id => fromLonLat(s.props.stations.find(row => row.id === id)!.coordinate));
    expect(s.map.view.fit).toHaveBeenLastCalledWith([
      Math.min(points[0][0], points[1][0]), Math.min(points[0][1], points[1][1]),
      Math.max(points[0][0], points[1][0]), Math.max(points[0][1], points[1][1]),
    ], expect.objectContaining({ maxZoom: 12, duration: 300 }));
    expect(s.submit).not.toHaveBeenCalled();
  });
  it('选中故障链路保留故障质量颜色与粗线，未改写链路状态', async () => {
    const s = await mountMap(), before = JSON.stringify(s.props.links);
    s.props.selectedLinkId = 'LINK-B'; s.props.highlightLinkIds = ['LINK-B']; await nextTick();
    expect(s.style('LINK-B')).toHaveLength(2); expect(s.lineStyle('LINK-B').getStroke()!.getColor()).toBe('#ef5f64');
    expect(s.lineStyle('LINK-B').getStroke()!.getWidth()).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(s.props.links)).toBe(before);
  });
  it('实际缩放事件简化并恢复同一要素和图片源，图例只说明已简化', async () => {
    const s = await mountMap({ withCoverage: true }), layer = s.layer();
    const features = layer.getSource()!.getFeatures(), layers = [...s.map.layers];
    const raster = layers.find(item => item instanceof ImageLayer) as ImageLayer<ImageSource>, source = raster.getSource();
    const before = JSON.stringify(s.props.links), paints = s.map.setLayers.mock.calls.length;
    expect(s.style('LINK-C')).toBeUndefined(); expect(s.style('LINK-B')).toBeDefined();
    expect(textOf(s.root)).toContain('拓扑已简化'); expect(textOf(s.root)).not.toContain('请放大');
    s.map.view.setZoom(10); await nextTick();
    expect(s.style('LINK-C')).toBeDefined(); expect(textOf(s.root)).not.toContain('拓扑已简化');
    s.map.view.setZoom(9.5); await nextTick(); expect(s.style('LINK-C')).toBeUndefined();
    vi.advanceTimersByTime(1200); await nextTick();
    expect(s.layer()).toBe(layer); expect(layer.getSource()!.getFeatures()).toEqual(features);
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints); expect(s.map.layers).toEqual(layers);
    expect(raster.getSource()).toBe(source); expect(JSON.stringify(s.props.links)).toBe(before);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled();
  });
  it('选中或高亮普通链路时保留，取消关注后重新简化', async () => {
    const s = await mountMap(); expect(s.style('LINK-C')).toBeUndefined();
    s.props.selectedLinkId = 'LINK-C'; await nextTick(); expect(s.style('LINK-C')).toBeDefined();
    expect(textOf(s.root)).not.toContain('拓扑已简化');
    s.props.selectedLinkId = ''; s.props.highlightLinkIds = ['LINK-C']; await nextTick();
    expect(s.style('LINK-C')).toHaveLength(2);
    s.props.highlightLinkIds = []; await nextTick(); expect(s.style('LINK-C')).toBeUndefined();
  });
  it('暗相仍有故障样式和原点选事件；关闭图层、移除故障与离页均停止动画', async () => {
    const s = await mountMap(), before = JSON.stringify(s.props.links);
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(600);
    expect(s.lineStyle('LINK-B').getStroke()!.getColor()).toBe('#ef5f6466');
    s.map.picked = s.layer().getSource()!.getFeatures().find(feature => feature.get('objectId') === 'LINK-B');
    s.map.handlers.get('singleclick')!({ pixel: [1, 1], coordinate: [0, 0] });
    expect(s.select).toHaveBeenCalledWith('LINK-B'); expect(JSON.stringify(s.props.links)).toBe(before);
    s.props.showLinks = false; await nextTick();
    expect(vi.getTimerCount()).toBe(0); expect(s.layer().getVisible()).toBe(false);
    expect(textOf(s.root)).not.toContain('拓扑已简化');
    s.props.showLinks = true; await nextTick(); expect(vi.getTimerCount()).toBe(1);
    const retired = s.layer(), changed = vi.spyOn(retired, 'changed');
    s.props.links = s.props.links.filter(link => link.state !== 'FAULT'); await nextTick();
    changed.mockClear(); vi.advanceTimersByTime(1200);
    expect(changed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    app!.unmount(); app = undefined; expect(s.map.dispose).toHaveBeenCalledOnce();
  });
  it('缺失端点不恢复故障，不显示无实际隐藏链路的简化提示', async () => {
    const s = await mountMap(); s.props.stations = s.props.stations.filter(station => station.id !== 'ND-0004');
    await nextTick(); expect(s.layer().getSource()!.getFeatures()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0); expect(textOf(s.root)).not.toContain('拓扑已简化');
  });
  it('减少动态效果和后台事件作用于实际地图，离页解绑且不再重绘', async () => {
    const s = await mountMap({ reduced: true }); expect(vi.getTimerCount()).toBe(0);
    s.motion.matches = false; s.motion.dispatchEvent(new Event('change')); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(600); s.page.hidden = true; s.page.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0); expect(s.lineStyle('LINK-B').getStroke()!.getColor()).toBe('#ef5f64');
    s.page.hidden = false; s.page.dispatchEvent(new Event('visibilitychange')); expect(vi.getTimerCount()).toBe(1);
    const layer = s.layer(), changed = vi.spyOn(layer, 'changed'), removePage = vi.spyOn(s.page, 'removeEventListener');
    app!.unmount(); app = undefined; changed.mockClear();
    s.motion.dispatchEvent(new Event('change')); s.page.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(3000);
    expect(vi.getTimerCount()).toBe(0); expect(changed).not.toHaveBeenCalled();
    expect(removePage).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
  it('HTTP 模式不启用 Mock 简化和闪烁，来回切换只管理当前图层', async () => {
    const s = await mountMap({ resourceRead: true }); expect(vi.getTimerCount()).toBe(0);
    expect(textOf(s.root)).not.toContain('拓扑已简化'); expect(s.layer()).toBeUndefined();
    s.props.resourceRead = false; await nextTick(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(600); const retired = s.layer(), changed = vi.spyOn(retired, 'changed');
    s.props.resourceRead = true; await nextTick(); changed.mockClear();
    vi.advanceTimersByTime(2400); expect(vi.getTimerCount()).toBe(0); expect(changed).not.toHaveBeenCalled();
    s.props.resourceRead = false; await nextTick(); expect(vi.getTimerCount()).toBe(1);
    expect(s.lineStyle('LINK-B').getStroke()!.getColor()).toBe('#ef5f64');
  });
  it('旧快照缺少标记时不简化，状态变化仅影响动画和当前绘制', async () => {
    const s = await mountMap(); s.props.links = structuredClone(planningPresets[0].result!.links); await nextTick();
    expect(vi.getTimerCount()).toBe(0); expect(textOf(s.root)).not.toContain('拓扑已简化');
    for (const link of s.props.links) expect(s.style(link.id)).toBeDefined();
    s.props.links[1].state = 'FAULT'; await nextTick(); expect(vi.getTimerCount()).toBe(1);
    s.props.links[1].state = 'GOOD'; await nextTick(); expect(vi.getTimerCount()).toBe(0);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled();
  });
});

describe('GIS 设备层在实际地图组件中的可选接入', () => {
  const frame = (count: number): GisDeviceMapFrame => ({ points: gisDevicePoints(initialResources()).points.slice(0, count),
    settings: defaultGisDeviceSettings(), selectedDeviceId: '', version: 1 });
  function deviceLayer(s: Awaited<ReturnType<typeof mountMap>>) {
    return s.map.layers.find(layer => layer instanceof VectorLayer && layer.getSource() instanceof Cluster
      && layer.getSource().getSource()?.getFeatures().some((f: Feature) => f.get('devicePoint'))) as VectorLayer<Cluster>;
  }
  function refresh(s: Awaited<ReturnType<typeof mountMap>>) {
    const source = deviceLayer(s).getSource()!;
    source.loadFeatures([-Infinity, -Infinity, Infinity, Infinity], s.map.view.getResolution()!, projection('EPSG:3857')!);
    return source;
  }
  const click = (s: Awaited<ReturnType<typeof mountMap>>) => s.map.handlers.get('singleclick')!({ pixel: [1, 1], coordinate: [0, 0] });
  it('公共点位与富图层组合，切入冻结网络后移除公共底层', async () => {
    const s = await mountMap({ resourceRead: true, gis: true, gisSurface: true, topologyOpacity: 1 });
    const node = s.props.stations[0]; node.origin = 'MANUAL'; s.props.resourceMarkers = true;
    s.props.richScene = true; s.props.gisDeviceFrame = frame(2);
    s.props.resourceFrame = { revision: 'R1', bbox: [113, 36, 116, 39], zoom: 9, clusters: [], totalNodes: 1, totalInterferences: 0,
      points: [{ kind: 'node', id: node.id, name: node.name, coordinate: node.coordinate, status: node.status, alert: node.alert, active: null }] };
    await nextTick();
    const base = s.map.layers.find(layer => layer instanceof VectorLayer && layer.getSource()?.getFeatures().some((feature: Feature) => feature.get('kind') === 'resource-read-point')) as VectorLayer;
    expect(base.getSource()!.getFeatures()).toHaveLength(1); expect(s.layer().getVisible()).toBe(true); expect(deviceLayer(s)).toBeDefined();
    const styles = base.getStyleFunction()!(base.getSource()!.getFeatures()[0], 1) as Style[];
    expect((styles[0].getImage() as import('ol/style/Circle').default).getStroke()!.getColor()).toBe('#dcb976');
    expect(s.map.layers.some(layer => layer instanceof VectorLayer && layer.getSource() instanceof Cluster && layer.getSource().getSource()?.getFeatures().some((feature: Feature) => feature.get('station')))).toBe(false);
    s.props.resourceRead = false; await nextTick(); expect(s.map.layers).not.toContain(base);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.httpSubmit).not.toHaveBeenCalled();
  });
  it('单设备点返回精确设备身份与显示版本，关闭站点参考点不关闭设备层', async () => {
    const s = await mountMap(); s.props.gisDeviceFrame = frame(1); s.props.showNodes = false; await nextTick();
    const source = refresh(s), fits = vi.mocked(s.map.view.fit).mock.calls.length;
    s.map.picked = source.getFeatures()[0]; click(s);
    expect(s.selectDevice).toHaveBeenCalledExactlyOnceWith('DV-0001', 1); expect(s.selectDeviceCluster).not.toHaveBeenCalled();
    expect(deviceLayer(s).getVisible()).toBe(true); expect(textOf(s.root)).toContain('短波设备 HF');
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits); expect(s.submit).not.toHaveBeenCalled();
  });
  it('聚合点击只发送成员清单，不自动缩放；旧聚合要素失效后不能再次选中', async () => {
    const s = await mountMap(); s.props.gisDeviceFrame = frame(3); await nextTick(); const source = refresh(s);
    const previous = source.getFeatures()[0], fits = vi.mocked(s.map.view.fit).mock.calls.length;
    s.map.picked = previous; click(s);
    expect(s.selectDeviceCluster).toHaveBeenCalledOnce(); expect([...s.selectDeviceCluster.mock.calls[0][0]].sort()).toEqual(['DV-0001', 'DV-0002', 'DV-0003']);
    expect(s.selectDevice).not.toHaveBeenCalled(); expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    s.props.gisDeviceFrame.points = s.props.gisDeviceFrame.points.slice(1); s.props.gisDeviceFrame.version++; await nextTick();
    refresh(s); click(s); expect(s.selectDeviceCluster).toHaveBeenCalledOnce();
  });
  it('透明度、状态与选中更新不触发请求或定位，保留覆盖图片源与设备几何缓存', async () => {
    const s = await mountMap({ withCoverage: true }); s.props.gisDeviceFrame = frame(2); await nextTick();
    const source = refresh(s), raw = source.getSource()!.getFeatures()[0], raster = s.map.layers.find(l => l instanceof ImageLayer) as ImageLayer<ImageSource>;
    const imageSource = raster.getSource(), fits = vi.mocked(s.map.view.fit).mock.calls.length;
    s.props.gisDeviceFrame.settings.HF.opacity = 0.3; s.props.gisDeviceFrame.version++; await nextTick();
    expect(source.getSource()!.getFeatures()[0]).toBe(raw); expect(deviceLayer(s).getSource()).toBe(source);
    s.props.gisDeviceFrame.selectedDeviceId = 'DV-0002'; await nextTick();
    expect(source.getSource()!.getFeatures()[0]).toBe(raw); expect(raster.getSource()).toBe(imageSource);
    s.props.gisDeviceFrame = undefined; await nextTick(); expect(deviceLayer(s)).toBeUndefined();
    expect(s.map.layers).toContain(raster); expect(raster.getSource()).toBe(imageSource); expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled();
  });
  it('未接入及 HTTP 模式沿用原站点图层，旧设备图层点击被拒绝', async () => {
    const s = await mountMap(); expect(deviceLayer(s)).toBeUndefined(); expect(textOf(s.root)).not.toContain('设备聚合数字');
    s.props.gisDeviceFrame = frame(2); await nextTick(); s.map.picked = refresh(s).getFeatures()[0];
    // 等父级属性传入地图后再点击，验证旧图层不能绕过 HTTP 模式隔离。
    s.props.resourceRead = true; await nextTick(); click(s);
    expect(deviceLayer(s)).toBeUndefined(); expect(textOf(s.root)).toContain('数字圆点：资源聚合');
    expect(textOf(s.root)).not.toContain('设备聚合数字'); expect(s.selectDeviceCluster).not.toHaveBeenCalled();
  });
});

describe('GIS 结果分组在实际地图组件中渲染', () => {
  const regions = (): MapRegion[] => ['coverage', 'blind', 'uncalculated', 'impact'].map(kind => ({
    id: 'r-' + kind, kind: kind as MapRegion['kind'], label: '来源区域', rings: [[[114, 37], [115, 37], [115, 38], [114, 37]]],
  }));
  const vector = (s: Awaited<ReturnType<typeof mountMap>>, match: (feature: Feature) => boolean) =>
    s.map.layers.find(layer => layer instanceof VectorLayer && layer.getSource()?.getFeatures().some(match)) as VectorLayer;
  const group = (s: Awaited<ReturnType<typeof mountMap>>, kind: string) => vector(s, f => f.get('region')?.kind === kind);
  async function attachAnalysis(s: Awaited<ReturnType<typeof mountMap>>) {
    const fixture = await interferenceFixture(), submitted = await fixture.submit(); fixture.advance();
    const loaded = await fixture.service.loadInterferenceWorkspace(), view = loaded.views.find(v => v.run.analysisId === submitted.view.run.analysisId)!;
    s.props.interferenceImpact = view.result!.impact; s.props.interferences = view.run.sources; await nextTick();
  }
  it('三组分别显隐与调透明度，关闭干扰区域仍保留受扰对象和源点及图例', async () => {
    const s = await mountMap({ gis: true }); s.props.regions = regions(); await attachAnalysis(s);
    const before = JSON.stringify([s.props.regions, s.props.interferenceImpact]), config = s.props.gisResultLayers!;
    config.coverage.opacity = 0.3; config.illustration.opacity = 0.6; config.interference.opacity = 0.4; await nextTick();
    expect(group(s, 'coverage')).toBe(group(s, 'blind')); expect(group(s, 'blind')).toBe(group(s, 'uncalculated'));
    expect(group(s, 'coverage').getOpacity()).toBe(0.3); expect(group(s, 'impact').getOpacity()).toBe(0.6);
    expect(vector(s, f => f.get('kind') === 'interference-region').getOpacity()).toBe(0.4);
    config.coverage.visible = false; config.interference.visible = false; await nextTick();
    expect(group(s, 'coverage').getVisible()).toBe(false); expect(group(s, 'impact').getVisible()).toBe(true);
    expect(vector(s, f => f.get('kind') === 'interference-region').getVisible()).toBe(false);
    expect(vector(s, f => f.get('kind') === 'interference-node').getVisible()).toBe(true);
    expect(vector(s, f => f.get('kind') === 'interference-source').getVisible()).toBe(true);
    expect(textOf(s.root)).not.toContain('▱ 覆盖'); expect(textOf(s.root)).not.toContain('干扰分析区域：');
    expect(textOf(s.root)).toContain('受扰对象：'); expect(textOf(s.root)).toContain('原有影响示意区域');
    config.illustration.opacity = 0; await nextTick(); expect(textOf(s.root)).not.toContain('原有影响示意区域');
    expect(JSON.stringify([s.props.regions, s.props.interferenceImpact])).toBe(before);
  });
  it('显示调整保留场强图片源，不触发业务请求或定位；加载/失败提示随覆盖组开关', async () => {
    const s = await mountMap({ gis: true, withCoverage: true }); s.props.regions = regions();
    s.map.view.setZoom(11); await nextTick(); // 自动模式仅在场强图可见的缩放级别报告加载状态。
    const raster = s.map.layers.find(layer => layer instanceof ImageLayer) as ImageLayer<ImageSource>, source = raster.getSource()!;
    const fits = vi.mocked(s.map.view.fit).mock.calls.length, animations = vi.mocked(s.map.view.animate).mock.calls.length;
    source.dispatchEvent('imageloadstart'); await nextTick(); expect(textOf(s.root)).toContain('教学场强图加载中');
    s.props.gisResultLayers!.coverage.visible = false; await nextTick();
    expect(textOf(s.root)).not.toContain('教学场强图加载中'); expect(raster.getVisible()).toBe(false);
    source.dispatchEvent('imageloaderror'); await nextTick(); expect(textOf(s.root)).not.toContain('教学场强图加载失败');
    s.props.gisResultLayers!.coverage.visible = true; s.props.gisResultLayers!.coverage.opacity = 0.4; await nextTick();
    expect(textOf(s.root)).toContain('教学场强图加载失败'); expect(s.map.layers).toContain(raster);
    expect(raster.getSource()).toBe(source); expect(raster.getOpacity()).toBe(0.4);
    s.props.gisResultLayers!.illustration.visible = false; s.map.view.setZoom(11); await nextTick();
    expect(raster.getSource()).toBe(source); expect(s.map.view.fit).toHaveBeenCalledTimes(fits);
    expect(s.map.view.animate).toHaveBeenCalledTimes(animations); expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled();
  });
  it('设备透明度相乘、盲区同行控制，切换组不清除逐台设置或重建图片', async () => {
    const s = await mountMap({ gis: true }), samples = loadDeviceCoverageCatalog().samples.slice(0, 2);
    s.props.regions = regions(); s.props.deviceCoverageActive = true;
    s.props.deviceCoverages = samples.map((sample, i) => ({ sample, representation: 'field' as const, visible: i === 0, opacity: i === 0 ? 0.4 : 0.7 }));
    s.props.gisResultLayers!.coverage.opacity = 0.5; await nextTick();
    const rasters = s.map.layers.filter(layer => layer instanceof ImageLayer) as ImageLayer<ImageSource>[], sources = rasters.map(layer => layer.getSource());
    expect(rasters.map(layer => layer.getOpacity())).toEqual([0.2, 0.35]);
    expect(group(s, 'coverage')).toBeUndefined(); // 设备模式不叠加整网覆盖。
    const deviceBlind = vector(s, f => f.get('region')?.id === samples[0].regions[0].id);
    expect(deviceBlind.getOpacity()).toBe(0.2); expect(deviceBlind.getVisible()).toBe(true);
    expect(textOf(s.root)).toContain(samples[0].deviceId); expect(textOf(s.root)).not.toContain(samples[1].deviceId);
    s.props.gisResultLayers!.coverage.visible = false; await nextTick();
    expect(deviceBlind.getVisible()).toBe(false); expect(group(s, 'impact').getVisible()).toBe(true);
    expect(textOf(s.root)).not.toContain('设备覆盖 · Mock');
    s.props.gisResultLayers!.coverage.visible = true; await nextTick();
    expect(deviceBlind.getVisible()).toBe(true); expect(rasters.map(layer => layer.getSource())).toEqual(sources);
    expect(rasters.every(layer => s.map.layers.includes(layer))).toBe(true);
    expect(s.props.deviceCoverages.map(row => [row.visible, row.opacity])).toEqual([[true, 0.4], [false, 0.7]]);
    s.props.deviceCoverages[0].opacity = 0; await nextTick(); expect(textOf(s.root)).not.toContain('设备覆盖 · Mock');
  });
  it('设备空选择与空结果不显示覆盖图例或恢复整网，但保留现有示意', async () => {
    const s = await mountMap({ gis: true }); expect(textOf(s.root)).not.toContain('▱ 覆盖');
    expect(textOf(s.root)).not.toContain('原有影响示意区域');
    s.props.regions = regions(); s.props.deviceCoverageActive = true; await nextTick();
    expect(group(s, 'coverage')).toBeUndefined(); expect(textOf(s.root)).not.toContain('▱ 覆盖');
    expect(textOf(s.root)).not.toContain('设备覆盖 · Mock'); expect(group(s, 'impact').getVisible()).toBe(true);
  });
  it('未传配置保留规划/诊断共用开关语义和原图例', async () => {
    const s = await mountMap(); s.props.regions = regions(); await attachAnalysis(s);
    s.props.showCoverage = false; s.props.opacity = 0.25; await nextTick();
    expect(group(s, 'coverage')).toBe(group(s, 'impact')); expect(group(s, 'impact').getVisible()).toBe(false);
    expect(group(s, 'impact').getOpacity()).toBe(0.25);
    expect(vector(s, f => f.get('kind') === 'interference-region').getVisible()).toBe(false);
    expect(textOf(s.root)).toContain('干扰：严重 / 中等 / 轻微'); expect(textOf(s.root)).toContain('▱ 覆盖');
    expect(textOf(s.root)).not.toContain('原有影响示意区域');
  });
  it('HTTP 地图忽略 GIS 配置且沿用原图层和图例', async () => {
    const s = await mountMap({ gis: true, resourceRead: true }), before = s.map.layers.map(layer => layer.constructor.name);
    s.props.regions = regions(); s.props.gisResultLayers!.coverage.visible = false; s.props.gisResultLayers!.illustration.opacity = 0.2; await nextTick();
    expect(s.map.layers.map(layer => layer.constructor.name)).toEqual(before); expect(group(s, 'impact')).toBeUndefined();
    expect(textOf(s.root)).toContain('数字圆点：资源聚合'); expect(textOf(s.root)).not.toContain('原有影响示意区域');
    expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled();
  });
  it('诊断区域独立显隐与透明度，隐藏不清除场景注入、对象高亮或冻结状态', async () => {
    const s = await mountMap({ gis: true });
    // 直接提供完整报告已有显示字段，地图不需要查询或推断影响。
    s.props.diagnosisRegions = [
      { ...regions()[3], id: 'DG-SEVERE', level: 'SEVERE', faultKey: null },
      { ...regions()[3], id: 'DG-UNKNOWN', level: null, faultKey: null },
    ];
    s.props.diagnosisFaults = [{ objectType: 'NODE', objectId: s.props.stations[0].id, faultType: 'HW_FAILURE', symptomIds: [], occurTime: null, interferenceId: null }];
    s.props.highlightLinkIds = [s.props.links[0].id];
    s.props.showCoverage = false; s.props.gisResultLayers!.diagnosis.opacity = 0.4; await nextTick();
    const before = JSON.stringify([s.props.links, s.props.stations, s.props.diagnosisRegions, s.props.diagnosisFaults]);
    const impact = () => vector(s, f => f.get('kind') === 'diagnosis-impact');
    const fault = () => vector(s, f => f.get('kind') === 'diagnosis-fault');
    const fits = vi.mocked(s.map.view.fit).mock.calls.length, animations = vi.mocked(s.map.view.animate).mock.calls.length;
    expect(impact().getVisible()).toBe(true); expect(impact().getOpacity()).toBe(0.4);
    const legend = textOf(s.root); expect(legend).toContain('诊断影响区域 · 严重'); expect(legend).toContain('诊断影响区域 · 未提供等级');
    expect(legend).not.toContain('诊断影响区域 · 一般'); expect(legend).not.toContain('诊断影响区域 · 轻微');
    const unknown = impact().getSource()!.getFeatures().find(f => f.get('objectId') === 'DG-UNKNOWN')!;
    expect((impact().getStyleFunction()!(unknown, 1) as Style).getFill()!.getColor()).toBe('#93a0b340');
    s.props.gisResultLayers!.diagnosis.visible = false; await nextTick();
    expect(impact().getVisible()).toBe(false); expect(textOf(s.root)).not.toContain('诊断影响区域 ·');
    expect(fault().getVisible()).toBe(true); expect(s.style(s.props.links[0].id)).toHaveLength(2);
    expect(textOf(s.root)).toContain('场景注入 · 硬件故障');
    s.map.picked = fault().getSource()!.getFeatures()[0]; s.map.handlers.get('singleclick')!({ pixel: [1, 1], coordinate: [0, 0] });
    expect(s.selectFault).toHaveBeenCalledExactlyOnceWith('NODE', s.props.stations[0].id);
    s.props.gisResultLayers!.diagnosis.visible = true; s.props.gisResultLayers!.diagnosis.opacity = 0; await nextTick();
    expect(impact().getVisible()).toBe(false); expect(impact().getOpacity()).toBe(0); expect(textOf(s.root)).not.toContain('诊断影响区域 ·');
    s.props.gisResultLayers!.diagnosis.opacity = 1; await nextTick();
    expect(impact().getVisible()).toBe(true); expect(impact().getOpacity()).toBe(1);
    s.map.view.setZoom(12); await nextTick();
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits); expect(s.map.view.animate).toHaveBeenCalledTimes(animations);
    expect(JSON.stringify([s.props.links, s.props.stations, s.props.diagnosisRegions, s.props.diagnosisFaults])).toBe(before);
    expect(s.report).not.toHaveBeenCalled(); expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled();
  });
  it('诊断筛选使用传入区域更新实际图例，空区域不留下旧等级', async () => {
    const s = await mountMap({ gis: true });
    s.props.diagnosisRegions = [
      { ...regions()[3], id: 'DG-MODERATE', level: 'MODERATE', faultKey: null },
      { ...regions()[3], id: 'DG-MINOR', level: 'MINOR', faultKey: null },
    ]; await nextTick();
    expect(textOf(s.root)).toContain('诊断影响区域 · 一般'); expect(textOf(s.root)).toContain('诊断影响区域 · 轻微');
    s.props.diagnosisRegions = [s.props.diagnosisRegions[1]]; await nextTick();
    expect(textOf(s.root)).not.toContain('诊断影响区域 · 一般'); expect(textOf(s.root)).toContain('诊断影响区域 · 轻微');
    expect(vector(s, f => f.get('kind') === 'diagnosis-impact').getSource()!.getFeatures()).toHaveLength(1);
    s.props.diagnosisRegions = []; await nextTick(); expect(textOf(s.root)).not.toContain('诊断影响区域 ·');
    expect(vector(s, f => f.get('kind') === 'diagnosis-impact')).toBeUndefined(); expect(s.report).not.toHaveBeenCalled();
  });
  it('未传 GIS 配置的诊断页保留原总透明度和独立区域显隐语义', async () => {
    const s = await mountMap(); s.props.showCoverage = false; s.props.opacity = 0.25;
    s.props.diagnosisRegions = [{ ...regions()[3], level: 'SEVERE', faultKey: null }]; await nextTick();
    const impact = vector(s, f => f.get('kind') === 'diagnosis-impact');
    expect(impact.getVisible()).toBe(true); expect(impact.getOpacity()).toBe(0.25);
    expect(textOf(s.root)).toContain('影响：严重 / 一般 / 轻微'); expect(textOf(s.root)).not.toContain('诊断影响区域 ·');
    s.props.opacity = 0; await nextTick(); expect(vector(s, f => f.get('kind') === 'diagnosis-impact').getVisible()).toBe(true);
    expect(textOf(s.root)).toContain('影响：严重 / 一般 / 轻微'); expect(s.report).not.toHaveBeenCalled();
  });
});

describe('独立候选维护地图图层', () => {
  const candidate = (link: NetworkLink): CandidateLink => ({
    id: link.id, nodeAId: link.a, nodeBId: link.b, deviceAId: link.deviceA, deviceBId: link.deviceB,
    deviceClass: link.deviceClass, freqKhz: link.frequencyKhz, bandwidthKhz: null, isBackup: false,
    distanceM: null, pathLossDb: null, rxPowerDbm: null, linkMarginDb: null, isAvailable: null, linkState: null,
    assessmentState: 'PENDING', reference: null, source: { kind: 'MANUAL', file: null, row: null },
  });
  type Mounted = Awaited<ReturnType<typeof mountMap>>;
  const layerOf = (s: Mounted) => s.map.layers.find(layer => layer instanceof VectorLayer
    && layer.getSource()?.getFeatures().some((feature: Feature) => feature.get('kind') === 'candidate-workset-link')) as ReturnType<typeof candidateLinkLayer> | undefined;
  const click = (s: Mounted, feature: Feature) => {
    s.map.picked = feature; s.map.handlers.get('singleclick')!({ pixel: [1, 1], coordinate: [0, 0] });
  };
  it('使用完整候选端点绘制筛选集合，所有参考质量均是中性虚线且 ID 与正式线分离', async () => {
    const s = await mountMap({ topologyOpacity: 0 }), row = candidate(s.props.links[0]);
    s.props.candidateStations = [...s.props.stations]; s.props.stations = [];
    s.props.candidateWorkset = [row, { ...row, id: 'OTHER', linkState: 'FAULT', isAvailable: true }];
    await nextTick();
    const layer = layerOf(s)!, features = layer.getSource()!.getFeatures();
    expect(features).toHaveLength(2); expect(features[0].getId()).toBe(`candidate:${row.id}`);
    expect(features[0].get('kind')).toBe('candidate-workset-link');
    const styles = features.map(feature => layer.getStyleFunction()!(feature, 1) as Style);
    expect(styles[0].getStroke()!.getColor()).toBe(styles[1].getStroke()!.getColor());
    expect(styles[0].getStroke()!.getLineDash()).toEqual([5, 5]);
    expect(layer.getVisible()).toBe(true); expect(layer.getOpacity()).toBe(1);
    click(s, features[0]); expect(s.selectCandidateLink).toHaveBeenCalledExactlyOnceWith(row.id); expect(s.select).not.toHaveBeenCalled();
    expect(textOf(s.root)).toContain('候选链路'); expect(textOf(s.root)).toContain('非当前评估');
    expect(s.submit).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled();
  });
  it('隐藏候选选择仍定位，正式透明度变化不改变候选显隐或再次定位', async () => {
    const s = await mountMap({ topologyOpacity: 0.3 }), row = candidate(s.props.links[0]);
    s.props.candidateWorkset = [row]; s.props.showCandidates = false; await nextTick();
    const fits = vi.mocked(s.map.view.fit).mock.calls.length;
    s.props.selectedCandidateLinkId = row.id; await nextTick();
    const layer = layerOf(s)!, feature = layer.getSource()!.getFeatures()[0];
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits + 1); expect(layer.getVisible()).toBe(false); expect(s.props.showCandidates).toBe(false);
    click(s, feature); expect(s.selectCandidateLink).not.toHaveBeenCalled();
    s.props.topologyOpacity = 0; await nextTick(); expect(layer.getVisible()).toBe(false); expect(layer.getOpacity()).toBe(1);
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits + 1);
    s.props.showCandidates = true; await nextTick();
    expect(layerOf(s)!.getVisible()).toBe(true); expect(s.map.view.fit).toHaveBeenCalledTimes(fits + 1);
    const selectedStyle = layerOf(s)!.getStyleFunction()!(layerOf(s)!.getSource()!.getFeatures()[0], 1) as Style;
    expect(selectedStyle.getText()!.getText()).toBe(`候选 · ${row.id}`);
  });
  it('切换集合或模式后拒绝旧候选要素，空或缺失集合不回填', async () => {
    const s = await mountMap(), row = candidate(s.props.links[0]); s.props.candidateWorkset = [row]; await nextTick();
    const old = layerOf(s)!.getSource()!.getFeatures()[0];
    s.props.candidateWorkset = []; await nextTick(); click(s, old);
    expect(layerOf(s)).toBeUndefined(); expect(s.selectCandidateLink).not.toHaveBeenCalled();
    expect(s.map.layers.some(layer => layer instanceof VectorLayer && layer.getSource()?.getFeatures()
      .some((feature: Feature) => feature.get('kind') === 'candidate-workset-link'))).toBe(false);
    s.props.candidateWorkset = [row]; await nextTick(); click(s, old); expect(s.selectCandidateLink).not.toHaveBeenCalled();
    const current = layerOf(s)!.getSource()!.getFeatures()[0]; click(s, current); expect(s.selectCandidateLink).toHaveBeenCalledOnce();
    s.props.resourceRead = true; await nextTick(); click(s, current); expect(s.selectCandidateLink).toHaveBeenCalledOnce(); expect(layerOf(s)).toBeUndefined();
    s.props.resourceRead = false; s.props.candidateWorkset = undefined; await nextTick();
    expect(s.map.layers.some(layer => layer instanceof VectorLayer && layer.getSource()?.getFeatures()
      .some((feature: Feature) => feature.get('kind') === 'candidate-workset-link'))).toBe(false);
  });
  it('缺失、非法或同一端点均不猜测几何，输入保真且无距离回填', () => {
    const stations = structuredClone(planningPresets[0].baseline.stations), row = candidate(planningPresets[0].result!.links[0]);
    const before = JSON.stringify([row, stations]);
    expect(candidateEndpoints(row, stations)).toHaveLength(2);
    expect(candidateLinkLayer([row], stations).getSource()!.getFeatures()).toHaveLength(1);
    expect(candidateEndpoints({ ...row, nodeAId: 'MISSING' }, stations)).toEqual([]);
    expect(candidateEndpoints({ ...row, nodeAId: row.nodeBId }, stations)).toEqual([]);
    expect(JSON.stringify([row, stations])).toBe(before);
    stations.find(station => station.id === row.nodeAId)!.coordinate = [181, 40];
    expect(candidateLinkLayer([row], stations).getSource()!.getFeatures()).toEqual([]);
  });
});

describe('GIS 正式拓扑独立透明度', () => {
  type Mounted = Awaited<ReturnType<typeof mountMap>>;
  const vector = (s: Mounted, kind: string) => s.map.layers.find(layer => layer instanceof VectorLayer
    && layer.getSource()?.getFeatures().some((feature: Feature) => feature.get('kind') === kind)) as VectorLayer;
  const click = (s: Mounted, feature: Feature) => {
    s.map.picked = feature; s.map.handlers.get('singleclick')!({ pixel: [1, 1], coordinate: [0, 0] });
  };
  const impact = () => structuredClone(interferenceDemoResult(interferenceScenarios[0], 'balanced').impact);

  it('拆分保持受扰对象身份、坐标和原选中样式；默认调用仍返回混合层', () => {
    const data = impact(), before = JSON.stringify(data), base = planningPresets[0];
    const legacy = interferenceImpactLayers(data, base.baseline.stations, base.result!.links, 'LINK-B');
    const split = interferenceImpactLayers(data, base.baseline.stations, base.result!.links, 'LINK-B', true);
    expect(legacy.linkObjects).toBeUndefined();
    expect(split.objects.getSource()!.getFeatures().every(feature => feature.get('kind') === 'interference-node')).toBe(true);
    const oldFeatures = legacy.objects.getSource()!.getFeatures(), lineFeatures = split.linkObjects!.getSource()!.getFeatures();
    expect(lineFeatures.length).toBeGreaterThan(0);
    expect(lineFeatures.every(feature => feature.get('kind') === 'interference-link')).toBe(true);
    for (const layer of [split.objects, split.linkObjects!]) for (const feature of layer.getSource()!.getFeatures()) {
      const original = oldFeatures.find(row => row.get('kind') === feature.get('kind') && row.get('objectId') === feature.get('objectId'))!;
      expect(feature.getGeometry()!.getExtent()).toEqual(original.getGeometry()!.getExtent());
      expect(feature.get('level')).toBe(original.get('level'));
      const style = layer.getStyleFunction()!(feature, 1) as Style, previous = legacy.objects.getStyleFunction()!(original, 1) as Style;
      expect(style.getStroke()!.getColor()).toBe(previous.getStroke()!.getColor());
      expect(style.getStroke()!.getWidth()).toBe(previous.getStroke()!.getWidth());
      expect(style.getZIndex()).toBe(previous.getZIndex());
    }
    expect(split.regions.getSource()!.getFeatures().map(feature => feature.getGeometry()!.getCoordinates()))
      .toEqual(legacy.regions.getSource()!.getFeatures().map(feature => feature.getGeometry()!.getCoordinates()));
    expect(JSON.stringify(data)).toBe(before);
  });

  it('0／中间值／1 同步正式及受扰线，不重建其他图层、图片或改变视角和业务数据', async () => {
    const s = await mountMap({ gis: true, topologyOpacity: 1, withCoverage: true });
    s.props.interferenceImpact = impact(); s.props.interferences = structuredClone(interferenceScenarios[0].sources);
    s.props.demands = structuredClone(planningPresets[0].input.demands);
    s.props.diagnosisFaults = [{ objectType: 'LINK', objectId: 'LINK-B', faultType: 'HW_FAILURE', symptomIds: [], occurTime: null, interferenceId: null }];
    s.props.selectedLinkId = 'LINK-B'; s.props.highlightLinkIds = ['LINK-B']; await nextTick();
    const base = s.layer(), affected = vector(s, 'interference-link'), nodes = vector(s, 'interference-node');
    const layers = [...s.map.layers], raster = layers.find(layer => layer instanceof ImageLayer) as ImageLayer<ImageSource>;
    const rasterSource = raster.getSource(), untouched = layers.filter(layer => layer !== base && layer !== affected)
      .map(layer => ({ layer, opacity: layer.getOpacity(), visible: layer.getVisible() }));
    const before = JSON.stringify([s.props.links, s.props.interferenceImpact, s.props.mockCoverage]);
    const paints = s.map.setLayers.mock.calls.length, fits = vi.mocked(s.map.view.fit).mock.calls.length, moves = vi.mocked(s.map.view.animate).mock.calls.length;
    expect(s.style('LINK-B')).toHaveLength(2); expect(vi.getTimerCount()).toBe(1);
    for (const opacity of [0.3, 0, 1]) {
      s.props.topologyOpacity = opacity; await nextTick();
      expect(s.layer()).toBe(base); expect(vector(s, 'interference-link')).toBe(affected);
      expect(base.getOpacity()).toBe(opacity); expect(affected.getOpacity()).toBe(opacity);
      expect(base.getVisible()).toBe(opacity > 0); expect(affected.getVisible()).toBe(opacity > 0);
      expect(vi.getTimerCount()).toBe(opacity > 0 ? 1 : 0);
      expect(s.style('LINK-B')).toHaveLength(2); expect(s.lineStyle('LINK-B').getStroke()!.getColor()).toBe('#ef5f64');
      for (const row of untouched) { expect(row.layer.getOpacity()).toBe(row.opacity); expect(row.layer.getVisible()).toBe(row.visible); }
      expect(s.map.layers).toEqual(layers); expect(raster.getSource()).toBe(rasterSource);
      expect(textOf(s.root).includes('链路 · 优秀')).toBe(opacity > 0);
      expect(textOf(s.root)).toContain('受扰对象：'); expect(textOf(s.root)).toContain('场景注入 · 硬件故障');
    }
    expect(nodes).not.toBe(affected); expect(vector(s, 'candidate-workset-link').getVisible()).toBe(true);
    expect(vector(s, 'task-demand').getVisible()).toBe(true); expect(vector(s, 'diagnosis-fault').getVisible()).toBe(true);
    expect(s.map.setLayers).toHaveBeenCalledTimes(paints); expect(s.map.view.fit).toHaveBeenCalledTimes(fits); expect(s.map.view.animate).toHaveBeenCalledTimes(moves);
    expect(JSON.stringify([s.props.links, s.props.interferenceImpact, s.props.mockCoverage])).toBe(before);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.image).not.toHaveBeenCalled(); expect(s.report).not.toHaveBeenCalled(); expect(s.httpSubmit).not.toHaveBeenCalled(); expect(s.save).not.toHaveBeenCalled();
  });

  it('隐藏或零值拒绝旧正式／受扰线命中，保留 LINK 注入图标；恢复后仍可点选', async () => {
    const s = await mountMap({ gis: true, topologyOpacity: 1 }); s.props.interferenceImpact = impact();
    s.props.diagnosisFaults = [{ objectType: 'LINK', objectId: 'LINK-B', faultType: 'HW_FAILURE', symptomIds: [], occurTime: null, interferenceId: null }]; await nextTick();
    const formal = s.layer().getSource()!.getFeatures().find(feature => feature.get('objectId') === 'LINK-B')!;
    const affected = vector(s, 'interference-link').getSource()!.getFeatures().find(feature => feature.get('objectId') === 'LINK-B')!;
    const glyph = vector(s, 'diagnosis-fault').getSource()!.getFeatures()[0];
    s.props.topologyOpacity = 0; await nextTick(); click(s, formal); click(s, affected); click(s, glyph);
    expect(s.select).not.toHaveBeenCalled(); expect(s.selectFault).toHaveBeenCalledExactlyOnceWith('LINK', 'LINK-B');
    s.props.topologyOpacity = 0.3; s.props.showLinks = false; await nextTick(); click(s, formal); click(s, affected);
    expect(s.select).not.toHaveBeenCalled(); expect(vector(s, 'interference-link').getVisible()).toBe(false); expect(vi.getTimerCount()).toBe(0);
    s.props.showLinks = true; await nextTick(); click(s, formal); click(s, affected);
    expect(s.select.mock.calls).toEqual([['LINK-B'], ['LINK-B']]); expect(s.layer().getOpacity()).toBe(0.3);
    expect(vector(s, 'interference-node').getOpacity()).toBe(1);
  });

  it('隐藏期间清单传入选择仍定位且保留 ID，恢复透明度不再次定位', async () => {
    const s = await mountMap({ topologyOpacity: 0 }); const fits = vi.mocked(s.map.view.fit).mock.calls.length;
    s.props.selectedLinkId = 'LINK-B'; s.props.highlightLinkIds = ['LINK-B']; await nextTick();
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits + 1); expect(s.layer().getVisible()).toBe(false);
    expect(s.props.selectedLinkId).toBe('LINK-B'); expect(s.style('LINK-B')).toHaveLength(2);
    s.props.topologyOpacity = 0.4; await nextTick(); expect(s.layer().getVisible()).toBe(true);
    expect(s.map.view.fit).toHaveBeenCalledTimes(fits + 1); expect(s.props.selectedLinkId).toBe('LINK-B');
  });

  it('仅受扰连线在零值时不留对象图例，有可绘制节点时保留，质量与备用图例随正式线隐藏', async () => {
    const s = await mountMap({ gis: true, topologyOpacity: 1 }); s.props.interferenceImpact = impact();
    s.props.interferenceImpact.nodes = []; s.props.links[0].backup = true; await nextTick();
    expect(textOf(s.root)).toContain('受扰对象：'); expect(textOf(s.root)).toContain('备用链路'); expect(textOf(s.root)).toContain('拓扑已简化');
    s.props.topologyOpacity = 0; await nextTick();
    expect(textOf(s.root)).not.toContain('受扰对象：'); expect(textOf(s.root)).not.toContain('链路 · 优秀'); expect(textOf(s.root)).not.toContain('备用链路'); expect(textOf(s.root)).not.toContain('拓扑已简化');
    s.props.interferenceImpact.nodes = impact().nodes; await nextTick(); expect(textOf(s.root)).toContain('受扰对象：');
    s.props.stations = []; await nextTick(); expect(textOf(s.root)).not.toContain('受扰对象：');
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('业务重绘立即应用当前偏好，旧正式及受扰图层不再接受透明度更新', async () => {
    const s = await mountMap({ gis: true, topologyOpacity: 0.3 }); s.props.interferenceImpact = impact(); await nextTick();
    const former = s.layer(), previousImpact = vector(s, 'interference-link');
    s.props.links = s.props.links.map(link => ({ ...link })); await nextTick();
    expect(s.layer()).not.toBe(former); expect(vector(s, 'interference-link')).not.toBe(previousImpact);
    expect(s.layer().getOpacity()).toBe(0.3); expect(vector(s, 'interference-link').getOpacity()).toBe(0.3);
    const current = s.layer(), currentImpact = vector(s, 'interference-link');
    s.props.topologyOpacity = 0; await nextTick();
    expect(current.getVisible()).toBe(false); expect(currentImpact.getVisible()).toBe(false);
    expect(former.getOpacity()).toBe(0.3); expect(previousImpact.getOpacity()).toBe(0.3);
    app!.unmount(); app = undefined; const revisions = [current.getRevision(), currentImpact.getRevision()];
    s.props.topologyOpacity = 1; vi.advanceTimersByTime(2400); await nextTick();
    expect([current.getRevision(), currentImpact.getRevision()]).toEqual(revisions); expect(vi.getTimerCount()).toBe(0);
  });

  it('未传属性维持旧受扰混合层与命中语义；显式接入及撤回切换可恢复原行为', async () => {
    const s = await mountMap({ gis: true }); s.props.interferenceImpact = impact(); s.props.showLinks = false; await nextTick();
    expect(vector(s, 'interference-node')).toBe(vector(s, 'interference-link')); expect(vector(s, 'interference-link').getVisible()).toBe(true);
    const previous = vector(s, 'interference-link').getSource()!.getFeatures().find(feature => feature.get('kind') === 'interference-link')!;
    click(s, previous); expect(s.select).toHaveBeenCalledOnce();
    s.props.topologyOpacity = 0.4; await nextTick(); expect(vector(s, 'interference-node')).not.toBe(vector(s, 'interference-link'));
    expect(vector(s, 'interference-link').getVisible()).toBe(false); click(s, previous); expect(s.select).toHaveBeenCalledOnce();
    s.props.topologyOpacity = undefined; await nextTick();
    expect(vector(s, 'interference-node')).toBe(vector(s, 'interference-link')); expect(vector(s, 'interference-link').getVisible()).toBe(true);
    expect(s.layer().getOpacity()).toBe(1); click(s, previous); expect(s.select).toHaveBeenCalledTimes(2);
  });

  it('切 HTTP 后不再修改旧 Mock 图层；HTTP 忽略拓扑属性并保持 API 线选择', async () => {
    const s = await mountMap({ gis: true, topologyOpacity: 0.3 }); s.props.interferenceImpact = impact(); await nextTick();
    const former = s.layer(), affected = vector(s, 'interference-link');
    s.props.resourceRead = true; await nextTick(); const layers = [...s.map.layers], paints = s.map.setLayers.mock.calls.length;
    s.props.topologyOpacity = 0; await nextTick();
    expect(s.map.layers).toEqual(layers); expect(s.map.setLayers).toHaveBeenCalledTimes(paints);
    expect(former.getOpacity()).toBe(0.3); expect(affected.getOpacity()).toBe(0.3); expect(vi.getTimerCount()).toBe(0);
    expect(textOf(s.root)).toContain('数字圆点：资源聚合'); expect(textOf(s.root)).not.toContain('链路 · 优秀');
    // API 要素沿原 HTTP 身份入口，不让 Mock 显示参数屏蔽点击。
    const { default: ActualFeature } = await import('ol/Feature');
    click(s, new ActualFeature({ kind: 'api-planned-link', objectId: 'HTTP-LINK' }));
    expect(s.select).toHaveBeenCalledExactlyOnceWith('HTTP-LINK');
    s.props.resourceRead = false; await nextTick();
    expect(s.layer().getOpacity()).toBe(0); expect(s.layer().getVisible()).toBe(false); expect(vector(s, 'interference-link').getVisible()).toBe(false);
  });
});
