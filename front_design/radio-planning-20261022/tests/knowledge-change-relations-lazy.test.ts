import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import type { KnowledgeChange, KnowledgeDraft, KnowledgeEntity, KnowledgeRelation, KnowledgeVersion } from '../src/types/knowledge';

const service = vi.hoisted(() => ({ saveKnowledgeReceipt: vi.fn(), getKnowledgeChange: vi.fn(), loadKnowledgeMetadata: vi.fn(), queryKnowledgeChanges: vi.fn() }));
vi.mock('../src/services', () => ({ previewService: service, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible ? h('aside', [slots.default?.(), slots.footer?.()]) : null }) };
});
vi.mock('../src/components/KnowledgeStateBadge.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/KnowledgePrincipleEditor.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/KnowledgeNetworkRuleEditor.vue', () => ({ default: { render: () => null } }));

import KnowledgeChangeDrawer from '../src/components/KnowledgeChangeDrawer.vue';
import KnowledgeEndpointSelect from '../src/components/KnowledgeEndpointSelect.vue';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { useAuthStore } from '../src/stores/auth';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { all, clientTemplate, find, node, textOf, type HostNode } from './helpers/vue-client';

let pinia: ReturnType<typeof createPinia>, app: App | undefined, root: HostNode;
const focused: HostNode[] = [], scrolled: HostNode[] = [];
function remove(child: HostNode) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
// Only records focus/scroll requests; this is not a browser performance or viewport test.
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove,
  createElement: tag => Object.assign(node(tag), {
    focus(this: HostNode) { focused.push(this); },
    scrollIntoView(this: HostNode) { scrolled.push(this); },
  }),
  createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
beforeAll(async () => {
  await clientTemplate(KnowledgeChangeDrawer, 'src/components/KnowledgeChangeDrawer.vue', 'lazy-relations-render.ts');
  await clientTemplate(KnowledgeEndpointSelect, 'src/components/KnowledgeEndpointSelect.vue', 'lazy-relations-render.ts');
});
beforeEach(() => {
  class TestDocument extends EventTarget {
    activeElement = null;
    getElementById(id: string) { return root ? find(root, n => n.props.id === id) ?? null : null; }
  }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('ShadowRoot', class {});
  vi.clearAllMocks(); focused.length = 0; scrolled.length = 0;
  pinia = createPinia(); setActivePinia(pinia);
  useAuthStore().accept({ id: 'editor-test', username: 'editor', name: '构造测试编辑者', roleId: 'edit', roleName: '编辑',
    sessionId: 'lazy-relations-test-session', epoch: 'test-epoch', revision: '1',
    permissions: ['knowledge.view', 'knowledge.edit', 'knowledge.review'] });
});
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }
function entity(id: string): KnowledgeEntity {
  return { id, name: '构造实体 ' + id, category: '故障运维知识', type: 'Symptom', description: '组件隔离测试',
    source: 'CONSTRUCTED_TEST', keywords: [], attributes: [], modelIds: [] };
}
function relation(id: string, head: string, tail: string): KnowledgeRelation {
  return { id, head, tail, type: 'hasSymptom', weight: null, source: '构造关系来源 ' + id };
}
function fixture() {
  const store = useKnowledgeStore();
  const version: KnowledgeVersion = { id: 'KGV-LAZY', number: 1, kind: 'BASELINE', parentId: null,
    restoredFromVersionId: null, actorId: 'editor-test', time: '2026-11-04T00:00:00Z', summary: '构造选项负载', changeId: null,
    entities: Array.from({ length: 1800 }, (_, i) => entity('KGE-BASE-' + i)),
    relations: [relation('KGR-BASE', 'KGE-BASE-0', 'KGE-BASE-1')] };
  store.workspace = { revision: 'before-save', currentVersionId: version.id, versions: [version], changes: [], logs: [] };
  store.catalog = { actors: [], types: [{ id: 'Symptom', name: '现象', category: '故障运维知识' }],
    relationTypes: [{ id: 'hasSymptom', name: '关联现象' }], models: [] };
  const draft: KnowledgeDraft = { summary: '八实体十关系，构造组件负载', baseVersionId: version.id,
    entities: Array.from({ length: 8 }, (_, i) => entity('new:entity-' + i)),
    relations: Array.from({ length: 10 }, (_, i) => relation('new:relation-' + i,
      'new:entity-' + (i % 8), 'new:entity-' + ((i + (i < 8 ? 1 : 2)) % 8))) };
  store.draft = draft; store.baseline = knowledgeClone(draft); store.drawerOpen = true; store.activeTab = 'changes';
  root = node('root'); app = renderer.createApp(KnowledgeChangeDrawer); app.use(pinia); app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  return { store, version };
}
function card(id: string) { const row = find(root, n => n.props['data-relation-id'] === id); expect(row, id).toBeDefined(); return row!; }
function relationCards() { return all(root, n => typeof n.props['data-relation-id'] === 'string'); }
function field(row: HostNode, label: string) {
  const parent = find(row, n => n.tag === 'label' && textOf(n).startsWith(label)); expect(parent, label).toBeDefined();
  return find(parent!, n => ['input', 'select', 'textarea'].includes(n.tag))!;
}
async function toggle(id: string, open = true) {
  (card(id).props.onToggle as (event: unknown) => void)({ currentTarget: { open } }); await settle();
}
async function click(label: string) {
  const button = find(root, n => n.tag === 'button' && textOf(n).trim() === label); expect(button, label).toBeDefined();
  await (button!.props.onClick as () => unknown)(); await settle();
}
function mountedRelationSelects() { return relationCards().flatMap(row => all(row, n => n.tag === 'select')); }

