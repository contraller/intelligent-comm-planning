// 只解释可识别的展示字段；未知内容保留原文，不补算缺口或业务结论。
export type PlanningFeedbackOperation = 'submit' | 'cancel' | 'savePlan' | 'confirm' | 'job' | 'plans' | 'plan' | 'compare' | 'receipt' | 'receipt-job' | 'receipt-plan' | 'local' | 'route';
export interface PlanningApiFeedbackState {
  operation: PlanningFeedbackOperation;
  taskId: string;
  requestToken: number;
  message: string;
  code?: string | number;
  requestId?: string;
  data?: unknown;
}
const labels: Record<PlanningFeedbackOperation, string> = {
  submit: '提交规划', cancel: '取消规划', savePlan: '保存方案', confirm: '确认方案', job: '查询作业', plans: '查询方案列表', plan: '读取方案', compare: '对比方案',
  receipt: '核实原请求', 'receipt-job': '读取核实后的作业', 'receipt-plan': '读取核实后的方案', local: '操作检查', route: '定位任务或方案',
};
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function rawText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}
export function planningFeedbackDisplay(feedback: PlanningApiFeedbackState) {
  const data = record(feedback.data), gap = record(data?.gap);
  const quantityKeys = ['required_channels', 'available_channels', 'shortage'] as const;
  const quantityLabels = ['所需信道数', '可用信道数', '缺口数量'];
  return {
    operationLabel: labels[feedback.operation], message: feedback.message, code: feedback.code, requestId: feedback.requestId,
    suggestions: Array.isArray(data?.suggestions) ? data.suggestions.filter((value): value is string => typeof value === 'string') : [],
    reason: typeof data?.infeasible_reason === 'string' ? data.infeasible_reason : null,
    quantities: gap && quantityKeys.some(key => Object.hasOwn(gap, key)) ? quantityKeys.map((key, index) => ({ label: quantityLabels[index], value: typeof gap[key] === 'number' && Number.isFinite(gap[key]) ? String(gap[key]) : '未提供' })) : [],
    issues: Array.isArray(data?.gap) ? data.gap.flatMap(value => {
      const issue = record(value); if (!issue || !['objectId', 'field', 'message'].some(key => typeof issue[key] === 'string')) return [];
      return [{ objectId: typeof issue.objectId === 'string' ? issue.objectId : '未提供', field: typeof issue.field === 'string' ? issue.field : '未提供', message: typeof issue.message === 'string' ? issue.message : '未提供' }];
    }) : [],
    errorDetail: data && Object.hasOwn(data, 'error_detail') ? rawText(data.error_detail) : null,
    // 使用是否提供判断，保留 0、false、空字符串及 null。
    rawDetails: feedback.data !== undefined ? rawText(feedback.data) : null,
  };
}
