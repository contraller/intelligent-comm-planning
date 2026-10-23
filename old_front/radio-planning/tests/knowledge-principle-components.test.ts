import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import KnowledgePrincipleFlow from '../src/components/KnowledgePrincipleFlow.vue';
import KnowledgePrincipleEditor from '../src/components/KnowledgePrincipleEditor.vue';
import KnowledgeChangeDrawer from '../src/components/KnowledgeChangeDrawer.vue';
import KnowledgeVersionDrawer from '../src/components/KnowledgeVersionDrawer.vue';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { resolveKnowledgePrinciple } from '../src/services/knowledge-principle';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { authorizeStore } from './helpers/auth';
import type { KnowledgePrincipleFlow as PrincipleFlow } from '../src/types/knowledge';

// 只替换弹层的 DOM 外壳；业务模板、事件和状态使用真实组件。
vi.mock('primevue/dialog', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: { visible: Boolean, closeOnEscape: { type: Boolean, default: true }, modal: Boolean, blockScroll: Boolean, header: String }, emits: ['update:visible'],
    setup(props, { emit, slots }) { return () => props.visible ? h('dialog-probe', {
      modal: props.modal, blockScroll: props.blockScroll, closeOnEscape: props.closeOnEscape, header: props.header,
      onKeydown: (event: { key: string }) => { if (event.key === 'Escape' && props.closeOnEscape !== false) emit('update:visible', false); },
    }, [...(slots.default?.() ?? []), ...(slots.footer?.() ?? []), h('button', { onClick: () => emit('update:visible', false) }, '关闭弹窗')]) : null; },
  }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) {
    return () => props.visible ? h('section', [...(slots.default?.() ?? []), ...(slots.footer?.() ?? [])]) : null;
  } }) };
});
vi.mock('../src/components/KnowledgeStateBadge.vue', () => ({ default: { render: () => null } }));

// 与既有设备组件检查一致，在内存中编译客户端模板，不生成测试文件产物。
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
  clientTemplate(KnowledgePrincipleFlow, 'src/components/KnowledgePrincipleFlow.vue'),
  clientTemplate(KnowledgePrincipleEditor, 'src/components/KnowledgePrincipleEditor.vue'),
  clientTemplate(KnowledgeChangeDrawer, 'src/components/KnowledgeChangeDrawer.vue'),
  clientTemplate(KnowledgeVersionDrawer, 'src/components/KnowledgeVersionDrawer.vue'),
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
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); await nextTick(); }
async function click(root: HostNode, label: string) {
  const button = find(root, n => n.tag === 'button' && (n.props['aria-label'] === label || textOf(n).trim() === label));
  expect(button, label).toBeDefined(); await (button!.props.onClick as () => unknown)(); await settle();
}
async function input(root: HostNode, label: string, value: string) {
  const element = find(root, n => n.props['aria-label'] === label)!;
  expect(element, label).toBeDefined();
  (element.props.onInput as (event: { target: { value: string } }) => void)({ target: { value } }); await settle();
}
const dialog = (root: HostNode) => find(root, n => n.tag === 'dialog-probe');
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('window', new EventTarget());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore('kg_editor'), store = useKnowledgeStore();
  store.workspace = initialKnowledgeWorkspace();
  const state = reactive({ entity: knowledgeClone(store.current!.entities.find(e => e.id === 'KGE-PRINCIPLE')!), readonly: false, context: '草稿预览 · KGV-SEED-2' });
  async function mount(component: Component = { render: () => h(KnowledgePrincipleEditor, { ...state,
    'onUpdate:flow': (flow: PrincipleFlow | null) => { state.entity.principleFlow = flow; },
  }) }) {
    app = renderer.createApp(component); app.use(pinia!); app.provide(ssrContextKey, {});
    const root = node('root'); app.mount(root); await settle(); return root;
  }
  return { state, auth, store, mount };
}

