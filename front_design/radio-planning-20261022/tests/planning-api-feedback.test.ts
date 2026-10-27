import { describe, expect, it } from 'vitest';
import { planningFeedbackDisplay, type PlanningApiFeedbackState } from '../src/services/planning-api-feedback';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import PlanningApiFeedback from '../src/components/PlanningApiFeedback.vue';
import PlanningApiProgressPanel from '../src/components/PlanningApiProgressPanel.vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { apiJob } from './fixtures/planning-api';
const display = (data: unknown, code = 3001) => planningFeedbackDisplay({ operation: 'submit', taskId: 'T1', requestToken: 1, message: '业务拒绝', code, requestId: 'server-response', data });

describe('规划失败载荷展示', () => {
  it('停止中的失败作业保留超时结论，不显示完成百分比或再次取消入口', async () => {
    const pinia = createPinia(); setActivePinia(pinia);
    try {
      const planning = usePlanningApiStore();
      planning.job = { ...apiJob(), state: 'FAILED', result: null, outcome: null, stopping: true, progress: 100, error: '计算超时，超时不代表已证明无解' };
      const html = await renderToString(createSSRApp({ render: () => h(PlanningApiProgressPanel, { compact: true }) }).use(pinia));
      expect(html).toContain('正在停止后台计算'); expect(html).toContain('超时不代表已证明无解');
      expect(html).not.toContain('100%'); expect(html).not.toContain('取消规划');
    } finally { disposePinia(pinia); }
  });
  // 本次故障来自顶层数组，不能只证明 gap 分支可展示。
  it('反馈详情默认收起，保留未知字段且不修改载荷', async () => {
    const data=[{objectId:'TASK',field:'demands',message:'通联需求与所选输入不匹配'},{objectId:'TASK',field:'futureField',message:'待核对'}];
    const before=JSON.stringify(data),feedback:PlanningApiFeedbackState={operation:'submit',taskId:'T1',requestToken:1,message:'当前输入暂无预生成结果；输入已保留',code:'NO_PRESET',data};
    expect(planningFeedbackDisplay(feedback).issues).toEqual(data);
    const html=await renderToString(createSSRApp({render:()=>h(PlanningApiFeedback,{feedback})}));
    const start=html.indexOf('<details'),summary=html.slice(0,start),details=html.slice(start,html.indexOf('</details>')+10);
    expect(summary).toContain('提交规划失败');expect(summary).toContain(feedback.message);
    for(const text of ['TASK /','futureField','业务码','原始接口详情'])expect(summary).not.toContain(text);
    for(const text of ['通联需求','通联需求与所选输入不匹配','futureField','待核对','NO_PRESET','原始接口详情'])expect(details).toContain(text);
    expect(details.slice(0,details.indexOf('>'))).not.toContain('open');
    expect(JSON.stringify(data)).toBe(before);
  });
  it('紧凑反馈收起技术编号但保留异常、零缺口及核实入口', async () => {
    const feedback: PlanningApiFeedbackState={operation:'submit',taskId:'T1',requestToken:1,message:'频率资源不足',code:3002,requestId:'request-1',data:{gap:{required_channels:353,available_channels:48,shortage:0},suggestions:['调整需求']}};
    const html=await renderToString(createSSRApp({render:()=>h(PlanningApiFeedback,{feedback,pending:true})}));
    expect(html).toContain('频率资源不足');expect(html).toContain('调整需求');expect(html).toContain('核实原请求');expect(html).toContain('0');
    const technical=html.slice(html.indexOf('<details'),html.indexOf('</details>')+10);expect(technical).toContain('request-1');expect(technical.slice(0,technical.indexOf('>'))).not.toContain('open');
    const summary=html.slice(0,html.indexOf('<details'));
    for(const text of ['频率资源不足','调整需求','缺口数量：0'])expect(summary).toContain(text);
    expect(html.indexOf('核实原请求')).toBeGreaterThan(html.indexOf('</details>'));
  });
  it('完成阶段收起后，过期、来源变化、业务结论与待核实操作仍在外层', async () => {
    const pinia=createPinia();setActivePinia(pinia);
    try {
      const planning=usePlanningApiStore();planning.job={...apiJob(),state:'SUCCESS',expired:true,sourceChanged:true,outcome:{...apiJob().outcome!,code:3002,message:'频率不足',gap:[],suggestions:['调整频率需求']}};
      planning.pending={kind:'submit',taskId:'T1',requestId:'pending-1'};
      const html=await renderToString(createSSRApp({render:()=>h(PlanningApiProgressPanel,{compact:true})}).use(pinia));
      const stagesEnd=html.indexOf('</details>');expect(stagesEnd).toBeGreaterThan(0);
      for(const label of ['未保存结果已过期','来源已变化','频率不足','调整频率需求','核实原请求'])expect(html.indexOf(label)).toBeGreaterThan(stagesEnd);
      const stages=html.slice(html.indexOf('<details'),html.indexOf('>',html.indexOf('<details')));expect(stages).not.toContain('open');
    } finally {disposePinia(pinia);}
  });
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
