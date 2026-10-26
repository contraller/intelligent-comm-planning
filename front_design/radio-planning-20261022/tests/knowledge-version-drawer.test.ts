import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import type { KnowledgeEntity, KnowledgeRelation, KnowledgeVersion } from '../src/types/knowledge';

const service = vi.hoisted(() => ({ getKnowledgeVersion: vi.fn(), rollbackKnowledgeReceipt: vi.fn() }));
const panels = vi.hoisted(() => ({ mounted: vi.fn() }));
vi.mock('../src/services', () => ({ previewService: service, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { h } = await import('vue');
  return { default: { props: ['visible'], emits: ['update:visible'], setup(props: { visible: boolean }, context: {
    slots: Record<string, () => import('vue').VNode[]>; emit: (event: 'update:visible', value: boolean) => void;
  }) { return () => props.visible ? h('aside', [h('button', { 'aria-label': '关闭版本', onClick: () => context.emit('update:visible', false) }, '关闭'), context.slots.default?.(), context.slots.footer?.()]) : null; } } };
});
vi.mock('../src/components/KnowledgePrincipleFlow.vue', () => ({ default: { setup() { panels.mounted(); return () => null; } } }));
vi.mock('../src/components/KnowledgeNetworkRulePanel.vue', () => ({ default: { setup() { panels.mounted(); return () => null; } } }));

import KnowledgeVersionDrawer from '../src/components/KnowledgeVersionDrawer.vue';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { useAuthStore } from '../src/stores/auth';
import * as validation from '../src/services/knowledge-validation';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

let pinia: ReturnType<typeof createPinia>, app: App | undefined;
beforeAll(() => clientTemplate(KnowledgeVersionDrawer, 'src/components/KnowledgeVersionDrawer.vue', 'knowledge-version-drawer-render.ts'));
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
  vi.clearAllMocks(); pinia = createPinia(); setActivePinia(pinia);
  useAuthStore().accept({ id: 'explicit-reviewer', username: 'reviewer', name: '隔离审核人', roleId: 'test-review-role', roleName: '测试审核角色',
    sessionId: 'isolated-session', epoch: 'test-generation', revision: '1', permissions: ['knowledge.view', 'knowledge.review', 'knowledge.rollback'] });
});
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function snapshot(id: string, entities = 107, relations = 113): KnowledgeVersion {
  return { id, number: 2, parentId: 'parent', restoredFromVersionId: null, kind: 'PUBLISH', actorId: 'explicit-reviewer',
    time: '2026-10-24T00:00:00Z', summary: '显式构造的组件测试快照', changeId: null,
    entities: Array.from({ length: entities }, (_, index): KnowledgeEntity => ({ id: id + '-E-' + index, name: '实体 ' + index,
      category: '设备知识', type: 'Device', description: '只读历史内容', keywords: [], source: 'CONSTRUCTED_TEST', attributes: [], modelIds: [] })),
    relations: Array.from({ length: relations }, (_, index): KnowledgeRelation => ({ id: id + '-R-' + index,
      head: id + '-E-' + (index % Math.max(entities, 1)), tail: id + '-E-' + ((index + 1) % Math.max(entities, 1)), type: 'related', weight: null, source: 'CONSTRUCTED_TEST' })) };
}
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
async function mount(version = snapshot('version-one')) {
  const store = useKnowledgeStore(), parent = { ...snapshot('parent', 0, 0), parentId: null, number: 1, kind: 'BASELINE' as const };
  store.workspace = { revision: 'test-revision', currentVersionId: version.id, versions: [version, parent], changes: [], logs: [] };
  store.historyVersionId = version.id;
  const root = node('root'); app = renderer.createApp(KnowledgeVersionDrawer); app.use(pinia); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
  return { root, store, version };
}
function section(root: HostNode, name: string) { return find(root, item => item.props['data-snapshot'] === name)!; }
function rows(root: HostNode, name: string) { return all(root, item => typeof item.props['data-' + name + '-id'] === 'string'); }
async function toggle(root: HostNode, name: string, open: boolean) {
  const target = section(root, name); expect(target).toBeDefined();
  (target.props.onToggle as (event: unknown) => void)({ currentTarget: { open } }); await settle();
}
async function click(root: HostNode, label: string) {
  const button = find(root, item => item.tag === 'button' && item.props['aria-label'] === label)!;
  expect(button, label).toBeDefined(); expect(button.props.disabled, label).not.toBe(true);
  await (button.props.onClick as () => unknown)(); await settle();
}
function rollbackButton(root: HostNode) { return find(root, item => item.tag === 'button' && textOf(item) === '恢复上一版并生成新版本'); }

