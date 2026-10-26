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
  previewObservationImport(input: ObservationRead & { file: ObservationImportFile }): Promise<ObservationImportPreview>;
  importObservation(input: ObservationImportSubmission): Promise<ObservationImportOperation>;
  getObservationImportReceipt(input: ObservationRead & { requestId: string; includeDeviceStatusRef?: boolean }): Promise<ObservationImportOperation>;
  getObservationDeviceStatusRef(input: ObservationSelection): Promise<ObservationDeviceStatusRefResult>;
  exportObservationDataset(input: ObservationSelection & { includeDeviceStatusRef?: boolean }): Promise<Blob>;
}
export type ImportedObservationFrame = Omit<ObservationFrame, 'datasetId' | 'datasetRevision' | 'dataOrigin'>;
export interface ObservationImportFileV1 {
  schemaVersion: 1; fileKind: 'SPECTRUM_OBSERVATION_DATASET'; dataOrigin: typeof OBSERVATION_ORIGIN;
  dataset: { datasetId: string; provenanceNote: string; resourceRevision: string; deviceStatusSnapshotId: null;
    source: ObservationSource; frames: ImportedObservationFrame[] };
}
export interface ObservationDeviceStatusRefInput {
  snapshotId: string; snapshotRevision: string; resourceRevision: string; deviceIds: string[];
}
export interface ObservationDeviceStatusRefWire extends ObservationDeviceStatusRefInput { refRevision: string; contentHash: string }
export interface ObservationDeviceStatusRefResult {
  schemaVersion: 1; dataOrigin: typeof OBSERVATION_ORIGIN; datasetId: string; datasetRevision: string;
  resourceRevision: string; deviceStatusRef: ObservationDeviceStatusRefWire | null;
}
export interface ObservationImportFileV2 extends Omit<ObservationImportFileV1, 'schemaVersion'> {
  schemaVersion: 2; deviceStatusRef: ObservationDeviceStatusRefInput;
}
export type ObservationImportFile = ObservationImportFileV1 | ObservationImportFileV2;
export type ObservationImportSubmission = ObservationRead & { requestId: string; previewHash: string } & (
  { file: ObservationImportFileV1; datasetContentHash?: never } | { file: ObservationImportFileV2; datasetContentHash: string }
);
export interface ObservationImportPreviewV1 {
  schemaVersion: 1; dataOrigin: typeof OBSERVATION_ORIGIN; previewHash: string; datasetId: string;
  resourceRevision: string; source: ObservationSource; frameCount: number;
  sourceBinding: 'REGISTERED_VERSION' | 'DECLARED_ONLY'; warnings: string[];
}
export interface ObservationImportPreviewV2 extends Omit<ObservationImportPreviewV1, 'schemaVersion'> {
  schemaVersion: 2; datasetContentHash: string; datasetRevision: string; deviceStatusRef: ObservationDeviceStatusRefWire;
}
export type ObservationImportPreview = ObservationImportPreviewV1 | ObservationImportPreviewV2;
export interface ObservationImportReceipt {
  requestId: string; actorId: string; datasetId: string; datasetRevision: string; dataOrigin: typeof OBSERVATION_ORIGIN;
  resourceRevision: string; frameCount: number; changed: boolean; importedAt: string;
}
export interface ObservationImportOperationV1 {
  schemaVersion: 1; dataOrigin: typeof OBSERVATION_ORIGIN; requestId: string;
  operationType: 'OBSERVATION_IMPORT'; status: 'COMMITTED' | 'NOT_FOUND'; receipt: ObservationImportReceipt | null;
}
export interface ObservationImportOperationV2 extends Omit<ObservationImportOperationV1, 'schemaVersion'> {
  schemaVersion: 2; deviceStatusRef: ObservationDeviceStatusRefWire | null;
}
export type ObservationImportOperation = ObservationImportOperationV1 | ObservationImportOperationV2;
