import type { PlanningDemand, PlanningInput, PlanningIssue, RouteStrategy } from '../types/planning';

export const routingStrategies: ReadonlyArray<{ value: RouteStrategy; label: string }> = [
  { value: 'SHORTEST_PATH', label: '最短路径' }, { value: 'MIN_DELAY', label: '最小时延' },
  { value: 'MAX_RELIABILITY', label: '最高可靠性' },
];
export const routingKeys = ['routeStrategy', 'needBackup'] as const;
export type RoutingInput = Pick<PlanningDemand, 'routeStrategy' | 'needBackup'>;
export function routingIssues(row: RoutingInput & { id?: string }): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  if (row.routeStrategy != null && !routingStrategies.some(s => s.value === row.routeStrategy))
    issues.push({ objectId: row.id ?? '', field: 'routeStrategy', message: '路由策略须为最短路径、最小时延、最高可靠性或未指定' });
  if (row.needBackup != null && typeof row.needBackup !== 'boolean')
    issues.push({ objectId: row.id ?? '', field: 'needBackup', message: '备份请求须为 true、false 或未指定' });
  return issues;
}
// 只读取显式字段，不给旧输入添加默认值；响应中的非法布尔不得强制转换。
export function readRouting(value: Record<string, unknown>): RoutingInput {
  const result: RoutingInput = {};
  for (const key of routingKeys) if (Object.hasOwn(value, key)) Object.assign(result, { [key]: value[key] });
  if (routingIssues(result).length) throw new Error('路由条件无效');
  return result;
}
// 仅规范化条件比较；原保存对象中的 null、缺省以及 false 均不被改写。
export function routingSignature(row: RoutingInput): RoutingInput {
  return { ...(row.routeStrategy == null ? {} : { routeStrategy: row.routeStrategy }),
    ...(row.needBackup == null ? {} : { needBackup: row.needBackup }) };
}
export const routeStrategyLabel = (value: unknown) => value == null ? '未指定'
  : routingStrategies.find(s => s.value === value)?.label ?? '无效策略（' + String(value) + '）';
export const backupRequestLabel = (value: unknown) => value == null ? '未指定'
  : value === true ? '请求备份' : value === false ? '不请求备份' : '无效备份请求（' + String(value) + '）';
export const routingSummary = (row: RoutingInput) => `路由：${routeStrategyLabel(row.routeStrategy)} · 备份：${backupRequestLabel(row.needBackup)}`;
export const routingHeaders = ['strategy', 'need_backup'];
export const routingFileValues = (row: RoutingInput) => [row.routeStrategy ?? '', row.needBackup == null ? '' : String(row.needBackup)];
export function readRoutingFile(row: Record<string, string>, issue: (field: string, message: string) => void): RoutingInput {
  const result: RoutingInput = {};
  if (row.strategy) {
    if (routingStrategies.some(s => s.value === row.strategy)) result.routeStrategy = row.strategy as RouteStrategy;
    else issue('strategy', '路由策略须为 SHORTEST_PATH、MIN_DELAY 或 MAX_RELIABILITY');
  }
  if (row.need_backup) {
    if (row.need_backup === 'true' || row.need_backup === 'false') result.needBackup = row.need_backup === 'true';
    else issue('need_backup', '备份请求只允许空白、true 或 false');
  }
  return result;
}
// 完整导入清空附加条件需可见；按需求 ID 比较，不把行号当身份。
export function routingClearNotes(before: PlanningInput, after: PlanningInput): string[] {
  return after.demands.flatMap(row => {
    const old = before.demands.find(d => d.id === row.id);
    return old && routingKeys.some(key => old[key] != null && row[key] == null)
      ? [`需求 ${row.id} 的路由条件有未设置项，确认应用后将清空对应原设置；尚未保存。`] : [];
  });
}
