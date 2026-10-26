export const deviceTraceSchema = 'device-trace-a1' as const;
export type RestoreField = 'tx_power_dbm' | 'work_freq_khz' | 'antenna_height_m';
export interface TraceSummary {
  request_id: string | null; device_id: string; kind: 'RESOURCE_CHANGE' | 'RETAINED_BASELINE'; base_revision: string | null;
  revision: string; created_at: string; actor_id: string | null; changed: boolean; changed_fields: string[]; data_origin: 'SYNTHETIC_INTEGRATION';
}
export interface TracePage { schema_version: typeof deviceTraceSchema; items: TraceSummary[]; total: number; page: number; page_size: number }
export interface TraceDiff { field: string; before: string | null; after: string | null; known: boolean }
export interface TraceDetail extends TraceSummary {
  schema_version: typeof deviceTraceSchema; before: Record<string, string> | null; after: Record<string, string> | null;
  diffs: TraceDiff[]; source_files: Record<string, { path: string; sha256: string }>;
}
export interface TraceQuery { context: 'ledger'; device_id: string; resource_revision: string; page?: number; page_size?: number }
export interface TraceDetailQuery { context: 'ledger'; device_id: string; resource_revision: string; request_id: string }
export interface RestoreInput {
  schema_version: typeof deviceTraceSchema; context: 'ledger'; base_revision: string; source_revision: string; source_request_id: string | null;
}
export interface RestoreProposal {
  schema_version: typeof deviceTraceSchema; device_id: string; base_revision: string; source_revision: string;
  source_request_id: string | null; model_id: string; compatible: boolean;
  changes: { field: RestoreField; before: number | null; after: number; known: true }[];
  patch: Partial<Record<RestoreField, number>>; blocked_fields: string[]; warnings: string[];
}
