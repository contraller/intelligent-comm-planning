import type { PlanningIssue } from '../types/planning';

// 仅翻译展示名称和定位已有字段，不补充业务校验或推断缺失数据。
const labels: Record<string, string> = {
  name: '任务名称',
  description: '任务说明',
  bbox: '任务区域',
  stationIds: '参与节点',
  presetId: '参数预设及频率资源',
  frequencyId: '频率资源组',
  constraints: '规划目标',
  startTime: '开始时间',
  durationH: '持续时长',
  demands: '通联需求',
  id: '需求编号',
  sourceId: '通联节点端点',
  targetId: '终点节点',
  sourceDeviceId: '通联设备端点',
  targetDeviceId: '终点设备',
  endpointMode: '端点类型',
  service: '业务、优先级及必要通联',
  priority: '优先级',
  mandatory: '必要通联',
  requiredRateKbps: '速率',
  maxDelayMs: '最大时延',
  minReliability: '最低可靠性',
  dataVolumeMb: '数据量',
  preferredClass: '优先类别',
  routeStrategy: '路由策略',
  needBackup: '请求备份路由',
  deploymentConstraints: '部署约束',
  maxSlopeDeg: '最大坡度',
  roadMaxDistanceM: '距道路最大距离',
  minSiteSpacingM: '最小站点间距',
  gridStepM: '网格步长',
  elevationRangeM: '海拔范围',
  allowedLandcover: '允许地物',
  losRequiredNodeIds: '通视节点',
  forcedInclude: '强制部署点',
  forcedExcludePolygons: '禁部署区',
  frequencyConstraints: '频率条件',
  rangeKhz: '频率范围',
  excludeFreqIds: '排除频点',
  deploymentSolve: '部署求解条件',
  mode: '求解模式',
  fixedCount: '新增部署单元数',
  solutionCount: '期望备选数量',
  currentWorkMode: '当前工作模式',
  ports: '端口配置',
  devices: '设备集合',
  interferences: '干扰配置',
  'auxiliary.demand': '未应用的通联需求',
  'auxiliary.deployment': '部署约束',
  'auxiliary.options': '频率与求解条件',
};
export function planningFieldLabel(field: string): string {
  return (
    labels[field] ??
    field
      .split('.')
      .map((part) => labels[part] ?? part)
      .join(' / ')
  );
}
export function planningIssueText(issue: PlanningIssue): string {
  return `${issue.objectId ? issue.objectId + ' / ' : ''}${planningFieldLabel(issue.field)}：${issue.message}`;
}
export function fieldIssues(issues: PlanningIssue[], field: string): PlanningIssue[] {
  return issues.filter((issue) => issue.field === field || issue.field.startsWith(field + '.'));
}
export function fieldIssueMessage(issues: PlanningIssue[], field: string): string {
  return fieldIssues(issues, field)
    .map((issue) => issue.message)
    .join('；');
}
// 按已有标记展开、滚动和聚焦；集合错误只定位整组，不猜测具体坐标。
export function focusPlanningField(root: HTMLElement | null, field: string): boolean {
  if (!root) return false;
  const candidates = [
    root,
    ...Array.from(root.querySelectorAll<HTMLElement>('[data-validation-field]')),
  ];
  // 只映射校验器明确给出的结构问题；未知子字段不能借用同名前缀聚焦。
  const targetField = field === 'deploymentConstraints.shape' ? 'deploymentConstraints' : field;
  const target = candidates.find((el) => el.getAttribute('data-validation-field') === targetField);
  if (!target) return false;
  for (let parent: HTMLElement | null = target; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
  return true;
}
