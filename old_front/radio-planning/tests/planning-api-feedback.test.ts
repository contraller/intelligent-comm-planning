import { describe, expect, it } from 'vitest';
import { planningFeedbackDisplay, type PlanningApiFeedbackState } from '../src/services/planning-api-feedback';
const display = (data: unknown, code = 3001) => planningFeedbackDisplay({ operation: 'submit', taskId: 'T1', requestToken: 1, message: '业务拒绝', code, requestId: 'server-response', data });

describe('规划失败载荷展示', () => {
  it('3001 提取文本原因和建议，混合值及额外字段仍保留，输入不被修改', () => {
    const data = { infeasible_reason: '约束不可行', suggestions: ['保留原约束', { detail: '额外建议' }, false, '<script>不执行</script>'], extra: { raw: 0 } };
    const before = JSON.stringify(data), result = display(data);
    expect(result).toMatchObject({ operationLabel: '提交规划', code: 3001, requestId: 'server-response', reason: '约束不可行', suggestions: ['保留原约束', '<script>不执行</script>'] });
    expect(JSON.parse(result.rawDetails!)).toEqual(data); expect(JSON.stringify(data)).toBe(before);
  });
  it('3002 数量缺口原值展示，不相减推导短缺且不补零', () => {
    expect(display({ gap: { required_channels: 353, available_channels: 48, shortage: 0 } }, 3002).quantities.map(x => x.value)).toEqual(['353', '48', '0']);
    expect(display({ gap: { required_channels: 0, shortage: null } }, 3002).quantities.map(x => x.value)).toEqual(['0', '未提供', '未提供']);
    expect(display({ gap: { required_channels: '353', shortage: Number.NaN } }, 3002).quantities.map(x => x.value)).toEqual(['未提供', '未提供', '未提供']);
  });
  it('字段问题数组不与数量缺口混淆，部分字段和未知项仍可追溯', () => {
    const data = { gap: [{ objectId: 'N1', field: 'frequency', message: '暂无分配' }, { message: '缺字段' }, { other: true }, 0] };
    const result = display(data, 3002);
    expect(result.quantities).toEqual([]); expect(result.issues).toEqual([{ objectId: 'N1', field: 'frequency', message: '暂无分配' }, { objectId: '未提供', field: '未提供', message: '缺字段' }]);
    expect(JSON.parse(result.rawDetails!)).toEqual(data);
  });
  it.each(['服务计算失败', { expression: 'x < 1', reason: false }, [0, '详细原因'], '', false, null])('2003 错误详情保留原类型内容 %#', data => {
    const result = display({ error_detail: data }, 2003);
    expect(result.errorDetail).toBe(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  });
  it.each([0, false, '', null, ['未知数组'], { extension: '扩展响应' }])('有效假值及未知载荷不被丢弃 %#', data => {
    const result = display(data);
    expect(result.rawDetails).toBe(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    expect(result.suggestions).toEqual([]); expect(result.quantities).toEqual([]);
  });
  it('本地错误不制造服务码、请求 ID 或详情', () => {
    const local: PlanningApiFeedbackState = { operation: 'local', taskId: 'T1', requestToken: 7, message: '请先保存' };
    expect(planningFeedbackDisplay(local)).toMatchObject({ operationLabel: '操作检查', code: undefined, requestId: undefined, rawDetails: null, errorDetail: null });
  });
});