describe('知识版本真实模板有界快照DOM', () => {
  it('1835实体/5863关系默认不创建行或规则面板，回滚输入立即可用', async () => {
    const diff = vi.spyOn(validation, 'knowledgeDiff'), { root, store } = await mount(snapshot('large-version', 1835, 5863));
    expect(textOf(root)).toContain('1835 个实体'); expect(textOf(root)).toContain('5863 条关系');
    for (const name of ['entity', 'relation', 'difference']) expect(rows(root, name)).toHaveLength(0);
    expect(panels.mounted).not.toHaveBeenCalled(); expect(diff).not.toHaveBeenCalled(); expect(all(root, () => true).length).toBeLessThan(160);
    const textarea = find(root, item => item.tag === 'textarea')!; expect(textarea).toBeDefined(); expect(textarea.props.disabled).toBe(false);
    (textarea.props['onUpdate:modelValue'] as (value: string) => void)('显式回滚原因'); await settle();
    expect(store.rollbackReason).toBe('显式回滚原因'); expect(store.dirty).toBe(true); expect(rollbackButton(root)!.props.disabled).toBe(false);
    expect(diff).not.toHaveBeenCalled(); expect(rows(root, 'entity')).toHaveLength(0); expect(rows(root, 'relation')).toHaveLength(0);
  });
  it.each([['entities', 'entity', 107, '实体'], ['relations', 'relation', 113, '关系']])('%s各页按源顺序完整可达且不改历史数组', async (name, row, total, label) => {
    const { root, store } = await mount(), before = JSON.stringify(store.workspace);
    await toggle(root, String(name), true);
    expect(rows(root, String(row))).toHaveLength(50); expect(find(root, item => item.props['aria-label'] === '上一页' + label)!.props.disabled).toBe(true);
    expect(textOf(section(root, String(name)))).toContain('共 ' + total);
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      ids.push(...rows(root, String(row)).map(item => String(item.props['data-' + row + '-id'])));
      expect(textOf(section(root, String(name)))).toContain('第 ' + page + ' / 3 页');
      if (page < 3) await click(root, '下一页' + label);
    }
    expect(rows(root, String(row))).toHaveLength(Number(total) - 100);
    expect(find(root, item => item.props['aria-label'] === '下一页' + label)!.props.disabled).toBe(true);
    const expected = name === 'entities' ? store.historyVersion!.entities : store.historyVersion!.relations;
    expect(ids).toEqual(expected.map(item => item.id)); expect(new Set(ids).size).toBe(total);
    await click(root, '上一页' + label); expect(rows(root, String(row))[0]!.props['data-' + row + '-id']).toBe(expected[50]!.id);
    expect(JSON.stringify(store.workspace)).toBe(before);
  });
  it('折叠释放行，同版重开保留页码，实体与关系互不改页', async () => {
    const { root } = await mount(); await toggle(root, 'entities', true); await click(root, '下一页实体');
    await toggle(root, 'relations', true); expect(rows(root, 'relation')[0]!.props['data-relation-id']).toBe('version-one-R-0');
    expect(rows(root, 'entity')[0]!.props['data-entity-id']).toBe('version-one-E-50');
    await toggle(root, 'entities', false); expect(rows(root, 'entity')).toHaveLength(0); expect(rows(root, 'relation')).toHaveLength(50);
    await toggle(root, 'entities', true); expect(rows(root, 'entity')[0]!.props['data-entity-id']).toBe('version-one-E-50');
  });
  it('差异只在展开时计算且最多50行，关闭不创建前后快照DOM', async () => {
    const diff = vi.spyOn(validation, 'knowledgeDiff'), { root } = await mount(snapshot('changed', 60, 0));
    expect(diff).not.toHaveBeenCalled(); await toggle(root, 'differences', true);
    expect(diff).toHaveBeenCalledTimes(1); expect(rows(root, 'difference')).toHaveLength(50); expect(textOf(root)).toContain('60 项差异');
    await click(root, '下一页差异'); expect(rows(root, 'difference')).toHaveLength(10); expect(diff).toHaveBeenCalledTimes(1);
    await toggle(root, 'differences', false); expect(rows(root, 'difference')).toHaveLength(0); expect(textOf(root)).toContain('相对父版差异未展开');
  });
  it('切换版本重置三个本地展开/页码，关闭再开同版本也从闭合首页开始', async () => {
    const { root, store } = await mount();
    for (const [name, label] of [['entities', '实体'], ['relations', '关系'], ['differences', '差异']]) { await toggle(root, name!, true); await click(root, '下一页' + label); }
    const second = snapshot('version-two'); store.workspace!.versions.push(second); store.historyVersionId = second.id; await settle();
    for (const [name, row] of [['entities', 'entity'], ['relations', 'relation'], ['differences', 'difference']]) {
      expect(section(root, name!).props.open).toBe(false); expect(rows(root, row!)).toHaveLength(0); await toggle(root, name!, true);
      expect(textOf(section(root, name!))).toContain('第 1 /');
    }
    store.historyVersionId = ''; await settle(); store.historyVersionId = second.id; await settle();
    for (const name of ['entity', 'relation', 'difference']) expect(rows(root, name)).toHaveLength(0);
  });
  it('空快照总数和边界明确，不生成假记录', async () => {
    const { root } = await mount(snapshot('empty', 0, 0));
    for (const [name, label, message] of [['entities', '实体', '无实体'], ['relations', '关系', '无关系'], ['differences', '差异', '无差异']]) {
      await toggle(root, name!, true); expect(textOf(section(root, name!))).toContain('共 0'); expect(textOf(section(root, name!))).toContain(message);
      for (const direction of ['上一页', '下一页']) expect(find(root, item => item.props['aria-label'] === direction + label)!.props.disabled).toBe(true);
    }
  });
  it('回滚原因翻页不丢失，关闭仍调用真实dirty保护，取消保留现场', async () => {
    const { root, store } = await mount(); const textarea = find(root, item => item.tag === 'textarea')!;
    (textarea.props['onUpdate:modelValue'] as (value: string) => void)('应保留的原因'); await toggle(root, 'relations', true); await click(root, '下一页关系');
    expect(store.rollbackReason).toBe('应保留的原因'); await click(root, '关闭版本');
    expect(store.decision?.title).toBe('尚未提交的回滚原因'); store.answer('cancel'); await settle();
    expect(store.historyVersion?.id).toBe('version-one'); expect(store.rollbackReason).toBe('应保留的原因'); expect(store.dirty).toBe(true);
    expect(rows(root, 'relation')[0]!.props['data-relation-id']).toBe('version-one-R-50');
    await click(root, '关闭版本'); store.answer('save'); await settle(); expect(store.historyVersion).toBeNull(); expect(store.rollbackReason).toBe('');
    expect(service.rollbackKnowledgeReceipt).not.toHaveBeenCalled();
  });
  it('原回滚成功后仍重读当前新版本，失败不重读、不清原因', async () => {
    const { root, store } = await mount(); store.rollbackReason = '明确原因'; await settle();
    const rollback = vi.spyOn(store, 'rollback').mockResolvedValueOnce(false), show = vi.spyOn(store, 'showVersion').mockResolvedValue();
    await (rollbackButton(root)!.props.onClick as () => Promise<void>)(); expect(rollback).toHaveBeenCalledWith('明确原因'); expect(show).not.toHaveBeenCalled(); expect(store.rollbackReason).toBe('明确原因');
    rollback.mockImplementationOnce(async () => { store.workspace!.currentVersionId = 'new-rollback-version'; return true; });
    await (rollbackButton(root)!.props.onClick as () => Promise<void>)(); expect(show).toHaveBeenCalledWith({ id: 'new-rollback-version' });
  });
  it('权限或busy变化保留输入，历史版本不出现回滚入口', async () => {
    const { root, store } = await mount(); store.rollbackReason = '保留输入'; store.busy = true; await settle();
    expect(find(root, item => item.tag === 'textarea')!.props.disabled).toBe(true); expect(rollbackButton(root)!.props.disabled).toBe(true);
    const auth = useAuthStore(); auth.accept({ ...auth.identity!, permissions: ['knowledge.view'] }); await settle();
    expect(find(root, item => item.tag === 'textarea')).toBeUndefined(); expect(rollbackButton(root)).toBeUndefined(); expect(store.rollbackReason).toBe('保留输入');
    store.busy = false; store.historyVersionId = 'parent'; await settle(); expect(rollbackButton(root)).toBeUndefined();
  });
});
