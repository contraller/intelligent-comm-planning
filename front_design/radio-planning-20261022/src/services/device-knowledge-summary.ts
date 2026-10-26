import type { DeviceModelKnowledgeSummary, SummaryItem, SummaryRelationType } from '../types/device-knowledge-summary';

type RecordValue = Record<string, unknown>;
interface EntityValue extends RecordValue {
  id: string; name: string; description: string; source: string; category: string; type: string; modelIds: string[];
}
interface RelationValue extends RecordValue { id: string; head: string; tail: string; type: string; source: string }
const relationGroups = {
  hasComponent: { group: 'components', type: 'Component' },
  hasInterface: { group: 'interfaces', type: 'Interface' },
  hasFunction: { group: 'functions', type: 'Function' },
} as const;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function requireValid(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`型号知识摘要关联错误：${message}`);
}
function entityValue(value: unknown): EntityValue {
  requireValid(record(value) && identifier(value.id) && identifier(value.name) && identifier(value.type)
    && typeof value.description === 'string' && typeof value.source === 'string'
    && typeof value.category === 'string' && ['设备知识', '网络态势知识', '故障运维知识'].includes(value.category)
    && Array.isArray(value.modelIds) && value.modelIds.every(identifier), '实体必要字段格式无效');
  return value as EntityValue;
}
function relationValue(value: unknown): RelationValue {
  requireValid(record(value) && identifier(value.id) && identifier(value.head) && identifier(value.tail)
    && identifier(value.type) && typeof value.source === 'string', '关系必要字段格式无效');
  return value as RelationValue;
}
// 对象键顺序不属于内容差异；数组保留原顺序，不静默修正接口返回的含义。
function contentSignature(value: RecordValue): string {
  return JSON.stringify(value, (_key, item: unknown) => record(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function register<T extends RecordValue & { id: string }>(rows: Map<string, T>, signatures: Map<string, string>, value: T, label: string) {
  const signature = contentSignature(value);
  requireValid(!signatures.has(value.id) || signatures.get(value.id) === signature, `${label} ${value.id} 的重复身份内容矛盾`);
  if (!rows.has(value.id)) { rows.set(value.id, value); signatures.set(value.id, signature); }
}

/** 仅投影服务明确返回的有向一跳关系，不推断组成、角色或设备当前状态。 */
export function projectDeviceKnowledgeSummary(data: unknown, expected: { modelId: string; versionId: string }): DeviceModelKnowledgeSummary {
  requireValid(identifier(expected.modelId) && identifier(expected.versionId), '请求型号或发布版本无效');
  requireValid(record(data) && data.modelId === expected.modelId && data.versionId === expected.versionId
    && Array.isArray(data.items), '响应型号、发布版本或明细格式不匹配');
  const entities = new Map<string, EntityValue>(), relations = new Map<string, RelationValue>();
  const entitySignatures = new Map<string, string>(), relationSignatures = new Map<string, string>();
  const itemEntityIds = new Set<string>();
  for (const detail of data.items) {
    requireValid(record(detail) && detail.versionId === expected.versionId
      && Array.isArray(detail.neighbors) && Array.isArray(detail.relations), '明细发布版本或关系格式不匹配');
    const entity = entityValue(detail.entity);
    itemEntityIds.add(entity.id);
    register(entities, entitySignatures, entity, '实体');
    for (const neighbor of detail.neighbors) register(entities, entitySignatures, entityValue(neighbor), '实体');
    for (const relation of detail.relations) register(relations, relationSignatures, relationValue(relation), '关系');
  }
  // 邻居中的型号实体不能自动成为根；多个明确根分别保留来源证据。
  const roots = [...itemEntityIds].map(id => entities.get(id)!).filter(entity => entity.category === '设备知识'
    && entity.type === 'DeviceModel' && entity.modelIds.includes(expected.modelId));
  const summary: DeviceModelKnowledgeSummary = {
    modelId: expected.modelId, versionId: expected.versionId,
    roots: roots.map(root => ({ entityId: root.id, name: root.name, description: root.description, entitySource: root.source })),
    components: [], interfaces: [], functions: [],
  };
  const grouped = { components: new Map<string, SummaryItem>(), interfaces: new Map<string, SummaryItem>(), functions: new Map<string, SummaryItem>() };
  for (const root of roots) {
    for (const relation of relations.values()) {
      if (relation.head !== root.id || !Object.hasOwn(relationGroups, relation.type)) continue;
      const relationType = relation.type as SummaryRelationType, rule = relationGroups[relationType];
      const target = entities.get(relation.tail);
      requireValid(target, `关系 ${relation.id} 缺少目标实体`);
      // 共享根可指向其他型号专属目标；通用目标只凭明确正向关系进入摘要。
      if (target.modelIds.length && !target.modelIds.includes(expected.modelId)) continue;
      requireValid(target.category === '设备知识' && target.type === rule.type, `关系 ${relation.id} 的目标类别或类型不匹配`);
      let item = grouped[rule.group].get(target.id);
      if (!item) {
        item = { entityId: target.id, name: target.name, description: target.description, entitySource: target.source, bindings: [] };
        grouped[rule.group].set(target.id, item);
        summary[rule.group].push(item);
      }
      item.bindings.push({ rootId: root.id, rootName: root.name, rootSource: root.source,
        relationId: relation.id, relationType, relationSource: relation.source });
    }
  }
  return summary;
}
