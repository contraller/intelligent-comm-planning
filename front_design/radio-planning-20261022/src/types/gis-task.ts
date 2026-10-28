import type { ApiTask } from './task-api';
import type { ReadNode } from './resource-read';

// 任务态势只读已保存版本，通联需求沿用任务输入，不作为规划结果链路。
export interface GisTaskSnapshotQuery {
  taskId: string;
  revision: string;
  context: 'planning';
}

export interface GisTaskSnapshot {
  task: ApiTask;
  resourceRevision: string;
  taskRevision: string;
  snapshotId: string;
  sourceChanged: boolean;
  nodes: ReadNode[];
  missingNodeIds: string[];
  message: string;
}

export interface GisTaskSituationTarget {
  taskId: string;
  revision: string;
  snapshotId: string | null;
}

export interface GisTaskHttp {
  getSnapshot(query: GisTaskSnapshotQuery, signal?: AbortSignal): Promise<GisTaskSnapshot>;
}
