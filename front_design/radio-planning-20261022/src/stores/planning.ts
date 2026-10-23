import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { dependenciesChanged } from '../services/planning-validation';
import type {
  PlanningJobView,
  PlanningLoaded,
  PlanningWorkspace,
} from '../types/planning';
import type { TaskWorkspace } from '../types/task';
import { emptyTasks, latestTask, taskSourceChanged } from '../services/task-validation';
import { usePreviewStore } from './preview';
import { useAuthStore } from './auth';

// 保留 GIS 与跨页读取所需状态，规划页交互由独立的 API Store 承担。
export const usePlanningStore = defineStore('planning', () => {
  const preview = usePreviewStore(),auth=useAuthStore();
  const workspace = ref<PlanningWorkspace | null>(null);
  const readRevision=ref('');
  // 活跃页面仅核对来源版本，不为触发跨页刷新重新下载完整规划库。
  async function refreshReadContext(){
    if(!auth.can('planning.view'))return;
    const token=generation,session=auth.generation;
    try{const value=await previewService.loadPlanningReadContext({context:'gis'});if(token===generation&&session===auth.generation)readRevision.value=value.revision;}
    catch{/* 各业务保留自身成功内容及独立重试入口。 */}
  }
  const tasks=ref<TaskWorkspace>(emptyTasks());
  const savedTask=computed(()=>taskId.value?latestTask(tasks.value,taskId.value):undefined);

  const taskId = ref<string | null>(null);
  const jobId = ref('');
  const view = ref<PlanningJobView | null>(null);
  const loading = ref(false);
  const loadError = ref('');
  const queryError = ref('');
  let generation = 0;
  let queryPending = false,querySerial=0,loadSerial=0;
  const running = computed(() => !!view.value && ['PENDING', 'RUNNING'].includes(view.value.state));
  const sourceChanged = computed(
    () =>
      !!view.value &&
      !!preview.data &&
      (dependenciesChanged(view.value.job.dependencies, preview.data.resourceMeta)||taskSourceChanged(view.value.job.taskId,view.value.job.input,preview.data.resourceMeta,view.value.job.dependencies.task?.conditionVersion)),
  );

  function setWorkspace(next: PlanningWorkspace) {
    workspace.value = next;
    preview.mergePlanning(next.plans);
  }
  // 失权只使在途读取失效，已显示结果和持久化作业保持原样。
  function stopQueries() {
    generation += 1;
  }
  // 共享缓存恢复时只读取一次作业；当前规划页独立维护轮询。
  async function readJob() {
    if (!auth.can('planning.view') || !jobId.value || queryPending) return;
    queryPending = true;
    const token = generation,serial=++querySerial;
    const requestedJob = jobId.value;
    try {
      const next = await previewService.getPlanningJob(requestedJob);
      if (token === generation && requestedJob === jobId.value) {
        view.value = next;
        queryError.value = '';
      }
    } catch (reason) {
      if (token === generation && requestedJob === jobId.value) {
        if (reason instanceof ApiError && reason.code === 2001 && reason.data) {
          view.value = reason.data as PlanningJobView;
          queryError.value = '';
        } else
          queryError.value = `查询失败，状态未确认：${reason instanceof Error ? reason.message : '请重试'}`;
      }
    } finally {
      if(serial!==querySerial)return;
      queryPending = false;
    }
  }
  function restore(loaded: PlanningLoaded) {
    setWorkspace(loaded.workspace);
    const last = loaded.workspace.jobs.at(-1);
    const saved=latestTask(tasks.value,last?.taskId??'')??tasks.value.tasks.at(-1)?.versions.at(-1);
    const savedId=saved?tasks.value.tasks.find(t=>t.versions.some(v=>v.id===saved.id))!.id:null;
    // 保留共享任务身份的原选择顺序，不把它改成当前编辑任务。
    taskId.value = savedId??last?.taskId ?? null;
    jobId.value = last?.id ?? '';
    view.value = null;
  }
  async function load() {
    if (!auth.can('planning.view') || loading.value) return;
    const session=auth.generation,serial=++loadSerial;
    loading.value = true;
    try {
      const [loaded,taskLibrary] = await Promise.all([previewService.loadPlanningWorkspace(),previewService.loadTaskWorkspace()]);
      if(session!==auth.generation)return;
      generation += 1;
      tasks.value=taskLibrary;
      restore(loaded);
      loadError.value = '';
      queryError.value = '';
    } catch (reason) {
      if(session===auth.generation)loadError.value = reason instanceof Error ? reason.message : '规划加载失败';
    } finally {
      if(serial===loadSerial)loading.value = false;
    }
    if (session===auth.generation && !loadError.value && jobId.value) await readJob();
  }
  // 会话清理仅释放共享读取缓存，不取消持久化作业。
  function clearForSession(){
    readRevision.value='';tasks.value=emptyTasks();loadSerial++;querySerial++;queryPending=false;
    stopQueries();workspace.value=null;taskId.value=null;jobId.value='';view.value=null;
    loading.value=false;loadError.value='';queryError.value='';
  }
  return {
    readRevision,refreshReadContext,
    tasks,savedTask,
    clearForSession,
    workspace,
    taskId,
    jobId,
    view,
    loading,
    loadError,
    queryError,
    running,
    sourceChanged,
    load,
    stopQueries,
  };
});
