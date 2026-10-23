import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import { initialResources } from '../src/mocks/resource-presets';
import { previewService } from '../src/services';
import DevicePortsPanel from '../src/components/DevicePortsPanel.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import DeviceTraceDrawer from '../src/components/DeviceTraceDrawer.vue';
import DeviceRestorePreview from '../src/components/DeviceRestorePreview.vue';
import StatusBadge from '../src/components/StatusBadge.vue';
import type { Device } from '../src/types/domain';
import type { DeviceMaintenanceContext, DevicePort, PortObservation } from '../src/types/device-maintenance';
import type { DeviceTraceClient } from '../src/services/device-trace-http';
import { deviceTraceSchema } from '../src/types/device-trace';

const runtime = vi.hoisted(() => ({ mode: 'http' as 'http' | 'mock' }));
vi.mock('../src/config/env', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, get mode() { return runtime.mode; } } };
});
// 仅替换详情分组/抽屉外壳，端口、设备和追溯内容仍编译实际模板。
vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup(_, { slots }) {
    return () => h('detail-groups', [slots.basic?.(), slots.structure?.(), slots.parameters?.(), slots.actions?.()]);
  } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) {
    return () => props.visible ? h('aside', slots.default?.()) : null;
  } }) };
});
for (const [component, path] of [
  [DevicePortsPanel, 'src/components/DevicePortsPanel.vue'],
  [DeviceInfoPanel, 'src/components/DeviceInfoPanel.vue'],
  [DeviceTraceDrawer, 'src/components/DeviceTraceDrawer.vue'],
  [DeviceRestorePreview, 'src/components/DeviceRestorePreview.vue'],
  [StatusBadge, 'src/components/StatusBadge.vue'],
] as const) await clientTemplate(component, path, 'p06-ports-boundary-render.ts');

