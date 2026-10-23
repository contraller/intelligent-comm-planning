// 独立观测契约，保留未知值，不伪装为既有实测 DTO。
export const OBSERVATION_ORIGIN = 'SYNTHETIC_INTEGRATION' as const;
export interface ObservationSource {
  sourceId: string; name: string; configRevision: string;
  minKhz: number; maxKhz: number; intervalSeconds: number | null;
}
export interface ObservationBin {
  binId: string; minKhz: number; maxKhz: number;
  occupancyPercent: number | null; powerDbm: number | null;
  abnormal: boolean | null; reason: string | null; unknownReasons: string[];
}
export interface ObservationFrame {
  frameId: string; index: number; observedAt: string | null; label: string;
  bins: ObservationBin[]; occupancyPercent: number | null;
  abnormalBandCount: number | null; unknownReasons: string[];
  datasetId: string; datasetRevision: string; dataOrigin: typeof OBSERVATION_ORIGIN;
}
export interface ObservationDataset {
  datasetId: string; datasetRevision: string; schemaVersion: 1;
  dataOrigin: typeof OBSERVATION_ORIGIN; provenanceNote: string;
  resourceRevision: string; deviceStatusSnapshotId: null; source: ObservationSource;
  frameCount: number; firstObservedAt: string | null; lastObservedAt: string | null;
  importedAt: string; contentHash: string;
}
export interface ObservationRead { signal?: AbortSignal }
export interface ObservationSelection extends ObservationRead { datasetId: string; datasetRevision: string }
export interface ObservationPageQuery extends ObservationRead { page: number; pageSize: number }
export interface ObservationFrameQuery extends ObservationSelection, ObservationPageQuery {}
export interface ObservationIndexQuery extends ObservationSelection { index: number }
export interface ObservationContext {
  schemaVersion: 1; dataOrigin: typeof OBSERVATION_ORIGIN; datasetCount: number;
  selected: ObservationDataset | null; reasons: string[];
  replay: { mode: 'FINITE'; loop: false; maxFramesPerDataset: 256; maxBinsPerFrame: 256 };
}
export interface ObservationPage<T> {
  schemaVersion: 1; dataOrigin: typeof OBSERVATION_ORIGIN;
  items: T[]; page: number; pageSize: number; total: number;
}
export interface ObservationFrameIdentity {
  schemaVersion: 1; dataOrigin: typeof OBSERVATION_ORIGIN;
  datasetId: string; datasetRevision: string; resourceRevision: string;
  sourceId: string; configRevision: string; frameCount: number;
}
export interface ObservationFramePage extends ObservationPage<ObservationFrame>, ObservationFrameIdentity {}
export interface ObservationFrameResult extends ObservationFrameIdentity {
  index: number; hasPrevious: boolean; hasNext: boolean; frame: ObservationFrame;
}
export interface ObservationServices {
  loadObservationContext(input?: ObservationRead & { datasetId?: string; datasetRevision?: string }): Promise<ObservationContext>;
  queryObservationDatasets(input: ObservationPageQuery): Promise<ObservationPage<ObservationDataset>>;
  queryObservationFrames(input: ObservationFrameQuery): Promise<ObservationFramePage>;
  getObservationFrame(input: ObservationIndexQuery): Promise<ObservationFrameResult>;
}
