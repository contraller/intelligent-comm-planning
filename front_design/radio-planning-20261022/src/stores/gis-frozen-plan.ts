import { ref, shallowRef } from 'vue';
import type { GisLinkDetail, GisNetwork, GisPaths, GisPlanServices, GisPlanSurface } from '../types/gis-plan';
import type { PlanningPlanSummary, SavedPlanningPlansQuery } from '../types/planning-api';
import type { ApiPage } from '../types/task-api';

export interface GisFrozenPlanServices {
  plans: GisPlanServices;
  queryPlans(input: SavedPlanningPlansQuery): Promise<ApiPage<PlanningPlanSummary>>;
  getPlan?(input: { context: 'gis'; taskId: string; planId: string; signal?: AbortSignal }): Promise<Pick<PlanningPlanSummary, 'id' | 'taskId' | 'version'>>;
}

// 目录、网络与详情分别取消；切换方案后绝不保留上一方案的点线或实测结论。
export function createGisFrozenPlanWorkspace(services: GisFrozenPlanServices) {
  const catalog = shallowRef<ApiPage<PlanningPlanSummary> | null>(null);
  const network = shallowRef<GisNetwork | null>(null), surface = shallowRef<GisPlanSurface | null>(null);
  const detail = shallowRef<GisLinkDetail | null>(null), paths = shallowRef<GisPaths | null>(null);
  const listing = ref(false), opening = ref(false), readingDetail = ref(false);
  const listError = ref(''), error = ref(''), detailError = ref(''), surfaceError = ref('');
  const selectedNodeId = ref(''), selectedLinkId = ref(''), selectedDemandId = ref('');
  const planVersion = ref('');
  let listSerial = 0, networkSerial = 0, detailSerial = 0;
  let listRead: AbortController | undefined, networkRead: AbortController | undefined, detailRead: AbortController | undefined;
  const message = (reason: unknown) => reason instanceof Error ? reason.message : '读取失败，请重试';
  function clearSelection() {
    detailSerial++; detailRead?.abort(); detailRead = undefined;
    selectedNodeId.value = ''; selectedLinkId.value = ''; selectedDemandId.value = '';
    detail.value = null; paths.value = null; detailError.value = ''; readingDetail.value = false;
  }
  function closeNetwork() {
    networkSerial++; networkRead?.abort(); networkRead = undefined;
    opening.value = false; network.value = null; surface.value = null;
    error.value = ''; surfaceError.value = ''; planVersion.value = ''; clearSelection();
  }
  function stop() {
    listSerial++; listRead?.abort(); listRead = undefined; listing.value = false;
    closeNetwork(); catalog.value = null; listError.value = '';
  }
  async function queryPlans(input: Omit<SavedPlanningPlansQuery, 'context' | 'signal'>) {
    listRead?.abort(); const controller = new AbortController(), serial = ++listSerial;
    listRead = controller; listing.value = true; listError.value = '';
    const expected = { ...input, context: 'gis' as const, signal: controller.signal };
    try {
      const result = await services.queryPlans(expected);
      if (serial === listSerial && !controller.signal.aborted) catalog.value = result;
    } catch (reason) {
      if (serial === listSerial && !controller.signal.aborted) listError.value = message(reason);
    } finally { if (serial === listSerial) listing.value = false; }
  }
  async function openPlan(plan: Pick<PlanningPlanSummary, 'id' | 'taskId'> & Partial<Pick<PlanningPlanSummary, 'version'>>) {
    closeNetwork(); const serial = networkSerial, controller = new AbortController();
    networkRead = controller; opening.value = true;
    const query = { planId: plan.id, taskId: plan.taskId };
    const version = plan.version ?? '';
    try {
      const result = await services.plans.getNetwork(query, controller.signal);
      if (serial !== networkSerial || controller.signal.aborted) return;
      network.value = result;
      planVersion.value = version;
      const frozen = { ...query, snapshotId: result.identity.snapshot_id };
      try {
        const ground = await services.plans.getSurface(frozen, result, controller.signal);
        if (serial === networkSerial && !controller.signal.aborted) surface.value = ground;
      } catch (reason) {
        if (serial === networkSerial && !controller.signal.aborted) surfaceError.value = message(reason);
      }
    } catch (reason) {
      if (serial === networkSerial && !controller.signal.aborted) error.value = message(reason);
    } finally { if (serial === networkSerial) opening.value = false; }
  }
  // 深链先读取真实方案版本；不猜测V1，也不依赖目录当前页恰好包含目标。
  async function openIdentity(input: { taskId: string; planId: string }) {
    closeNetwork(); const serial = networkSerial, controller = new AbortController();
    networkRead = controller; opening.value = true;
    const expected = { ...input, context: 'gis' as const, signal: controller.signal };
    try {
      if (!services.getPlan) throw new Error('指定方案读取服务尚未接入');
      const row = await services.getPlan(expected);
      if (serial !== networkSerial || controller.signal.aborted) return false;
      if (row.id !== expected.planId || row.taskId !== expected.taskId || !/^V[1-9][0-9]*$/.test(row.version)) throw new Error('返回方案身份或版本与入口不符');
      await openPlan(row);
      return network.value?.identity.plan_id === expected.planId && network.value?.identity.task_id === expected.taskId;
    } catch (reason) {
      if (serial === networkSerial && !controller.signal.aborted) error.value = message(reason);
      return false;
    } finally { if (serial === networkSerial) opening.value = false; }
  }
  function selectNode(id: string) {
    if (!network.value?.nodes.some(row => row.id === id)) return;
    clearSelection(); selectedNodeId.value = id;
  }
  async function selectDetail(kind: 'link' | 'demand', id: string) {
    const source = network.value;
    if (!source || !(kind === 'link' ? source.links : source.demands).some(row => row.id === id)) return;
    clearSelection(); const serial = detailSerial, owner = networkSerial, controller = new AbortController();
    detailRead = controller; readingDetail.value = true;
    if (kind === 'link') selectedLinkId.value = id; else selectedDemandId.value = id;
    const query = { planId: source.identity.plan_id, taskId: source.identity.task_id, snapshotId: source.identity.snapshot_id };
    try {
      const value = kind === 'link'
        ? await services.plans.getLink({ ...query, linkId: id }, source, controller.signal)
        : await services.plans.getPaths({ ...query, demandId: id }, source, controller.signal);
      if (serial !== detailSerial || owner !== networkSerial || controller.signal.aborted) return;
      if (kind === 'link') detail.value = value as GisLinkDetail; else paths.value = value as GisPaths;
    } catch (reason) {
      if (serial === detailSerial && owner === networkSerial && !controller.signal.aborted) detailError.value = message(reason);
    } finally { if (serial === detailSerial) readingDetail.value = false; }
  }
  return { catalog, network, surface, detail, paths, listing, opening, readingDetail,
    listError, error, detailError, surfaceError, selectedNodeId, selectedLinkId, selectedDemandId, planVersion,
    queryPlans, openPlan, openIdentity, selectNode, selectLink: (id: string) => selectDetail('link', id),
    selectDemand: (id: string) => selectDetail('demand', id), closeNetwork, stop };
}
