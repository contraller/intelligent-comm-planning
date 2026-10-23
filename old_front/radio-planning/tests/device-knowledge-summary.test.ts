import { describe, expect, it } from 'vitest';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { deviceKnowledgeSnapshot } from '../src/services/knowledge-query';
import { projectDeviceKnowledgeSummary } from '../src/services/device-knowledge-summary';
import type { DeviceKnowledge, KnowledgeDetail, KnowledgeEntity, KnowledgeRelation } from '../src/types/knowledge';

const expected = { modelId: 'DM-0001', versionId: 'TEST-PUBLISHED' };
// 独立测试图不改教学预设；用明确边验证投影边界，而非按同名或同型号补关系。
const entity = (id: string, type: string, patch: Partial<KnowledgeEntity> = {}): KnowledgeEntity => ({
  id, name: id, type, category: '设备知识', description: `${id} 说明`, source: `${id} 实体来源`,
  modelIds: ['DM-0001'], keywords: [], attributes: [], ...patch,
});
const relation = (id: string, head: string, type: string, tail: string, patch: Partial<KnowledgeRelation> = {}): KnowledgeRelation => ({
  id, head, type, tail, weight: null, source: `${id} 关系来源`, ...patch,
});
const detail = (root: KnowledgeEntity, neighbors: KnowledgeEntity[] = [], relations: KnowledgeRelation[] = []): KnowledgeDetail => ({
  versionId: expected.versionId, entity: root, neighbors, relations,
});
const response = (...items: KnowledgeDetail[]): DeviceKnowledge => ({ ...expected, items });
const project = (data: unknown) => projectDeviceKnowledgeSummary(data, expected);
function fixture() {
  const root = entity('MODEL', 'DeviceModel'), component = entity('PART', 'Component');
  const edge = relation('MODEL-PART', root.id, 'hasComponent', component.id);
  return response(detail(root, [component], [edge]));
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  return value;
}
function freeze(value: unknown) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value)) freeze(nested);
}

