import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkRuleSeed, networkRuleTeaching } from '../src/mocks/knowledge-network-rules';
import { networkRuleIssues, resolveNetworkRule, describeNetworkRule } from '../src/services/knowledge-network-rule';
import { validateKnowledgeWorkspace } from '../src/services/knowledge-storage';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { knowledgeEntityDetail, searchKnowledgeSnapshot } from '../src/services/knowledge-query';
import { authFixture } from './helpers/auth';
import type { KnowledgeEntity } from '../src/types/knowledge';

afterEach(() => vi.restoreAllMocks());
const entity = (): KnowledgeEntity => ({ ...structuredClone(networkRuleSeed), networkRule: structuredClone(networkRuleTeaching) });
describe('网络规则知识契约和版本', () => {
  it('教学附件不改旧种子，采用、移除与显式版本数据各有语义', () => {
    const w = initialKnowledgeWorkspace(), before = structuredClone(w), e = knowledgeEntityDetail(w, w.currentVersionId, 'KGE-RULE').entity;
    expect(resolveNetworkRule(e)?.teaching).toBe(true); expect(e.networkRule).toBeUndefined();
    e.networkRule = structuredClone(networkRuleTeaching); expect(resolveNetworkRule(e)?.teaching).toBe(false);
    e.networkRule = null; expect(resolveNetworkRule(e)).toBeNull(); expect(describeNetworkRule(e)).toContain('已明确移除');
    expect(w).toEqual(before); expect(() => validateKnowledgeWorkspace(w)).not.toThrow();
  });
  it.each(['id', 'name', 'description', 'category', 'type', 'source', 'keywords', 'attributes', 'modelIds'])('原指纹 %s 改变不能套旧附件', key => {
    const e = structuredClone(networkRuleSeed);
    (e as unknown as Record<string, unknown>)[key] = ['keywords', 'attributes', 'modelIds'].includes(key) ? ['changed'] : 'changed';
    expect(resolveNetworkRule(e)).toBeNull();
  });
  const changes: [string, (e: KnowledgeEntity) => void][] = [
    ['不适用类型', e => { e.type = 'Metric'; }], ['缺范围', e => { e.networkRule!.scope = ''; }],
    ['长范围', e => { e.networkRule!.scope = '长'.repeat(501); }], ['长来源', e => { e.networkRule!.source = '长'.repeat(201); }],
    ['重复状态', e => { e.networkRule!.criteria[1].state = 'EXCELLENT'; }], ['缺状态', e => { e.networkRule!.criteria.pop(); }],
    ['空条件', e => { e.networkRule!.criteria[0].condition = ''; }], ['空含义', e => { e.networkRule!.criteria[0].meaning = ''; }],
    ['稀疏判据', e => { delete e.networkRule!.criteria[1]; }], ['非法变化', e => { e.networkRule!.transitions[0].to = 'UNKNOWN' as never; }],
    ['过多变化', e => { e.networkRule!.transitions = Array.from({ length: 13 }, () => e.networkRule!.transitions[0]); }],
    ['缺变化说明', e => { e.networkRule!.transitions[0].description = ''; }],
  ];
  it.each(changes)('%s 阻止保存并保留无效原值', (_label, mutate) => {
    const e = entity(); mutate(e); const before = structuredClone(e);
    expect(networkRuleIssues(e).length).toBeGreaterThan(0); expect(resolveNetworkRule(e)).toBeNull(); expect(e).toEqual(before);
  });
  it('纯文本表达式不执行，空变化列表不等于永不变化', () => {
    const e = entity(); e.networkRule!.criteria[0].condition = 'globalThis.__ruleExecuted = true'; e.networkRule!.transitions = [];
    expect(networkRuleIssues(e)).toEqual([]); expect(describeNetworkRule(e)).toContain('暂无状态变化说明');
    expect((globalThis as Record<string, unknown>).__ruleExecuted).toBeUndefined();
  });
  it('发布、回滚和重新加载保留版本语义，观测和设备角色不受知识发布影响', async () => {
    const s = authFixture(); await s.login('kg_editor');
    let w = (await s.service.loadKnowledgeWorkspace()).workspace!, serial = 0;
    const seed = structuredClone(w.versions), initial = w.currentVersionId;
    const preview = await s.raw.loadPreview(), context = await s.raw.loadMonitoringContext(null);
    const frame = await s.raw.getMonitoringFrame({ taskId: null, networkKey: context.network!.key, index: 1 });
    const request = (actorId: string) => ({ actorId, baseRevision: w.revision, requestId: 'rule-' + (++serial) });
    const e = entity(); e.networkRule!.scope = '新发布独有关键词';
    const saved = await s.service.saveKnowledgeChange({ ...request('KG-EDITOR'), changeId: null, revision: null,
      draft: { baseVersionId: initial, summary: '维护规则说明', entities: [e], relations: [] } });
    w = saved.workspace; const c = w.changes.find(c => c.id === saved.entityId)!;
    const query = () => ({ versionId: w.currentVersionId, categories: ['网络态势知识'] as ['网络态势知识'], query: '新发布独有关键词' });
    expect((await s.service.searchKnowledge(query())).total).toBe(0);
    w = (await s.service.submitKnowledgeChange({ ...request('KG-EDITOR'), changeId: c.id, revision: c.revision })).workspace;
    await s.service.logout(); await s.login('kg_reviewer');
    w = (await s.service.reviewKnowledgeChange({ ...request('KG-REVIEWER'), changeId: c.id, revision: c.revision, submission: 1, approved: true, opinion: '' })).workspace;
    expect(w.currentVersionId).toBe(initial);
    w = (await s.service.publishKnowledgeChange({ ...request('KG-REVIEWER'), changeId: c.id, revision: c.revision })).workspace;
    const published = w.currentVersionId; expect((await s.service.searchKnowledge(query())).total).toBe(1);
    expect(resolveNetworkRule((await s.service.getKnowledgeEntity({ versionId: published, entityId: e.id })).entity)?.teaching).toBe(false);
    expect(resolveNetworkRule((await s.service.getKnowledgeEntity({ versionId: initial, entityId: e.id })).entity)?.teaching).toBe(true);
    expect((await s.service.loadKnowledgeWorkspace()).workspace).toEqual(w);
    w = (await s.service.rollbackKnowledgeVersion({ ...request('KG-REVIEWER'), versionId: published, reason: '恢复前版说明' })).workspace;
    expect(w.versions.slice(0, 2)).toEqual(seed); expect((await s.service.searchKnowledge(query())).total).toBe(0);
    expect((await s.service.getKnowledgeEntity({ versionId: published, entityId: e.id })).entity.networkRule?.scope).toBe('新发布独有关键词');
    expect(await s.raw.loadPreview()).toEqual(preview);
    expect(await s.raw.getMonitoringFrame({ taskId: null, networkKey: context.network!.key, index: 1 })).toEqual(frame);
  });
  it('显式移除随发布保存，历史附件仍只读，搜索不泄漏草稿', async () => {
    const s = authFixture(); await s.login('kg_editor'); let w = (await s.service.loadKnowledgeWorkspace()).workspace!;
    const original = w.currentVersionId, e = { ...structuredClone(networkRuleSeed), networkRule: null };
    const req = (actorId: string) => ({ actorId, baseRevision: w.revision, requestId: crypto.randomUUID() });
    const saved = await s.service.saveKnowledgeChange({ ...req('KG-EDITOR'), changeId: null, revision: null, draft: { baseVersionId: original, summary: '移除规则说明', entities: [e], relations: [] } });
    w = saved.workspace; w = (await s.service.submitKnowledgeChange({ ...req('KG-EDITOR'), changeId: saved.entityId, revision: 1 })).workspace;
    await s.service.logout(); await s.login('kg_reviewer');
    w = (await s.service.reviewKnowledgeChange({ ...req('KG-REVIEWER'), changeId: saved.entityId, revision: 1, submission: 1, approved: true, opinion: '' })).workspace;
    w = (await s.service.publishKnowledgeChange({ ...req('KG-REVIEWER'), changeId: saved.entityId, revision: 1 })).workspace;
    const current = await s.service.getKnowledgeEntity({ versionId: w.currentVersionId, entityId: e.id });
    expect(current.entity.networkRule).toBeNull(); expect(resolveNetworkRule(current.entity)).toBeNull();
    expect(searchKnowledgeSnapshot(w, { versionId: w.currentVersionId, categories: ['网络态势知识'], query: '深衰落' }).total).toBe(0);
    expect(searchKnowledgeSnapshot(w, { versionId: original, categories: ['网络态势知识'], query: '深衰落' }).total).toBe(1);
  });
});
