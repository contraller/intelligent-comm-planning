export interface InterferenceRow {
  interference_id: string;
  name: string;
  lon: string | number;
  lat: string | number;
  center_freq_khz: string | number;
  tx_power_dbm: string | number;
  active: string | boolean;
  [key: string]: unknown;
}

export interface Sr4Snapshot {
  snapshot_id: string;
  task_id: string;
  dataset_revision: string;
  interference_sources: InterferenceRow[];
  task_demands: TaskDemand[];
}

export interface TaskDemand {
  demand_id: string;
  task_id: string;
  src_node_id: string;
  dst_node_id: string;
  priority: string;
  is_mandatory: string | boolean;
  required_rate_kbps: string | number;
  min_reliability: string | number;
  [key: string]: unknown;
}

export interface Sr4Job {
  task_id: string;
  status?: 'PENDING' | 'RUNNING';
  progress?: number;
  stage?: string;
  solution_id?: string;
  summary?: Record<string, unknown>;
  error_detail?: string;
}

export interface Sr4Plan {
  solution_id: string;
  summary: Record<string, unknown>;
  detail: {
    nodes: Array<{ node_id: string; lon: string | number; lat: string | number }>;
    links: Array<{ link_id: string; node_a_id: string; node_b_id: string; device_class: string }>;
    routes: Record<string, unknown>;
    frequency: Record<string, unknown>;
    interference: Record<string, unknown>;
  };
}

interface Envelope<T> { code: number; message: string; data: T }

async function call<T>(path: string, init?: RequestInit, allowed: number[] = []): Promise<Envelope<T>> {
  const response = await fetch('/api/v1' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  const result = await response.json() as Envelope<T>;
  if (!allowed.includes(result.code) && result.code !== 0) throw new Error(result.message);
  return result;
}

export const sr4Live = {
  async catalog() {
    return (await call<{ tasks: Array<{ task_id: string; task_name: string }>; task_demands: TaskDemand[]; interference_sources: InterferenceRow[]; dataset_revision: string; terrain_source_sha256: string }>('/integration/sr4/catalog')).data;
  },
  async snapshot(taskId: string) {
    return (await call<Sr4Snapshot | null>(`/integration/sr4/snapshots/${encodeURIComponent(taskId)}`)).data;
  },
  async save(taskId: string, previous: string | null, rows: InterferenceRow[], demands: TaskDemand[]) {
    return (await call<Sr4Snapshot>(`/integration/sr4/snapshots/${encodeURIComponent(taskId)}`, {
      method: 'PUT', body: JSON.stringify({ expected_snapshot_id: previous, interference_sources: rows, task_demands: demands }),
    })).data;
  },
  async run(taskId: string, snapshotId: string) {
    return (await call<Sr4Job>('/integration/sr4/runs', {
      method: 'POST', body: JSON.stringify({ task_id: taskId, snapshot_id: snapshotId }),
    })).data;
  },
  async job(jobId: string) {
    return await call<Sr4Job>(`/plan/tasks/${encodeURIComponent(jobId)}`, undefined, [2002, 2003]);
  },
  async plan(solutionId: string) {
    return (await call<Sr4Plan>(`/plans/${encodeURIComponent(solutionId)}`)).data;
  },
};
