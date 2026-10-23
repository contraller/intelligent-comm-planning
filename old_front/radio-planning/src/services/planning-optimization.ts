import type { PlanningOptimization, PlanningResultDetailsContext } from '../types/planning-result-details';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const number = (v: unknown, max = Infinity) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
// 仅验证字段和已声明的关联，不根据拓扑寻找关键桥或计算抗毁性。
export function assertPlanningOptimization(value: unknown, context: Pick<PlanningResultDetailsContext, 'links' | 'demandIds'>): asserts value is PlanningOptimization {
  const fail = (): never => { throw new Error('优化明细字段或冻结关联无效'); };
  if (!record(value) || !text(value.sourceLabel)) fail();
  const v = value as Record<string, unknown>;
  if (v.tradeoff !== null) {
    if (!Array.isArray(v.tradeoff)) fail();
    const ids = new Set<string>();
    for (const row of v.tradeoff as unknown[]) {
      if (!record(row) || !text(row.id) || ids.has(row.id) || !number(row.survivabilityPercent, 100) || !number(row.totalRadiatedPowerW)
        || row.meetsConstraints !== null && typeof row.meetsConstraints !== 'boolean' || row.description !== null && typeof row.description !== 'string') fail();
      ids.add((row as Record<string, string>).id);
    }
  }
  if (v.criticalBridges !== null) {
    if (!Array.isArray(v.criticalBridges)) fail();
    const ids = new Set<string>();
    for (const raw of v.criticalBridges as unknown[]) {
      if (!record(raw)) fail();
      const row = raw as Record<string, unknown>;
      if (!text(row.linkId) || ids.has(String(row.linkId)) || !context.links.some(l => l.id === row.linkId)
        || !Array.isArray(row.affectedDemandIds) || !row.affectedDemandIds.every(id => typeof id === 'string' && context.demandIds.includes(id))
        || new Set(row.affectedDemandIds as string[]).size !== (row.affectedDemandIds as string[]).length
        || !number(row.survivabilityAfterFailurePercent, 100) || row.explanation !== null && typeof row.explanation !== 'string') fail();
      ids.add(String(row.linkId));
    }
  }
}
export const optimizationConclusion = (value: boolean | null) => value === true ? '满足全部硬约束' : value === false ? '不满足全部硬约束' : '未提供结论';
export function optimizationChart(value: PlanningOptimization) {
  // 保留服务顺序与原始点位；不插值、不拟合，也不补造空数据。
  return { tooltip: { trigger: 'item', formatter: (p: { data: { value: number[]; name: string } }) => `${p.data.name}<br/>抗毁性 ${p.data.value[0]}% · 总功率 ${p.data.value[1]} W` },
    grid: { left: 65, right: 20, top: 25, bottom: 50 }, xAxis: { type: 'value', name: '抗毁性 / %', min: 0, max: 100 }, yAxis: { type: 'value', name: '总功率 / W' },
    series: [{ type: 'line', smooth: false, connectNulls: false, symbolSize: 9, data: (value.tradeoff ?? []).map(p => ({ id: p.id,
      name: optimizationConclusion(p.meetsConstraints), value: [p.survivabilityPercent, p.totalRadiatedPowerW],
      itemStyle: { color: p.meetsConstraints === true ? '#8ed66b' : p.meetsConstraints === false ? '#e8b677' : '#90a4b8' } })) }] };
}
