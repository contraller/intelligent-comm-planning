import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick, reactive, ssrContextKey, type App, type Component } from 'vue';
import type { KnowledgeDraft, KnowledgeEntity, KnowledgeNetworkRule, KnowledgePrincipleFlow as PrincipleFlow, KnowledgeRelation, KnowledgeVersion } from '../src/types/knowledge';

const service = vi.hoisted(() => ({ getDeviceKnowledge: vi.fn(), saveKnowledgeReceipt: vi.fn() }));
vi.mock('../src/services', () => ({ previewService: service, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], emits: ['update:visible'], setup(props, { slots, emit }) {
    return () => props.visible ? h('aside', [
      h('button', { onClick: () => emit('update:visible', false) }, '关闭抽屉'),
      slots.default?.(), slots.footer?.(),
    ]) : null;
  } }) };
});
vi.mock('primevue/dialog', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'header'], setup(props, { slots }) {
    return () => props.visible ? h('dialog-probe', { header: props.header }, [slots.default?.(), slots.footer?.()]) : null;
  } }) };
});
vi.mock('../src/components/KnowledgeStateBadge.vue', () => ({ default: { render: () => null } }));

import KnowledgeChangeDrawer from '../src/components/KnowledgeChangeDrawer.vue';
import KnowledgeVersionDrawer from '../src/components/KnowledgeVersionDrawer.vue';
import DeviceKnowledgePanel from '../src/components/DeviceKnowledgePanel.vue';
import KnowledgePrincipleFlow from '../src/components/KnowledgePrincipleFlow.vue';
import KnowledgeNetworkRulePanel from '../src/components/KnowledgeNetworkRulePanel.vue';
import KnowledgePrincipleEditor from '../src/components/KnowledgePrincipleEditor.vue';
import KnowledgeNetworkRuleEditor from '../src/components/KnowledgeNetworkRuleEditor.vue';
import { useAuthStore } from '../src/stores/auth';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { knowledgeNetworkRule } from '../src/mocks/knowledge-network-rules';
import {
  describeKnowledge, knowledgeAttributeName, knowledgeAttributeValue, knowledgeEntityName,
  knowledgeRelationName, knowledgeSource, knowledgeText, knowledgeTypeName,
} from '../src/services/knowledge-display';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

