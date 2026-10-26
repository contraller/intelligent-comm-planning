export type SceneJson = null | boolean | number | string | SceneJson[] | { [key: string]: SceneJson };
export type SceneJsonObject = { [key: string]: SceneJson };

export interface InterferenceSceneSave {
  sceneId: string;
  requestId: string;
  taskId: string;
  planId: string;
  planVersion: string;
  resourceRevision: string;
  baseSceneVersionId: string | null;
  name: string;
  note: string;
  interferenceIds: string[];
}

export interface InterferenceSceneSummary {
  sceneId: string;
  taskId: string;
  versionId: string;
  versionNo: number;
  name: string;
  planId: string;
  planVersion: string;
  resourceRevision: string;
  sourceCount: number;
  snapshotHash: string;
  dataOrigin: string;
  savedAt: string;
}

export interface InterferenceSceneVersion extends InterferenceSceneSummary {
  schemaVersion: 1;
  note: string;
  previousVersionId: string | null;
  savedBy: string;
  resourceContentHash: string;
  source: string;
  interferenceIds: string[];
  interferenceSources: { interferenceId: string; sourceRow: Record<string, string> }[];
  planSnapshot: {
    taskId: string;
    planId: string;
    planVersion: string;
    inputVersion: string;
    conditionVersion: string;
    resourceRevision: string;
    source: 'SR4';
    inputSnapshot: SceneJsonObject;
    rawSnapshot: SceneJsonObject;
  };
}

export interface InterferenceSceneReceipt {
  requestId: string;
  operation: 'SAVE_INTERFERENCE_SCENE';
  status: 'SUCCEEDED';
  actorId: string;
  taskId: string;
  sceneId: string;
  baseSceneVersionId: string | null;
  versionId: string;
  versionNo: number;
  planId: string;
  planVersion: string;
  resourceRevision: string;
  snapshotHash: string;
  dataOrigin: string;
  changed: boolean;
  createdAt: string;
}

export interface InterferenceScenePageQuery {
  taskId: string;
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface InterferenceSceneDetailQuery {
  taskId: string;
  sceneId: string;
  versionId?: string;
}

export interface InterferenceScenePage {
  items: InterferenceSceneSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InterferenceSceneDetail {
  version: InterferenceSceneVersion;
  sourceState: { state: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN'; reasons: string[] };
}

export interface InterferenceSceneServices {
  saveScene(input: InterferenceSceneSave): Promise<InterferenceSceneReceipt>;
  listScenes(input: InterferenceScenePageQuery): Promise<InterferenceScenePage>;
  getScene(input: InterferenceSceneDetailQuery): Promise<InterferenceSceneDetail>;
  listSceneVersions(input: Omit<InterferenceScenePageQuery, 'search'> & { sceneId: string }): Promise<InterferenceScenePage>;
  getSceneReceipt(input: { taskId: string; sceneId: string; requestId: string }): Promise<InterferenceSceneReceipt>;
}
