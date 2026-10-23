import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import Papa from 'papaparse';
import AppDrawer from '../src/components/AppDrawer.vue';
import ResourceImportDrawer from '../src/components/ResourceImportDrawer.vue';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { resourceTemplate } from '../src/services/resource-files';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 仅共用编译逻辑，焦点、滚动和 Hash 模拟保留本地实现。
import { clientTemplate } from './helpers/vue-client';

// 只替换弹层容器，实际抽屉模板、Store、校验器及导入解析器均参与回归。
vi.mock('primevue/drawer', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible
    ? h('drawer-probe', [slots.default?.(), slots.footer?.()]) : null }) };
});
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[]; options: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown; open: boolean;
  focus: () => void; scrollIntoView: () => void; getAttribute: (key: string) => string | null;
  matches: (selector: string) => boolean; querySelectorAll: (selector: string) => HostNode[];
  querySelector: (selector: string) => HostNode | null;
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
let focused: HostNode | null = null, scrolled: HostNode | null = null;
function all(root: HostNode): HostNode[] { return [root, ...root.children.flatMap(all)]; }
const node = (tag: string, text = ''): HostNode => ({
  tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {}, open: false,
  get options() { return this.children.filter(n => n.tag === 'option'); },
  // 内存节点是普通对象，去掉 Vue 代理后按真实 DOM 的对象身份记录焦点。
  focus() { focused = Vue.toRaw(this); }, scrollIntoView() { scrolled = Vue.toRaw(this); },
  getAttribute(key) { return this.props[key] == null ? null : String(this.props[key]); },
  matches() { return !!this.props.disabled; },
  querySelectorAll(selector) { const key = selector.slice(1, -1); return all(this).slice(1).filter(n => n.props[key] != null); },
  querySelector(selector) { return all(this).slice(1).find(n => n.tag === selector) ?? null; },
  addEventListener() {}, removeEventListener() {}, getRootNode: () => document,
});
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; if (key === 'open') el.open = !!value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
const actions = (root: HostNode) => all(root).filter(n => n.props.class === 'text-link');
const invoke = (el: HostNode) => (el.props.onClick as () => Promise<void>)();
// 内存宿主补充链接的默认 Hash 行为以捕获旧缺陷；不冒充浏览器导航或布局验收。
async function click(el: HostNode) {
  if (el.props.onClick) await invoke(el);
  if (el.tag === 'a' && el.props.href) location.hash = new URL(String(el.props.href), location.href).hash;
  await nextTick();
}
await Promise.all([
  [AppDrawer, 'src/components/AppDrawer.vue'],
  [ResourceImportDrawer, 'src/components/ResourceImportDrawer.vue'],
].map(([component, path]) => clientTemplate(component as Component, path as string, 'resource-entry-render.ts')));
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => {
  app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); focused = null; scrolled = null;
});
async function context() {
  class TestDocument { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('location', new URL('http://localhost/#/situation'));
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  vi.spyOn(previewService, 'previewResourceImport').mockImplementation(raw.previewResourceImport);
  // GIS 导入使用服务返回的完整编辑基线，不建立旧台账表单宿主。
  const read = await raw.loadResourceReadContext({ context: 'gis' }), editor = useResourceEditStore();
  editor.acceptGisContext(await raw.loadGisResourceEditContext({ context: 'gis', revision: read.revision })); editor.begin();
  return { editor, storage };
}
function mount(component: Component) {
  const root = node('root'); app = renderer.createApp({ render: () => h(component) });
  app.use(pinia!); app.provide(ssrContextKey, {}); app.mount(root); return root;
}
async function importFile(kind: 'field' | 'header' | 'duplicate' = 'field') {
  const file = await resourceTemplate('csv', 'nodes'), rows = Papa.parse<string[]>(new TextDecoder().decode(file.bytes)).data;
  if (kind === 'field') rows[1][rows[0].indexOf('lon')] = 'bad';
  if (kind === 'header') rows[0][0] = 'unknown_column';
  if (kind === 'duplicate') rows.push([...rows[1]]);
  return { ...file, bytes: new TextEncoder().encode(Papa.unparse(rows)) };
}
async function importContext(kind: 'field' | 'header' | 'duplicate' = 'field') {
  const state = await context(); await state.editor.openImport();
  const root = mount(ResourceImportDrawer); await nextTick();
  await state.editor.previewImport(await importFile(kind)); await nextTick();
  expect(state.editor.importPreview!.issues.length).toBeGreaterThan(0);
  return { ...state, root };
}

describe('资源错误定位入口', () => {
  it('有效导入错误展开实际预览行、聚焦摘要，保留文件及路由且不提交', async () => {
    const { editor, root, storage } = await importContext(), confirm = vi.spyOn(editor, 'confirmImport');
    const preview = editor.importPreview, file = editor.importFile, row = all(root).find(n => n.tag === 'details')!;
    row.open = false; await click(actions(root)[0]!);
    expect(row.open).toBe(true); expect(focused?.tag).toBe('summary'); expect(focused?.parent).toBe(row); expect(scrolled).toBe(row);
    expect(editor.importPreview).toBe(preview); expect(editor.importFile).toBe(file); expect(location.hash).toBe('#/situation');
    expect(confirm).not.toHaveBeenCalled(); expect(storage.writes).toBe(0);
  });
  it.each(['header', 'duplicate'] as const)('解析器返回 %s 无对应预览行时显示原文件修正说明', async kind => {
    const { editor, root } = await importContext(kind);
    expect(editor.importPreview!.issues.every(issue => !editor.importPreview!.rows.some(row => row.sheet === issue.sheet && row.row === issue.row))).toBe(true);
    expect(actions(root)).toHaveLength(0); expect(all(root).filter(n => n.tag === 'a')).toHaveLength(0);
    expect(textOf(root)).toContain('请在原文件修正后重新预检'); expect(location.hash).toBe('#/situation');
  });
  it('重新预检即使工作表行号相同也拒绝旧预览的定位事件', async () => {
    const { editor, root } = await importContext(), action = actions(root)[0]!, previous = editor.importPreview;
    await editor.previewImport(await importFile()); await nextTick(); expect(editor.importPreview).not.toBe(previous);
    await invoke(action); expect(focused).toBeNull(); expect(scrolled).toBeNull();
    await click(actions(root)[0]!); expect(focused?.tag).toBe('summary');
  });
  it('选取替换文件时旧定位立即失效，保留读取中的文件状态', async () => {
    const { editor, root } = await importContext(), action = actions(root)[0]!, file = await importFile();
    let finish!: (bytes: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    const input = all(root).find(n => n.props.type === 'file')!;
    const reading = (input.props.onChange as (event: unknown) => Promise<void>)({ target: { files: [{ name: 'replacement.csv', size: file.bytes.length, arrayBuffer: () => bytes }] } });
    await invoke(action); expect(focused).toBeNull(); expect(scrolled).toBeNull(); expect(editor.importFile!.name).toBe('replacement.csv');
    finish(new Uint8Array(file.bytes).buffer); await reading; await nextTick(); expect(editor.importPreview).not.toBeNull();
  });
  it('导入关闭后旧入口和等待渲染的定位都不再聚焦', async () => {
    const { editor, root } = await importContext(), action = actions(root)[0]!, pending = invoke(action);
    editor.importOpen = false; await pending; expect(focused).toBeNull(); expect(scrolled).toBeNull();
    await invoke(action); expect(focused).toBeNull(); expect(scrolled).toBeNull();
  });
});
