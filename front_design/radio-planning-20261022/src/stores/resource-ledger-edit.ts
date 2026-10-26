// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import {
  createForm,
  createNewForm,
  formChanges,
  resourceSignature,
} from '../services/resource-validation';
import type { Availability, ResourcesData } from '../types/domain';
import type {
  Decision,
  DecisionRequest,
  EditForm,
  ResourceImportPreview,
  ResourceIssue,
  ResourceKind,
  ResourceMaintenanceContext,
  ResourceMutationReceipt,
} from '../types/resource-edit';
import { useAuthStore } from './auth';
import { useResourceReadStore } from './resource-read';
import { usePreviewStore } from './preview';
import { maintenanceFields } from '../services/device-maintenance';
import type { DeviceRestorePreview } from '../types/device-maintenance';

// 台账维护只持有单设备上下文；分页结果和导入候选均不冒充完整编辑快照。
export const useResourceLedgerEditStore = defineStore('resource-ledger-edit', () => {
  const auth = useAuthStore(),
    read = useResourceReadStore(),
    preview = usePreviewStore();
  const visible = ref(false),
    form = ref<EditForm | null>(null),
    context = ref<ResourceMaintenanceContext | null>(null);
  const lastChanged = ref(false);
  const portsEditing=ref(false);
  // 用户继续修改恢复候选后按普通维护保存，不伪称完整恢复了历史版本。
  watch(()=>form.value?.fields,()=>{if(form.value?.restoreFrom)delete form.value.restoreFrom;},{deep:true,flush:'sync'});
  const loading = ref(false),
    saving = ref(false),
    importing = ref(false),
    error = ref(''),
    message = ref('');
  const issues = ref<ResourceIssue[]>([]),
    decision = ref<DecisionRequest | null>(null);
  const importOpen = ref(false),
    importKind = ref<ResourceKind>('nodes');
  const importFile = ref<{ name: string; bytes: Uint8Array } | null>(null),
    importPreview = ref<ResourceImportPreview | null>(null);
  const formDirty = computed(
    () =>
      !!form.value &&
      resourceSignature(form.value.fields) !== resourceSignature(form.value.initial),
  );
  const dirty = computed(() => formDirty.value || !!importFile.value);
  const busy = computed(() => loading.value || saving.value || importing.value);
  const canMaintainAll = computed(() => auth.can('resources.edit'));
  const writable = computed(() => auth.can('resources.view') && !auth.blocked && !!read.workspace && !read.frozen);
  const canCreate = computed(() => writable.value && (canMaintainAll.value || auth.can('resources.create')));
  const canImport = computed(() => writable.value && (canMaintainAll.value || auth.can('resources.import')));
  const canEdit = computed(
    () =>
      (canMaintainAll.value || auth.can('resources.device.edit') || auth.can('resources.workspace.edit') || auth.can('resources.create')) &&
      auth.can('resources.view') &&
      !auth.blocked &&
      !!read.workspace &&
      !read.frozen,
  );
  const canChangeAvailability = computed(() =>
    (canMaintainAll.value || auth.can('resources.device.availability')) && auth.can('resources.view')
      && !auth.blocked && !!read.workspace && !read.frozen);
  let generation = 0,
    importSerial = 0,
    targetId = '',
    saveKey = '',
    saveId = '',
    importId = '',
    availabilityKey = '',
    availabilityId = '';
  let availabilityPending: {
    context: ResourceMaintenanceContext;
    request: { baseRevision: string; requestId: string; ids: string[]; availability: Availability };
  } | null = null;
  let resolve: ((value: Decision) => void) | null = null;
  function answer(value: Decision) {
    const next = resolve;
    resolve = null;
    decision.value = null;
    next?.(value);
  }
  function ask(request: DecisionRequest) {
    if (decision.value || busy.value) return Promise.resolve('cancel' as Decision);
    decision.value = request;
    return new Promise<Decision>((next) => {
      resolve = next;
    });
  }
  function clearFeedback() {
    error.value = '';
    message.value = '';
    issues.value = [];
  }
  function report(reason: unknown) {
    message.value = '';
    error.value = reason instanceof Error ? reason.message : '操作失败，输入已保留';
    issues.value =
      reason instanceof ApiError
        ? ((reason.data as { issues?: ResourceIssue[] } | undefined)?.issues ?? [])
        : [];
  }
  function current(token: number, session: number) {
    return token === generation && session === auth.generation && !auth.blocked;
  }
  function references(value: ResourceMaintenanceContext): ResourcesData {
    if (value.resources) return value.resources;
    return {
      source: '设备维护选项',
      version: value.revision,
      stations: value.stations,
      models: value.models,
      antennas: value.antennas,
      devices: value.device ? [value.device] : [],
    };
  }
  async function loadContext(deviceId?: string, ids?: string[]) {
    if (!read.workspace) throw new Error('资源尚未加载，请先刷新资源');
    const revision = read.workspace.revision;
    const value = await previewService.loadResourceMaintenanceContext({
      context: 'ledger',
      revision,
      deviceId,
      ids,
    });
    if (read.workspace?.revision !== revision || value.revision !== revision)
      throw new ApiError('资源版本已变化，请重新读取维护信息', 'RESOURCE_VERSION_CHANGED');
    if ((deviceId && value.device?.id !== deviceId) || (!deviceId && value.device !== null))
      throw new ApiError('维护设备与请求不一致', 'INVALID_RESOURCE_RESPONSE');
    return value;
  }
  async function retryForm() {
    if (!canEdit.value || busy.value || !visible.value) return false;
    const token = ++generation,
      session = auth.generation;
    loading.value = true;
    clearFeedback();
    try {
      const value = await loadContext(targetId || undefined);
      if (!current(token, session) || !visible.value) return false;
      context.value = value;
      form.value = value.device
        ? createForm(references(value), 'device', value.device.id)
        : createNewForm('device', references(value));
      return true;
    } catch (reason) {
      if (current(token, session)) report(reason);
      return false;
    } finally {
      if (token === generation) loading.value = false;
    }
  }
  async function settleForm() {
    if (busy.value) return false;
    if (!formDirty.value) return true;
    const choice = await ask({
      title: '设备参数尚未保存',
      message: '保存仅修改当前设备；失败时保留输入。',
      saveLabel: '保存并继续',
      discardLabel: '放弃本次修改',
    });
    return choice === 'discard' || (choice === 'save' && (await save()));
  }
  async function closeForm() {
    const token = generation,
      session = auth.generation;
    if (!(await settleForm())) return false;
    if (token !== generation || session !== auth.generation) return false;
    generation++;
    visible.value = false;
    portsEditing.value=false;
    form.value = null;
    context.value = null;
    return true;
  }
  async function openForm(id = '', portEntry=false) {
    const session = auth.generation;
    if ((!id && !canCreate.value) || (portEntry && !canMaintainAll.value)
      || (id && !canMaintainAll.value && !auth.can('resources.device.edit') && !auth.can('resources.workspace.edit'))) return false;
    if (!canEdit.value || busy.value || !(await closeImport()) || !(await closeForm()))
      return false;
    if (session !== auth.generation || !canEdit.value) return false;
    targetId = id;
    portsEditing.value=portEntry;
    visible.value = true;
    form.value = null;
    context.value = null;
    // 读取失败仍保留同一抽屉与重试入口，不因数据来源切换页面。
    const loaded=await retryForm();
    if(!loaded&&session===auth.generation)portsEditing.value=false;
    return loaded&&session===auth.generation&&visible.value;
  }
  async function acceptSaved(result: ResourceMutationReceipt) {
    const token = generation,
      session = auth.generation;
    // 小回执只使旧完整缓存失效，不把当前页或单设备填成整库。
    if (result.changed) preview.invalidateResources();
    // 提交与列表刷新是两个结果；读取异常不能被报告成保存失败。
    let refreshed = false;
    try {
      refreshed = await read.refresh();
    } catch {
      /* 读取层保留原页，提示用户手动刷新。 */
    }
    if (!current(token, session)) return false;
    if (!refreshed) message.value += '；保存已成功，列表刷新失败，请刷新资源';
    return true;
  }
  async function save() {
    if (!canEdit.value || busy.value || !form.value || !context.value) return false;
    const token = generation,
      session = auth.generation,
      editing = form.value;
    try {
      let changes = formChanges(editing);
      if (editing.creating && !canCreate.value) throw new ApiError('无新增资源权限','FORBIDDEN');
      if (!canMaintainAll.value && !editing.creating) {
        if (editing.restoreFrom || portsEditing.value) throw new ApiError('仅允许修改已有设备基础参数','FORBIDDEN');
        const row = changes.devices[0]!;
        changes = {stations:[],devices:[{id:row.id,antennaHeightM:row.antennaHeightM,txPowerDbm:row.txPowerDbm,workFreqKhz:row.workFreqKhz}]};
      }
      const key = resourceSignature([context.value.baseRevision, changes]);
      if (key !== saveKey) {
        saveKey = key;
        saveId = randomUuid();
      }
      saving.value = true;
      clearFeedback();
      const result = await previewService.saveResourceChanges({
        ...(editing.restoreFrom?{restoreFrom:{[editing.id]:editing.restoreFrom}}:{}),
        baseRevision: context.value.baseRevision,
        ...changes,
        context: 'ledger',
        requestId: saveId,
      });
      if (!current(token, session)) return false;
      context.value = {
        ...context.value,
        revision: result.readRevision,
        baseRevision: result.revision,
        device: result.device ?? context.value.device,
      };
      form.value = result.device ? createForm(references(context.value), 'device', result.device.id)
        : { ...editing, initial: { ...editing.fields } };
      if (result.device) targetId = result.device.id;
      message.value = result.changed ? '设备已保存' : '没有需要保存的修改';
      return await acceptSaved(result);
    } catch (reason) {
      if (current(token, session)) report(reason);
      return false;
    } finally {
      if (token === generation) saving.value = false;
    }
  }
  async function openImport() {
    const session = auth.generation;
    if (!canImport.value || busy.value || !(await closeForm()) || !(await closeImport()))
      return false;
    if (session !== auth.generation || !canImport.value) return false;
    importOpen.value = true;
    clearFeedback();
    return true;
  }
  async function closeImport(defer = false) {
    if (busy.value) return false;
    if (importFile.value) {
      const choice = await ask({
        title: '导入尚未确认',
        message: '当前文件尚未提交，离开不会自动保存。',
        discardLabel: '放弃本次导入',
        cancelLabel: '继续查看',
      });
      if (choice !== 'discard') return false;
    }
    if (!defer) {
      importSerial++;
      importOpen.value = false;
      importFile.value = null;
      importPreview.value = null;
    }
    return true;
  }
  async function previewImport(file: { name: string; bytes: Uint8Array }) {
    if (!canImport.value || busy.value || !importOpen.value) return;
    const token = generation,
      serial = ++importSerial,
      session = auth.generation;
    importFile.value = file;
    importPreview.value = null;
    importId = randomUuid();
    importing.value = true;
    clearFeedback();
    try {
      const value = await loadContext();
      if (!current(token, session) || serial !== importSerial) return;
      context.value = value;
      const result = await previewService.previewResourceImport({
        context: 'ledger',
        baseRevision: value.baseRevision,
        kind: importKind.value,
        file: structuredClone(toRaw(file)),
      });
      if (current(token, session) && serial === importSerial) {
        importPreview.value = result;
        issues.value = result.issues;
      }
    } catch (reason) {
      if (current(token, session) && serial === importSerial) report(reason);
    } finally {
      if (token === generation && serial === importSerial) importing.value = false;
    }
  }
  async function confirmImport() {
    if (!canImport.value || busy.value || !importPreview.value || importPreview.value.issues.length)
      return false;
    const token = generation,
      session = auth.generation,
      value = structuredClone(toRaw(importPreview.value));
    importing.value = true;
    clearFeedback();
    try {
      const result = await previewService.applyResourceImport({
        baseRevision: value.request.baseRevision,
        requestId: importId,
        preview: value,
      });
      if (!current(token, session)) return false;
      importOpen.value = false;
      importFile.value = null;
      importPreview.value = null;
      message.value = result.changed ? '资源已整批保存' : '全部记录无变化';
      return await acceptSaved(result);
    } catch (reason) {
      if (current(token, session)) report(reason);
      return false;
    } finally {
      if (token === generation) importing.value = false;
    }
  }
  function pageTargets(ids: string[], detail = false) {
    return (
      ids.length > 0 &&
      new Set(ids).size === ids.length &&
      (detail
        ? ids.length === 1 &&
          read.detail?.object.kind === 'device' &&
          read.detail.object.id === ids[0]
        : ids.every((id) => read.ledger?.items.some((d) => d.id === id)))
    );
  }
  async function setAvailability(ids: string[], availability: Availability, detail = false) {
    if (
      !canChangeAvailability.value || ids.length > 50 ||
      busy.value ||
      read.pending.ledger ||
      !pageTargets(ids, detail) ||
      !(await closeImport()) ||
      !(await closeForm())
    )
      return false;
    const token = generation,
      session = auth.generation;
    loading.value = true;
    clearFeedback();
    let value: ResourceMaintenanceContext;
    // 响应丢失后优先重放原事务，不让新版上下文挡住幂等回执读取。
    const pending =
      availabilityPending?.request.availability === availability &&
      resourceSignature([...availabilityPending.request.ids].sort()) ===
        resourceSignature([...ids].sort())
        ? availabilityPending
        : null;
    try {
      value = pending?.context ?? (await loadContext(undefined, ids));
    } catch (reason) {
      if (current(token, session)) report(reason);
      return false;
    } finally {
      if (token === generation) loading.value = false;
    }
    if (!current(token, session) || !pageTargets(ids, detail)) return false;
    const choice = await ask({
      title: availability === 'ACTIVE' ? '启用设备' : '下架设备',
      saveLabel: '确认操作',
      message: `本次 ${ids.length} 台设备。${value.impact.description}。关联方案 ${value.impact.planIds.length} 个${value.impact.planIds.length ? '（' + value.impact.planIds.join('、') + '）' : ''}。未提供链路级影响明细。保留设备 ID、运行状态和历史；新规划排除下架设备，明确指定下架设备或节点无可用设备时拒绝提交；启用也不会恢复旧方案有效性。`,
    });
    if (!current(token, session)) return false;
    if (choice !== 'save' || !canChangeAvailability.value || !pageTargets(ids, detail)) {
      message.value = `本次 ${ids.length} 台未执行`;
      return false;
    }
    const key = resourceSignature([value.baseRevision, ids, availability]);
    if (key !== availabilityKey) {
      availabilityKey = key;
      availabilityId = randomUuid();
    }
    const request = pending?.request ?? {
      baseRevision: value.baseRevision,
      requestId: availabilityId,
      ids: [...ids],
      availability,
    };
    availabilityPending = { context: value, request };
    saving.value = true;
    try {
      const result = await previewService.updateDeviceAvailability(request);
      if (!current(token, session)) return false;
      availabilityPending = null;
      // 配置输入只在资源实际变更后清理，无变化回执仍保留现场。
      lastChanged.value = result.changed;
      message.value = `成功变更 ${result.updated.length} 台，失败 0 台，无变化 ${result.unchanged.length} 台`;
      return await acceptSaved(result);
    } catch (reason) {
      if (current(token, session)) {
        if (
          reason instanceof ApiError &&
          ['REVISION_CONFLICT', 'RESOURCE_VERSION_CHANGED', 'REQUEST_CONFLICT', 'RESOURCE_NOT_FOUND', 'VALIDATION_ERROR', 'NOT_IMPLEMENTED', 'FORBIDDEN'].includes(String(reason.code))
        ) {
          availabilityPending = null;
          availabilityKey = '';availabilityId = '';
        }
        report(reason);
        const rejected =
          reason instanceof ApiError &&
          ['REVISION_CONFLICT', 'RESOURCE_VERSION_CHANGED', 'REQUEST_CONFLICT', 'RESOURCE_NOT_FOUND', 'VALIDATION_ERROR', 'NOT_IMPLEMENTED', 'FORBIDDEN'].includes(
            String(reason.code),
          );
        error.value = rejected
          ? `成功 0 台，失败 ${ids.length} 台；整批未保存：${error.value}`
          : `本次 ${ids.length} 台结果未确认，可重试原请求：${error.value}`;
      }
      return false;
    } finally {
      if (token === generation) saving.value = false;
    }
  }
  async function leave(defer = false) {
    if (busy.value || !(await closeImport(true)) || !(await settleForm())) return false;
    if (!defer) clearForSession();
    return true;
  }
  function stop() {
    generation++;
    importSerial++;
    answer('cancel');
    loading.value = false;
    saving.value = false;
    importing.value = false;
  }
  function clearForSession() {
    portsEditing.value=false;
    stop();
    visible.value = false;
    form.value = null;
    context.value = null;
    importOpen.value = false;
    importFile.value = null;
    importPreview.value = null;
    saveKey = '';
    saveId = '';
    importId = '';
    availabilityKey = '';
    availabilityId = '';
    availabilityPending = null;
    lastChanged.value = false;
    clearFeedback();
  }
  // 复用原表单所有者，端口也受离页与会话保护。
  async function openPorts(id:string){return openForm(id,true);}
  async function applyRestore(id:string,value:DeviceRestorePreview){
    if(!canMaintainAll.value)return false;
    const session=auth.generation;
    if(!value.compatible||read.workspace?.revision!==value.revision||!await openForm(id))return false;
    if(session!==auth.generation||!canEdit.value||form.value?.id!==id||read.workspace?.revision!==value.revision)return false;
    for(const key of maintenanceFields)if(Object.hasOwn(value.values,key))form.value.fields[key]=key==='ports'?JSON.stringify(value.values.ports):String(value.values[key]??'');
    form.value.restoreFrom=value.historyId;return true;
  }
  return {
    portsEditing,openPorts,applyRestore,
    visible,
    lastChanged,
    form,
    context,
    loading,
    saving,
    importing,
    busy,
    canEdit,
    canMaintainAll,
    canCreate,
    canImport,
    canChangeAvailability,
    dirty,
    formDirty,
    error,
    message,
    issues,
    decision,
    answer,
    importOpen,
    importKind,
    importFile,
    importPreview,
    openForm,
    retryForm,
    closeForm,
    save,
    openImport,
    closeImport,
    previewImport,
    confirmImport,
    setAvailability,
    leave,
    stop,
    clearForSession,
  };
});
