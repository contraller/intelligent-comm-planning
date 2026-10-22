export type FaultObjectKind = 'NODE' | 'DEVICE' | 'LINK';
export type FaultKind = 'HW_FAILURE' | 'LINK_DOWN' | 'SW_CONFIG' | 'EMI';

export interface FaultSource {
  taskId: string;
  planId: string;
  revision: string;
  resourceRevision: string;
  name: string;
  version: string;
  state: 'CONFIRMED';
}

export interface FaultInputApi {
  object_type: FaultObjectKind;
  object_id: string;
  fault_type: FaultKind;
  symptom_ids: string[];
}

export interface FaultScenarioInput {
  scenario_name: string;
  description: string;
  faults: FaultInputApi[];
}

export interface FaultScenario extends FaultScenarioInput {
  scenarioId: string;
  taskId: string;
  planId: string;
  planRevision: string;
  resourceRevision: string;
  versionId: string;
  versionNo: number;
  archived: boolean;
  savedAt: string;
}

export interface FaultTaskReceipt {
  taskId: string;
  requestId: string;
  replayed: boolean;
}

export interface FaultAnalysis {
  taskId: string;
  planId: string;
  diagnoseTaskId: string;
  impactTaskId: string | null;
  state: 'PENDING' | 'RUNNING' | 'DIAGNOSIS_READY' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  progress: number;
  phases: { name: string; status: string; progress: number }[];
  diagnosisReady: boolean;
  impactReady: boolean;
  reportReady: boolean;
  error: string | null;
  source: { plan_revision: string; resource_revision: string };
  scenario: { scenario_id: string; version_id: string; version_no: number; scenario_name: string; faults: FaultInputApi[] };
  diagnosis: {
    data_source: string;
    fusion_mode: string;
    results: { fault_object: { object_type: string; object_id: string }; fused: { fault_type: string | null; confidence: number; root_cause: string | null; need_manual_review: boolean }; branches: { source: string; confidence: number | null; disabled_reason?: string | null; evidence: unknown }[] }[];
  } | null;
  impact: {
    affected_nodes: { node_id: string; level: string; state: string; reason: string }[];
    affected_links: { link_id: string; level: string; state: string; reason: string }[];
    summary: { affected_node_count: number; affected_link_count: number; total_bandwidth_loss_kbps: number };
  } | null;
  suggestions: { suggestions: { priority: number; action: string; source: string }[] } | null;
  report: { data_source: string; generated_at: string } | null;
}