describe('工作原理维护与展示组件', () => {
  it('仅打开示例不改草稿，明确编辑才复制四个步骤', async () => {
    const s = fixture(), before = JSON.stringify(s.state.entity), root = await s.mount();
    expect(textOf(root)).toContain('输入信号'); expect(JSON.stringify(s.state.entity)).toBe(before);
    await click(root, '编辑示例步骤'); expect(s.state.entity.principleFlow!.steps).toHaveLength(4);
    await input(root, '第 1 步标题', '新的输入'); await input(root, '第 1 步说明', '新的说明');
    expect(s.state.entity.principleFlow!.steps[0]).toEqual({ title: '新的输入', description: '新的说明' });
    expect(resolveKnowledgePrinciple(initialKnowledgeWorkspace().versions[0].entities.find(e => e.id === 'KGE-PRINCIPLE')!)!.flow.steps[0].title).toBe('输入信号');
  });
  it('上移、下移、增删保持顺序，至少保留两步', async () => {
    const s = fixture(), root = await s.mount(); await click(root, '编辑示例步骤');
    await click(root, '下移第 1 步'); expect(s.state.entity.principleFlow!.steps.map(s => s.title)).toEqual(['信号处理', '输入信号', '射频传输', '接收还原']);
    await click(root, '上移第 2 步'); expect(s.state.entity.principleFlow!.steps[0].title).toBe('输入信号');
    await click(root, '移除第 4 步'); await click(root, '移除第 3 步');
    const remove = find(root, n => n.props['aria-label'] === '移除第 1 步')!; expect(remove.props.disabled).toBe(true);
    await click(root, '移除第 1 步'); expect(s.state.entity.principleFlow!.steps).toHaveLength(2);
    await click(root, '添加步骤'); expect(s.state.entity.principleFlow!.steps).toHaveLength(3);
    expect(textOf(root)).toContain('第 3 步：标题');
    expect(find(root, n => n.props['aria-label'] === '工作原理流程图')).toBeUndefined();
    await input(root, '第 3 步标题', '新步骤'); expect(find(root, n => n.props['aria-label'] === '工作原理流程图')).toBeDefined();
  });
  it('最多十二步，直接调用禁用按钮也不能越界', async () => {
    const s = fixture(), root = await s.mount(); await click(root, '编辑示例步骤');
    for (let i = 0; i < 9; i++) await click(root, '添加步骤');
    expect(s.state.entity.principleFlow!.steps).toHaveLength(12);
    expect(find(root, n => n.tag === 'button' && textOf(n) === '添加步骤')!.props.disabled).toBe(true);
  });
  it('移除整个流程明确写 null，不自动恢复示例；再添加从空步骤开始', async () => {
    const s = fixture(), root = await s.mount(); await click(root, '移除整个流程');
    expect(s.state.entity.principleFlow).toBeNull(); expect(textOf(root)).not.toContain('固定教学示例');
    expect(find(root, n => n.props['aria-label'] === '工作原理流程图')).toBeUndefined();
    await click(root, '添加工作原理流程'); expect(s.state.entity.principleFlow!.steps).toEqual([{ title: '', description: '' }, { title: '', description: '' }]);
  });
  it('只读状态展示步骤，事件守卫阻止陈旧编辑回调写入', async () => {
    const s = fixture(), root = await s.mount(); await click(root, '编辑示例步骤');
    const oldInput = find(root, n => n.props['aria-label'] === '第 1 步标题')!.props.onInput as (event: unknown) => void;
    s.state.readonly = true; await settle(); const before = JSON.stringify(s.state.entity);
    expect(find(root, n => n.props['aria-label'] === '第 1 步标题')!.props.readonly).toBe(true);
    expect(find(root, n => n.tag === 'button' && textOf(n) === '添加步骤')).toBeUndefined();
    oldInput({ target: { value: '越权修改' } }); await settle(); expect(JSON.stringify(s.state.entity)).toBe(before);
    await click(root, '全屏查看'); expect(dialog(root)).toBeDefined();
  });
  it('全屏标记模态与 Esc，退出和关闭事件均收起且不改实体', async () => {
    const s = fixture(), root = await s.mount(), before = JSON.stringify(s.state.entity);
    await click(root, '全屏查看'); expect(dialog(root)!.props).toMatchObject({ modal: true, blockScroll: true, closeOnEscape: true });
    expect(textOf(dialog(root)!)).toContain('草稿预览 · KGV-SEED-2');
    await click(root, '退出全屏'); expect(dialog(root)).toBeUndefined();
    await click(root, '全屏查看'); await click(root, '关闭弹窗'); expect(dialog(root)).toBeUndefined();
    await click(root, '全屏查看'); (dialog(root)!.props.onKeydown as (event: { key: string }) => void)({ key: 'Escape' }); await settle();
    expect(dialog(root)).toBeUndefined(); expect(JSON.stringify(s.state.entity)).toBe(before);
  });
  it.each(['版本', '内容', '身份', '权限'] as const)('%s 变化关闭旧全屏，丢失权限不显示图', async kind => {
    const s = fixture(), root = await s.mount(); await click(root, '全屏查看');
    if (kind === '版本') s.state.context = '已发布 · KGV-NEW';
    else if (kind === '内容') s.state.entity.description = '原理已改变';
    else if (kind === '身份') s.auth.generation++;
    else s.auth.identity!.permissions = [];
    await settle(); expect(dialog(root)).toBeUndefined();
    if (kind === '权限') expect(find(root, n => n.props['aria-label'] === '工作原理流程图')).toBeUndefined();
  });
  it('流程文字仅按文本显示，不执行 HTML；非设备知识没有编辑区', async () => {
    const s = fixture(); s.state.entity.principleFlow = { steps: [{ title: '<img src=x onerror=alert(1)>', description: '<script>alert(2)</script>' }, { title: '结束', description: '' }] };
    const root = await s.mount();
    expect(find(root, n => n.tag === 'img' || n.tag === 'script')).toBeUndefined();
    expect(find(root, n => n.tag === 'strong' && n.text.includes('<img'))).toBeDefined();
    s.state.entity.category = '网络态势知识'; await settle(); expect(find(root, n => n.props['aria-label'] === '工作原理步骤维护')).toBeUndefined();
  });
  it('实际变更抽屉显示步骤差异，审核身份不能编辑送审内容', async () => {
    const s = fixture(); await s.store.newChange(s.state.entity); const root = await s.mount(KnowledgeChangeDrawer);
    expect(s.store.dirtyDraft).toBe(false); await click(root, '编辑示例步骤'); await input(root, '第 1 步标题', '新版输入');
    expect(s.store.dirtyDraft).toBe(true);
    expect(textOf(root)).toContain('变更前'); expect(textOf(root)).toContain('固定教学示例'); expect(textOf(root)).toContain('1. 新版输入');
    authorizeStore('kg_reviewer'); await settle();
    expect(find(root, n => n.props['aria-label'] === '第 1 步标题')!.props.readonly).toBe(true);
  });
  it('历史抽屉按选定快照显示步骤，切换版本收起全屏', async () => {
    const s = fixture(); const w = s.store.workspace!;
    w.versions.push({ ...knowledgeClone(w.versions[1]), id: 'test-history', number: 3, parentId: w.versions[1].id });
    w.versions[2].entities.find(e => e.id === 'KGE-PRINCIPLE')!.principleFlow = { steps: [{ title: '历史新步骤', description: '' }, { title: '末步', description: '' }] };
    s.store.historyVersionId = 'test-history'; const root = await s.mount(KnowledgeVersionDrawer);
    expect(textOf(root)).toContain('1. 历史新步骤'); await click(root, '全屏查看'); expect(dialog(root)).toBeDefined();
    s.store.historyVersionId = w.versions[0].id; await settle();
    expect(dialog(root)).toBeUndefined(); expect(textOf(root)).not.toContain('历史新步骤'); expect(textOf(root)).toContain('输入信号');
  });
});
