import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import DeviceDetailTabs from '../src/components/DeviceDetailTabs.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import DeviceNetworkPanel from '../src/components/DeviceNetworkPanel.vue';
import DeviceKnowledgePanel from '../src/components/DeviceKnowledgePanel.vue';
import KnowledgePrincipleFlow from '../src/components/KnowledgePrincipleFlow.vue';
import ObjectInfoPanel from '../src/components/ObjectInfoPanel.vue';
import ResourcesView from '../src/views/ResourcesView.vue';
import ResourceLedgerFilters from '../src/components/ResourceLedgerFilters.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { createDeviceNetworkContext } from '../src/services/device-network';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import type { DeviceKnowledge } from '../src/types/knowledge';
import type { Device } from '../src/types/domain';

// 只替换组件库的 DOM 外壳；业务组件使用实际模板、状态和生命周期。
vi.mock('primevue/dialog', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], emits: ['update:visible'], setup(props, { slots }) {
    return () => props.visible ? h('dialog-probe', [...(slots.default?.() ?? []), ...(slots.footer?.() ?? [])]) : null;
  } }) };
});
vi.mock('primevue/tabs', async () => {
  const { defineComponent, h, provide } = await import('vue');
  return { default: defineComponent({ props: ['value', 'lazy'], emits: ['update:value'], setup(props, { emit, slots }) {
    provide('test-detail-tabs', { value: () => props.value, select: (value: string) => emit('update:value', value) });
    return () => h('tabs-probe', { value: props.value, lazy: props.lazy }, slots.default?.());
  } }) };
});
vi.mock('primevue/tab', async () => {
  const { defineComponent, h, inject } = await import('vue');
  return { default: defineComponent({ props: ['value'], setup(props, { slots }) {
    const tabs = inject<{ select: (value: string) => void }>('test-detail-tabs')!;
    return () => h('button', { onClick: () => tabs.select(props.value) }, slots.default?.());
  } }) };
});
vi.mock('primevue/tabpanel', async () => {
  const { defineComponent, h, inject } = await import('vue');
  return { default: defineComponent({ props: ['value'], setup(props, { slots }) {
    const tabs = inject<{ value: () => string }>('test-detail-tabs')!;
    return () => h('panel-probe', { value: props.value, hidden: tabs.value() !== props.value }, slots.default?.());
  } }) };
});
vi.mock('primevue/tablist', async () => {
  const { h } = await import('vue');
  return { default: { render(this: { $slots: Vue.Slots }) { return h('div', this.$slots.default?.()); } } };
});
vi.mock('primevue/tabpanels', async () => {
  const { h } = await import('vue');
  return { default: { render(this: { $slots: Vue.Slots }) { return h('div', this.$slots.default?.()); } } };
});
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceExportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) {
    return () => props.visible ? h('section', slots.default?.()) : null;
  } }) };
});
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows'], emits: ['select'], setup(props, { emit }) {
    return () => h('div', props.rows.map((row: { id: string }) => h('button', { onClick: () => emit('select', row) }, row.id)));
  } }) };
});