let pinia: ReturnType<typeof createPinia>, app: App | undefined;
beforeAll(async () => {
  for (const [component, name] of [
    [KnowledgeChangeDrawer, 'KnowledgeChangeDrawer'], [KnowledgeVersionDrawer, 'KnowledgeVersionDrawer'],
    [DeviceKnowledgePanel, 'DeviceKnowledgePanel'], [KnowledgePrincipleFlow, 'KnowledgePrincipleFlow'],
    [KnowledgeNetworkRulePanel, 'KnowledgeNetworkRulePanel'],
    [KnowledgePrincipleEditor, 'KnowledgePrincipleEditor'], [KnowledgeNetworkRuleEditor, 'KnowledgeNetworkRuleEditor'],
  ] as const) await clientTemplate(component, `src/components/${name}.vue`, `${name}-zh-render.ts`);
});
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument);
  vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('ShadowRoot', class {});
  vi.clearAllMocks();
  pinia = createPinia(); setActivePinia(pinia);
  useAuthStore().accept({ id: 'test-editor', username: 'editor', name: '当前编辑人', roleId: 'test-role', roleName: '测试角色',
    sessionId: 'isolated-zh-session', epoch: 'test-epoch', revision: '1',
    permissions: ['knowledge.view', 'knowledge.edit', 'knowledge.review', 'knowledge.rollback'] });
});
afterEach(() => {
  app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function entity(): KnowledgeEntity {
  return { id: 'KGE-DM-0001', name: 'DM-0001', type: 'DeviceModel', category: '设备知识',
    description: 'NORMAL', keywords: ['EXCELLENT', 'unmapped custom phrase'], source: 'devices_v1.csv', modelIds: ['DM-0001'],
    attributes: [
      { name: 'status', value: 'EXCELLENT', unit: null },
      { name: 'model_name', value: 'HF SDR Model-900', unit: null },
      { name: 'device_id', value: 'DV-0001', unit: null },
      { name: 'source_doc', value: 'HF SDR manual.docx', unit: null },
      { name: 'vendor_private', value: 'unmapped custom phrase', unit: null },
      { name: 'attrs', value: '{"state":"GOOD","model_name":"HF SDR Model-900","device_id":"DV-0001"}', unit: null },
    ], principleFlow: { steps: [{ title: 'NORMAL', description: 'EXCELLENT' }, { title: 'GOOD', description: 'unmapped custom phrase' }] } };
}
function relation(): KnowledgeRelation {
  return { id: 'KGR-0001', head: 'KGE-DM-0001', tail: 'KGE-DV-0001', type: 'hasComponent', weight: null, source: 'MANUAL' };
}
function networkEntity(): KnowledgeEntity {
  const rule = knowledgeClone(knowledgeNetworkRule);
  rule.scope = 'NORMAL'; rule.source = 'MANUAL';
  rule.criteria[0]!.condition = 'EXCELLENT'; rule.criteria[0]!.meaning = 'unmapped custom phrase';
  rule.transitions[0]!.description = 'FAULT';
  return { ...entity(), type: 'NetRule', category: '网络态势知识', principleFlow: undefined, networkRule: rule };
}
function fixture() {
  const store = useKnowledgeStore(), item = entity(), link = relation();
  const version: KnowledgeVersion = { id: 'KGV-TEST', number: 2, kind: 'PUBLISH', parentId: 'KGV-PARENT', restoredFromVersionId: null,
    actorId: 'test-editor', time: '2026-10-24T00:00:00Z', summary: 'NORMAL', changeId: null,
    entities: [item], relations: [link] };
  store.workspace = { revision: 'test-revision', currentVersionId: version.id, versions: [version, {
    ...knowledgeClone(version), id: 'KGV-PARENT', number: 1, parentId: null, kind: 'BASELINE', entities: [], relations: [],
  }], changes: [], logs: [], identitySnapshots: [{ key: 'version:' + version.id, id: 'test-editor',
    name: '历史发布人', role: 'EDITOR', roleId: 'old-role', roleName: '历史角色' }] };
  store.catalog = { actors: [], types: [{ id: 'DeviceModel', name: 'DeviceModel', category: '设备知识' }],
    relationTypes: [{ id: link.type, name: link.type }], models: [{ id: 'DM-0001', name: 'HF SDR Model-900' }] };
  const draft: KnowledgeDraft = { summary: 'NORMAL', baseVersionId: version.id, entities: [knowledgeClone(item)], relations: [knowledgeClone(link)] };
  store.draft = draft; store.baseline = knowledgeClone(draft); store.drawerOpen = true;
  return { store, version, item, link };
}
async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick(); } }
async function mount(component: Component) {
  const root = node('root'); app = renderer.createApp(component); app.use(pinia); app.provide(ssrContextKey, { modules: new Set() });
  app.component('RouterLink', defineComponent({ props: ['to'], setup(_props, { slots }) { return () => h('a', slots.default?.()); } }));
  app.mount(root); await settle(); return root;
}
function field(root: HostNode, label: string) {
  const parent = find(root, n => n.tag === 'label' && textOf(n).startsWith(label));
  expect(parent, label).toBeDefined();
  return find(parent!, n => n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select')!;
}
function labelled(root: HostNode, label: string) {
  const target = find(root, n => n.props['aria-label'] === label);
  expect(target, label).toBeDefined(); return target!;
}
async function input(target: HostNode, value: string) {
  (target.props.onInput as (event: unknown) => void)({ target: { value } }); await settle();
}
async function click(root: HostNode, label: string) {
  const button = find(root, n => n.tag === 'button' && textOf(n) === label)!;
  expect(button, label).toBeDefined(); await (button.props.onClick as () => unknown)(); await settle();
}
async function expand(root: HostNode, name: string) {
  const target = find(root, n => n.props['data-snapshot'] === name)!;
  (target.props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } }); await settle();
  return target;
}

