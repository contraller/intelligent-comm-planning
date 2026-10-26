import { describe, expect, it } from 'vitest';
import { diagnosisDataOrigin, diagnosisDemoEnabled, diagnosisOriginLabel, diagnosisTemplateAvailable } from '../src/services/diagnosis-presentation';

// 来源与能力分别验证，避免把网络有效、HTTP 或演示开关当作数据真伪。
describe('诊断来源与演示能力', () => {
  it.each([['SAMPLE','示例数据'],['BUSINESS','业务数据'],['UNKNOWN','来源未知'],[undefined,'来源未知'],['http','来源未知']] as const)('来源 %s 显示为 %s', (value,label) => {
    expect(diagnosisOriginLabel(value)).toBe(label);
    expect(diagnosisDataOrigin(value)).toBe(value === 'SAMPLE' || value === 'BUSINESS' ? value : 'UNKNOWN');
  });
  it('演示能力必须明确开启，缺省与关闭均不启用', () => {
    expect(diagnosisDemoEnabled()).toBe(false);expect(diagnosisDemoEnabled({})).toBe(false);
    expect(diagnosisDemoEnabled({demoControls:false})).toBe(false);expect(diagnosisDemoEnabled({demoControls:true})).toBe(true);
  });
  it('模板以服务给定网络关联为准，空列表不回退到旧 Mock 身份', () => {
    expect(diagnosisTemplateAvailable({planIds:['P2']},'P2')).toBe(true);
    expect(diagnosisTemplateAvailable({planIds:[]},'P2')).toBe(false);
    // 不再按旧预设身份推测模板关联。
    expect(diagnosisTemplateAvailable({networkPresetId:'balanced'} as never,'P2')).toBe(false);
    expect(diagnosisTemplateAvailable({} as never,'P2')).toBe(false);
  });
});