describe('设备型号知识的只读有向投影', () => {
  it('直接复用当前教学库，两型号有部件和三项功能，接口及其他型号保持缺失', () => {
    const workspace = initialKnowledgeWorkspace(), before = structuredClone(workspace);
    for (const modelId of ['DM-0001', 'DM-0002']) {
      const request = { modelId, versionId: workspace.currentVersionId };
      const summary = projectDeviceKnowledgeSummary(deviceKnowledgeSnapshot(workspace, request), request);
      expect(summary.roots.map(item => item.entityId)).toEqual(['KGE-MODEL']);
      expect(summary.components.map(item => item.entityId)).toEqual(['KGE-POWER']);
      expect(summary.functions.map(item => item.entityId)).toEqual(['KGE-PRINCIPLE', 'KGE-OPERATION', 'KGE-MAINTENANCE']);
      expect(summary.interfaces).toEqual([]);
      expect(summary.components[0].entitySource).toContain('非厂家操作手册');
    }
    const request = { modelId: 'DM-0003', versionId: workspace.currentVersionId };
    expect(projectDeviceKnowledgeSummary(deviceKnowledgeSnapshot(workspace, request), request).roots).toEqual([]);
    expect(workspace).toEqual(before);
  });

  it('按关系类型分三组，完整保留实体、根及关系来源', () => {
    const root = entity('MODEL', 'DeviceModel'), rows = [entity('PART', 'Component'), entity('PORT', 'Interface'), entity('USE', 'Function')];
    const edges = ['hasComponent', 'hasInterface', 'hasFunction'].map((type, i) => relation(`R${i}`, root.id, type, rows[i].id));
    const summary = project(response(detail(root, rows, edges)));
    expect(summary.roots).toEqual([{ entityId: 'MODEL', name: 'MODEL', description: 'MODEL 说明', entitySource: 'MODEL 实体来源' }]);
    for (const [index, group] of [summary.components, summary.interfaces, summary.functions].entries()) {
      expect(group).toEqual([{ entityId: rows[index].id, name: rows[index].name, description: rows[index].description,
        entitySource: rows[index].source, bindings: [{ rootId: root.id, rootName: root.name, rootSource: root.source,
          relationId: edges[index].id, relationType: edges[index].type, relationSource: edges[index].source }] }]);
    }
  });

  it('多个根可共享型号和目标，按实体 ID 合并并保留所有不同关系证据', () => {
    const rootA = entity('ROOT-A', 'DeviceModel', { modelIds: ['DM-0001', 'DM-0002'] });
    const rootB = entity('ROOT-B', 'DeviceModel'), part = entity('PART', 'Component');
    const edges = [relation('A1', rootA.id, 'hasComponent', part.id), relation('A2', rootA.id, 'hasComponent', part.id), relation('B1', rootB.id, 'hasComponent', part.id)];
    const data = response(detail(rootA, [part], edges.slice(0, 2)), detail(rootB, [part], edges.slice(2)), detail(part, [rootA, rootB], edges));
    const summary = project(data);
    expect(summary.roots.map(item => item.entityId)).toEqual(['ROOT-A', 'ROOT-B']);
    expect(summary.components).toHaveLength(1);
    expect(summary.components[0].bindings.map(item => [item.rootId, item.relationId])).toEqual([['ROOT-A', 'A1'], ['ROOT-A', 'A2'], ['ROOT-B', 'B1']]);
  });

  it('根必须是主实体明确绑定当前型号，邻居型号及其他类别不能升级成根', () => {
    const root = entity('NEIGHBOR-ROOT', 'DeviceModel'), part = entity('PART', 'Component');
    const other = entity('OTHER-ROOT', 'DeviceModel', { modelIds: ['DM-0002'] });
    const network = entity('NETWORK-ROOT', 'DeviceModel', { category: '网络态势知识' });
    const data = response(detail(part, [root], [relation('R1', root.id, 'hasComponent', part.id)]),
      detail(other, [part], [relation('R2', other.id, 'hasComponent', part.id)]),
      detail(network, [part], [relation('R3', network.id, 'hasComponent', part.id)]));
    expect(project(data)).toEqual({ ...expected, roots: [], components: [], interfaces: [], functions: [] });
  });

  it('反向边、二跳、其他关系及同型号孤立实体都不进入摘要', () => {
    const root = entity('MODEL', 'DeviceModel'), first = entity('FIRST', 'Component'), second = entity('SECOND', 'Component');
    const backwards = entity('BACK', 'Component'), isolated = entity('ISOLATED', 'Component');
    const edges = [relation('R1', root.id, 'hasComponent', first.id), relation('R2', first.id, 'hasComponent', second.id),
      relation('R3', backwards.id, 'hasComponent', root.id), relation('R4', root.id, 'hasParameter', isolated.id)];
    const summary = project(response(detail(root, [first, backwards, isolated], edges), detail(second), detail(isolated)));
    expect(summary.components.map(item => item.entityId)).toEqual(['FIRST']);
  });

  it('明确属于其他型号的分支先过滤，不把其不同类别或类型误报为当前型号错误', () => {
    const data = fixture();
    data.items[0].entity.modelIds.push('DM-0002');
    data.items[0].neighbors[0] = entity('PART', 'Symptom', { category: '故障运维知识', modelIds: ['DM-0002'] });
    expect(project(data).components).toEqual([]);
  });

  it('通用目标只凭明确正向关系展示，无关系的通用实体不能附加', () => {
    const root = entity('MODEL', 'DeviceModel'), generic = entity('GENERIC', 'Interface', { modelIds: [] });
    const detached = entity('DETACHED', 'Interface', { modelIds: [] });
    const summary = project(response(detail(root, [generic, detached], [relation('PORT', root.id, 'hasInterface', generic.id)]), detail(detached)));
    expect(summary.interfaces.map(item => item.entityId)).toEqual(['GENERIC']);
    expect(summary.interfaces[0].bindings[0].rootId).toBe('MODEL');
  });

  it('同名不同 ID 保留两条，名称或描述中的型号字样不代替身份绑定', () => {
    const root = entity('MODEL', 'DeviceModel'), first = entity('A', 'Component', { name: '同名部件' });
    const second = entity('B', 'Component', { name: first.name }), wrong = entity('C', 'Component', { name: 'DM-0001 部件', modelIds: ['DM-0002'] });
    const summary = project(response(detail(root, [first, second, wrong], [first, second, wrong].map(row => relation(`R-${row.id}`, root.id, 'hasComponent', row.id)))));
    expect(summary.components.map(item => item.entityId)).toEqual(['A', 'B']);
  });

  it('正常空响应或有根无关系都明确保留缺知识，不补默认型号内容', () => {
    expect(project(response())).toEqual({ ...expected, roots: [], components: [], interfaces: [], functions: [] });
    const summary = project(response(detail(entity('MODEL', 'DeviceModel'))));
    expect(summary.roots).toHaveLength(1);
    expect([summary.components, summary.interfaces, summary.functions]).toEqual([[], [], []]);
  });

  it('一致实体和关系可跨明细重复，对象及嵌套键顺序不构成冲突', () => {
    const data = fixture(), original = data.items[0];
    original.neighbors[0].attributes = [{ name: '参数', value: '说明', unit: null }];
    original.neighbors[0].principleFlow = { steps: [{ title: '步骤', description: '描述' }] };
    data.items.push(reverseKeys(original) as KnowledgeDetail);
    const summary = project(data);
    expect(summary.roots).toHaveLength(1);
    expect(summary.components).toHaveLength(1);
    expect(summary.components[0].bindings).toHaveLength(1);
  });

  it.each(['description', 'source', 'modelIds', 'attributes', 'principleFlow'] as const)('同实体 ID 的 %s 内容矛盾拒绝整份摘要', field => {
    const data = fixture(), duplicate = structuredClone(data.items[0].neighbors[0]);
    if (field === 'description' || field === 'source') duplicate[field] = '矛盾内容';
    if (field === 'modelIds') duplicate.modelIds = ['DM-0002'];
    if (field === 'attributes') duplicate.attributes = [{ name: '新增', value: '不同', unit: null }];
    if (field === 'principleFlow') duplicate.principleFlow = { steps: [{ title: '新增', description: '不同' }] };
    data.items.push(detail(duplicate));
    expect(() => project(data)).toThrow('实体 PART 的重复身份内容矛盾');
  });

  it.each(['head', 'tail', 'type', 'source', 'weight'] as const)('同关系 ID 的 %s 内容矛盾拒绝整份摘要', field => {
    const data = fixture(), duplicate = structuredClone(data.items[0].relations[0]);
    if (field === 'weight') duplicate.weight = 0.5;
    else duplicate[field] = '不同内容';
    data.items[0].relations.push(duplicate);
    expect(() => project(data)).toThrow('关系 MODEL-PART 的重复身份内容矛盾');
  });

  it.each([null, {}, { ...expected, items: null }, { ...expected, modelId: 'DM-0002', items: [] }, { ...expected, versionId: 'OLD', items: [] }])('无效响应或归属错误不能当成无知识：%j', data => {
    expect(() => project(data)).toThrow('响应型号、发布版本或明细格式不匹配');
  });

  it('任何明细版本不一致都失败，不接受外层版本掩盖的混合内容', () => {
    const data = fixture(); data.items.push({ ...detail(entity('UNRELATED', 'Function')), versionId: 'OLD' });
    expect(() => project(data)).toThrow('明细发布版本或关系格式不匹配');
  });

  it.each(['neighbors', 'relations'] as const)('明细 %s 非数组时失败', key => {
    const data = fixture() as unknown as { items: Record<string, unknown>[] }; data.items[0][key] = null;
    expect(() => project(data)).toThrow('明细发布版本或关系格式不匹配');
  });

  it.each(['modelIds', 'name', 'description', 'source'] as const)('目标必要字段 %s 格式无效时失败', key => {
    const data = fixture(), target = data.items[0].neighbors[0] as unknown as Record<string, unknown>;
    target[key] = null;
    expect(() => project(data)).toThrow('实体必要字段格式无效');
  });

  it('其他型号目标仍先检查必要形状，不让筛选掩盖损坏的实体', () => {
    const data = fixture(); data.items[0].neighbors[0].modelIds = ['DM-0002'];
    (data.items[0].neighbors[0] as unknown as Record<string, unknown>).description = null;
    expect(() => project(data)).toThrow('实体必要字段格式无效');
  });

  it('选中的正向关系缺目标是错误，不能退化成空列表', () => {
    const data = fixture(); data.items[0].neighbors = [];
    expect(() => project(data)).toThrow('关系 MODEL-PART 缺少目标实体');
  });

  it.each(['head', 'tail', 'source'] as const)('关系必要字段 %s 格式无效时失败', key => {
    const data = fixture(); (data.items[0].relations[0] as unknown as Record<string, unknown>)[key] = null;
    expect(() => project(data)).toThrow('关系必要字段格式无效');
  });

  it.each([{ type: 'Function' }, { category: '网络态势知识' as const }])('保留目标的类别或类型错误时拒绝整份摘要：%j', patch => {
    const data = fixture(); Object.assign(data.items[0].neighbors[0], patch);
    expect(() => project(data)).toThrow('目标类别或类型不匹配');
  });

  it('合法但未选择的边可指向响应范围外，不做全图完整性推断', () => {
    const data = fixture();
    data.items[0].relations.push(relation('OUTSIDE', 'MODEL', 'hasParameter', 'NOT-RETURNED'),
      relation('REVERSE', 'OUTSIDE-ROOT', 'hasComponent', 'MODEL'));
    expect(project(data).components.map(item => item.entityId)).toEqual(['PART']);
  });

  it('空描述保持缺值，不读取名称或原理步骤生成替代说明', () => {
    const data = fixture(); data.items[0].neighbors[0].description = '';
    data.items[0].neighbors[0].principleFlow = { steps: [{ title: '步骤', description: '不作为说明' }] };
    expect(project(data).components[0].description).toBe('');
  });

  it('输入冻结也可投影，修改返回列表和证据不改服务响应', () => {
    const data = fixture(), before = structuredClone(data); freeze(data);
    const summary = project(data);
    summary.components[0].description = '显示层改动';
    summary.components[0].bindings[0].rootSource = '改来源';
    summary.roots[0].name = '改名称'; summary.interfaces.push({ ...summary.components[0], bindings: [] });
    expect(data).toEqual(before);
    expect(project(data).components[0].description).toBe('PART 说明');
  });
});
