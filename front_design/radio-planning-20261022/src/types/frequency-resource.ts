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
