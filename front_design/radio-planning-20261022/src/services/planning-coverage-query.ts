import type { ApiPlan, ApiPlanningJob, ApiPlanningResult } from '../types/planning-api';
import type { FrozenCoverageQuery } from '../types/frozen-coverage';

export interface PlanningCoverageSource {
  selectedPlan: ApiPlan | null;
  adjustmentParent: ApiPlan | null;
  adjustmentResult: ApiPlanningResult | null;
  job: ApiPlanningJob | null;
  inAdjustment: boolean;
  previewSide: 'before' | 'after';
  dirty: boolean;
  running: boolean;
  pending: boolean;
  candidateOrigins?: readonly FrozenCoverageQuery[];
}
const savedQuery = (plan: ApiPlan | null, origins: readonly FrozenCoverageQuery[] = []): FrozenCoverageQuery | null => {
  if (!plan?.resourceRevision) return null;
  const origin = plan.jobId ? origins.find(query => query.planId === `PREVIEW-${plan.jobId}` && query.taskId === plan.taskId && query.snapshotId === plan.result.snapshotId && query.resourceRevision === plan.resourceRevision) : null;
  return origin ? {...origin,context:'planning'} : { planId: plan.id, taskId: plan.taskId, snapshotId: plan.result.snapshotId, resourceRevision: plan.resourceRevision, context: 'planning' };
};

// A draft only receives coverage from its exact successful job snapshot. A stale
// or pending candidate never falls back to the baseline's previous coverage.
export function resolvePlanningCoverageQuery(source: PlanningCoverageSource): FrozenCoverageQuery | null {
  if (!source.inAdjustment || !source.adjustmentParent) return savedQuery(source.selectedPlan,source.candidateOrigins);
  const parent = source.adjustmentParent;
  if (source.previewSide === 'before') return savedQuery(parent,source.candidateOrigins);
  if (source.dirty || source.running || source.pending) return null;
  const job = source.job, result = source.adjustmentResult;
  if (result && job?.state === 'SUCCESS' && job.taskId === parent.taskId && job.parentPlanId === parent.id
    && job.result?.snapshotId === result.snapshotId && job.resourceRevision) {
    return { planId: `PREVIEW-${job.id}`, taskId: job.taskId, snapshotId: result.snapshotId,
      resourceRevision: job.resourceRevision, context: 'planning' };
  }
  if (result || job?.parentPlanId === parent.id && job.adjustment) return null;
  return savedQuery(parent,source.candidateOrigins);
}
