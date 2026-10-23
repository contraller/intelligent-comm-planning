import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import Drawer from '../src/components/DeviceConfigurationDrawer.vue';
import { useDeviceConfigurationAcceptanceStore, type DeviceConfigurationClient } from '../src/stores/device-configuration-acceptance';
import { TestStorage } from './helpers/storage';
import { deviceConfigurationSchema, type ConfigurationAcceptanceContext } from '../src/services/device-configuration-decode';
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) { return () => props.visible ? h('drawer', slots.default?.()) : null; } }) };
});
await clientTemplate(Drawer, 'src/components/DeviceConfigurationDrawer.vue', 'p06-acceptance-render.ts');
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('readonly missing-service state has no fake modes, execution scenarios or dispatch success', async () => {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const root = node('root'); app = renderer.createApp({ render: () => h(Drawer, { visible: true, deviceId: 'D1', resourceRevision: 'resource-1111111111111111' }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await nextTick();
  expect(textOf(root)).toContain('配置服务未接入'); expect(textOf(root)).not.toContain('下发配置');
  expect(find(root, n => n.tag === 'select')).toBeUndefined();
  const config = useDeviceConfigurationAcceptanceStore(); expect(config.editable).toBe(false);
});
it('only emits close after the store allows it; pending needs explicit preserve-original action', async () => {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const root = node('root'), closed = vi.fn(); let exposed!: { requestLeave(): Promise<boolean> };
  app = renderer.createApp({ render: () => h(Drawer, { visible: true, deviceId: 'D1', resourceRevision: 'resource-1111111111111111', onClose: closed,
    ref: value => { exposed = value as unknown as typeof exposed; } }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await nextTick();
  const config = useDeviceConfigurationAcceptanceStore(); config.bind(null, new TestStorage()); config.busy = true;
  expect(await exposed.requestLeave()).toBe(false); expect(config.visible).toBe(true); expect(closed).not.toHaveBeenCalled();
  config.busy = false; config.pending = { schema_version: deviceConfigurationSchema, context: 'ledger', base_revision: 'resource-1111111111111111',
    device_id: 'D1', model_id: 'M1', request_id: 'original-pending', values: { tx_power_dbm: 20, work_freq_khz: 3000 } };
  expect(await exposed.requestLeave()).toBe(false); expect(closed).not.toHaveBeenCalled(); await nextTick();
  const keep = find(root, n => n.tag === 'button' && textOf(n) === '保留原号并关闭')!;
  (keep.props.onClick as Function)(); await nextTick(); expect(closed).toHaveBeenCalledTimes(1); expect(config.pending?.request_id).toBe('original-pending');
});
const revision = 'resource-1111111111111111';
const context: ConfigurationAcceptanceContext = {
  schema_version: deviceConfigurationSchema, context: 'ledger', resource_revision: revision, resource_content_hash: 'a'.repeat(64),
  device: { device_id: 'D1', node_id: 'N1', model_id: 'M1', availability: 'ACTIVE', source_values: { tx_power_dbm: 20, work_freq_khz: 3000 } },
  model: { model_id: 'M1', freq_min_khz: 2000, freq_max_khz: 30000, tx_power_max_dbm: 50 },
  provenance: { data_origin: 'SYNTHETIC_INTEGRATION', resource_source: '测试构造', source_files: { 'device.csv': { path: 'data/device.csv', sha256: 'b'.repeat(64) } } },
  protocol: { port_options: null, mode_options: null, confirmation: '待确认' },
};
async function interactive(loadContext: DeviceConfigurationClient['loadContext']) {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const services = { loadContext: vi.fn().mockImplementation(loadContext), validateRequest: vi.fn(), submitRequest: vi.fn(), getRequest: vi.fn(), queryHistory: vi.fn() } satisfies DeviceConfigurationClient;
  const state = reactive({ visible: true, editable: true }), root = node('root'), closed = vi.fn();
  app = renderer.createApp({ render: () => h(Drawer, { ...state, services, deviceId: 'D1', resourceRevision: revision, onClose: closed }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root);
  for (let i = 0; i < 10; i++) await nextTick();
  return { state, services, closed, config: useDeviceConfigurationAcceptanceStore() };
}
it('does not cancel a busy read before checking a parent visible=false request', async () => {
  let done!: (value: ConfigurationAcceptanceContext) => void;
  const s = await interactive(() => new Promise<ConfigurationAcceptanceContext>(resolve => { done = resolve; }));
  const signal = s.services.loadContext.mock.calls[0]?.[1]?.signal;
  expect(s.config.busy).toBe(true); s.state.visible = false; await nextTick();
  expect(signal?.aborted).toBe(false); expect(s.config.busy).toBe(true); expect(s.config.visible).toBe(true); expect(s.closed).not.toHaveBeenCalled();
  done(context); for (let i = 0; i < 10; i++) await nextTick();
  expect(s.config.data?.resource_revision).toBe(revision); expect(s.config.busy).toBe(false);
});
it('updates same-device access without reopening or losing unsaved input', async () => {
  const s = await interactive(async () => context);
  s.config.power = '21'; s.config.validated = true;
  s.state.editable = false; await nextTick();
  expect(s.config.target?.editable).toBe(false); expect(s.config.locked).toBe(true); expect(s.config.validated).toBe(false);
  expect(s.config.power).toBe('21'); expect(s.config.dirty).toBe(true); expect(s.config.close()).toBe(false);
  await s.config.submit(); expect(s.services.submitRequest).not.toHaveBeenCalled(); expect(s.services.loadContext).toHaveBeenCalledTimes(1);
});