describe('知识草稿关系编辑按需挂载', () => {
  it('18项草稿与1800基线选项默认保留全部摘要，只挂载一条关系的选项', async () => {
    const { store } = fixture(), before = knowledgeClone(store.draft); await settle();
    expect(relationCards()).toHaveLength(10); expect(mountedRelationSelects()).toHaveLength(0);
    expect(relationCards().flatMap(row => all(row, n => n.tag === 'option'))).toHaveLength(0);
    await toggle('new:relation-0');
    expect(mountedRelationSelects()).toHaveLength(3);
    const options = mountedRelationSelects().flatMap(row => all(row, n => n.tag === 'option'));
    expect(options).toHaveLength(2 * (1800 + 8 + 1) + 1);
    expect(all(root, n => n.tag === 'option').length).toBeLessThan(5500);
    await toggle('new:relation-8');
    expect(mountedRelationSelects()).toHaveLength(3);
    expect(all(card('new:relation-0'), n => n.tag === 'select')).toHaveLength(0);
    expect(store.draft).toEqual(before);
  });

  it('切换和折叠仅释放编辑体，头尾ID与来源输入不丢失', async () => {
    const { store } = fixture(); await toggle('new:relation-0');
    (field(card('new:relation-0'), '头实体').props.onChange as (e: unknown) => void)({ target: { value: 'KGE-BASE-123' } });
    (field(card('new:relation-0'), '来源说明').props.onInput as (e: unknown) => void)({ target: { value: '本条显式修改来源' } });
    await toggle('new:relation-1'); await toggle('new:relation-1', false);
    expect(mountedRelationSelects()).toHaveLength(0);
    await toggle('new:relation-0');
    expect(field(card('new:relation-0'), '头实体').props.value).toBe('KGE-BASE-123');
    expect(field(card('new:relation-0'), '来源说明').props.value).toBe('本条显式修改来源');
    expect(store.draft!.relations[1].source).toBe('构造关系来源 new:relation-1');
  });

  it('新增和加入已有关系自动展开目标、挂载后聚焦端点且不展开第二条', async () => {
    const { store } = fixture(); await click('新增关系');
    const id = store.draft!.relations.at(-1)!.id;
    expect(card(id).props.open).toBe(true); expect(mountedRelationSelects()).toHaveLength(3);
    expect(focused.at(-1)).toBe(field(card(id), '头实体'));
    const existing = find(root, n => n.props['aria-label'] === '选择已有关系加入编辑')!;
    (existing.props['onUpdate:modelValue'] as (id: string) => void)('KGR-BASE');
    await (existing.props.onChange as () => unknown)(); await settle();
    expect(card('KGR-BASE').props.open).toBe(true); expect(card(id).props.open).toBe(false);
    expect(focused.at(-1)).toBe(field(card('KGR-BASE'), '头实体'));
    expect(store.draft!.relations).toHaveLength(12);
    expect(mountedRelationSelects()).toHaveLength(3);
  });

  it.each([['source', '来源说明'], ['endpoints', '头实体'], ['tail', '尾实体'], ['type', '关系类型'], ['weight', '权重（']] as const)
  ('校验问题%s展开目标后聚焦原字段', async (name, label) => {
    const { store } = fixture(); await toggle('new:relation-0');
    store.issues = [{ objectId: 'new:relation-7', field: name, message: '构造校验问题' }]; await settle();
    const issue = find(root, n => n.tag === 'button' && textOf(n).startsWith('new:relation-7 ·'))!;
    await (issue.props.onClick as () => unknown)(); await settle();
    expect(card('new:relation-7').props.open).toBe(true);
    expect(mountedRelationSelects()).toHaveLength(3);
    expect(scrolled.at(-1)).toBe(card('new:relation-7'));
    expect(focused.at(-1)).toBe(field(card('new:relation-7'), label));
  });

  it('迟到定位和旧details事件不能重开替换草稿中的同名关系', async () => {
    const { store } = fixture(); store.issues = [{ objectId: 'new:relation-7', field: 'source', message: '待定位' }]; await settle();
    const oldToggle = card('new:relation-7').props.onToggle as (event: unknown) => void;
    const issue = find(root, n => n.tag === 'button' && textOf(n).startsWith('new:relation-7 ·'))!;
    const pending = (issue.props.onClick as () => Promise<unknown>)();
    store.draft = knowledgeClone(store.draft); await pending; await settle();
    oldToggle({ currentTarget: { open: true } }); await settle();
    expect(mountedRelationSelects()).toHaveLength(0); expect(focused).toHaveLength(0);
  });

  it('保存全量8实体10关系，服务分配ID后不沿用旧定位对象', async () => {
    const { store, version } = fixture(); await toggle('new:relation-7');
    (field(card('new:relation-7'), '来源说明').props.onInput as (e: unknown) => void)({ target: { value: '待保存的明确来源' } });
    const payload = knowledgeClone(store.draft!);
    const saved = knowledgeClone(payload), ids = new Map(saved.entities.map((e, i) => [e.id, 'KGE-SAVED-' + i]));
    saved.entities.forEach(e => { e.id = ids.get(e.id)!; });
    saved.relations.forEach((r, i) => { r.id = 'KGR-SAVED-' + i; r.head = ids.get(r.head) ?? r.head; r.tail = ids.get(r.tail) ?? r.tail; });
    const change: KnowledgeChange = { id: 'KGC-SAVED', authorId: 'editor-test', state: 'DRAFT', revision: 1, content: saved,
      createdAt: version.time, updatedAt: version.time, publishedVersionId: null, submissions: [] };
    service.saveKnowledgeReceipt.mockResolvedValue({ objectId: change.id, entityId: change.id, changed: true, revision: 'saved', currentVersionId: version.id });
    service.getKnowledgeChange.mockResolvedValue(change);
    service.loadKnowledgeMetadata.mockResolvedValue({ ...knowledgeClone(store.catalog), error: null, workspace: {
      revision: 'saved', currentVersionId: version.id, current: version, counts: { '设备知识': 0, '网络态势知识': 0, '故障运维知识': 1800 } } });
    service.queryKnowledgeChanges.mockResolvedValue({ items: [], total: 0 });
    expect(await store.saveDraft()).toBe(true); await settle();
    expect(service.saveKnowledgeReceipt.mock.calls[0][0].draft).toEqual(payload);
    expect(store.draft!.entities).toHaveLength(8); expect(store.draft!.relations).toHaveLength(10);
    expect(store.draft!.relations[7].source).toBe('待保存的明确来源');
    expect(mountedRelationSelects()).toHaveLength(0);
    expect(find(root, n => n.props['data-relation-id'] === 'new:relation-7')).toBeUndefined();
    store.issues = [{ objectId: 'KGR-SAVED-7', field: 'source', message: '保存后仍可定位新编号' }]; await settle();
    const issue = find(root, n => n.tag === 'button' && textOf(n).startsWith('KGR-SAVED-7 ·'))!;
    await (issue.props.onClick as () => unknown)(); await settle();
    expect(focused.at(-1)).toBe(field(card('KGR-SAVED-7'), '来源说明'));
  });

  it('只读审核可逐条展开完整字段，不显示新增入口或改变草稿', async () => {
    const { store } = fixture(); useAuthStore().identity!.permissions = ['knowledge.view', 'knowledge.review'];
    const before = knowledgeClone(store.draft); await settle();
    expect(find(root, n => n.tag === 'button' && textOf(n) === '新增关系')).toBeUndefined();
    for (const relation of store.draft!.relations) {
      await toggle(relation.id);
      expect(field(card(relation.id), '头实体').props.disabled).toBe(true);
      expect(field(card(relation.id), '来源说明').props.readonly).toBe(true);
      expect(field(card(relation.id), '来源说明').props.value).toBe(relation.source);
      expect(mountedRelationSelects()).toHaveLength(3);
    }
    expect(store.draft).toEqual(before); expect(service.saveKnowledgeReceipt).not.toHaveBeenCalled();
  });
});
