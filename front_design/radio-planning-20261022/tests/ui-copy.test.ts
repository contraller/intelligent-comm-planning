import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import ReadableData from '../src/components/ReadableData.vue';
import { uiCode, uiEvidence, uiSource, uiStructured, uiText } from '../src/services/ui-copy';

describe('正式界面中文展示与原始依据边界', () => {
  it('状态、方案、分类和干扰选项采用中文，未知扩展与缺失值不猜补', () => {
    expect(['NORMAL', 'FAULT', 'OFFLINE', null].map(value => uiCode(value))).toEqual(['正常', '故障', '离线', '未提供']);
    expect(['I_FIXED', 'FIXED_STATION', 'FIXED'].map(value => uiCode(value))).toEqual(['I级短波固定站', '已有固定站', '固定部署']);
    expect(['REFERENCE', 'REVIEW', 'NOISE', 'OMNI', true, false].map(value => uiCode(value))).toEqual(['未达标参考', '审核', '噪声', '全向', '是', '否']);
    expect(uiCode('vendor_state')).toBe('vendor_state');
    expect(uiCode('SYNTHETIC_INTEGRATION')).toContain('非实测');
    expect(uiSource('来源未提供')).toBe('未提供');
  });
  it('诊断候选与匹配依据可读，原编号、零、否和缺项保持各自语义', () => {
    const evidence = { label: 'candidate_rankings', value: JSON.stringify([{ case_id: 'LINK', fault_type: 'LINK_DOWN',
      score: 0, matched_symptom_count: 0, available: false, reason: null,
      source_docs: ['fault_cases_v1.csv#FC-0064 [CONSTRUCTED]'] }]) };
    const before = JSON.stringify(evidence), shown = uiEvidence(evidence);
    expect(shown.label).toBe('候选案例排序');
    for (const text of ['案例编号：LINK', '故障类型：链路中断', '相似度：0', '可用：否', '原因：未提供', 'fault_cases_v1.csv#FC-0064 [构造数据]']) expect(shown.value).toContain(text);
    expect(shown.value).not.toContain('case_id');
    expect(uiEvidence({ label: 'match_kind', value: 'PARTIAL_MISSING_INPUT' })).toEqual({ label: '匹配方式', value: '输入缺失下的部分匹配' });
    expect(uiEvidence({ label: 'rule_ids', value: '["RULE","HF"]' }).value).toBe('RULE\nHF');
    expect(JSON.stringify(evidence)).toBe(before);
  });
  it('结构化条件保留未设置、空集合、零和原始身份，解释文字不改写编号片段', () => {
    const value = { before: null, after: { mode: 'FIXED_COUNT', fixedCount: 0, solutionCount: 1, excludeFreqIds: [] } };
    const original = JSON.stringify(value), text = uiStructured(value);
    for (const fragment of ['变更前：未提供', '求解模式：指定新增部署数量', '新增部署单元数：0', '排除频点：无']) expect(text).toContain(fragment);
    expect(JSON.stringify(value)).toBe(original);
    expect(uiText('现有 CONSTRUCTED 案例，ML 未启用；LINK_DOWN-01不改。')).toBe('现有 构造数据 案例，机器学习 未启用；LINK_DOWN-01不改。');
    expect(uiStructured('{broken json')).toBe('{broken json');
  });
  it('可读摘要与完整原始依据同时存在，渲染不执行数据中的HTML或写回原对象', async () => {
    const value = { kind: 'LINK', link_id: 'LK-1', level: 'SEVERE', reason: '<script>unsafe</script>' };
    const original = JSON.stringify(value);
    const html = await renderToString(createSSRApp({ render: () => h(ReadableData, { value }) }));
    expect(html).toContain('对象类型：链路'); expect(html).toContain('等级：严重');
    expect(html).toMatch(/<summary[^>]*>原始依据<\/summary>/); expect(html).toContain('link_id');
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;'); expect(html).not.toContain('<script>unsafe');
    expect(JSON.stringify(value)).toBe(original);
  });
});