describe('知识面板中文纯显示', () => {
  it('维护字段显示中文，选项仍使用原ID；打开与未触碰保存请求不改变草稿', async () => {
    const { store } = fixture(), before = knowledgeClone(store.draft), root = await mount(KnowledgeChangeDrawer);
    expect(field(root, '名称').props.value).toBe('设备型号 DM-0001');
    expect(field(root, '描述').props.value).toBe('正常');
    expect(field(root, '来源说明').props.value).toBe(knowledgeSource(before!.entities[0].source));
    expect(field(root, '关键词（').props.value).toBe('优秀,unmapped custom phrase');
    const options = all(root, n => n.tag === 'option');
    expect(options.some(n => n.props.value === 'DeviceModel' && textOf(n) === '设备知识 · 设备型号')).toBe(true);
    expect(options.some(n => n.props.value === 'hasComponent' && textOf(n) === '包含部件')).toBe(true);
    expect(options.some(n => n.props.value === 'DM-0001' && textOf(n) === 'DM-0001 · HF SDR Model-900')).toBe(true);
    const attributes = all(root, n => n.props.class === 'attribute-row');
    expect(field(attributes[0]!, '字段').props.value).toBe('设备状态');
    expect(field(attributes[0]!, '内容').props.value).toBe('优秀');
    for (const [index, value] of [[1, 'HF SDR Model-900'], [2, 'DV-0001'], [3, 'HF SDR manual.docx'], [4, 'unmapped custom phrase']] as const)
      expect(field(attributes[index]!, '内容').props.value).toBe(value);
    expect(field(attributes[5]!, '内容').props.value).toBe(knowledgeAttributeValue(before!.entities[0].attributes[5]!.value, 'attrs'));
    expect(store.draft).toEqual(before); expect(store.dirtyDraft).toBe(false);
    // 只记录真实store产生的保存载荷，替身拒绝落库；不将其当作端到端保存成功。
    service.saveKnowledgeReceipt.mockRejectedValueOnce(new Error('隔离测试停止写入'));
    await click(root, '保存草稿');
    expect(service.saveKnowledgeReceipt).toHaveBeenCalledTimes(1);
    expect(service.saveKnowledgeReceipt.mock.calls[0]![0].draft).toEqual(before);
    expect(store.draft).toEqual(before); expect(store.dirtyDraft).toBe(false);
  });

  it('只有输入事件更新对应原字段，未保存保护和只读守卫继续生效', async () => {
    const { store } = fixture(), root = await mount(KnowledgeChangeDrawer), before = knowledgeClone(store.draft);
    await input(field(root, '描述'), 'Operator custom sentence');
    expect(store.draft!.entities[0].description).toBe('Operator custom sentence');
    expect(store.draft!.entities[0].attributes).toEqual(before!.entities[0].attributes);
    expect(store.draft!.entities[0].name).toBe('DM-0001'); expect(store.dirtyDraft).toBe(true);
    const close = store.closeDrawer(); expect(store.decision?.title).toBe('未保存的知识草稿');
    store.answer('cancel'); await close; expect(store.drawerOpen).toBe(true);
    const attributes = all(root, n => n.props.class === 'attribute-row');
    await input(field(attributes[0]!, '字段'), 'work_mode');
    await input(field(attributes[0]!, '内容'), 'SDR');
    expect(store.draft!.entities[0].attributes[0]).toEqual({ name: 'work_mode', value: 'SDR', unit: null });
    expect(field(attributes[0]!, '内容').props.value).toBe(knowledgeAttributeValue('SDR', 'work_mode'));
    const oldInput = field(root, '名称').props.onInput as (event: unknown) => void;
    store.busy = true; await settle(); const raw = knowledgeClone(store.draft);
    expect(field(root, '名称').props.readonly).toBe(true);
    oldInput({ target: { value: '不应写入' } }); await settle(); expect(store.draft).toEqual(raw);
    store.busy = false;
    useAuthStore().identity!.permissions = ['knowledge.view']; await settle();
    expect(field(root, '名称').props.readonly).toBe(true);
    oldInput({ target: { value: '失权写入' } }); await settle(); expect(store.draft).toEqual(raw);
  });

  it('空字段与未知自由英文原样显示，打开后不会产生占位值或脏数据', async () => {
    const { store } = fixture(), item = store.draft!.entities[0];
    item.name = ''; item.description = ''; item.source = ''; item.keywords = [];
    item.attributes = [{ name: '', value: '', unit: null }]; store.draft!.relations[0].source = '';
    store.baseline = knowledgeClone(store.draft); const before = knowledgeClone(store.draft), root = await mount(KnowledgeChangeDrawer);
    for (const label of ['名称', '描述', '来源说明', '关键词（', '字段', '内容']) expect(field(root, label).props.value).toBe('');
    expect(store.draft).toEqual(before); expect(store.dirtyDraft).toBe(false);
    await input(field(root, '名称'), 'Unknown custom entity');
    expect(field(root, '名称').props.value).toBe('Unknown custom entity');
    expect(store.draft!.entities[0].name).toBe('Unknown custom entity');
  });

  it('完整快照及差异统一显示中文类型、属性和关系，并保留历史身份与原数据', async () => {
    const { store, version, item, link } = fixture(); store.historyVersionId = version.id;
    version.entities.push({ ...entity(), id: 'KGE-RULE', name: '组网规则', type: 'NetRule', category: '网络态势知识',
      principleFlow: undefined, networkRule: knowledgeClone(knowledgeNetworkRule) });
    const before = knowledgeClone(store.workspace), root = await mount(KnowledgeVersionDrawer);
    expect(textOf(root)).toContain('历史发布人');
    expect(all(root, n => typeof n.props['data-entity-id'] === 'string')).toHaveLength(0);
    const entities = await expand(root, 'entities'), relations = await expand(root, 'relations'), differences = await expand(root, 'differences');
    expect(textOf(entities)).toContain('设备型号 DM-0001');
    expect(textOf(entities)).toContain(describeKnowledge(item));
    expect(textOf(relations)).toContain(describeKnowledge(link));
    expect(textOf(differences)).toContain(describeKnowledge(item));
    expect(textOf(differences)).toContain(describeKnowledge(link));
    expect(textOf(entities)).toContain('设备状态：优秀');
    expect(textOf(entities)).not.toContain(' / DeviceModel');
    expect(textOf(relations)).not.toContain('hasComponent');
    expect(textOf(entities)).toContain('HF SDR Model-900');
    expect(textOf(entities)).toContain('HF SDR manual.docx');
    expect(textOf(entities)).toContain('状态等级与变化依据');
    await click(root, '全屏查看'); expect(find(root, n => n.tag === 'dialog-probe')).toBeDefined();
    store.historyVersionId = 'KGV-PARENT'; await settle();
    expect(find(root, n => n.tag === 'dialog-probe')).toBeUndefined();
    expect(all(root, n => typeof n.props['data-entity-id'] === 'string')).toHaveLength(0);
    expect(store.workspace).toEqual(before);
  });

  it('维护差异调用同一中文描述，包含原理、结构化属性与关系来源', async () => {
    const { store } = fixture(); store.draft!.entities[0].description = 'GOOD'; store.draft!.relations[0].source = 'IMPORT';
    const before = knowledgeClone(store.draft), root = await mount(KnowledgeChangeDrawer);
    const diff = find(root, n => n.tag === 'details' && textOf(n).startsWith('变更前后预览'))!;
    expect(textOf(diff)).toContain(describeKnowledge(store.draft!.entities[0]));
    expect(textOf(diff)).toContain(describeKnowledge(store.draft!.relations[0]));
    expect(textOf(diff)).toContain('工作原理'); expect(textOf(diff)).toContain('设备状态：优秀');
    expect(textOf(diff)).not.toContain('hasComponent'); expect(store.draft).toEqual(before);
  });

  it('设备详情与关联显示中文，型号筛选和只读查询参数保持原值', async () => {
    const { store, version, item, link } = fixture(), neighbor = { ...entity(), id: link.tail, type: 'Component', name: 'NORMAL', modelIds: ['DM-0001'] };
    const excluded = { ...neighbor, id: 'OTHER', name: '不应显示的其他型号', modelIds: ['DM-9999'] };
    const data = { versionId: version.id, modelId: 'DM-0001', items: [{ versionId: version.id, entity: item,
      relations: [link, { ...link, id: 'KGR-OTHER', tail: excluded.id }], neighbors: [neighbor, excluded] }] };
    service.getDeviceKnowledge.mockResolvedValue(data); const before = JSON.stringify(data);
    const root = await mount({ render: () => h(DeviceKnowledgePanel, { modelId: 'DM-0001' }) });
    expect(service.getDeviceKnowledge).toHaveBeenCalledWith({ versionId: version.id, modelId: 'DM-0001', search: '' });
    expect(textOf(root)).toContain(knowledgeTypeName(item.type)); expect(textOf(root)).toContain(knowledgeEntityName(item));
    expect(textOf(root)).toContain(knowledgeAttributeName('status') + '：优秀');
    expect(textOf(root)).toContain(knowledgeRelationName(link.type) + ' · ' + knowledgeEntityName(neighbor));
    expect(textOf(root)).toContain('HF SDR Model-900'); expect(textOf(root)).toContain('HF SDR manual.docx');
    expect(textOf(root)).not.toContain(excluded.name); expect(JSON.stringify(data)).toBe(before);
    expect(service.saveKnowledgeReceipt).not.toHaveBeenCalled(); expect(store.dirtyDraft).toBe(false);
  });

  it('工作原理缩略与全屏显示受控中文，未知文本保留且换版本关闭旧全屏', async () => {
    const state = reactive({ entity: entity(), context: 'KGV-TEST' }), before = JSON.stringify(state.entity);
    const root = await mount({ render: () => h(KnowledgePrincipleFlow, state) });
    expect(textOf(root)).toContain('优秀'); expect(textOf(root)).toContain('unmapped custom phrase');
    await click(root, '全屏查看');
    const dialog = find(root, n => n.tag === 'dialog-probe')!;
    expect(dialog.props.header).toBe('设备型号 DM-0001 · 工作原理');
    expect(textOf(dialog)).toContain(knowledgeSource(state.entity.source));
    expect(textOf(dialog)).toContain('良好'); expect(JSON.stringify(state.entity)).toBe(before);
    state.context = 'KGV-NEXT'; await settle(); expect(find(root, n => n.tag === 'dialog-probe')).toBeUndefined();
    useAuthStore().identity!.permissions = []; await settle(); expect(textOf(root)).not.toContain('全屏查看');
  });

  it('组网规则说明翻译受控状态、来源与变更文字，不改写规则或执行文本', async () => {
    const item: KnowledgeEntity = { ...entity(), category: '网络态势知识', type: 'NetRule', networkRule: knowledgeClone(knowledgeNetworkRule) };
    item.networkRule!.scope = 'NORMAL'; item.networkRule!.source = 'MANUAL';
    item.networkRule!.criteria[0]!.condition = 'EXCELLENT'; item.networkRule!.criteria[0]!.meaning = 'unmapped custom phrase';
    item.networkRule!.transitions[0]!.description = 'WARNING';
    const before = JSON.stringify(item), root = await mount({ render: () => h(KnowledgeNetworkRulePanel, { entity: item, context: 'KGV-TEST' }) });
    expect(textOf(root)).toContain('正常'); expect(textOf(root)).toContain('来源：' + knowledgeSource('MANUAL'));
    expect(textOf(root)).toContain(knowledgeText('WARNING')); expect(textOf(root)).toContain('unmapped custom phrase');
    expect(textOf(root)).not.toContain('EXCELLENT'); expect(JSON.stringify(item)).toBe(before);
    useAuthStore().identity!.permissions = []; await settle(); expect(textOf(root)).not.toContain('网络状态规则说明');
  });

  it.each([false, true])('原理编辑器中文显示不回写，仅输入更新原文，readonly=%s', async readonly => {
    const state = reactive({ entity: entity(), readonly, context: 'KGV-TEST' });
    const update = vi.fn((value: PrincipleFlow | null) => { state.entity.principleFlow = value; });
    const before = knowledgeClone(state.entity);
    const root = await mount({ render: () => h(KnowledgePrincipleEditor, { ...state, 'onUpdate:flow': update }) });
    expect(labelled(root, '第 1 步标题').props.value).toBe('正常');
    expect(labelled(root, '第 1 步说明').props.value).toBe('优秀');
    expect(labelled(root, '第 2 步说明').props.value).toBe('unmapped custom phrase');
    expect(labelled(root, '第 1 步标题').props.readonly).toBe(readonly);
    expect(state.entity).toEqual(before); expect(update).not.toHaveBeenCalled();
    await input(labelled(root, '第 1 步标题'), 'GOOD');
    await input(labelled(root, '第 1 步说明'), 'WARNING');
    if (readonly) { expect(state.entity).toEqual(before); expect(update).not.toHaveBeenCalled(); }
    else {
      expect(update).toHaveBeenCalledTimes(2);
      expect(state.entity.principleFlow!.steps[0]).toEqual({ title: 'GOOD', description: 'WARNING' });
      expect(state.entity.principleFlow!.steps[1]).toEqual(before.principleFlow!.steps[1]);
      expect(labelled(root, '第 1 步标题').props.value).toBe('良好');
      const oldInput = labelled(root, '第 1 步标题').props.onInput as (event: unknown) => void;
      state.readonly = true; await settle(); const locked = knowledgeClone(state.entity);
      oldInput({ target: { value: '迟到写入' } }); await settle(); expect(state.entity).toEqual(locked);
    }
  });

  it('新增原理流程及新增步骤保持空标题和说明，不填入占位内容', async () => {
    const state = reactive({ entity: { ...entity(), principleFlow: undefined } as KnowledgeEntity, readonly: false, context: 'KGV-TEST' });
    const update = vi.fn((value: PrincipleFlow | null) => { state.entity.principleFlow = value; });
    const root = await mount({ render: () => h(KnowledgePrincipleEditor, { ...state, 'onUpdate:flow': update }) });
    expect(update).not.toHaveBeenCalled(); await click(root, '添加工作原理流程'); await click(root, '添加步骤');
    expect(update).toHaveBeenCalledTimes(2);
    expect(state.entity.principleFlow!.steps).toEqual(Array.from({ length: 3 }, () => ({ title: '', description: '' })));
    for (let i = 1; i <= 3; i++) {
      expect(labelled(root, `第 ${i} 步标题`).props.value).toBe('');
      expect(labelled(root, `第 ${i} 步说明`).props.value).toBe('');
    }
  });

  it.each([false, true])('规则编辑器各文字字段中文显示，输入原值与选项ID保留，readonly=%s', async readonly => {
    const state = reactive({ entity: networkEntity(), readonly, context: 'KGV-TEST' });
    const update = vi.fn((value: KnowledgeNetworkRule | null) => { state.entity.networkRule = value; });
    const before = knowledgeClone(state.entity);
    const root = await mount({ render: () => h(KnowledgeNetworkRuleEditor, { ...state, 'onUpdate:rule': update }) });
    for (const [label, value] of [['规则适用范围', '正常'], ['规则来源', '人工录入'], ['优秀 条件', '优秀'],
      ['优秀 含义', 'unmapped custom phrase'], ['变化 1 说明', '故障']]) {
      expect(labelled(root, label!).props.value).toBe(value); expect(labelled(root, label!).props.readonly).toBe(readonly);
    }
    const options = all(root, n => n.tag === 'option');
    expect(new Set(options.map(n => n.props.value))).toEqual(new Set(['EXCELLENT', 'GOOD', 'WARNING', 'FAULT']));
    expect(options.every(n => /^(优秀|良好|预警|故障)$/.test(textOf(n)))).toBe(true);
    expect(labelled(root, '变化 1 起始状态').props.value).toBe('GOOD');
    expect(labelled(root, '变化 1 目标状态').props.value).toBe('WARNING');
    expect(state.entity).toEqual(before); expect(update).not.toHaveBeenCalled();
    for (const [label, value] of [['规则适用范围', 'WARNING'], ['规则来源', 'IMPORT'], ['优秀 条件', 'GOOD'],
      ['优秀 含义', 'Operator custom rule'], ['变化 1 说明', 'EXCELLENT']]) await input(labelled(root, label!), value!);
    if (readonly) { expect(state.entity).toEqual(before); expect(update).not.toHaveBeenCalled(); }
    else {
      expect(update).toHaveBeenCalledTimes(5);
      expect(state.entity.networkRule).toMatchObject({ scope: 'WARNING', source: 'IMPORT' });
      expect(state.entity.networkRule!.criteria[0]).toEqual({ state: 'EXCELLENT', condition: 'GOOD', meaning: 'Operator custom rule' });
      expect(state.entity.networkRule!.transitions[0]).toEqual({ from: 'GOOD', to: 'WARNING', description: 'EXCELLENT' });
      expect(state.entity.networkRule!.criteria.slice(1)).toEqual(before.networkRule!.criteria.slice(1));
      const oldInput = labelled(root, '规则适用范围').props.onInput as (event: unknown) => void;
      state.context = 'KGV-NEXT'; await settle(); const switched = knowledgeClone(state.entity);
      oldInput({ target: { value: '旧版本写入' } }); await settle(); expect(state.entity).toEqual(switched);
      useAuthStore().identity!.permissions = ['knowledge.view']; await settle();
      await input(labelled(root, '规则来源'), '失权写入'); expect(state.entity).toEqual(switched);
    }
  });

  it('新增规则及变化说明保持空字段，打开和渲染不额外触发更新', async () => {
    const state = reactive({ entity: { ...networkEntity(), networkRule: undefined } as KnowledgeEntity, readonly: false, context: 'KGV-TEST' });
    const update = vi.fn((value: KnowledgeNetworkRule | null) => { state.entity.networkRule = value; });
    const root = await mount({ render: () => h(KnowledgeNetworkRuleEditor, { ...state, 'onUpdate:rule': update }) });
    expect(update).not.toHaveBeenCalled(); await click(root, '添加规则说明'); await click(root, '添加状态变化说明');
    expect(update).toHaveBeenCalledTimes(2);
    expect(state.entity.networkRule).toEqual({ scope: '', source: '', criteria: ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT'].map(state =>
      ({ state, condition: '', meaning: '' })), transitions: [{ from: 'GOOD', to: 'WARNING', description: '' }] });
    for (const label of ['规则适用范围', '规则来源', '优秀 条件', '优秀 含义', '良好 条件', '良好 含义',
      '预警 条件', '预警 含义', '故障 条件', '故障 含义', '变化 1 说明']) expect(labelled(root, label).props.value).toBe('');
  });
});
