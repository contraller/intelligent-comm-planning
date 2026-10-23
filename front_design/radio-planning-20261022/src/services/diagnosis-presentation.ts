import type { DiagnosisCapabilities, DiagnosisDataOrigin } from '../types/diagnosis';

export const diagnosisDataOrigins: readonly DiagnosisDataOrigin[] = ['SAMPLE', 'BUSINESS', 'UNKNOWN'];
// 缺项不能借当前环境或网络有效性推定为业务数据。
export function diagnosisDataOrigin(value: unknown): DiagnosisDataOrigin {
  return diagnosisDataOrigins.includes(value as DiagnosisDataOrigin) ? value as DiagnosisDataOrigin : 'UNKNOWN';
}
export function diagnosisOriginLabel(value: unknown): string {
  return { SAMPLE: '示例数据', BUSINESS: '业务数据', UNKNOWN: '来源未知' }[diagnosisDataOrigin(value)];
}
export function diagnosisDemoEnabled(capabilities?: DiagnosisCapabilities): boolean {
  return capabilities?.demoControls === true;
}
// 页面只按服务给出的适用网络显示模板，不推测预设身份。
export function diagnosisTemplateAvailable(template: { planIds: readonly string[] }, planId: string): boolean {
  return Array.isArray(template.planIds) && template.planIds.includes(planId);
}
