import type { PlanningInput, PlanningIssue } from '../types/planning';
import type { PlanningDeploymentSolve, PlanningFrequencyConstraints, PlanningFrequencyResource } from '../types/planning-options';

export const planningOptionKeys = ['frequencyConstraints', 'deploymentSolve'] as const;
// 与服务端实际频点搜索的完整校验预算一致，不使用整数存储上限代替业务上限。
export const MAX_PLANNING_SOLUTIONS = 40;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120 && !/[\s;\u0000-\u001f\u007f]/.test(v);
const shape = (v: Record<string, unknown>, keys: string[]) => keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k));
export function planningOptionIssues(input: { frequencyConstraints?: unknown; deploymentSolve?: unknown }, executionLimits = true): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  const add = (field: string, message: string) => issues.push({ objectId: 'TASK', field, message });
  const frequency = input.frequencyConstraints;
  if (frequency != null) {
    if (!record(frequency) || !shape(frequency, ['filters']) || !Array.isArray(frequency.filters) || !frequency.filters.length || frequency.filters.length > 2)
      add('frequencyConstraints', '频率条件至少设置一个类别，每类最多一项');
    else {
      const seen = new Set<string>();
      for (const filter of frequency.filters) {
        if (!record(filter) || !shape(filter, ['deviceClass', 'rangeKhz', 'excludeFreqIds']) || !['HF', 'VUHF'].includes(String(filter.deviceClass)) || seen.has(String(filter.deviceClass))) {
          add('frequencyConstraints', '频率类别无效、重复或字段缺失'); continue;
        }
        seen.add(String(filter.deviceClass));
        const prefix = 'frequencyConstraints.' + filter.deviceClass;
        const range = filter.rangeKhz, excluded = filter.excludeFreqIds;
        if (range !== null && (!Array.isArray(range) || range.length !== 2 || !range.every(v => finite(v) && v > 0) || range[0] > range[1]))
          add(prefix + '.rangeKhz', '频率上下界需成组填写正数，且下界不大于上界 / kHz');
        if (!Array.isArray(excluded) || !excluded.every(id) || new Set(excluded).size !== excluded.length)
          add(prefix + '.excludeFreqIds', '排除频点编号不可为空、重复或含空白/分号');
        else if (range === null && !excluded.length) add(prefix, '请填写范围或排除频点，或关闭此类别条件');
      }
    }
  }
  const solve = input.deploymentSolve;
  if (solve != null) {
    if (!record(solve) || !shape(solve, ['mode', 'fixedCount', 'solutionCount']) || !['MIN_COUNT', 'FIXED_COUNT'].includes(String(solve.mode)))
      add('deploymentSolve', '部署求解参数字段或模式无效');
    else {
      if (solve.mode === 'MIN_COUNT' ? solve.fixedCount !== null : !Number.isSafeInteger(solve.fixedCount) || Number(solve.fixedCount) < 0)
        add('deploymentSolve.fixedCount', '最少部署模式数量应留空；指定数量须为非负整数，0表示不新增');
      if (!Number.isSafeInteger(solve.solutionCount) || Number(solve.solutionCount) < 1)
        add('deploymentSolve.solutionCount', '期望备选数量须为正整数，实际数量由服务返回');
      else if (executionLimits && Number(solve.solutionCount) > MAX_PLANNING_SOLUTIONS)
        add('deploymentSolve.solutionCount', `期望备选数量最多${MAX_PLANNING_SOLUTIONS}份，实际数量由可行方案和搜索预算决定`);
    }
  }
  return issues;
}
export function readPlanningOption<K extends typeof planningOptionKeys[number]>(key: K, value: unknown): PlanningInput[K] {
  if (value === undefined || planningOptionIssues({ [key]: value }, false).length) throw new Error('规划条件格式无效：' + key);
  return structuredClone(value) as PlanningInput[K];
}
// 集合只在比较副本排序；始终输出扩展键，旧预设不能忽略新增条件。
export function planningOptionsSignature(input: Pick<PlanningInput, typeof planningOptionKeys[number]>) {
  return { frequencyConstraints: input.frequencyConstraints == null ? null : { filters: input.frequencyConstraints.filters
    .map(f => ({ ...f, excludeFreqIds: [...f.excludeFreqIds].sort() })).sort((a, b) => a.deviceClass.localeCompare(b.deviceClass)) },
    deploymentSolve: input.deploymentSolve ?? null };
}
export function readFrequencyResources(value: unknown, snake = false): PlanningFrequencyResource[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error('频点目录须为列表或未提供');
  const names = ['freqId', 'deviceClass', 'centerFreqKhz', 'bandwidthKhz', 'channelNo', 'isAvailable', 'occupiedBy', 'reuseMinDistanceM', 'adjacentGuardKhz', 'note'] as const;
  const wire = ['freq_id', 'device_class', 'center_freq_khz', 'bandwidth_khz', 'channel_no', 'is_available', 'occupied_by', 'reuse_min_distance_m', 'adjacent_guard_khz', 'note'];
  const rows = value.map(raw => {
    if (!record(raw)) throw new Error('频点记录无效');
    const row = Object.fromEntries(names.map((k, i) => [k, raw[snake ? wire[i] : k]]));
    if (!id(row.freqId) || !['HF', 'VUHF'].includes(String(row.deviceClass))) throw new Error('频点身份或类别无效');
    for (const key of ['centerFreqKhz', 'bandwidthKhz', 'channelNo', 'reuseMinDistanceM', 'adjacentGuardKhz']) {
      const v = row[key];
      if (v !== null && (!finite(v) || v < 0 || ['centerFreqKhz', 'bandwidthKhz'].includes(key) && v === 0 || key === 'channelNo' && !Number.isSafeInteger(v))) throw new Error('频点数值无效：' + key);
    }
    if (row.isAvailable !== null && typeof row.isAvailable !== 'boolean') throw new Error('频点可用标记无效');
    for (const key of ['occupiedBy', 'note']) if (row[key] !== null && typeof row[key] !== 'string') throw new Error('频点说明无效');
    return row as unknown as PlanningFrequencyResource;
  });
  if (new Set(rows.map(r => r.freqId)).size !== rows.length) throw new Error('频点身份重复');
  return rows;
}
export const planningOptionHeaders = ['hf_min_khz', 'hf_max_khz', 'hf_exclude_freq_ids', 'vuhf_min_khz', 'vuhf_max_khz', 'vuhf_exclude_freq_ids', 'deployment_solve_json'];
export function planningOptionFileValues(input: Pick<PlanningInput, typeof planningOptionKeys[number]>): unknown[] {
  return [...(['HF', 'VUHF'] as const).flatMap(kind => { const f = input.frequencyConstraints?.filters.find(f => f.deviceClass === kind);
    return [f?.rangeKhz?.[0] ?? '', f?.rangeKhz?.[1] ?? '', f?.excludeFreqIds.join(';') ?? '']; }),
    input.deploymentSolve == null ? '' : JSON.stringify(input.deploymentSolve)];
}
export function readPlanningOptionsFile(row: Record<string, string>, add: (field: string, message: string) => void): Pick<PlanningInput, typeof planningOptionKeys[number]> {
  const output: Pick<PlanningInput, typeof planningOptionKeys[number]> = {};
  const filters: PlanningFrequencyConstraints['filters'] = [];
  const numeric = (s: string) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s) ? Number(s) : NaN;
  for (const deviceClass of ['HF', 'VUHF'] as const) {
    const prefix = deviceClass.toLowerCase(), min = row[prefix + '_min_khz']?.trim() ?? '', max = row[prefix + '_max_khz']?.trim() ?? '', excludes = row[prefix + '_exclude_freq_ids']?.trim() ?? '';
    if (min || max || excludes) filters.push({ deviceClass, rangeKhz: min || max ? [numeric(min), numeric(max)] : null, excludeFreqIds: excludes ? excludes.split(';').map(s => s.trim()) : [] });
  }
  if (filters.length) output.frequencyConstraints = { filters };
  if (row.deployment_solve_json?.trim()) {
    try { output.deploymentSolve = JSON.parse(row.deployment_solve_json) as PlanningDeploymentSolve; }
    catch { add('deploymentSolve', '部署求解JSON格式无效'); }
  }
  for (const issue of planningOptionIssues(output)) add(issue.field, issue.message);
  return output;
}
export function planningOptionsSummary(input: Pick<PlanningInput, typeof planningOptionKeys[number]>) {
  const solve = input.deploymentSolve;
  return { frequencies: input.frequencyConstraints?.filters.map(f => ({ ...f, range: f.rangeKhz ? f.rangeKhz.map(v => Number.isFinite(v) ? String(v) : '未完成').join('–') + ' kHz' : '未指定范围' })) ?? null,
    solve: solve ? `${solve.mode === 'MIN_COUNT' ? '尽量少新增部署' : '指定新增部署 ' + (Number.isFinite(solve.fixedCount) ? solve.fixedCount : '未完成') + ' 个单元'}；期望 ${Number.isFinite(solve.solutionCount) ? solve.solutionCount : '未完成'} 份备选` : '未设置部署求解条件' };
}
