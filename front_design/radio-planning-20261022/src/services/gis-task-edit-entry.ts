import type { ApiTask } from '../types/task-api';

interface TaskEditor {
  taskId: string;
  saved: Pick<ApiTask, 'taskId' | 'revision' | 'resourceRevision'> | null;
  save(): Promise<boolean>;
}
// 只接真实任务保存的回读；资源有独立版本/回执，不在此处伪造联合事务。
export async function saveTaskForGis(task: TaskEditor, current: () => boolean) {
  const id = task.taskId;
  if (!id || !current() || !(await task.save()) || !current()) return null;
  const saved = task.saved;
  if (task.taskId !== id || saved?.taskId !== id || !saved.revision || !saved.resourceRevision)
    return null;
  return { taskId: id, revision: saved.revision, resourceRevision: saved.resourceRevision };
}
