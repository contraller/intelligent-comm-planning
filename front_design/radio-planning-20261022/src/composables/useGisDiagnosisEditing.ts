import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { RouteLocationNormalized, RouteLocationRaw } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useDiagnosisStore } from '../stores/diagnosis';
import { useResourceReadStore } from '../stores/resource-read';
import { usePlanningStore } from '../stores/planning';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisDraft, DiagnosisScenarioVersion, FaultInput } from '../types/diagnosis';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../config/demo';

type Target = Pick<FaultInput, 'objectType' | 'objectId'>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const key = (target: Target) => `${target.objectType}:${target.objectId}`;

/** GIS 只接管场景的空间编辑；草稿、版本及保存仍由原诊断工作区持有。 */
export function useGisDiagnosisEditing() {
  const route = useRoute(), router = useRouter(), auth = useAuthStore(), diagnosis = useDiagnosisStore();
  const preview = useResourceReadStore(), planning = usePlanningStore();
  // 单一入口状态同时用于参数校验和页面工作区切换。
  const active = computed(() => Object.prototype.hasOwnProperty.call(route.query, 'faultEdit'));
  const initialized = ref(false), loading = ref(false), error = ref(''), notice = ref('');
  const boundNetwork = ref<PlanVersion | null>(null), epoch = ref(0);
  const selected = ref<Target[]>([]), drawing = ref(true), drawerOpen = ref(false);
  const focus = ref<{ type: FaultInput['objectType']; id: string; nonce: number } | null>(null);
  let attached = false, serial = 0, focusSerial = 0;
  const accountKey = () => JSON.stringify([auth.identity?.sessionId, auth.identity?.id]);
  let account = accountKey();
  let returning: { session: number; scenarioId: string; versionId: string } | null = null;
  const readable = computed(() => !auth.blocked && auth.can('situation.view') && auth.can('diagnosis.view'));
  const routeKey = computed(() => JSON.stringify(route.query));
  const targetError = computed(() => {
    const { faultEdit, scenarioId, versionId } = route.query;
    if (!active.value) return '';
    if (faultEdit !== '1' || Object.keys(route.query).some(field => !['faultEdit', 'scenarioId', 'versionId'].includes(field)) ||
      (scenarioId === undefined) !== (versionId === undefined) ||
      [scenarioId, versionId].some(value => value !== undefined && (typeof value !== 'string' || !value || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)))) return '故障标绘入口参数无效';
    return '';
  });
  const network = computed(() => active.value && readable.value && initialized.value && diagnosis.draft?.planId === boundNetwork.value?.id ? boundNetwork.value : null);
  const draft = computed(() => active.value && readable.value ? diagnosis.draft : null);
  const ready = computed(() => !!network.value && !!draft.value);
  const sourceEligible = computed(() => !!boundNetwork.value && !diagnosis.sources.error && diagnosis.sources.plans.some(plan =>
    plan.id === boundNetwork.value!.id && ('inputSnapshot' in plan ? JSON.stringify(plan) === JSON.stringify(boundNetwork.value) : plan.snapshotId === boundNetwork.value!.snapshotId && plan.version === boundNetwork.value!.version)));
  const canEdit = computed(() => ready.value && sourceEligible.value && diagnosis.canEdit && !targetError.value);
  const busy = computed(() => loading.value || diagnosis.locked);
  const unappliedSelection = computed(() => selected.value.some(target => !diagnosis.draft?.faults.some(fault => key(fault) === key(target))));
  const dirty = computed(() => active.value && (diagnosis.dirty || unappliedSelection.value));
  const scenes = computed(() => diagnosis.workspace?.scenarios.filter(scene => !scene.archived) ?? []);
  const contextKey = computed(() => `fault-edit:${auth.generation}:${epoch.value}:${diagnosis.scenarioId ?? 'new'}:${diagnosis.versionId}`);
  const sourceNotice = computed(() => !readable.value ? '故障标绘需要 GIS、诊断查看权限'
    : !auth.can('diagnosis.scenario') ? '当前角色没有故障场景编辑权限，原输入已保留'
    : diagnosis.sources.error ? `网络来源无法核实：${diagnosis.sources.error}`
      : boundNetwork.value && !sourceEligible.value ? '绑定网络已不是当前有效确认方案，输入和原网络保留；请返回诊断页复制场景或重新选择网络。' : '');
  function exists(target: Target) {
    const plan = network.value;
    return !!plan && (target.objectType === 'NODE' ? plan.inputSnapshot.stations : target.objectType === 'DEVICE' ? plan.inputSnapshot.devices : target.objectType === 'LINK' ? plan.links : []).some(row => row.id === target.objectId);
  }
  function adoptNetwork() {
    boundNetwork.value = diagnosis.network ? clone(diagnosis.network) : null;
    initialized.value = true; epoch.value++; selected.value = []; focus.value = null; drawerOpen.value = false; drawing.value = true;
    if (!boundNetwork.value) error.value = '请先准备有效的已确认网络，并选择或新建故障场景';
  }
  async function initialize() {
    if (!attached || !active.value || loading.value) return false;
    const token = ++serial, session = auth.generation, target = routeKey.value;
    const current = () => attached && token === serial && session === auth.generation && target === routeKey.value && active.value && readable.value;
    error.value = ''; notice.value = ''; initialized.value = false;
    if (targetError.value || !readable.value || !auth.can('diagnosis.scenario')) { error.value = targetError.value || sourceNotice.value || '当前角色没有故障场景编辑权限'; return false; }
    loading.value = true;
    try {
      if (!diagnosis.workspace) await diagnosis.load();
      if (!current()) return false;
      if (!diagnosis.workspace) { error.value = diagnosis.loadError || '诊断工作区尚不可用'; return false; }
      if (!diagnosis.acceptGisTransfer(route.query)) {
        const { scenarioId, versionId } = route.query;
        if (typeof scenarioId === 'string' && typeof versionId === 'string') {
          // 深链可指向当前分页之外的场景，直接按明确身份取详情。
          if (diagnosis.scenarioId !== scenarioId || diagnosis.versionId !== versionId || !diagnosis.draft) await diagnosis.selectVersion({scenarioId,id:versionId});
          if (diagnosis.scenarioId !== scenarioId || diagnosis.versionId !== versionId) return false;
        } else if (!(await diagnosis.newScenario())) { error.value = diagnosis.error || '尚未创建故障场景'; return false; }
      }
      if (!current()) return false;
      await diagnosis.refreshSources();
      if (!current()) return false;
      adoptNetwork(); return !!boundNetwork.value;
    } finally { if (token === serial) loading.value = false; }
  }
  function pick(type: FaultInput['objectType'], id: string) {
    const target = { objectType: type, objectId: id };
    if (!canEdit.value || busy.value || !drawing.value || !exists(target) || drawerOpen.value) return false;
    const index = selected.value.findIndex(row => key(row) === key(target));
    if (index < 0) selected.value.push(target); else selected.value.splice(index, 1);
    focus.value = { type, id, nonce: ++focusSerial }; return true;
  }
  function locate(type: FaultInput['objectType'], id: string) {
    if (!ready.value || !exists({ objectType: type, objectId: id })) return false;
    focus.value = { type, id, nonce: ++focusSerial }; return true;
  }
  function openEditor() { if (!canEdit.value || busy.value) return false; drawerOpen.value = true; return true; }
  function apply(input: DiagnosisDraft) {
    // 原抽屉负责字段校验；这里只接受当前绑定网络且仍有效的提交。
    if (!canEdit.value || busy.value || input.planId !== network.value?.id || input.faults.some(target => !exists(target))) return false;
    diagnosis.updateDraft(input); diagnosis.formDirty = false; drawerOpen.value = false; selected.value = []; error.value = ''; return true;
  }
  async function closeEditor() {
    if (busy.value) return false;
    if (diagnosis.formDirty && await diagnosis.ask({ title: '未应用的故障配置', message: '放弃抽屉内尚未应用的修改？已应用到场景草稿的内容会保留。', discardLabel: '放弃未应用配置', cancelLabel: '继续配置' }) !== 'discard') return false;
    diagnosis.formDirty = false; drawerOpen.value = false; return true;
  }
  async function save() {
    if (!canEdit.value || busy.value) return false;
    if (diagnosis.formDirty || unappliedSelection.value) {
      error.value = '请先在“配置对象”抽屉中应用故障配置，再保存场景'; drawerOpen.value = true; return false;
    }
    const owner = epoch.value, session = auth.generation;
    if (!(await diagnosis.save()) || session !== auth.generation || !active.value) return false;
    // 保存会更新版本号，但不能替换绑定网络或接收另一轮初始化的回执。
    if (owner !== epoch.value) return false;
    selected.value = []; notice.value = '场景版本已保存，可返回故障诊断执行'; error.value = ''; return true;
  }
  function isReturnTarget(to: Pick<RouteLocationNormalized, 'path' | 'query'>) {
    const target = returning;
    if (!target || target.session !== auth.generation || diagnosis.dirty || unappliedSelection.value || diagnosis.locked || to.path !== '/diagnosis' ||
      target.scenarioId !== diagnosis.scenarioId || target.versionId !== diagnosis.versionId || to.query.scenarioId !== target.scenarioId || to.query.versionId !== target.versionId ||
      Object.keys(to.query).some(field => !['scenarioId', 'versionId'].includes(field))) return false;
    returning = null; return true;
  }
  async function saveAndReturn() {
    if (!active.value || !ready.value || targetError.value || !readable.value || busy.value) return false;
    // 干净的已保存版本即使来源过期也可返回查看，不为返回动作另存版本。
    const saved = !dirty.value && !!diagnosis.scenarioId && !!diagnosis.versionId && diagnosis.selectedVersion?.scenarioId === diagnosis.scenarioId;
    if ((!saved && !(await save())) || !diagnosis.scenarioId || !diagnosis.versionId) return false;
    returning = { session: auth.generation, scenarioId: diagnosis.scenarioId, versionId: diagnosis.versionId };
    const destination: RouteLocationRaw = { path: '/diagnosis', query: { scenarioId: diagnosis.scenarioId, versionId: diagnosis.versionId } };
    try { return !(await router.push(destination)); } finally { returning = null; }
  }
  async function leave(defer = false) {
    if (busy.value) { error.value = '故障场景操作尚未完成，请稍候'; return false; }
    if (!dirty.value) return true;
    const choice = await diagnosis.ask({ title: '未保存的故障场景', message: '保存包含当前场景草稿；放弃会还原整个未保存场景及未应用配置，历史版本和已提交诊断保留。',
      saveLabel: canEdit.value && !diagnosis.formDirty && !unappliedSelection.value ? '保存场景后继续' : undefined,
      discardLabel: '放弃未保存场景', cancelLabel: '继续标绘' });
    if (choice === 'save') return save();
    if (choice !== 'discard') return false;
    if (!defer) { diagnosis.discardDraft(); selected.value = []; drawerOpen.value = false; epoch.value++; }
    return true;
  }
  async function selectVersion(version: Pick<DiagnosisScenarioVersion,'id'|'scenarioId'>) {
    const session = auth.generation;
    if (!readable.value || !auth.can('diagnosis.scenario') || busy.value || !(await leave()) || session !== auth.generation || !readable.value) return false;
    await diagnosis.selectVersion(version);
    if (session !== auth.generation || !active.value || diagnosis.versionId !== version.id) return false;
    error.value = ''; adoptNetwork(); return true;
  }
  async function newScenario(planId?: string) {
    const session = auth.generation;
    if (!readable.value || !auth.can('diagnosis.scenario') || busy.value || !(await leave()) || session !== auth.generation || !readable.value) return false;
    if (!(await diagnosis.newScenario(planId)) || session !== auth.generation || !active.value) return false;
    error.value = ''; adoptNetwork(); return true;
  }
  async function switchPlan(id: string) {
    const session = auth.generation;
    if (!readable.value || !auth.can('diagnosis.scenario') || busy.value || !(await leave()) || session !== auth.generation || !readable.value) return false;
    await diagnosis.switchPlan(id);
    if (session !== auth.generation || !active.value || diagnosis.draft?.planId !== id) return false;
    error.value = ''; adoptNetwork(); return true;
  }
  async function allowRouteUpdate(to: Pick<RouteLocationNormalized, 'query'>) {
    return !active.value || JSON.stringify(to.query) === routeKey.value || await leave();
  }
  // 事件闭包绑定当前显示代次，旧地图或抽屉不得写入新身份、新场景。
  const actions = computed(() => {
    const owner = contextKey.value, session = auth.generation;
    const current = () => attached && active.value && owner === contextKey.value && session === auth.generation;
    return {
      pick: (type: FaultInput['objectType'], id: string) => current() && pick(type, id),
      node: (id: string) => current() && pick('NODE', id), link: (id: string) => current() && pick('LINK', id),
      apply: (input: DiagnosisDraft) => current() && apply(input),
      dirty: (value: boolean) => { if (current() && readable.value) diagnosis.formDirty = value; },
    };
  });
  const refresh = () => { if (attached && active.value && readable.value && !document.hidden) void diagnosis.refreshSources(); };
  const storage = (event: StorageEvent) => { if (event.key === null || [DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY].includes(event.key)) refresh(); };
  watch(routeKey, () => { serial++; loading.value = false; epoch.value++; initialized.value = false; returning = null; if (attached && active.value) void initialize(); });
  watch(() => auth.generation, () => {
    serial++; loading.value = false; returning = null; epoch.value++;
    // 权限代次变化只冻结原输入；只有真正换账号/会话才清空本页显示。
    if (account !== accountKey()) {
      account = accountKey(); initialized.value = false; boundNetwork.value = null; selected.value = []; focus.value = null; drawerOpen.value = false;
      error.value = '身份已变化，请重新进入故障标绘';
    }
  }, { flush: 'sync' });
  watch(() => [readable.value, auth.can('diagnosis.scenario'), sourceEligible.value], () => { epoch.value++; returning = null; }, { flush: 'sync' });
  watch(() => [preview.workspace?.revision, planning.readRevision || planning.workspace?.revision], refresh);
  onMounted(() => { attached = true; if (active.value) void initialize(); window.addEventListener('focus', refresh); window.addEventListener('storage', storage); });
  onBeforeUnmount(() => { attached = false; serial++; returning = null; window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage); });
  return { active, ready, network, draft, scenes, selected, drawing, drawerOpen, focus, error, notice, sourceNotice, canEdit, busy, dirty, contextKey, actions,
    selectVersion, switchPlan, newScenario, pick, locate, openEditor, apply, closeEditor, save, saveAndReturn, leave, allowRouteUpdate, isReturnTarget };
}