let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeEach(() => {
  runtime.mode = 'http';
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const revision = 'resource-1111111111111111';
const port: DevicePort = { id: 'fixture-port', number: 'fixture-port-number', type: 'RF', freqMinKhz: 1000, freqMaxKhz: 2000,
  rateKbps: 0, gainDbi: null, heightM: null, azimuthDeg: null, tiltDeg: null };
const observation: PortObservation = { portId: port.id, status: 'NORMAL', observedAt: '2026-10-24T00:00:00Z', source: '显式教学夹具' };
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
async function click(root: HostNode, label: string) {
  const button = find(root, item => item.tag === 'button' && textOf(item) === label);
  expect(button, label).toBeDefined();
  const handler = button!.props.onClick;
  if (typeof handler !== 'function') throw new Error('测试按钮没有实际事件');
  await handler(); await settle();
}
async function mountPorts() {
  const root = node('root'), load = vi.fn(), edit = vi.fn();
  app = renderer.createApp({ render: () => h(DevicePortsPanel, { ports: [port], observations: [observation], source: 'fixture-source',
    loaded: true, busy: false, error: '旧维护占位错误', editable: true, onLoad: load, onEdit: edit }) });
  app.mount(root); await settle(); return { root, load, edit };
}
async function mountInfo(context: 'ledger' | 'gis') {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const resources = initialResources(), device: Device = { ...resources.devices[0]!, currentWorkMode: 'MOCK_FIXED', ports: [{ ...port }] };
  const model = resources.models.find(item => item.id === device.modelId);
  if (!model) throw new Error('设备夹具缺真实关联型号');
  const fixture: DeviceMaintenanceContext = { revision, device, model, modeOptions: [], observations: [observation], source: '显式教学夹具' };
  const legacy = vi.spyOn(previewService, 'getDeviceMaintenance').mockResolvedValue(fixture);
  const traces = { queryHistory: vi.fn().mockResolvedValue({ schema_version: deviceTraceSchema, items: [], total: 0, page: 1, page_size: 20 }),
    getOperation: vi.fn(), previewRestore: vi.fn() } satisfies DeviceTraceClient;
  const configure = vi.fn(), edit = vi.fn(), root = node('root');
  app = renderer.createApp({ render: () => h(DeviceInfoPanel, { device,
    detailContext: { node: null, model: null, antenna: null, knowledgeAvailable: false },
    maintenanceBinding: { context, revision, editable: true }, traceServices: traces,
    configuration: { editable: true, disabled: false, reason: '' }, onConfigure: configure, onPorts: edit }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await settle();
  return { root, device, legacy, configure, edit, traces };
}

it('HTTP shows explicit unknown readonly feedback, not supplied legacy ports, observations or placeholder failures', async () => {
  const s = await mountPorts();
  expect(textOf(s.root)).toContain('端口状态与采集时间未知'); expect(textOf(s.root)).toContain('协议待确认');
  expect(textOf(s.root)).toContain('当前只读'); expect(textOf(s.root)).not.toContain(port.number);
  expect(textOf(s.root)).not.toContain('fixture-source'); expect(textOf(s.root)).not.toContain(observation.observedAt);
  expect(textOf(s.root)).not.toContain('旧维护占位错误'); expect(find(s.root, item => item.tag === 'table')).toBeUndefined();
  const load = find(s.root, item => item.tag === 'button' && textOf(item) === '查看端口台账')!;
  expect(load.props.disabled).toBe(true); await click(s.root, '查看端口台账');
  expect(s.load).not.toHaveBeenCalled(); expect(s.edit).not.toHaveBeenCalled();
  expect(find(s.root, item => item.tag === 'button' && textOf(item) === '维护端口／批量编辑')).toBeUndefined();
});
it.each(['ledger', 'gis'] as const)('HTTP %s device does not call legacy maintenance or invent a mode, while configuration and trace remain available', async context => {
  const s = await mountInfo(context), before = JSON.stringify(s.device);
  await click(s.root, '查看端口台账'); expect(s.legacy).not.toHaveBeenCalled(); expect(s.edit).not.toHaveBeenCalled();
  expect(textOf(s.root)).toContain('未知（模式协议待确认）'); expect(textOf(s.root)).not.toContain('教学定频');
  expect(textOf(s.root)).not.toContain(port.number); expect(textOf(s.root)).not.toContain('读取失败');
  await click(s.root, '配置请求'); await click(s.root, '配置记录');
  expect(s.configure.mock.calls.map(call => call[0])).toEqual([false, true]);
  await click(s.root, '变更追溯与历史版本');
  expect(s.traces.queryHistory).toHaveBeenCalledWith({ context: 'ledger', device_id: s.device.id, resource_revision: revision, page: 1, page_size: 20 }, { signal: expect.any(AbortSignal) });
  expect(s.legacy).not.toHaveBeenCalled(); expect(s.traces.getOperation).not.toHaveBeenCalled(); expect(s.traces.previewRestore).not.toHaveBeenCalled();
  expect(JSON.stringify(s.device)).toBe(before);
});
it('non-HTTP explicit teaching ports keep their source and load/edit events', async () => {
  runtime.mode = 'mock'; const s = await mountPorts();
  expect(textOf(s.root)).toContain(port.number); expect(textOf(s.root)).toContain('fixture-source');
  await click(s.root, '刷新端口资料'); await click(s.root, '维护端口／批量编辑');
  expect(s.load).toHaveBeenCalledTimes(1); expect(s.edit).toHaveBeenCalledTimes(1);
});
it('non-HTTP device retains the old explicitly loaded maintenance path', async () => {
  runtime.mode = 'mock'; const s = await mountInfo('ledger');
  await click(s.root, '查看端口台账'); expect(s.legacy).toHaveBeenCalledTimes(1);
  expect(s.legacy).toHaveBeenCalledWith({ context: 'ledger', deviceId: s.device.id, revision, signal: expect.any(AbortSignal) });
  expect(textOf(s.root)).toContain(port.number); expect(textOf(s.root)).toContain('教学定频');
  expect(s.traces.queryHistory).not.toHaveBeenCalled();
});
