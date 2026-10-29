import { describe, expect, it } from 'vitest';
import { knowledgeEditDifferences, knowledgeEditIndex } from '../src/services/knowledge-edit-preview';
import { applyKnowledgeDraft, knowledgeClone, knowledgeDiff } from '../src/services/knowledge-validation';
import type { KnowledgeDraft, KnowledgeEntity, KnowledgeSnapshot } from '../src/types/knowledge';

const entity = (id: string): KnowledgeEntity => ({ id, name: id, type: 'Cause', category: '故障运维知识',
  description: '', source: '测试来源', keywords: [], attributes: [], modelIds: [] });
const base: KnowledgeSnapshot = { entities: [entity('A'), entity('B'), entity('C')], relations: [
  { id: 'R1', head: 'A', tail: 'B', type: 'causedBy', weight: null, source: '测试' },
  { id: 'R2', head: 'B', tail: 'C', type: 'causedBy', weight: 0.5, source: '测试' },
] };
const draft = (): KnowledgeDraft => ({ summary: '测试', baseVersionId: 'V1', entities: [], relations: [] });
function equivalent(value: KnowledgeDraft) {
  expect(knowledgeEditDifferences(knowledgeEditIndex(base), value))
    .toEqual(knowledgeDiff(base, applyKnowledgeDraft(base, value)));
}
describe('知识编辑增量预览', () => {
  it('空单、只改摘要及原样加入已有条目不产生知识差异', () => {
    equivalent(draft());
    equivalent({ ...draft(), entities: [knowledgeClone(base.entities[0]!)], relations: [knowledgeClone(base.relations[0]!)] });
  });
  it('新增、修改按原基线顺序展示，新增按草稿顺序追加', () => {
    const value = { ...draft(), entities: [entity('new:2'), { ...entity('C'), source: '更新' }, entity('new:1'), { ...entity('A'), name: '改名' }],
      relations: [{ ...base.relations[1]!, weight: 0 }, { ...base.relations[0]!, id: 'new:r' }] };
    equivalent(value);
    expect(knowledgeEditDifferences(knowledgeEditIndex(base), value).map((x) => x.id)).toEqual(['A', 'C', 'new:2', 'new:1', 'R2', 'new:r']);
  });
  it('深层属性、关键词顺序、步骤及规则变化不会漏掉', () => {
    const e = entity('A'); e.keywords = ['乙', '甲']; e.attributes = [{ name: '状态', value: '测试', unit: null }];
    e.principleFlow = { steps: [{ title: '步骤1', description: '检查' }] };
    equivalent({ ...draft(), entities: [e] });
  });
  it('保留空值、0和非法数字差异，不把NaN转换为null', () => {
    for (const weight of [null, 0, NaN, Infinity]) equivalent({ ...draft(), relations: [{ ...base.relations[1]!, weight }] });
  });
  it('重复ID与原合并规则一致，仍由原保存校验拒绝非法草稿', () => {
    equivalent({ ...draft(), entities: [{ ...entity('A'), source: '一' }, { ...entity('A'), source: '二' }] });
  });
  it('编辑还原及移除未保存行及时清除预览，不修改基线', () => {
    const copy = knowledgeClone(base), index = knowledgeEditIndex(copy), value = { ...draft(), entities: [knowledgeClone(copy.entities[0]!)] };
    value.entities[0]!.source = '修改'; expect(knowledgeEditDifferences(index, value)).toHaveLength(1);
    value.entities[0]!.source = '测试来源'; expect(knowledgeEditDifferences(index, value)).toHaveLength(0);
    value.entities.push(entity('new:x')); expect(knowledgeEditDifferences(index, value)).toHaveLength(1);
    value.entities.pop(); expect(knowledgeEditDifferences(index, value)).toHaveLength(0);
    expect(copy).toEqual(base);
  });
  it('已建索引后的输入不读取无关基线内容', () => {
    let unrelatedReads = 0;
    const unrelated = entity('UNRELATED');
    Object.defineProperty(unrelated, 'description', { enumerable: true, get() { unrelatedReads++; return '大量知识说明'; } });
    const index = knowledgeEditIndex({ entities: [entity('A'), unrelated], relations: [] });
    for (let i = 0; i < 5; i++) knowledgeEditDifferences(index, { ...draft(), entities: [{ ...entity('A'), source: String(i) }] });
    expect(unrelatedReads).toBe(0);
  });
});
