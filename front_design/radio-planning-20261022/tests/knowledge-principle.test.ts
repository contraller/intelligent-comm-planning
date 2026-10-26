import { describe, expect, it } from 'vitest';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { describeKnowledgePrinciple, principleIssues, resolveKnowledgePrinciple } from '../src/services/knowledge-principle';
import { deviceKnowledgeSnapshot, searchKnowledgeSnapshot } from '../src/services/knowledge-query';
import { knowledgeIssues } from '../src/services/knowledge-validation';
import type { KnowledgeEntity, KnowledgePrincipleFlow } from '../src/types/knowledge';

const principle = () => initialKnowledgeWorkspace().versions[1].entities.find(e => e.id === 'KGE-PRINCIPLE')!;
const flow = (count = 2): KnowledgePrincipleFlow => ({ steps: Array.from({ length: count }, (_, i) => ({ title: '步骤' + i, description: '' })) });
describe('工作原理数据与检索', () => {
  it('两个既有型号共用版本内工作原理，查询及展示均不补写版本', () => {
    const w = initialKnowledgeWorkspace(), before = JSON.stringify(w);
    for (const modelId of ['DM-0001', 'DM-0002']) {
      const item = deviceKnowledgeSnapshot(w, { versionId: w.currentVersionId, modelId }).items.find(x => x.entity.id === 'KGE-PRINCIPLE')!;
      expect(resolveKnowledgePrinciple(item.entity)).toMatchObject({ flow: { steps: [
        { title: '输入信号' }, { title: '信号处理' }, { title: '射频传输' }, { title: '接收还原' },
      ] } });
      expect(item.entity.principleFlow?.steps).toHaveLength(4);
    }
    expect(JSON.stringify(w)).toBe(before);
    expect(deviceKnowledgeSnapshot(w, { versionId: w.currentVersionId, modelId: 'DM-0003' }).items).toHaveLength(0);
  });
  it.each(['id', 'category', 'type', 'description', 'source', 'modelIds'] as const)('匹配条件 %s 变化且缺少步骤时不回填', field => {
    const e = principle(); delete e.principleFlow; Object.assign(e, { [field]: field === 'modelIds' ? ['DM-0001'] : '已经变化' });
    expect(resolveKnowledgePrinciple(e)).toBeNull();
  });
  it('显式步骤优先，null 明确移除；另一个实体不能仅凭相同文字借用示例', () => {
    const e = principle(); e.principleFlow = flow();
    expect(resolveKnowledgePrinciple(e)).toEqual({ flow: flow() });
    e.principleFlow = null; expect(resolveKnowledgePrinciple(e)).toBeNull();
    expect(describeKnowledgePrinciple(e)).toContain('已明确移除');
    delete e.principleFlow; e.id = 'other'; expect(resolveKnowledgePrinciple(e)).toBeNull();
  });
  it('返回流程副本不污染输入与固定示例，型号顺序不改变适用范围', () => {
    const e = principle(); e.modelIds.reverse();
    resolveKnowledgePrinciple(e)!.flow.steps[0].title = '外部改动';
    expect(resolveKnowledgePrinciple(e)!.flow.steps[0].title).toBe('输入信号');
    e.principleFlow = flow(); resolveKnowledgePrinciple(e)!.flow.steps[0].description = '外部改动';
    expect(e.principleFlow.steps[0].description).toBe('');
  });
  it.each([false, '错误', {}, { steps: [] }, flow(1), flow(13), { steps: new Array(2) },
    { steps: [null, { title: '有效', description: '' }] }, { steps: [{ title: ' ', description: '' }, { title: '有效', description: '' }] },
    { steps: [{ title: '长'.repeat(41), description: '' }, { title: '有效', description: '' }] },
    { steps: [{ title: '有效', description: '长'.repeat(201) }, { title: '有效', description: '' }] },
    { steps: [{ title: '有效' }, { title: '有效', description: '' }] },
  ])('非法流程不渲染且实体校验明确拒绝 %#', value => {
    const e = principle(); e.principleFlow = value as KnowledgePrincipleFlow;
    expect(principleIssues(e).length).toBeGreaterThan(0);
    expect(knowledgeIssues({ entities: [e], relations: [] }).some(issue => issue.field === 'principleFlow')).toBe(true);
    expect(resolveKnowledgePrinciple(e)).toBeNull();
  });
  it('合法边界和旧记录通过，其他图谱类别不能附带流程', () => {
    const e = principle(); expect(principleIssues(e)).toEqual([]);
    e.principleFlow = flow(12); e.principleFlow.steps[0] = { title: '长'.repeat(40), description: '长'.repeat(200) };
    expect(principleIssues(e)).toEqual([]);
    e.category = '故障运维知识'; expect(principleIssues(e)[0].message).toContain('仅设备知识');
    e.principleFlow = null; expect(principleIssues(e)).toEqual([]);
  });
  it('拒绝挂载对象属性的数组，避免 JSON 保存时丢失步骤内容', () => {
    const e = principle(); e.principleFlow = Object.assign([], flow()) as unknown as KnowledgePrincipleFlow;
    expect(principleIssues(e).length).toBeGreaterThan(0);
    e.principleFlow = { steps: [Object.assign([], { title: '输入', description: '' }), { title: '输出', description: '' }] };
    expect(principleIssues(e).length).toBeGreaterThan(0);
  });
  it('步骤标题/说明参与当前版本与型号检索，草稿或旧版不泄漏', () => {
    const w = initialKnowledgeWorkspace(), e = w.versions[1].entities.find(e => e.id === 'KGE-PRINCIPLE')!;
    e.principleFlow = { steps: [{ title: '新标题', description: '独有说明词' }, { title: '输出', description: '' }] };
    const q = { versionId: w.currentVersionId, categories: ['设备知识'] as KnowledgeEntity['category'][], search: '独有说明词' };
    expect(searchKnowledgeSnapshot(w, q).items.map(e => e.id)).toEqual([e.id]);
    expect(searchKnowledgeSnapshot(w, { ...q, search: '新标题' }).total).toBe(1);
    expect(searchKnowledgeSnapshot(w, { ...q, versionId: w.versions[0].id }).total).toBe(0);
    expect(searchKnowledgeSnapshot(w, { ...q, categories: ['网络态势知识'] }).total).toBe(0);
    expect(deviceKnowledgeSnapshot(w, { versionId: q.versionId, modelId: 'DM-0001', search: q.search }).items).toHaveLength(1);
    expect(deviceKnowledgeSnapshot(w, { versionId: q.versionId, modelId: 'DM-0003', search: q.search }).items).toHaveLength(0);
  });
  it('差异说明保留步骤顺序、说明和清除语义', () => {
    const e = principle(); expect(describeKnowledgePrinciple(e)).toContain('工作原理流程');
    e.principleFlow = { steps: [{ title: '乙', description: '说明乙' }, { title: '甲', description: '' }] };
    expect(describeKnowledgePrinciple(e)).toContain('1. 乙：说明乙\n2. 甲');
    e.principleFlow = null; expect(describeKnowledgePrinciple(e)).toContain('已明确移除');
    delete e.principleFlow; e.description = '新的文字'; expect(describeKnowledgePrinciple(e)).toContain('未提供');
  });
});
