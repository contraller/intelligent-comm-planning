import type { AuthenticatedRequest } from '../services/auth-http';
import type { ObservationPage, ObservationRead } from './observation';

export interface SpectrumSourceDraft {
  name: string; protocolHint: 'HTTP_JSON' | 'WEBSOCKET_JSON' | null; endpoint: string | null;
  intervalSeconds: number | null; minKhz: number | null; maxKhz: number | null;
  enabled: boolean; provenanceNote: string;
}
export interface SpectrumSourceVersion {
  schemaVersion: 1; dataOrigin: 'SYNTHETIC_INTEGRATION'; sourceId: string;
  configRevision: string; contentHash: string; draft: SpectrumSourceDraft; createdAt: string; actorId: string;
}
export interface SpectrumOfflineCheck {
  checkId: string; sourceId: string; configRevision: string; checkedAt: string;
  validation: 'VALID' | 'INCOMPLETE'; connection: 'NOT_ATTEMPTED'; validationMode: 'OFFLINE_ONLY';
  issues: { field: string; code: 'MISSING' | 'INVALID'; message: string }[];
}
export interface SpectrumSourceRow extends SpectrumSourceVersion { latestOfflineCheck: SpectrumOfflineCheck | null }
export interface SpectrumSourceReceipt {
  requestId: string; operationType: 'SOURCE_SAVE' | 'SOURCE_CHECK'; sourceId: string; configRevision: string;
  changed: boolean; actorId: string; committedAt: string; source: SpectrumSourceVersion | null; check: SpectrumOfflineCheck | null;
}
export interface SpectrumSourceOperation {
  schemaVersion: 1; dataOrigin: 'SYNTHETIC_INTEGRATION'; requestId: string;
  operationType: SpectrumSourceReceipt['operationType']; status: 'COMMITTED' | 'NOT_FOUND'; receipt: SpectrumSourceReceipt | null;
}
export interface SpectrumSourceSelection extends ObservationRead { sourceId: string; configRevision?: string }
export interface SpectrumSourceQuery extends ObservationRead { page: number; pageSize: number; search?: string; enabled?: boolean }
export interface SpectrumSourceSave extends ObservationRead {
  requestId: string; sourceId: string; baseConfigRevision: string | null; draft: SpectrumSourceDraft;
}
export interface SpectrumSourceHistory extends SpectrumSourceSelection { page: number; pageSize: number }
export interface SpectrumSourceServices {
  querySources(input: SpectrumSourceQuery): Promise<ObservationPage<SpectrumSourceRow>>;
  getSource(input: SpectrumSourceSelection): Promise<SpectrumSourceVersion>;
  saveSource(input: SpectrumSourceSave): Promise<SpectrumSourceReceipt>;
  checkSource(input: SpectrumSourceSelection & { requestId: string; configRevision: string }): Promise<SpectrumSourceReceipt>;
  queryVersions(input: SpectrumSourceHistory): Promise<ObservationPage<SpectrumSourceVersion> & { sourceId: string }>;
  queryChecks(input: SpectrumSourceHistory): Promise<ObservationPage<SpectrumOfflineCheck> & { sourceId: string }>;
  getSourceReceipt(input: ObservationRead & { requestId: string; operationType: SpectrumSourceReceipt['operationType'] }): Promise<SpectrumSourceOperation>;
  exportSource(input: SpectrumSourceSelection & { configRevision: string }): Promise<Blob>;
}
export type SpectrumSourceFactory = (request: AuthenticatedRequest) => SpectrumSourceServices;
