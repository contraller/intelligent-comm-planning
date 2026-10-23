import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, toRaw, type App } from 'vue';
import ResourceEditDrawer from '../src/components/ResourceEditDrawer.vue';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { initialResources } from '../src/mocks/resource-presets';
import type { Coordinate, ResourcesData } from '../src/types/domain';
import type { GisResourceEditContext } from '../src/types/gis-workspace';
import { authorizeStore } from './helpers/auth';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';

const runtime = vi.hoisted(() => ({ mode: 'http' }));
vi.mock('../src/config/env', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, get mode() { return runtime.mode; } } };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible
    ? h('drawer-probe', [slots.default?.(), slots.footer?.()]) : null }) };
});
await clientTemplate(ResourceEditDrawer, 'src/components/ResourceEditDrawer.vue', 'm5-resource-edit-render.ts');

const bounds: NonNullable<ResourcesData['planningBounds']> = [113.14986111114996, 36.27597222221908, 114.9498611111502, 37.72402777777483];
let pinia: ReturnType<typeof createPinia>;
let app: App<HostNode> | undefined;
beforeEach(() => {
  runtime.mode = 'http';
  class TestDocument { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {});
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
});
afterEach(async () => { await nextTick(); app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(planningBounds: ResourcesData['planningBounds'] = [...bounds], coordinate?: Coordinate) {
  const data = initialResources(); data.planningBounds = planningBounds; data.version = 'resource-1111111111111111';
  if (coordinate) {
    data.stations[0]!.coordinate = [...coordinate];
    data.interferences![0]!.coordinate = [...coordinate];
  }
  data.devices.forEach(row => { row.currentWorkMode = null; });
  const scene: GisResourceEditContext = { revision: data.version, baseRevision: data.version, resources: data,
    validationSource: structuredClone(data), resourceMeta: { revision: data.version, resourceEpoch: data.version,
      savedAt: null, stationVersions: {}, deviceVersions: {}, changedStationIds: [], changedDeviceIds: [] },
    situation: { title: 'Explicit test HTTP context', snapshotId: data.version, updatedAt: '2026-10-24T00:00:00Z',
      links: [], candidateLinks: [], regions: [], alerts: [], spectrum: [] } };
  const editor = useResourceEditStore(); editor.acceptGisContext(scene); editor.begin();
  return editor;
}
function mount() {
  const root = node('root'); app = renderer.createApp({ render: () => h(ResourceEditDrawer) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); return root;
}

describe('M5 actual GIS editor and drawer, explicit HTTP service context', () => {
  it('renders the same trusted HTTP coverage instead of the old sample rectangle', async () => {
    const editor = setup(); await editor.openForm('station', editor.resources.stations[0].id);
    const root = mount(); await nextTick();
    expect(textOf(root)).toContain(String(bounds[0])); expect(textOf(root)).toContain(String(bounds[3]));
    expect(textOf(root)).not.toContain('115.4045');
  });
  it('unknown coverage is visible and only coordinate edits are blocked', async () => {
    const editor = setup(null); await editor.openForm('station', editor.resources.stations[0].id);
    const root = mount(); await nextTick();
    expect(textOf(root)).toContain('当前 DEM 范围未提供');
    editor.form!.fields.remark = 'No coordinate change';
    expect(editor.applyForm(), editor.error).toBe(true);
    await editor.openForm('station', editor.resources.stations[0].id);
    editor.form!.fields.longitude = '113.6';
    expect(editor.applyForm()).toBe(false);
    expect(editor.issues.some(issue => issue.field === 'coordinate' && issue.message.includes('DEM'))).toBe(true);
  });
  it('applies a western coordinate while preserving every unrelated coordinate', async () => {
    const editor = setup(), before = structuredClone(toRaw(editor.resources));
    const id = editor.resources.stations[0].id;
    await editor.openForm('station', id);
    Object.assign(editor.form!.fields, { longitude: '113.2', latitude: '36.3' });
    expect(editor.applyForm(), editor.error).toBe(true);
    expect(editor.resources.stations[0].coordinate).toEqual([113.2, 36.3]);
    expect(editor.resources.stations.slice(1)).toEqual(before.stations.slice(1));
    expect(editor.resources.interferences).toEqual(before.interferences);
  });
  it('parameter edits keep all stations/interference untouched even without metadata', async () => {
    const editor = setup(null), before = structuredClone(toRaw(editor.resources));
    await editor.openForm('device', editor.resources.devices[0].id);
    editor.form!.fields.antennaHeightM = '15';
    expect(editor.applyForm(), editor.error).toBe(true);
    expect(editor.resources.stations).toEqual(before.stations);
    expect(editor.resources.interferences).toEqual(before.interferences);
    expect(editor.resources.devices[0].currentWorkMode).toBeNull();
  });
  it('HTTP hides the teaching mode dropdown and reports the protocol boundary', async () => {
    const editor = setup(); await editor.openForm('device', editor.resources.devices[0].id);
    const root = mount(); await nextTick();
    expect(all(root, item => item.props.id === 'resource-currentWorkMode')).toHaveLength(0);
    expect(textOf(root)).toContain('工作模式协议待确认');
  });
  it('Mock retains the teaching mode dropdown without touching P06 ports', async () => {
    runtime.mode = 'mock';
    const editor = setup(); await editor.openForm('device', editor.resources.devices[0].id);
    const root = mount(); await nextTick();
    expect(all(root, item => item.props.id === 'resource-currentWorkMode' && item.tag === 'select')).toHaveLength(1);
    expect(textOf(root)).toContain('教学定频'); expect(textOf(root)).not.toContain('工作模式协议待确认');
    expect(all(root, item => item.props.id === 'resource-ports')).toHaveLength(0);
  });
  it.each(['station', 'device'] as const)('new %s copy states UNKNOWN and does not invent observations', async kind => {
    const editor = setup(); await editor.newForm(kind, editor.resources.stations[0].id); editor.picking = false;
    const root = mount(); await nextTick();
    expect(textOf(root)).toContain('运行状态和告警均未知');
    expect(textOf(root)).not.toContain('初始为离线、无告警');
  });
});

describe('M5 map pick preserves raw DEM edge coordinates before validation', () => {
  const kinds = ['station', 'interference'] as const;
  const entries = ['pick', 'pickGis'] as const;
  const corners: Coordinate[] = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];
  const outside: Coordinate[] = [[bounds[0] - 1e-9, 37], [bounds[2] + 1e-9, 37],
    [114, bounds[1] - 1e-9], [114, bounds[3] + 1e-9]];
  const edgeCases = kinds.flatMap(kind => entries.flatMap(entry => [false, true].flatMap(creating =>
    corners.map((coordinate, corner) => ({ kind, entry, creating, coordinate, corner })))));
  const invalidCases = kinds.flatMap(kind => entries.flatMap(entry =>
    outside.map((coordinate, edge) => ({ kind, entry, coordinate, edge }))));

  function select(editor: ReturnType<typeof useResourceEditStore>, entry: typeof entries[number], coordinate: Coordinate) {
    editor.picking = true;
    if (entry === 'pick') editor.pick(coordinate);
    else editor.pickGis(coordinate, editor.form!);
  }
  function firstId(editor: ReturnType<typeof useResourceEditStore>, kind: typeof kinds[number]) {
    return (kind === 'station' ? editor.resources.stations : editor.resources.interferences!)[0]!.id;
  }

  it.each(edgeCases)('$kind $entry creating=$creating corner=$corner keeps exact raw bounds and applies', async ({ kind, entry, creating, coordinate }) => {
    const editor = setup(), before = structuredClone(toRaw(editor.resources));
    if (creating) {
      await editor.newForm(kind);
      Object.assign(editor.form!.fields, kind === 'station' ? { name: 'Exact edge station' }
        : { name: 'Exact edge interference', antennaHeightM: '0', centerFreqKhz: '1500', bandwidthKhz: '10', txPowerDbm: '-10' });
    } else await editor.openForm(kind, firstId(editor, kind));
    const id = editor.form!.id;
    select(editor, entry, coordinate);
    expect(editor.form!.fields.longitude).toBe(String(coordinate[0]));
    expect(editor.form!.fields.latitude).toBe(String(coordinate[1]));
    expect(editor.picking).toBe(false); expect(editor.resources).toEqual(before);
    expect(editor.applyForm(), editor.error).toBe(true);
    const rows = kind === 'station' ? editor.resources.stations : editor.resources.interferences!;
    expect(rows.find(row => row.id === id)!.coordinate).toEqual(coordinate);
    expect(rows.filter(row => row.id !== id)).toEqual((kind === 'station' ? before.stations : before.interferences!).filter(row => row.id !== id));
    expect(kind === 'station' ? editor.resources.interferences : editor.resources.stations)
      .toEqual(kind === 'station' ? before.interferences : before.stations);
  });

  it.each(invalidCases)('$kind $entry rejects raw outside edge=$edge without rounding it into the DEM', async ({ kind, entry, coordinate }) => {
    const editor = setup(), before = structuredClone(toRaw(editor.resources));
    await editor.openForm(kind, firstId(editor, kind));
    select(editor, entry, coordinate);
    expect(Number(editor.form!.fields.longitude)).toBe(coordinate[0]);
    expect(Number(editor.form!.fields.latitude)).toBe(coordinate[1]);
    expect(editor.applyForm()).toBe(false);
    expect(editor.issues.some(issue => issue.field === 'coordinate')).toBe(true);
    expect(editor.resources).toEqual(before); expect(editor.undoStack).toHaveLength(0);
  });

  it.each(kinds)('%s picking the same precise coordinate is a no-op even without metadata', async kind => {
    const coordinate: Coordinate = [113.500000123, 37.123456789];
    const editor = setup(null, coordinate), before = structuredClone(toRaw(editor.resources));
    await editor.openForm(kind, firstId(editor, kind));
    const fields = { ...editor.form!.fields };
    select(editor, 'pickGis', coordinate);
    expect(editor.form!.fields).toEqual(fields); expect(editor.formDirty).toBe(false);
    expect(editor.applyForm(), editor.error).toBe(true);
    expect(editor.resources).toEqual(before); expect(editor.undoStack).toHaveLength(0);
  });

  it.each(kinds)('%s still uses six places for safe interior picks', async kind => {
    const editor = setup(); await editor.openForm(kind, firstId(editor, kind));
    select(editor, 'pickGis', [113.6500004, 37.5000004]);
    expect(editor.form!.fields.longitude).toBe('113.650000');
    expect(editor.form!.fields.latitude).toBe('37.500000');
    expect(editor.applyForm(), editor.error).toBe(true);
  });

  it.each(kinds.flatMap(kind => entries.map(entry => ({ kind, entry }))))('$kind $entry keeps raw input when metadata is unavailable', async ({ kind, entry }) => {
    const editor = setup(null), before = structuredClone(toRaw(editor.resources));
    await editor.openForm(kind, firstId(editor, kind));
    const coordinate: Coordinate = [113.500000123, 37.123456789];
    select(editor, entry, coordinate);
    expect(editor.form!.fields.longitude).toBe(String(coordinate[0]));
    expect(editor.form!.fields.latitude).toBe(String(coordinate[1]));
    expect(editor.applyForm()).toBe(false);
    expect(editor.issues.some(issue => issue.field === 'coordinate' && issue.message.includes('DEM'))).toBe(true);
    expect(editor.resources).toEqual(before);
  });
});
