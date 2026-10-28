import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { previewService } from '../services';
import { collaborationHttp } from '../services/http';
import { sameValue } from '../services/planning-validation';
import { useAuthStore } from '../stores/auth';
import { usePlanningStore } from '../stores/planning';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import { ApiError } from '../services/types';
import { env } from '../config/env';
import type { PlanningInput } from '../types/planning';
import type { ApiTask } from '../types/task-api';
import type { ReadNode, ResourceObjectDetail } from '../types/resource-read';
import type { GisTaskSnapshot } from '../types/gis-task';

export interface GisSelectedTask {
  taskId: string;
  revision?: string;
  name: string;
  version: string;
  updatedAt: string;
  input: PlanningInput;
  resourceRevision?: string;
}

// GIS 只读保存版本，不能借选择任务覆盖规划页的编辑草稿。
export function useGisTaskSelection() {
  const auth = useAuthStore(), planning = usePlanningStore(), taskInput = useTaskInputStore(), resources = useResourceReadStore();
  const pageSize = 10;
  // 正式任务由规划页保存；GIS只是另一读取页面，资源查询仍使用GIS上下文。
  const taskContext = () => env.mode === 'http' ? 'planning' as const : 'gis' as const;
  const readable = computed(() => auth.can('situation.view') && auth.can('planning.view'));
  const library = ref<Pick<GisSelectedTask,'taskId'|'name'|'version'|'updatedAt'>[]>([]), selected = ref<GisSelectedTask | null>(null);
  const loading = ref(false), selecting = ref(false), error = ref('');
  const page = ref(1), total = ref(0), search = ref('');
  const nodes = ref<ReadNode[]>([]), referenceMessage = ref('');
  const snapshot = ref<GisTaskSnapshot | null>(null), savedTask = ref<ApiTask | null>(null);
  const referenceNotice = computed(() => {
    const value = snapshot.value;
    if (!value) return referenceMessage.value;
    const historical = value.sourceChanged || (!!resources.workspace && resources.workspace.revision !== value.resourceRevision);
    const missingListed = value.missingNodeIds.every(id => value.message.includes(id));
    return [historical && !value.message.includes('历史冻结') ? `当前显示历史冻结任务态势（资源版本 ${value.resourceRevision}），未使用当前资源坐标。` : '',
      value.message, value.missingNodeIds.length && !missingListed ? `以下任务参与节点在冻结快照中缺失，未补造坐标：${value.missingNodeIds.join('、')}` : ''].filter(Boolean).join(' ');
  });
  let listSerial = 0, selectionSerial = 0, referenceSerial = 0, disposed = false;
  const controllers = new Set<AbortController>();
  const taskControllers = new Set<AbortController>();
  const apiTask = (task: ApiTask): GisSelectedTask => ({ taskId: task.taskId, revision: task.revision, name: task.input.name,
    version: task.inputVersion, updatedAt: task.updatedAt, input: structuredClone(task.input), resourceRevision: task.resourceRevision });
  const validId = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
  const current = (owner: number) => !disposed && readable.value && owner === auth.generation;
  function clearSelection() {
    selectionSerial++; referenceSerial++;
    taskControllers.forEach(controller => { controller.abort(); controllers.delete(controller); }); taskControllers.clear();
    selected.value = null; savedTask.value = null; snapshot.value = null; selecting.value = false;
    nodes.value = []; referenceMessage.value = '';
  }
  function clear() {
    listSerial++; clearSelection(); controllers.forEach(controller => controller.abort()); controllers.clear();
    library.value = []; total.value = 0; loading.value = false;
  }
  async function queryLibrary(nextPage = 1, query = search.value) {
    if (!readable.value || disposed) { clear(); error.value = '没有任务查看权限'; return false; }
    const token = ++listSerial, owner = auth.generation, controller = new AbortController();
    controllers.add(controller); loading.value = true; error.value = ''; search.value = query;
    try {
      // 两种数据源都返回同一分页契约，GIS 不再自行扫描完整任务库。
      const value = await previewService.queryTaskSummaries({ context: taskContext(), pageNum: nextPage, pageSize, search: query || undefined, signal: controller.signal });
      if (!current(owner) || token !== listSerial) return false;
      library.value = value.items.map(row=>({...row,version:row.inputVersion})); total.value = value.total; page.value = value.pageNum; return true;
    } catch (reason) {
      if (current(owner) && token === listSerial) {
        library.value = []; total.value = 0; clearSelection();
        error.value = reason instanceof Error ? reason.message : '任务列表读取失败';
      }
      return false;
    } finally {
      controllers.delete(controller); if (token === listSerial) loading.value = false;
    }
  }
  async function select(taskId: unknown) {
    clearSelection(); error.value = '';
    if (!readable.value || disposed) { error.value = '没有任务查看权限'; return false; }
    if (!validId(taskId)) { error.value = '任务定位参数无效'; return false; }
    const token = selectionSerial, owner = auth.generation, controller = new AbortController();
    controllers.add(controller); taskControllers.add(controller); selecting.value = true;
    try {
      const stored = await previewService.getTaskInput({ context: taskContext(), taskId, signal: controller.signal });
      if (!current(owner) || token !== selectionSerial) return false;
      if (stored.taskId !== taskId || !validId(stored.revision) || !validId(stored.resourceRevision))
        throw new ApiError('任务响应的身份或版本不一致', 'INVALID_GIS_TASK_RESPONSE');
      savedTask.value = structuredClone(stored); selected.value = apiTask(stored);
      const loaded = await loadReferences();
      return loaded && current(owner) && token === selectionSerial && !!selected.value;
    } catch (reason) {
      if (current(owner) && token === selectionSerial) error.value = reason instanceof Error ? reason.message : '任务读取失败';
      return false;
    } finally {
      controllers.delete(controller); taskControllers.delete(controller); if (token === selectionSerial) selecting.value = false;
    }
  }
  async function loadReferences() {
    if (env.mode !== 'http') return loadMockReferences();
    const task = selected.value, stored = savedTask.value, token = selectionSerial, referenceToken = ++referenceSerial, owner = auth.generation;
    if (!task || !stored || !current(owner)) return false;
    const controller = new AbortController();
    controllers.add(controller); taskControllers.add(controller);
    nodes.value = []; snapshot.value = null; referenceMessage.value = ''; error.value = ''; selecting.value = true;
    const valid = () => current(owner) && token === selectionSerial && referenceToken === referenceSerial && selected.value === task;
    try {
      // 先读取的保存身份是唯一来源，快照不依赖当前资源工作区是否可读。
      const value = await collaborationHttp.gisTasks.getSnapshot({ context: 'planning', taskId: task.taskId, revision: stored.revision }, controller.signal);
      if (!valid()) return false;
      if (value.task.taskId !== stored.taskId || value.taskRevision !== stored.revision || value.task.revision !== stored.revision
        || value.resourceRevision !== stored.resourceRevision || value.task.resourceRevision !== stored.resourceRevision
        || value.snapshotId !== `GIS-TASK-${stored.revision}` || value.task.inputVersion !== stored.inputVersion
        || value.task.conditionVersion !== stored.conditionVersion || !sameValue(value.task.input, stored.input))
        throw new ApiError('任务快照与所选保存版本的身份或资源版本不一致', 'INVALID_GIS_TASK_RESPONSE');
      snapshot.value = value; nodes.value = value.nodes;
      return true;
    } catch (reason) {
      if (valid()) {
        if (reason instanceof ApiError && (reason.code === 'FORBIDDEN' || reason.code === 1104 || reason.status === 403)) clearSelection();
        if (reason instanceof ApiError && (reason.code === 2004 || reason.code === 'HISTORICAL_RESOURCE_NOT_FOUND'))
          referenceMessage.value = '历史资源缺失，无法载入该任务冻结态势；不能拼接当前资源坐标。';
        error.value = reason instanceof Error ? reason.message : '任务冻结态势读取失败';
      }
      return false;
    } finally {
      controllers.delete(controller); taskControllers.delete(controller);
      if (token === selectionSerial && referenceToken === referenceSerial) selecting.value = false;
    }
  }
  // Mock 保持原有同版引用读取，不用教学数据模拟历史资源快照。
  async function loadMockReferences() {
    nodes.value = []; referenceMessage.value = '';
    const task = selected.value, token = selectionSerial, owner = auth.generation;
    if (!task || !current(owner)) return false;
    if (!resources.workspace) return true;
    const revision = task.resourceRevision;
    if (!revision || resources.workspace?.revision !== revision) {
      referenceMessage.value = '任务引用资源版本与当前 GIS 资源版本不一致，未拼接不同版本的节点坐标。'; return true;
    }
    const controller = new AbortController(), found: ReadNode[] = [], missing: string[] = [];
    controllers.add(controller); taskControllers.add(controller);
    const valid = () => current(owner) && token === selectionSerial && selected.value === task && resources.workspace?.revision === revision;
    try {
      const ids = [...new Set(task.input.stationIds)];
      // 仅有界并发读取任务明确引用的节点，不扫描分页资源目录。
      for (let index = 0; index < ids.length; index += 8) {
        const batch = ids.slice(index, index + 8);
        const results: PromiseSettledResult<ResourceObjectDetail>[] = await Promise.allSettled(batch.map((id): Promise<ResourceObjectDetail> => previewService.getResourceObject({ context: 'gis', revision, kind: 'node', id, signal: controller.signal })));
        if (!valid()) return false;
        for (let item = 0; item < results.length; item++) {
          const result = results[item]!;
          if (result.status === 'rejected') {
            if (result.reason instanceof ApiError && (result.reason.code === 'FORBIDDEN' || result.reason.status === 403)) {
              clearSelection(); error.value = '没有任务节点查看权限'; return false;
            }
            missing.push(batch[item]!); continue;
          }
          if (result.value.revision !== revision || result.value.object.kind !== 'node' || result.value.object.id !== batch[item]) {
            referenceMessage.value = '任务节点响应的身份或资源版本不一致，未显示节点坐标。'; return false;
          }
          found.push(result.value.object);
        }
      }
      if (!valid()) return false;
      nodes.value = found; referenceMessage.value = missing.length ? `以下任务节点暂不可用：${missing.join('、')}` : ''; return true;
    } finally { controllers.delete(controller); taskControllers.delete(controller); }
  }
  async function initialize(explicitTaskId?: unknown) {
    if (!(await queryLibrary())) return false;
    if (!readable.value || disposed) return false;
    // 显式目标不可用时不回退；没有目标时也不擅自选择任务列表首项。
    const fallback = taskInput.saved?.taskId ?? (env.mode !== 'http' && planning.taskId && planning.savedTask ? planning.taskId : undefined);
    const target = explicitTaskId !== undefined ? explicitTaskId : fallback;
    if (target !== undefined) return select(target);
    clearSelection(); return true;
  }
  watch(() => [auth.generation, readable.value], () => { clear(); error.value = readable.value ? '' : '没有任务查看权限'; });
  watch(() => resources.workspace?.revision, () => { if (env.mode !== 'http' && selected.value) void loadReferences(); });
  onBeforeUnmount(() => { disposed = true; clear(); });
  return reactive({ readable, library, selected, loading, selecting, error, page, pageSize, total, search, nodes, snapshot, referenceNotice,
    taskId: computed(() => selected.value?.taskId ?? null), input: computed(() => selected.value?.input ?? null),
    initialize, queryLibrary, select, clearSelection, loadReferences });
}

export type GisTaskSelectionController = ReturnType<typeof useGisTaskSelection>;
