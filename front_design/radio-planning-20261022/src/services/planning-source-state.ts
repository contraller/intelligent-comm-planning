import type { PreviewData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import { dependenciesChanged } from './planning-validation';
import { taskSourceChanged } from './task-validation';

// 只更新来源标记，历史输入、结果、诊断均不随资源改动重写。
export function markChangedPlans(data: PreviewData, meta: ResourceMeta) {
  for (const plan of data.planning.plans) {
    if (plan.workflow) {
      plan.sourceChanged = dependenciesChanged(plan.workflow.dependencies, meta)||taskSourceChanged(plan.taskId,plan.workflow.input,meta,plan.workflow.dependencies.task?.conditionVersion);
      continue;
    }
    plan.sourceChanged ||= (meta.interferenceVersion??'initial')!=='initial' ||
      plan.inputSnapshot.stations.some((row) => meta.changedStationIds.includes(row.id)) ||
      plan.inputSnapshot.devices.some((row) => meta.changedDeviceIds.includes(row.id));
  }
}
