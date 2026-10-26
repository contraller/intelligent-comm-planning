import type { InterferenceWorkbenchServices } from '../types/interference-workbench';

// 入口只核实当前确认方案及活动任务，不创建场景、不启动或取消分析。
export async function verifyPlanningInterferenceEntry(
  services: Pick<InterferenceWorkbenchServices, 'getContext' | 'getProgress'>,
  input: { taskId: string; planId: string; planVersion: string },
  signal: AbortSignal,
): Promise<boolean> {
  const target = { ...input };
  const context = await services.getContext({ task_id: target.taskId }, signal);
  if (signal.aborted) return false;
  if (context.task_id !== target.taskId) throw new Error('返回干扰任务与指定任务不符');
  const source = context.source_options.find(
    (row) =>
      row.task_id === target.taskId &&
      row.plan_id === target.planId &&
      row.plan_version === target.planVersion,
  );
  if (!source) throw new Error('所选确认方案已不存在或版本已变化，请重新选择');
  if (!source.eligible)
    throw new Error(source.unavailable_reasons.join('；') || '所选方案当前不可分析');
  const runs = await Promise.all(
    context.active_run_ids.map((run_id) =>
      services.getProgress({ task_id: target.taskId, run_id }, signal),
    ),
  );
  if (signal.aborted) return false;
  if (runs.some((row) => row.task_id !== target.taskId))
    throw new Error('返回活动分析的任务身份不符');
  if (
    runs.some(
      (row) =>
        ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(row.state) &&
        (row.plan_id !== target.planId || row.plan_version !== target.planVersion),
    )
  )
    throw new Error('其他方案的干扰分析正在运行，请待其结束后再进入');
  return true;
}
