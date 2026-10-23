import { describe, expect, it } from 'vitest';
import { diagnosisBranchSummary, diagnosisFaultTypes, diagnosisFaultVisual, diagnosisRootDisplay } from '../src/services/diagnosis-display';
import { diagnosisPresets, diagnosisSymptoms } from '../src/mocks/diagnosis-presets';

// 直接使用已有教学结果，验证显示映射不修改诊断结论。
const conclusion = () => structuredClone(diagnosisPresets[0].result.conclusions[0]);
describe('诊断展示模型', () => {
  it('四类场景具有独立图形和配色，未知类型不猜测', () => {
    expect(diagnosisFaultTypes.map(row => row.type)).toEqual(['HW_FAILURE','LINK_DOWN','SW_CONFIG','EMI']);
    expect(new Set(diagnosisFaultTypes.map(row => row.glyph)).size).toBe(4);
    expect(new Set(diagnosisFaultTypes.map(row => row.color)).size).toBe(4);
    expect(diagnosisFaultVisual('not-known').label).toBe('未知类型');
    expect(diagnosisFaultVisual('硬件故障').label).toBe('未知类型');
  });
  it('现象保留 ID 和字典名称，原因和部件直接取字段，原始链条保持次序', () => {
    const c = conclusion(); c.chain = ['任意历史首段', '自由描述'];
    const before = JSON.stringify(c), row = diagnosisRootDisplay(c, diagnosisSymptoms);
    expect(row.symptoms).toEqual([{id:'SY-0001',label:'发射时驻波比告警'},{id:'SY-0003',label:'设备自检报功放故障码'}]);
    expect(row.cause).toBe(c.rootCause); expect(row.component).toBe(c.component);
    expect(row.chain).toEqual(c.chain); row.chain.push('显示副本'); expect(JSON.stringify(c)).toBe(before);
  });
  it('未知现象和空字典保留编号，不向其他数据源推断名称', () => {
    const c = conclusion(); c.fault!.symptomIds = ['SY-UNKNOWN'];
    expect(diagnosisRootDisplay(c, diagnosisSymptoms).symptoms).toEqual([{id:'SY-UNKNOWN',label:'名称未提供'}]);
    expect(diagnosisRootDisplay(conclusion(), []).symptoms.every(row => row.label === '名称未提供')).toBe(true);
  });
  it('历史缺结构化输入/部件时不把旧链条拆成字段', () => {
    const c = conclusion(); c.fault = null; c.component = null; c.rootCause = ''; c.chain = ['现象名称','似乎是原因','不能推断为部件'];
    expect(diagnosisRootDisplay(c, diagnosisSymptoms)).toEqual({symptoms:[],cause:'未提供',component:'未提供',chain:c.chain});
  });
  it('按来源排列三路而非数组位置，保留零权重及缺失贡献', () => {
    const c = conclusion(); c.branches.reverse(); const before = JSON.stringify(c), rows = diagnosisBranchSummary(c);
    expect(rows.map(row => row.source)).toEqual(['RULE','KG','ML']);
    expect(rows[0]).toMatchObject({confidence:'90.0%',weight:'0.5',contribution:'未提供'});
    expect(rows[2]).toMatchObject({confidence:'未提供',weight:'0',reason:'本批没有机器学习分支结果'});
    expect(JSON.stringify(c)).toBe(before);
  });
  it('仅展示独立置信度/权重/贡献，不凑和、不补机器学习结果', () => {
    const c = conclusion(); c.branches[0].weight = 0.17; c.branches[0].contribution = 0; c.confidence = 0.52;
    const rows = diagnosisBranchSummary(c);
    expect(rows[0]).toMatchObject({weight:'0.17',contribution:'0',confidence:'90.0%'});
    expect(rows[2].confidence).toBe('未提供'); expect(c.confidence).toBe(0.52);
  });
  it('缺少或重复分路时给出说明，保留原详细依据', () => {
    const c = conclusion(); c.branches = [c.branches[0],structuredClone(c.branches[0])];
    const before = JSON.stringify(c), rows = diagnosisBranchSummary(c);
    expect(rows[0]).toMatchObject({confidence:'未提供',reason:'分路资料重复，请查看详细依据'});
    expect(rows[1].reason).toBe('分路资料未提供'); expect(rows[2].weight).toBe('未提供');
    expect(JSON.stringify(c)).toBe(before);
  });
});
