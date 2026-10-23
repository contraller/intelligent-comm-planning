export interface FrequencyResourceItem {
  freqId: string;
  deviceClass: 'HF' | 'VUHF';
  centerFreqKhz: number;
  bandwidthKhz: number | null;
  channelNo: number | null;
  isAvailable: boolean;
  occupiedBy: string | null;
  reuseMinDistanceM: number | null;
  adjacentGuardKhz: number | null;
  note: string | null;
}

export interface FrequencyResourceQuery {
  context: 'ledger';
  revision: string;
}

export interface FrequencyDisableValidationInput extends FrequencyResourceQuery {
  ids: string[];
}

export interface FrequencyDisableInput {
  context: 'ledger';
  baseRevision: string;
  requestId: string;
  ids: string[];
}

export interface FrequencyResourceSnapshot {
  revision: string;
  baseRevision: string;
  contentHash: string;
  dataOrigin: 'SYNTHETIC_INTEGRATION';
  source: string;
  items: FrequencyResourceItem[];
}

export interface FrequencyDisableValidation extends FrequencyResourceSnapshot {
  selectedIds: string[];
  wouldDisable: string[];
  unchanged: string[];
  impact: {
    resourceRevisionWillChange: boolean;
    historicalResourcesPreserved: true;
    savedPlansRequireRecompute: boolean;
    linkImpact: 'UNKNOWN';
  };
}

export interface FrequencyDisableReceipt {
  objectId: 'resource-frequency-disable';
  requestId: string;
  baseRevision: string;
  revision: string;
  readRevision: string;
  changed: boolean;
  selectedIds: string[];
  affectedIds: string[];
  updated: string[];
  unchanged: string[];
  items: FrequencyResourceItem[];
  dataOrigin: 'SYNTHETIC_INTEGRATION';
  source: string;
  warnings: [];
}

export interface FrequencyPageQuery extends FrequencyResourceQuery {
  page: number;
  pageSize: 5 | 10 | 20 | 50;
  search?: string;
  deviceClass?: 'HF' | 'VUHF';
  availability?: 'AVAILABLE' | 'DISABLED';
  minKhz?: number;
  maxKhz?: number;
}
export interface FrequencyResourcePage extends FrequencyResourceSnapshot {
  page: number;
  pageSize: number;
  total: number;
}
export interface FrequencyHistoryQuery {
  context: 'ledger';
  page: number;
  pageSize: 5 | 10 | 20 | 50;
  search?: string;
}
export interface FrequencyOperationQuery { context: 'ledger'; requestId: string }
export interface FrequencyOperation {
  operation: 'FREQUENCY_DISABLE';
  requestId: string;
  createdAt: string;
  receipt: FrequencyDisableReceipt;
}
export interface FrequencyOperationSummary {
  operation: 'FREQUENCY_DISABLE';
  requestId: string;
  createdAt: string;
  baseRevision: string;
  revision: string;
  changed: boolean;
  selectedCount: number;
  updatedCount: number;
  unchangedCount: number;
}
export interface FrequencyOperationPage {
  page: number;
  pageSize: number;
  total: number;
  items: FrequencyOperationSummary[];
}
export interface FrequencyResourceServices {
  loadFrequencyResources(input: FrequencyResourceQuery, signal?: AbortSignal): Promise<FrequencyResourceSnapshot>;
  queryFrequencyResources(input: FrequencyPageQuery, signal?: AbortSignal): Promise<FrequencyResourcePage>;
  validateFrequencyDisable(input: FrequencyDisableValidationInput, signal?: AbortSignal): Promise<FrequencyDisableValidation>;
  disableFrequencyResources(input: FrequencyDisableInput, signal?: AbortSignal): Promise<FrequencyDisableReceipt>;
  queryFrequencyOperations(input: FrequencyHistoryQuery, signal?: AbortSignal): Promise<FrequencyOperationPage>;
  getFrequencyOperation(input: FrequencyOperationQuery, signal?: AbortSignal): Promise<FrequencyOperation>;
}
export interface FrequencyResourceHostContext {
  accountId: string;
  generation: number;
  readable: boolean;
  canDisable: boolean;
  canMaintain: boolean;
}
export interface FrequencyResourceChange {
  previousRevision: string;
  revision: string;
  readRevision: string;
  requestId: string;
  changed: boolean;
}
