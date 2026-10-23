import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ref, ssrContextKey, vModelText, withDirectives, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { clientTemplate } from './helpers/vue-client';
import { TestStorage } from './helpers/storage';
import Drawer from '../src/components/DeviceConfigurationDrawer.vue';
import { useDeviceConfigurationAcceptanceStore } from '../src/stores/device-configuration-acceptance';
import { createDeviceConfigurationHttp } from '../src/services/device-configuration-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { ApiError } from '../src/services/types';
import { configurationRequestInput, deviceConfigurationSchema, type ConfigurationAcceptanceContext,
  type ConfigurationRequestInput } from '../src/services/device-configuration-decode';

vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) {
    return () => props.visible ? h('aside', slots.default?.()) : null;
  } }) };
});
await clientTemplate(Drawer, 'src/components/DeviceConfigurationDrawer.vue', 'p06-input-boundary-render.ts');

// 本地事件宿主保留真实EventTarget监听/派发，让Vue数字v-model指令实际执行，不能手调model更新替代输入。
class TestElement extends EventTarget {
  parent: TestElement | null = null;
  children: TestElement[] = [];
  props: Record<string, unknown> = {};
  style: Record<string, string> = {};
  value = '';
  type = '';
  disabled = false;
  readonly listeners = new Map<string, EventListener>();
  constructor(readonly tag: string, public text = '') { super(); }
  get tagName() { return this.tag.toUpperCase(); }
  getRootNode() { return document; }
}
function remove(child: TestElement) {
  if (child.parent) {
    const index = child.parent.children.indexOf(child);
    if (index >= 0) child.parent.children.splice(index, 1);
  }
  child.parent = null;
}
function insert(child: TestElement, parent: TestElement, anchor?: TestElement | null) {
  remove(child); child.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<TestElement, TestElement>({
  insert, remove, createElement: tag => new TestElement(tag), createText: text => new TestElement('#text', text),
  createComment: text => new TestElement('#comment', text),
  setText: (element, text) => { element.text = text; },
  setElementText: (element, text) => { element.text = text; element.children = []; },
  parentNode: element => element.parent,
  nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
  patchProp(element, key, _previous, value: unknown) {
    element.props[key] = value;
    if (key === 'value') element.value = value == null ? '' : String(value);
    if (key === 'type') element.type = String(value);
    if (key === 'disabled') element.disabled = !!value;
    if (/^on[A-Z]/.test(key) && !key.startsWith('onUpdate:')) {
      const event = key.slice(2).toLowerCase(), previous = element.listeners.get(event);
      if (previous) element.removeEventListener(event, previous);
      element.listeners.delete(event);
      if (typeof value === 'function') {
        const listener: EventListener = event => { value(event); };
        element.listeners.set(event, listener); element.addEventListener(event, listener);
      }
    }
  },
  insertStaticContent(text, parent, anchor) {
    const element = new TestElement('#static', text); insert(element, parent, anchor); return [element, element];
  },
});
function find(root: TestElement, predicate: (element: TestElement) => boolean): TestElement | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const found = find(child, predicate); if (found) return found; }
}
const textOf = (root: TestElement): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
function input(root: TestElement, label: string) {
  const element = find(root, element => element.tag === 'input' && element.props['aria-label'] === label);
  if (!element) throw new Error('缺少真实输入控件: ' + label);
  return element;
}
function button(root: TestElement, label: string) {
  const element = find(root, element => element.tag === 'button' && textOf(element) === label);
  if (!element) throw new Error('缺少真实按钮: ' + label);
  return element;
}
async function settle() { for (let index = 0; index < 12; index++) await nextTick(); }
async function edit(root: TestElement, label: string, value: string) {
  const element = input(root, label); element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true })); await settle();
}
async function click(root: TestElement, label: string) {
  button(root, label).dispatchEvent(new Event('click', { bubbles: true })); await settle();
}