// 与既有 GIS 检查一致，Node 中编译客户端模板，避免只验证 SSR 字符串。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const compiled = compileTemplate({ source: descriptor.template!.content, filename, id: filename,
    compilerOptions: { mode: 'function', bindingMetadata: bindings },
  });
  if (compiled.errors.length) throw new Error(compiled.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${compiled.code} }`, 'device-detail-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}
await Promise.all([
  clientTemplate(DeviceDetailTabs, 'src/components/DeviceDetailTabs.vue'),
  clientTemplate(DeviceInfoPanel, 'src/components/DeviceInfoPanel.vue'),
  clientTemplate(DeviceNetworkPanel, 'src/components/DeviceNetworkPanel.vue'),
  clientTemplate(DeviceKnowledgePanel, 'src/components/DeviceKnowledgePanel.vue'),
  clientTemplate(KnowledgePrincipleFlow, 'src/components/KnowledgePrincipleFlow.vue'),
  clientTemplate(ObjectInfoPanel, 'src/components/ObjectInfoPanel.vue'),
  clientTemplate(ResourcesView, 'src/views/ResourcesView.vue'),
  clientTemplate(ResourceLedgerFilters, 'src/components/ResourceLedgerFilters.vue'),
]);

interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown; options: HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({
  tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  addEventListener: () => {}, removeEventListener: () => {}, getRootNode: () => document,
});
function remove(child: HostNode) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function find(root: HostNode, predicate: (entry: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; }
}
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
const tabs = (root: HostNode) => find(root, entry => entry.tag === 'tabs-probe')!;
const searchInput = (root: HostNode) => find(root, entry => entry.props['aria-label'] === '检索设备运维知识')!;
const knowledgeArea = (root: HostNode, label = '设备型号功能知识') => find(root, entry => entry.props['aria-label'] === label)!;
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); await nextTick(); }
async function click(root: HostNode, label: string) {
  const button = find(root, entry => entry.tag === 'button' && textOf(entry).trim() === label);
  expect(button, `未找到按钮：${label}`).toBeDefined();
  await (button!.props.onClick as () => unknown)(); await settle();
}
async function search(root: HostNode, query: string) {
  (searchInput(root).props['onUpdate:modelValue'] as (value: string) => void)(query);
  await nextTick();
  // 台账同时有频率筛选表单，知识检索只提交自己的表单。
  const panel = find(root, entry => entry.props.class === 'device-knowledge')!;
  const form = find(panel, entry => entry.tag === 'form')!;
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => unknown)({ preventDefault: () => {} });
  await settle();
}

let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  vi.spyOn(previewService, 'loadPreview').mockImplementation(raw.loadPreview);
  // 页面状态读取复用同一测试服务，避免掉入默认服务而丢失测试身份。
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  for (const name of ['loadKnowledgeWorkspace', 'searchKnowledge', 'queryKnowledgeGraph', 'getKnowledgeEntity'] as const)
    vi.spyOn(previewService, name).mockImplementation(raw[name] as never);
  const query = vi.spyOn(previewService, 'getDeviceKnowledge').mockImplementation(raw.getDeviceKnowledge);
  const knowledge = useKnowledgeStore(); await knowledge.load();
  const preview = usePreviewStore(); await preview.load();
  // 使用已有发布知识的型号，同时保留其他型号的空结果分支。
  const resources = preview.data!.resources, device = resources.devices.find(row => row.modelId === 'DM-0001')!;
  const props = reactive({ deviceId: device.id, modelId: device.modelId });
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { render: () => null } }, { path: '/resources', component: ResourcesView },
    { path: '/situation', component: { render: () => null } }, { path: '/knowledge', component: { render: () => null } },
  ] });
  async function mount(component: Component = { render: () => h(DeviceDetailTabs, props, {
    basic: () => h('p', '基础字段'), parameters: () => h('p', '参数字段'),
  }) }, path = '/') {
    await router.push(path); await router.isReady();
    app = renderer.createApp(component); app.use(pinia!); app.use(router); app.provide(ssrContextKey, {});
    const root = node('root'); app.mount(root); await settle(); return root;
  }
  return { mount, props, query, knowledge, auth, raw, storage, resources, device, router,
    catalog: preview.data!.deviceDetails!, preview, editor: useResourceEditStore() };
}

describe('设备详情双页签', () => {
  it('默认信息页，基础展开、参数折叠，知识内容不再套外层折叠', async () => {
    const s = await fixture(), root = await s.mount();
    expect(tabs(root).props).toMatchObject({ value: 'info', lazy: false });
    expect(find(root, row => row.tag === 'details' && textOf(row).startsWith('基础信息'))!.props.open).toBe('');
    expect(find(root, row => row.tag === 'details' && textOf(row).startsWith('参数信息'))!.props.open).toBeUndefined();
    expect(find(root, row => row.props.class === 'device-knowledge')!.tag).toBe('section');
  });
  it('同一设备往返页签保留检索，不重复查询或写入资源', async () => {
    const s = await fixture(), root = await s.mount(), before = [...s.storage.entries];
    await click(root, '运维知识'); await search(root, '操作');
    const input = searchInput(root), calls = s.query.mock.calls.length;
    expect(s.query).toHaveBeenLastCalledWith({ versionId: s.knowledge.current!.id, modelId: s.device.modelId, query: '操作' });
    await click(root, '设备信息'); await click(root, '运维知识');
    expect(tabs(root).props.value).toBe('knowledge'); expect(searchInput(root)).toBe(input); expect(input.value).toBe('操作');
    expect(s.query).toHaveBeenCalledTimes(calls); expect([...s.storage.entries]).toEqual(before);
  });
  it('换成同型号的另一设备也回到信息页并清空旧搜索', async () => {
    const s = await fixture(), root = await s.mount();
    await click(root, '运维知识'); await search(root, '操作');
    const input = searchInput(root), next = s.resources.devices.find(row => row.modelId === s.device.modelId && row.id !== s.device.id)!;
    s.props.deviceId = next.id; await settle();
    expect(tabs(root).props.value).toBe('info'); expect(searchInput(root)).not.toBe(input); expect(searchInput(root).value).toBe('');
    expect(s.query).toHaveBeenLastCalledWith({ versionId: s.knowledge.current!.id, modelId: next.modelId, query: '' });
  });
  it('更换型号后旧请求迟到不会覆盖新设备知识', async () => {
    const s = await fixture(); let finish!: (value: DeviceKnowledge) => void;
    s.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const root = await s.mount(), next = s.resources.devices.find(row => row.modelId !== s.device.modelId)!;
    s.props.deviceId = next.id; s.props.modelId = next.modelId; await settle();
    const current = textOf(root);
    finish(await s.raw.getDeviceKnowledge({ versionId: s.knowledge.current!.id, modelId: s.device.modelId })); await settle();
    expect(textOf(root)).toBe(current);
    expect(s.query).toHaveBeenLastCalledWith({ versionId: s.knowledge.current!.id, modelId: next.modelId, query: '' });
  });
  it('知识查询失败可重试，设备信息始终可切回', async () => {
    const s = await fixture(); s.query.mockRejectedValueOnce(new Error('型号知识暂不可用'));
    const root = await s.mount(); await click(root, '运维知识');
    expect(textOf(root)).toContain('型号知识暂不可用'); await click(root, '设备信息');
    expect(tabs(root).props.value).toBe('info'); expect(textOf(root)).toContain('基础字段');
    await click(root, '运维知识'); await click(root, '重试');
    expect(textOf(root)).not.toContain('型号知识暂不可用'); expect(textOf(root)).toContain('发布快照');
  });
  it('没有知识权限时不发查询，信息页和权限提示保留', async () => {
    const s = await fixture(); s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'knowledge.view') });
    const root = await s.mount(); await click(root, '运维知识');
    expect(s.query).not.toHaveBeenCalled(); expect(textOf(root)).toContain('当前角色没有知识查看权限');
    expect(searchInput(root)).toBeUndefined(); await click(root, '设备信息'); expect(textOf(root)).toContain('基础字段');
  });
  it('空知识结果保留检索入口，不把空结果当作设备错误', async () => {
    const s = await fixture(), root = await s.mount(); await click(root, '运维知识'); await search(root, '不存在的教学知识条目');
    expect(textOf(root)).toContain('暂无匹配的已发布型号知识'); expect(searchInput(root)).toBeDefined();
    await click(root, '设备信息'); expect(textOf(root)).toContain('参数字段');
  });
  it('GIS 等待父级确认时保留原设备检索，接受选择后才复位', async () => {
    const s = await fixture(), selection = reactive({ id: s.device.id }), selected = vi.fn(), edit = vi.fn();
    const station = s.resources.stations.find(row => row.id === s.device.stationId)!;
    const next = s.resources.devices.find(row => row.stationId === station.id && row.id !== s.device.id)!;
    const root = await s.mount({ render: () => h(ObjectInfoPanel, { resources: s.resources, station, selectedDeviceId: selection.id,
      editable: true, 'onSelect-device': selected, 'onEdit-device': edit }) });
    await click(root, '运维知识'); await search(root, '操作');
    const input = searchInput(root), control = find(root, row => row.props['aria-label'] === '选择节点设备')!;
    const summary = textOf(knowledgeArea(root)), queryCount = s.query.mock.calls.length;
    const event = { target: { value: next.id } };
    (control.props.onChange as (value: unknown) => void)(event); await settle();
    expect(selected).toHaveBeenCalledWith(next.id); expect(event.target.value).toBe(s.device.id);
    expect(tabs(root).props.value).toBe('knowledge'); expect(searchInput(root)).toBe(input); expect(input.value).toBe('操作');
    expect(textOf(knowledgeArea(root))).toBe(summary); expect(s.query).toHaveBeenCalledTimes(queryCount);
    selection.id = next.id; await settle(); expect(tabs(root).props.value).toBe('info'); expect(searchInput(root).value).toBe('');
    expect(s.query).toHaveBeenCalledWith({ versionId: s.knowledge.current!.id, modelId: next.modelId });
    await click(root, '编辑设备参数'); expect(edit).toHaveBeenCalledWith(next.id);
  });
  it('台账接入同一页签，拒绝更换详情保留检索，接受后清空', async () => {
    const s = await fixture(), root = await s.mount({ render: () => h(RouterView) }, '/resources');
    await click(root, s.device.id); await click(root, '运维知识'); await search(root, '操作');
    const next = s.resources.devices.find(row => row.id !== s.device.id)!, input = searchInput(root), close = vi.spyOn(s.editor, 'closeForm').mockResolvedValueOnce(false);
    const summary = textOf(knowledgeArea(root)), queryCount = s.query.mock.calls.length;
    await click(root, next.id); expect(close).toHaveBeenCalled(); expect(searchInput(root)).toBe(input); expect(input.value).toBe('操作');
    expect(tabs(root).props.value).toBe('knowledge');
    expect(textOf(knowledgeArea(root))).toBe(summary); expect(s.query).toHaveBeenCalledTimes(queryCount);
    await click(root, next.id); expect(tabs(root).props.value).toBe('info'); expect(searchInput(root).value).toBe('');
    expect(s.query).toHaveBeenCalledWith({ versionId: s.knowledge.current!.id, modelId: next.modelId, query: '' });
    expect(s.query).toHaveBeenCalledWith({ versionId: s.knowledge.current!.id, modelId: next.modelId });
  });
  it('台账知识异常不阻断原编辑入口，打开表单不提交资源', async () => {
    const s = await fixture(); let rejectKnowledge = true;
    // 摘要省略 query，原运维页签仍携带 query；失败只注入原运维请求。
    s.query.mockImplementation(request => {
      if (request.query !== undefined && rejectKnowledge) { rejectKnowledge = false; return Promise.reject(new Error('型号查询失败')); }
      return s.raw.getDeviceKnowledge(request);
    });
    const root = await s.mount({ render: () => h(RouterView) }, '/resources'), before = [...s.storage.entries];
    await click(root, s.device.id); await click(root, '运维知识'); expect(textOf(root)).toContain('型号查询失败');
    await click(root, '设备信息'); expect(textOf(root)).toContain('下架设备'); expect(textOf(root)).toContain('地图定位');
    const edit = vi.spyOn(s.editor, 'openForm'); await click(root, '编辑设备参数');
    expect(edit).toHaveBeenCalledWith('device', s.device.id, 'ledger'); expect(s.editor.form).not.toBeNull();
    expect([...s.storage.entries]).toEqual(before);
  });
});

describe('设备资料与告警共用展示', () => {
  it('角色跟随明确设备与网络，换设备、脏态和失权均清除旧内容', async () => {
    const s = await fixture(), selection = reactive({ id: 'DV-0001', dirty: false });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, {
      device: s.resources.devices.find(row => row.id === selection.id)!, resources: s.resources, catalog: s.catalog,
      network: createDeviceNetworkContext(s.preview.data!.situation, s.resources, s.preview.data!.resourceMeta, selection.dirty),
    }) });
    const role = () => textOf(find(root, row => row.props['aria-label'] === '设备网络角色')!);
    expect(role()).toContain('教学角色 A'); expect(role()).toContain('NET-DEMO-03');
    selection.id = 'DV-0002'; await settle(); expect(role()).toContain('未提供'); expect(role()).not.toContain('教学角色 A');
    expect(role()).toContain('NET-DEMO-03'); expect(role()).toContain('独立教学角色目录');
    selection.id = 'DV-0027'; await settle(); expect(role()).toContain('教学角色 B');
    selection.dirty = true; await settle(); expect(role()).toContain('未保存修改'); expect(role()).not.toContain('教学角色 B');
    selection.dirty = false; await settle(); expect(role()).toContain('教学角色 B');
    const identity = { ...s.auth.identity! };
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(p => p !== 'situation.view') }); await settle();
    expect(role()).toContain('没有关联网络查看权限'); expect(role()).not.toContain('教学角色 B');
  });
  it('角色资料错误单独提示，原设备字段仍显示', async () => {
    const s = await fixture(); s.preview.data!.situation.deviceNetwork!.roles!.snapshotId = 'OTHER';
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.device, resources: s.resources, catalog: s.catalog,
      network: createDeviceNetworkContext(s.preview.data!.situation, s.resources, s.preview.data!.resourceMeta) }) });
    expect(textOf(root)).toContain('角色资料归属或字段无效'); expect(textOf(root)).toContain(s.device.id);
    expect(textOf(root)).not.toContain('教学角色 A');
  });
  it('四组信息仅基础默认展开，资料按型号和关联天线读取，节点角色不冒充设备角色', async () => {
    const s = await fixture(), station = s.resources.stations.find(row => row.id === s.device.stationId)!;
    station.role = '节点专属角色';
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.device, resources: s.resources, catalog: s.catalog }) });
    for (const name of ['基础信息', '组成结构', '功能信息', '参数信息']) {
      const group = find(root, row => row.tag === 'details' && textOf(row).startsWith(name))!;
      expect(group, name).toBeDefined(); expect(group.props.open).toBe(name === '基础信息' ? '' : undefined);
    }
    const text = textOf(root), model = s.resources.models.find(row => row.id === s.device.modelId)!;
    const antenna = s.resources.antennas.find(row => row.id === s.device.antennaId)!;
    expect(text).toContain(model.manufacturer); expect(text).toContain('电台类型背负电台');
    expect(text).toContain(antenna.name); expect(text).toContain(s.device.antennaId);
    expect(text).toContain('设备网络角色未提供'); expect(text).not.toContain('节点专属角色');
    expect(text).toContain(station.coordinate.map(v => v.toFixed(6)).join(', '));
    expect(textOf(knowledgeArea(root, '设备子模块知识'))).toContain('功率放大模块');
    expect(textOf(knowledgeArea(root, '设备接口知识'))).toContain('此发布版本未提供该型号的接口知识');
    expect(textOf(knowledgeArea(root))).toContain('设备操作规范');
    expect(text).toContain('支持业务类型话音 / 数据'); expect(text).toContain('接收灵敏度-113 dBm');
    expect(text).toContain('支持信道带宽未提供'); expect(text).toContain('支持数据速率未提供');
    expect(text).toContain('PRC-150_用户操作手册.pdf');
    expect(!!find(root, row => row.tag === 'a' && textOf(row).includes('PRC-150_用户操作手册.pdf'))).toBe(false);
    expect(s.storage.writes).toBe(0);
  });
  it('能力档位与当前配置分别显示，零值、负值和原始约束文本不丢失', async () => {
    const s = await fixture(), device = { ...s.device, workFreqKhz: null, txPowerDbm: 0, tiltDeg: 0, azimuthDeg: 0 };
    const detail = s.catalog.models.find(row => row.modelId === device.modelId)!;
    detail.bandwidthKhz = [0.5, 2.4, 3]; detail.dataRatesKbps = [9.6, 19.2]; detail.constraintNote = '条件一；条件二;仍是完整说明';
    s.catalog.antennas.find(row => row.antennaId === device.antennaId)!.gainDbi = 0;
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources, catalog: s.catalog }) }), text = textOf(root);
    expect(text).toContain('设备当前配置工作频率未提供发射功率0 dBm');
    expect(text).toContain('倾角 / 方位角0 ° / 0 °'); expect(text).toContain('天线型号增益0 dBi');
    expect(text).toContain('支持信道带宽0.5 / 2.4 / 3 kHz'); expect(text).toContain('支持数据速率9.6 / 19.2 kbps');
    expect(text).toContain('支持功率档位30 / 36.99 / 43.01 dBm'); expect(text).toContain(detail.constraintNote);
    expect(text).toContain('以下为支持能力，不代表当前使用的模式、带宽或速率。');
    expect(device.workFreqKhz).toBeNull(); expect(device.txPowerDbm).toBe(0); expect(s.storage.writes).toBe(0);
  });
  it('缺少补充目录或型号和天线资料时显示未提供，不套用第一条资料', async () => {
    const s = await fixture(), device = reactive({ ...s.device });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources }) });
    for (const label of ['电台类型', '接收灵敏度', '天线型号增益', '支持功率档位']) expect(textOf(root)).toContain(label + '未提供');
    device.modelId = 'UNKNOWN'; device.antennaId = 'UNKNOWN'; device.stationId = 'UNKNOWN'; await settle();
    for (const label of ['厂家', '设备类别', '部署位置', '支持工作模式', '支持频段']) expect(textOf(root)).toContain(label + '未提供');
    expect(textOf(root)).not.toContain('-113 dBm'); expect(s.storage.writes).toBe(0);
  });
  // 三态与独立告警位组合验证，离线本身不被改成故障。
  it.each<[Device['status'], boolean, string]>([
    ['NORMAL', false, ''], ['NORMAL', true, '设备告警（运行状态：正常）'],
    ['FAULT', false, '设备故障'], ['FAULT', true, '设备故障 · 附加告警'],
    ['OFFLINE', false, ''], ['OFFLINE', true, '设备离线 · 附加告警'],
  ])('%s / alert=%s 使用设备自身状态展示横幅', async (status, alert, expected) => {
    const s = await fixture(), device = { ...s.device, status, alert };
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources, catalog: s.catalog }) });
    const banner = find(root, row => row.props.role === 'alert');
    if (expected) {
      expect(banner).toBeDefined(); expect(textOf(banner!)).toContain(expected);
      expect(textOf(banner!)).toContain('具体原因和发生时间未提供');
    } else expect(banner).toBeUndefined();
    expect(device.status).toBe(status); expect(device.alert).toBe(alert); expect(s.storage.writes).toBe(0);
  });
  it('设备切换同步更新型号、天线及横幅，不残留上一台资料', async () => {
    const s = await fixture(), selection = reactive({ device: { ...s.device, status: 'FAULT' as Device['status'], alert: false } });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: selection.device, resources: s.resources, catalog: s.catalog }) });
    expect(textOf(root)).toContain('设备故障');
    selection.device = { ...s.resources.devices.find(row => row.modelId !== s.device.modelId && row.antennaId !== s.device.antennaId)!, status: 'NORMAL', alert: false };
    await settle();
    const detail = s.catalog.models.find(row => row.modelId === selection.device.modelId)!;
    const gain = s.catalog.antennas.find(row => row.antennaId === selection.device.antennaId)!.gainDbi;
    expect(textOf(root)).toContain('电台类型' + detail.category); expect(textOf(root)).toContain(`天线型号增益${gain} dBi`);
    expect(textOf(root)).toContain(detail.sourceDoc!); expect(textOf(root)).not.toContain('PRC-150_用户操作手册.pdf');
    expect(find(root, row => row.props.role === 'alert')).toBeUndefined(); expect(tabs(root).props.value).toBe('info');
  });
  it('台账通过原预览入口拿到补充资料，保留权限限制且不会提交资源', async () => {
    const s = await fixture(), root = await s.mount({ render: () => h(RouterView) }, '/resources');
    await click(root, s.device.id);
    expect(textOf(root)).toContain('电台类型背负电台'); expect(textOf(root)).toContain('接收灵敏度-113 dBm');
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'resources.edit') });
    await settle();
    expect(find(root, row => row.tag === 'button' && textOf(row).trim() === '编辑设备参数')!.props.disabled).toBe(true);
    expect(s.storage.writes).toBe(0);
  });
});

describe('设备型号知识摘要展示', () => {
  it.each(['DM-0001', 'DM-0002'])('%s 显示明确部件和三项功能，来源与关系证据可折叠查看', async modelId => {
    const s = await fixture(), device = s.resources.devices.find(row => row.modelId === modelId)!;
    const before = JSON.stringify(s.preview.data), stored = [...s.storage.entries];
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources, catalog: s.catalog }) });
    const parts = knowledgeArea(root, '设备子模块知识'), functions = knowledgeArea(root);
    expect(textOf(parts)).toContain('功率放大模块'); expect(textOf(parts)).toContain('教学发射通路中的功率放大部件。');
    for (const name of ['通信工作原理', '设备操作规范', '日常维护要求']) expect(textOf(functions)).toContain(name);
    expect(textOf(functions)).not.toContain('工作频率说明'); expect(textOf(parts)).not.toContain('短波天线检查');
    expect(textOf(parts)).toContain('独立教学预设 · 非厂家操作手册');
    const evidence = find(parts, row => row.tag === 'details')!;
    expect(evidence.props.open).toBeUndefined(); expect(textOf(evidence)).toContain('KGE-POWER');
    expect(textOf(evidence)).toContain('短波电台型号知识（KGE-MODEL）');
    expect(textOf(evidence)).toContain('hasComponent（KGR-001）');
    expect(textOf(evidence)).toContain('独立教学关系预设 · 不参与推理');
    expect(textOf(root)).toContain('型号知识发布版本：KGV-SEED-2');
    expect(textOf(knowledgeArea(root, '设备接口知识'))).toBe('此发布版本未提供该型号的接口知识');
    expect(s.query).toHaveBeenCalledWith({ versionId: 'KGV-SEED-2', modelId });
    expect(JSON.stringify(s.preview.data)).toBe(before); expect([...s.storage.entries]).toEqual(stored);
  });
  it('其他型号保持知识缺省，切回已知型号重新读取，不套用前一型号', async () => {
    const s = await fixture(), selection = reactive({ device: s.device });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: selection.device, resources: s.resources }) });
    expect(textOf(knowledgeArea(root))).toContain('日常维护要求');
    selection.device = s.resources.devices.find(row => row.modelId === 'DM-0003')!; await settle();
    for (const [label, kind] of [['设备子模块知识', '部件'], ['设备接口知识', '接口'], ['设备型号功能知识', '功能']])
      expect(textOf(knowledgeArea(root, label))).toBe(`此发布版本未提供该型号的${kind}知识`);
    selection.device = s.device; await settle(); expect(textOf(knowledgeArea(root))).toContain('日常维护要求');
    expect(s.storage.writes).toBe(0);
  });
  it('完整摘要不被运维检索裁剪，往返页签不额外读取或改资源草稿', async () => {
    const s = await fixture(), device = reactive({ ...s.device });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources }) });
    const summary = textOf(knowledgeArea(root)), count = () => s.query.mock.calls.filter(([request]) => request.query === undefined).length;
    expect(count()).toBe(1); await click(root, '运维知识'); await search(root, '操作');
    const panel = find(root, row => row.props.class === 'device-knowledge')!;
    expect(textOf(panel)).toContain('设备操作规范'); expect(textOf(panel)).not.toContain('日常维护要求');
    expect(textOf(knowledgeArea(root))).toBe(summary); expect(count()).toBe(1);
    device.txPowerDbm = 0; await settle(); expect(textOf(knowledgeArea(root))).toBe(summary); expect(count()).toBe(1);
    await click(root, '设备信息'); await click(root, '运维知识'); expect(count()).toBe(1); expect(searchInput(root).value).toBe('操作');
    expect(device.txPowerDbm).toBe(0); expect(s.storage.writes).toBe(0);
  });
  it('摘要读取失败独立重试，原运维知识和设备信息仍可使用', async () => {
    const s = await fixture(); let failSummary = true;
    s.query.mockImplementation(request => {
      if (request.query === undefined && failSummary) return Promise.reject(new Error('摘要读取暂不可用'));
      return s.raw.getDeviceKnowledge(request);
    });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.device, resources: s.resources }) });
    expect(textOf(knowledgeArea(root))).toContain('型号知识读取失败：摘要读取暂不可用');
    expect(textOf(root)).toContain('设备当前配置'); expect(s.knowledge.loadError).toBe(''); expect(s.preview.error).toBe('');
    await click(root, '运维知识'); expect(textOf(find(root, row => row.props.class === 'device-knowledge')!)).toContain('发布快照：KGV-SEED-2');
    failSummary = false; await click(root, '设备信息'); await click(root, '重试型号知识');
    expect(textOf(knowledgeArea(root))).toContain('日常维护要求'); expect(textOf(root)).not.toContain('摘要读取暂不可用');
    expect(s.storage.writes).toBe(0);
  });
  it('加载中不把摘要显示成缺资料，失去权限清除摘要且不再请求', async () => {
    const s = await fixture(); let finish!: (data: DeviceKnowledge) => void;
    s.query.mockImplementation(request => request.query === undefined ? new Promise(resolve => { finish = resolve; }) : s.raw.getDeviceKnowledge(request));
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.device, resources: s.resources }) });
    expect(textOf(knowledgeArea(root))).toBe('正在读取型号知识…'); expect(textOf(root)).toContain('设备当前配置');
    const result = await s.raw.getDeviceKnowledge({ versionId: s.knowledge.current!.id, modelId: s.device.modelId });
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'knowledge.view') }); await settle();
    const calls = s.query.mock.calls.length; finish(result); await settle();
    expect(textOf(knowledgeArea(root))).toBe('当前角色没有知识查看权限'); expect(textOf(root)).not.toContain('型号知识发布版本：');
    expect(s.query).toHaveBeenCalledTimes(calls); expect(textOf(root)).toContain('设备当前配置'); expect(s.storage.writes).toBe(0);
  });
  it('明确接口关系显示名称和来源，空描述保留未提供说明', async () => {
    const s = await fixture();
    // 接口仅作为本测试的服务响应，不写入初始知识数据或工作区。
    s.query.mockImplementation(async request => {
      const result = await s.raw.getDeviceKnowledge(request);
      if (request.query === undefined) {
        const root = result.items.find(item => item.entity.id === 'KGE-MODEL')!;
        root.neighbors.push({ ...structuredClone(root.entity), id: 'KGE-TEST-INTERFACE', type: 'Interface', name: '测试接口知识', description: '', source: '组件检查资料' });
        root.relations.push({ id: 'KGR-TEST-INTERFACE', head: root.entity.id, tail: 'KGE-TEST-INTERFACE', type: 'hasInterface', weight: null, source: '组件检查明确关系' });
      }
      return result;
    });
    const before = [...s.storage.entries], root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.device, resources: s.resources }) });
    const text = textOf(knowledgeArea(root, '设备接口知识'));
    expect(text).toContain('测试接口知识'); expect(text).toContain('未提供说明'); expect(text).toContain('组件检查资料');
    expect(text).toContain('hasInterface（KGR-TEST-INTERFACE）'); expect(text).toContain('组件检查明确关系');
    expect([...s.storage.entries]).toEqual(before);
  });
  it('实际回滚更新当前发布摘要和版本，不读取未发布草稿', async () => {
    const s = await fixture(), root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.device, resources: s.resources }) });
    expect(textOf(knowledgeArea(root))).toContain('维护完成后复查并记录结果');
    expect(textOf(knowledgeArea(root))).not.toContain('记录异常与操作时间');
    const w = s.knowledge.workspace!;
    const result = await s.raw.rollbackKnowledgeVersion({ actorId: 'KG-REVIEWER', baseRevision: w.revision, requestId: 'summary-back', versionId: w.currentVersionId, reason: '摘要回滚检查' });
    s.knowledge.workspace = result.workspace; await settle();
    expect(textOf(knowledgeArea(root))).not.toContain('维护完成后复查并记录结果');
    expect(textOf(knowledgeArea(root))).toContain('不执行真实控制');
    expect(textOf(root)).toContain(`型号知识发布版本：${result.workspace.currentVersionId}`);
    expect(s.query).toHaveBeenCalledWith({ versionId: result.workspace.currentVersionId, modelId: s.device.modelId });
  });
});

describe('设备关联分组展示', () => {
  // 运行同一资料组件和实际目录，避免只检查静态标签。
  const networkOf = (s: Awaited<ReturnType<typeof fixture>>) => createDeviceNetworkContext(s.preview.data!.situation, s.resources, s.preview.data!.resourceMeta);
  const networkPanel = (root: HostNode) => find(root, row => row.props.class === 'device-network')!;
  it('关联分组默认折叠，展示两项业务主备路径及明确来源，不填入设备当前频点', async () => {
    const s = await fixture(), device = s.resources.devices.find(row => row.id === 'DV-0001')!;
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources, catalog: s.catalog, network: networkOf(s) }) });
    expect(find(root, row => row.tag === 'details' && textOf(row).startsWith('关联链路与承载业务'))!.props.open).toBeUndefined();
    const text = textOf(networkPanel(root));
    expect(text).toContain('NET-DEMO-03'); expect(text).toContain('非实时业务流量');
    expect(text).toContain('关联链路 · 2 条'); expect(text).toContain('承载业务 · 2 项');
    expect(text).toContain('固定站话音保障 · 话音'); expect(text).toContain('固定站数据传输 · 数据');
    expect(text).toContain('主路径参与'); expect(text).toContain('备用保障');
    expect(text).toContain('PL-002 → PL-003'); expect(text).toContain('PL-001 → PL-007');
    expect(text).toContain('备用保障不表示已切换或正在承载流量');
    expect(textOf(root)).toContain('设备当前配置工作频率未提供'); expect(device.workFreqKhz).toBeNull(); expect(s.storage.writes).toBe(0);
  });
  it('更换设备后主备参与关系更新，同站其他设备显示空态且不残留原业务', async () => {
    const s = await fixture(), selection = reactive({ id: 'DV-0037' });
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device: s.resources.devices.find(row => row.id === selection.id)!, resources: s.resources, network: networkOf(s) }) });
    expect(textOf(networkPanel(root))).toContain('主路径参与');
    selection.id = 'DV-0027'; await settle();
    expect(textOf(networkPanel(root))).not.toContain('主路径参与');
    expect(textOf(find(networkPanel(root), row => row.props.class === 'route-role')!)).toBe('未经过本设备');
    expect(textOf(networkPanel(root))).toContain('PL-007');
    selection.id = 'DV-0002'; await settle();
    expect(textOf(networkPanel(root))).toContain('当前演示网络未关联此设备');
    expect(textOf(networkPanel(root))).toContain('此设备暂无预设承载业务');
    expect(textOf(networkPanel(root))).not.toContain('固定站话音保障'); expect(tabs(root).props.value).toBe('info'); expect(s.storage.writes).toBe(0);
  });
  it('无 GIS 查看权限只隐藏关联，基础资料与原台账编辑入口保留', async () => {
    const s = await fixture(), root = await s.mount({ render: () => h(RouterView) }, '/resources');
    await click(root, 'DV-0001'); expect(textOf(networkPanel(root))).toContain('固定站话音保障');
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'situation.view') }); await settle();
    expect(textOf(networkPanel(root))).toContain('没有 GIS 查看权限'); expect(textOf(networkPanel(root))).not.toContain('PL-001');
    expect(textOf(root)).toContain('设备当前配置'); await click(root, '编辑设备参数');
    expect(s.editor.form?.id).toBe('DV-0001'); expect(s.storage.writes).toBe(0);
  });
  it('台账按保存状态展示关联，未提交表单保留；保存变更后暂停展示', async () => {
    const s = await fixture(), root = await s.mount({ render: () => h(RouterView) }, '/resources');
    await click(root, 'DV-0001'); await click(root, '编辑设备参数');
    s.editor.form!.fields.txPowerDbm = '40'; await settle();
    // 原台账打开编辑表单时收起详情；其网络依据仍是保存值。
    expect(!!networkPanel(root)).toBe(false); expect(networkOf(s).state).toBe('ready');
    s.preview.data!.resourceMeta.changedDeviceIds.push('DV-0001'); await settle();
    expect(s.editor.form!.fields.txPowerDbm).toBe('40');
    s.editor.form!.fields.txPowerDbm = s.editor.form!.initial.txPowerDbm;
    await s.editor.closeForm(); await settle();
    expect(textOf(networkPanel(root))).toContain('资源已变更'); expect(textOf(networkPanel(root))).not.toContain('固定站话音保障');
    expect(s.storage.writes).toBe(0);
  });
  it('缺目录与快照错配只影响关联区域，不回退其他网络或阻断设备资料', async () => {
    const s = await fixture(), device = s.resources.devices.find(row => row.id === 'DV-0001')!;
    const root = await s.mount({ render: () => h(DeviceInfoPanel, { device, resources: s.resources, network: networkOf(s) }) });
    s.preview.data!.situation.deviceNetwork!.snapshotId = 'NET-DEMO-01'; await settle();
    expect(textOf(networkPanel(root))).toContain('版本不匹配'); expect(textOf(networkPanel(root))).not.toContain('PL-001');
    delete s.preview.data!.situation.deviceNetwork; await settle();
    expect(textOf(networkPanel(root))).toContain('暂无当前演示网络的关联资料'); expect(textOf(root)).toContain('设备当前配置'); expect(s.storage.writes).toBe(0);
  });
});

describe('设备知识工作原理联动', () => {
  const chart = (root: HostNode) => find(root, n => n.props['aria-label'] === '工作原理流程图');
  const full = (root: HostNode) => find(root, n => n.tag === 'dialog-probe');
  it('GIS 共用详情展示固定流程，查看不改资源和知识记录', async () => {
    const s = await fixture(), before = [...s.storage.entries];
    const root = await s.mount({ render: () => h(ObjectInfoPanel, { station: s.resources.stations.find(row => row.id === s.device.stationId), selectedDeviceId: s.device.id, resources: s.resources, deviceCatalog: s.catalog }) });
    await click(root, '运维知识'); expect(chart(root)).toBeDefined();
    await click(root, '全屏查看'); expect(textOf(full(root)!)).toContain('输入信号'); expect(textOf(full(root)!)).toContain('KGV-SEED-2');
    await click(root, '退出全屏'); expect(full(root)).toBeUndefined(); expect([...s.storage.entries]).toEqual(before);
  });
  it('同型号换设备也关闭全屏，换到无知识型号不会残留旧图', async () => {
    const s = await fixture(), root = await s.mount(); await click(root, '运维知识'); await click(root, '全屏查看');
    s.props.deviceId = s.resources.devices.find(d => d.id !== s.device.id && d.modelId === s.device.modelId)!.id;
    await settle(); expect(full(root)).toBeUndefined(); expect(tabs(root).props.value).toBe('info');
    await click(root, '运维知识'); await click(root, '全屏查看');
    Object.assign(s.props, { deviceId: 'other-device', modelId: 'DM-0003' }); await settle();
    expect(full(root)).toBeUndefined(); expect(chart(root)).toBeUndefined(); expect(textOf(root)).toContain('暂无匹配');
  });
  it('真实知识回滚后重查并关闭旧全屏，搜索不匹配时不残留图', async () => {
    const s = await fixture(), root = await s.mount(); await click(root, '运维知识'); await click(root, '全屏查看');
    const w = s.knowledge.workspace!;
    const result = await s.raw.rollbackKnowledgeVersion({ actorId: 'KG-REVIEWER', baseRevision: w.revision, requestId: 'flow-back', versionId: w.currentVersionId, reason: '回滚演示' });
    s.knowledge.workspace = result.workspace; await settle();
    expect(full(root)).toBeUndefined(); expect(chart(root)).toBeDefined();
    await click(root, '全屏查看'); expect(textOf(full(root)!)).toContain(result.workspace.currentVersionId);
    await search(root, '不存在的原理'); expect(full(root)).toBeUndefined(); expect(chart(root)).toBeUndefined();
  });
  it('台账详情同样展示流程；权限变化关闭全屏但保留设备资料', async () => {
    const s = await fixture(), root = await s.mount({ render: () => h(RouterView) }, '/resources');
    await click(root, s.device.id); await click(root, '运维知识'); await click(root, '全屏查看'); expect(full(root)).toBeDefined();
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'knowledge.view') }); await settle();
    expect(full(root)).toBeUndefined(); expect(chart(root)).toBeUndefined(); expect(textOf(root)).toContain('没有知识查看权限');
    await click(root, '设备信息'); expect(textOf(root)).toContain('设备当前配置'); expect(s.storage.writes).toBe(0);
  });
});
