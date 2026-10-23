import { afterEach, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import Drawer from '../src/components/DeviceConfigurationDrawer.vue';
import { useDeviceConfigurationAcceptanceStore } from '../src/stores/device-configuration-acceptance';
import { TestStorage } from './helpers/storage';
import { deviceConfigurationSchema } from '../src/services/device-configuration-decode';
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) { return () => props.visible ? h('drawer', slots.default?.()) : null; } }) };
});
await clientTemplate(Drawer, 'src/components/DeviceConfigurationDrawer.vue', 'p06-acceptance-render.ts');
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
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