let app: App<TestElement> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('localStorage', new TestStorage());
});
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const revision = 'resource-1111111111111111';
function context(): ConfigurationAcceptanceContext {
  return { schema_version: deviceConfigurationSchema, context: 'ledger', resource_revision: revision, resource_content_hash: 'a'.repeat(64),
    device: { device_id: 'fixture-device', node_id: 'fixture-node', model_id: 'fixture-model', availability: 'ACTIVE',
      source_values: { tx_power_dbm: 20, work_freq_khz: 3000 } },
    model: { model_id: 'fixture-model', freq_min_khz: 2000, freq_max_khz: 30000, tx_power_max_dbm: 50 },
    provenance: { data_origin: 'SYNTHETIC_INTEGRATION', resource_source: '显式输入边界测试夹具',
      source_files: { 'device.csv': { path: 'data/fixture/device.csv', sha256: 'b'.repeat(64) } } },
    protocol: { port_options: null, mode_options: null, confirmation: '待确认' } };
}
const validResponse = (request: ConfigurationRequestInput) => ({ valid: true, context: context(), requested_values: { ...request.values } });
async function mount(validation: (request: ConfigurationRequestInput) => unknown | Promise<unknown> = validResponse) {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  // 仅替换运输层，真实HTTP客户端仍严格解码响应；不直接写validated或改store类型。
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(async (path, init) => {
    if (path.startsWith('/device-configurations/context?')) return context();
    if (path === '/device-configurations/validate') {
      const body: unknown = JSON.parse(String(init?.body)); configurationRequestInput(body);
      return validation(body);
    }
    throw new Error('未约定的测试请求: ' + path);
  });
  const services = createDeviceConfigurationHttp(request as AuthenticatedRequest), validate = vi.spyOn(services, 'validateRequest');
  const state = reactive({ editable: true }), root = new TestElement('root');
  app = renderer.createApp({ render: () => h(Drawer, { visible: true, ...state, services,
    deviceId: 'fixture-device', resourceRevision: revision }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await settle();
  return { root, state, request, validate, config: useDeviceConfigurationAcceptanceStore() };
}

it('reproduces native number v-model coercion through actual Vue directive input listeners', async () => {
  const power = ref<unknown>('20'), frequency = ref<unknown>('3000'), root = new TestElement('root');
  app = renderer.createApp({ render: () => h('section', [
    withDirectives(h('input', { type: 'number', 'aria-label': 'legacy-power', 'onUpdate:modelValue': (value: unknown) => { power.value = value; } }), [[vModelText, power.value]]),
    withDirectives(h('input', { type: 'number', 'aria-label': 'legacy-frequency', 'onUpdate:modelValue': (value: unknown) => { frequency.value = value; } }), [[vModelText, frequency.value]]),
  ]) });
  app.mount(root); await edit(root, 'legacy-power', '40'); await edit(root, 'legacy-frequency', '7000');
  expect(power.value).toBe(40); expect(frequency.value).toBe(7000);
  expect(typeof power.value).toBe('number'); expect(typeof frequency.value).toBe('number');
});
it.each([['40', '7000'], ['40.5', '7000.25']])('keeps input buffers as strings and validates numeric wire values %s/%s', async (power, frequency) => {
  const s = await mount(); await edit(s.root, '请求功率', power); await edit(s.root, '请求频率', frequency);
  expect(s.config.power).toBe(power); expect(s.config.frequency).toBe(frequency); expect(s.config.validated).toBe(false);
  await click(s.root, '校验');
  const body = { schema_version: deviceConfigurationSchema, context: 'ledger', base_revision: revision,
    device_id: 'fixture-device', model_id: 'fixture-model', values: { tx_power_dbm: Number(power), work_freq_khz: Number(frequency) } };
  expect(s.validate).toHaveBeenCalledWith(body, { signal: expect.any(AbortSignal) });
  const call = s.request.mock.calls.find(([path]) => path === '/device-configurations/validate');
  expect(call?.[1]?.method).toBe('POST'); expect(JSON.parse(String(call?.[1]?.body))).toEqual(body);
  expect(s.config.error).toBe(''); expect(s.config.validated).toBe(true); expect(button(s.root, '提交系统受理').disabled).toBe(false);
  expect(s.request.mock.calls.filter(([path]) => path === '/device-configurations')).toHaveLength(0);
});
it.each([['', '7000'], ['40', ''], ['40', '0'], ['40', '-1']])('rejects empty or invalid input %s/%s before validation transport', async (power, frequency) => {
  const s = await mount(); await edit(s.root, '请求功率', power); await edit(s.root, '请求频率', frequency); await click(s.root, '校验');
  expect(s.config.power).toBe(power); expect(s.config.frequency).toBe(frequency);
  expect(s.validate).not.toHaveBeenCalled(); expect(s.request).toHaveBeenCalledTimes(1);
  expect(s.config.validated).toBe(false); expect(s.config.error).toBeTruthy(); expect(s.config.error).not.toContain('trim');
  expect(button(s.root, '提交系统受理').disabled).toBe(true);
});
it('does not turn a service validation rejection into success', async () => {
  const s = await mount(() => { throw new ApiError('构造服务拒绝校验', 1001, null, 'fixture-validation', 400); });
  await edit(s.root, '请求功率', '40'); await edit(s.root, '请求频率', '7000'); await click(s.root, '校验');
  expect(s.validate).toHaveBeenCalledTimes(1); expect(s.config.error).toContain('构造服务拒绝校验');
  expect(s.config.validated).toBe(false); expect(button(s.root, '提交系统受理').disabled).toBe(true);
});
it('keeps malformed validation responses rejected by the real decoder', async () => {
  const s = await mount(request => ({ ...validResponse(request), requested_values: { ...request.values, tx_power_dbm: 41 } }));
  await edit(s.root, '请求功率', '40'); await edit(s.root, '请求频率', '7000'); await click(s.root, '校验');
  expect(s.validate).toHaveBeenCalledTimes(1); expect(s.config.error).toContain('不符合契约');
  expect(s.config.validated).toBe(false); expect(button(s.root, '提交系统受理').disabled).toBe(true);
});
it.each(['readonly', 'pending'] as const)('keeps %s inputs locked even for synthetic input/click events', async gate => {
  const s = await mount();
  if (gate === 'readonly') s.state.editable = false;
  else s.config.pending = { schema_version: deviceConfigurationSchema, context: 'ledger', base_revision: revision,
    device_id: 'fixture-device', model_id: 'fixture-model', request_id: 'fixture-pending', values: { tx_power_dbm: 20, work_freq_khz: 3000 } };
  await settle(); expect(input(s.root, '请求功率').disabled).toBe(true); expect(input(s.root, '请求频率').disabled).toBe(true);
  await edit(s.root, '请求功率', '40'); await edit(s.root, '请求频率', '7000');
  await click(s.root, '校验'); await click(s.root, '提交系统受理');
  expect(s.config.power).toBe('20'); expect(s.config.frequency).toBe('3000'); expect(s.config.validated).toBe(false);
  expect(s.validate).not.toHaveBeenCalled(); expect(s.request).toHaveBeenCalledTimes(1);
});
it('keeps the in-flight validation values unchanged and prevents concurrent validation while busy', async () => {
  let complete!: (value: unknown) => void;
  const response = new Promise<unknown>(resolve => { complete = resolve; }), s = await mount(() => response);
  await edit(s.root, '请求功率', '40'); await edit(s.root, '请求频率', '7000'); await click(s.root, '校验');
  try {
    expect(s.config.busy).toBe(true); expect(input(s.root, '请求功率').disabled).toBe(true);
    await edit(s.root, '请求功率', '41'); await edit(s.root, '请求频率', '8000'); await click(s.root, '校验');
    expect(s.config.power).toBe('40'); expect(s.config.frequency).toBe('7000'); expect(s.validate).toHaveBeenCalledTimes(1);
  } finally {
    complete(validResponse({ schema_version: deviceConfigurationSchema, context: 'ledger', base_revision: revision,
      device_id: 'fixture-device', model_id: 'fixture-model', values: { tx_power_dbm: 40, work_freq_khz: 7000 } })); await settle();
  }
  expect(s.config.busy).toBe(false); expect(s.config.validated).toBe(true); expect(s.config.error).toBe('');
});
it('requires validation again after a subsequent input event changes a previously validated value', async () => {
  const s = await mount(); await edit(s.root, '请求功率', '40'); await edit(s.root, '请求频率', '7000'); await click(s.root, '校验');
  expect(s.config.validated).toBe(true); await edit(s.root, '请求功率', '41');
  expect(s.config.power).toBe('41'); expect(s.config.validated).toBe(false); expect(button(s.root, '提交系统受理').disabled).toBe(true);
  await click(s.root, '提交系统受理'); expect(s.request.mock.calls.filter(([path]) => path === '/device-configurations')).toHaveLength(0);
});
