import type { PlanningCheck } from '../types/planning';

export type PlanningComparisonSort = 'original' | 'connectivityPercent' | 'totalRadiatedPowerW' | 'survivabilityPercent' | 'deploymentCost';
export type PlanningComparisonDirection = 'asc' | 'desc';
export interface PlanningComparisonValues {
  connectivityPercent: number | null;
  totalRadiatedPowerW: number | null;
  survivabilityPercent: number | null;
  deploymentCost: number | null;
  costUnit: string | null;
}
export function planningComparisonDefaultDirection(key: PlanningComparisonSort): PlanningComparisonDirection {
  return key === 'connectivityPercent' || key === 'survivabilityPercent' ? 'desc' : 'asc';
}
// 同列按优先方向、反向、恢复原序循环；切换列从该指标的优先方向开始。
export function nextPlanningComparisonSort(current: PlanningComparisonSort, direction: PlanningComparisonDirection, field?: string): { key: PlanningComparisonSort; direction: PlanningComparisonDirection } | null {
  if (!['connectivityPercent', 'totalRadiatedPowerW', 'survivabilityPercent', 'deploymentCost'].includes(field ?? '')) return null;
  const key = field as PlanningComparisonSort, preferred = planningComparisonDefaultDirection(key);
  if (current !== key) return { key, direction: preferred };
  return direction === preferred ? { key, direction: preferred === 'asc' ? 'desc' : 'asc' } : { key: 'original', direction: preferred };
}
const comparisonNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function planningComparisonCostSortIssue(rows: readonly PlanningComparisonValues[]): string {
  // 没有数值的成本保持缺值，不参与单位比较或排序换算。
  const priced = rows.filter(row => comparisonNumber(row.deploymentCost));
  if (!priced.length) return '未提供可比较的部署成本，暂不可按成本排序。';
  const units = priced.map(row => row.costUnit?.trim());
  if (units.some(unit => !unit || unit === '未提供')) return '部署成本单位未提供，暂不可按成本排序。';
  return new Set(units).size > 1 ? '部署成本单位不一致，暂不可按成本排序。' : '';
}
export function sortPlanningComparisonRows<T extends PlanningComparisonValues>(
  rows: readonly T[], key: PlanningComparisonSort, direction: PlanningComparisonDirection,
): T[] {
  if (key === 'original' || (key === 'deploymentCost' && planningComparisonCostSortIssue(rows))) return [...rows];
  // 只排序展示副本；缺值永远置后，同值保留原选择顺序，不改变差值基准。
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = a.row[key], right = b.row[key];
    if (!comparisonNumber(left)) return comparisonNumber(right) ? 1 : a.index - b.index;
    if (!comparisonNumber(right)) return -1;
    return (direction === 'asc' ? left - right : right - left) || a.index - b.index;
  }).map(item => item.row);
}

export interface PlanningMetricCard {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  icon: string;
  state: 'passed' | 'failed' | 'unknown' | 'objective';
  status: string;
  note: string;
}

// 只放宽展示入参以承接 HTTP 空值，不改变冻结结果的业务类型。
type PlanningMetricValues = Readonly<{
  connectivityPercent: number | null;
  totalRadiatedPowerW: number | null;
  survivabilityPercent: number | null;
}>;

export function planningMetricCards(metrics: PlanningMetricValues | undefined, checks: readonly PlanningCheck[] = []): PlanningMetricCard[] {
  const state = (id: PlanningCheck['id']) => {
    const rows = checks.filter(row => row?.id === id);
    const check = rows.length === 1 ? rows[0] : undefined;
    return { state: check?.passed === true ? 'passed' as const : check?.passed === false ? 'failed' as const : 'unknown' as const,
      status: check?.passed === true ? '达标' : check?.passed === false ? '未达标' : '未提供校验结论',
      detail: typeof check?.detail === 'string' ? check.detail : '' };
  };
  const connectivity = state('connectivity'), survivability = state('survivability');
  const value = (key: keyof PlanningMetricValues) => typeof metrics?.[key] === 'number' && Number.isFinite(metrics[key]) ? metrics[key] : null;
  // 等级只取显式结论，不能根据数值反推达标，也不把总功率声明为最优。
  return [
    { id: 'connectivity', label: '网络连通率', value: value('connectivityPercent'), unit: '%', icon: 'pi-globe',
      state: connectivity.state, status: connectivity.status, note: connectivity.detail || '目标 100%' },
    { id: 'power', label: '总辐射功率', value: value('totalRadiatedPowerW'), unit: 'W', icon: 'pi-bolt',
      state: 'objective', status: '最小化目标', note: '直接读取结果，未提供单项达标结论' },
    { id: 'survivability', label: '抗毁性', value: value('survivabilityPercent'), unit: '%', icon: 'pi-shield',
      state: survivability.state, status: survivability.status, note: survivability.detail || '目标 ≥90%' },
  ];
}

