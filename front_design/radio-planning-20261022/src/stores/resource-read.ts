import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { useAuthStore } from './auth';
import type { Bounds, ReadDevice, ReadInterference, ReadNode, ResourceMapFrame, ResourceMapQuery, ResourceObjectDetail, ResourceObjectKind, ResourcePage, ResourcePageQuery, ResourceReadContext, ResourceReadFilter, ResourceReadWorkspace } from '../types/resource-read';

type PageInput = Omit<ResourcePageQuery, 'revision' | 'context' | 'signal'>;
// 分页缓存只属于当前身份和资源版本，不写入 Mock 编辑工作区或持久化存储。
export const useResourceReadStore = defineStore('resource-read', () => {
  const auth = useAuthStore();
  const context = ref<ResourceReadContext>('ledger'), workspace = ref<ResourceReadWorkspace | null>(null);
  const stale = ref(false), notice = ref(''), errors = ref<Record<string, string>>({}), pending = ref<Record<string, boolean>>({});
  const ledger = ref<ResourcePage<ReadDevice> | null>(null), frame = ref<ResourceMapFrame | null>(null), detail = ref<ResourceObjectDetail | null>(null);
  const ledgerQuery = ref<PageInput>({ pageNum: 1, pageSize: 10, sort: 'id', order: 'asc' });
  const ledgerApplied = ref<PageInput | null>(null), mapFilter = ref<ResourceReadFilter>({});
  const viewport = ref<{ bbox: Bounds; zoom: number } | null>(null), showNodes = ref(true), showInterferences = ref(true);
  const refreshing = ref(false), refreshKey = ref(0), selected = ref<{ kind: ResourceObjectKind; id: string } | null>(null);
  const readable = computed(() => auth.can(context.value === 'ledger' ? 'resources.view' : context.value === 'planning' ? 'planning.view' : 'situation.view'));
  const frozen = computed(() => stale.value || !readable.value || refreshing.value);
  let generation = 0;
  const controllers = new Map<string, AbortController>();
  let lastMapKey = '', mapFlight: {key:string;promise:Promise<void>} | null = null;
  function cancelGroup(prefix: string) {
    for (const [key, controller] of controllers) if (!prefix || key === prefix || key.startsWith(prefix.endsWith(':') ? prefix : prefix + ':')) { controller.abort(); controllers.delete(key); pending.value[key] = false; }
  }
  function stop() { generation++; cancelGroup(''); refreshing.value = false; lastMapKey=''; mapFlight=null; }
  function handleFailure(reason: unknown, key: string) {
    if (reason instanceof ApiError && ['REQUEST_ABORTED', 'SESSION_CHANGED', 'HTTP_AUTH_BUSY'].includes(String(reason.code))) return;
    if (reason instanceof ApiError && reason.code === 'RESOURCE_VERSION_CHANGED') {
      stale.value = true; notice.value = '资源版本已变化，当前保留上次成功内容。请刷新资源后继续浏览。';
      cancelGroup('');
    }
    errors.value[key] = reason instanceof Error ? reason.message : '资源读取失败';
  }
  async function run<T>(key: string, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (frozen.value || !workspace.value) return;
    cancelGroup(key); const controller = new AbortController(), token = generation, session = auth.generation;
    controllers.set(key, controller); pending.value[key] = true; delete errors.value[key];
    const current = () => controllers.get(key) === controller && !controller.signal.aborted && token === generation && session === auth.generation && readable.value && !stale.value;
    try { const value = await action(controller.signal); return current() ? value : undefined; }
    catch (reason) { if (current()) handleFailure(reason, key); return undefined; }
    finally { if (controllers.get(key) === controller) { controllers.delete(key); pending.value[key] = false; } }
  }
  const versioned = (signal?: AbortSignal) => ({ context: context.value, revision: workspace.value!.revision, signal });
  function mapRequest(revision: string, signal?: AbortSignal): ResourceMapQuery {
    const view = viewport.value ?? { bbox: workspace.value!.bounds, zoom: 9 };
    return { ...mapFilter.value, ...view, context: context.value, revision, signal, showNodes: showNodes.value, showInterferences: context.value === 'planning' ? false : showInterferences.value };
  }
  async function loadLedger(input: Partial<PageInput> = {}) {
    if (frozen.value) return;
    ledgerQuery.value = { ...ledgerQuery.value, ...input };
    const query = { ...ledgerQuery.value };
    const value = await run('ledger', signal => previewService.queryResourceDevices({ ...query, ...versioned(signal) }));
    if (value) { ledger.value = value; ledgerApplied.value = query; }
  }
  async function loadMap(force = true) {
    if(frozen.value||!workspace.value)return;
    const input=mapRequest(workspace.value.revision),key=JSON.stringify(input);
    if(mapFlight?.key===key&&controllers.has('map'))return mapFlight.promise;
    if(!force&&frame.value&&lastMapKey===key&&!errors.value.map)return;
    // 自动视口请求可复用成功结果；显式刷新保持原读取语义，同一在途查询仍合并。
    const promise=(async()=>{const value=await run('map',signal=>previewService.queryResourceMap({...input,signal}));if(value){frame.value=value;lastMapKey=key;}})();
    const flight={key,promise};mapFlight=flight;
    try{await promise;}finally{if(mapFlight===flight)mapFlight=null;}
  }
  async function fetchNodes(input: PageInput, key = 'tree:root'): Promise<ResourcePage<ReadNode> | undefined> {
    return run(key, signal => previewService.queryResourceNodes({ ...input, ...versioned(signal) }));
  }
  async function fetchInterferences(input: PageInput, key = 'tree:sources'): Promise<ResourcePage<ReadInterference> | undefined> {
    return run(key, signal => previewService.queryResourceInterferences({ ...input, ...versioned(signal) }));
  }
  async function fetchDevices(nodeId: string, page: number, key = 'detail:devices') {
    return run(key, signal => previewService.queryResourceDevices({ ...versioned(signal), nodeId, pageNum: page, pageSize: 10, sort: 'id' }));
  }
  async function selectObject(kind: ResourceObjectKind, id: string) {
    if (frozen.value) return;
    selected.value = { kind, id }; cancelGroup('detail:');
    // 切换对象时不把上一对象详情显示成当前选中项。
    detail.value = null;
    const value = await run('detail', signal => previewService.getResourceObject({ ...versioned(signal), kind, id,observationSnapshotId:context.value==='ledger'?ledgerApplied.value?.observationSnapshotId:undefined }));
    if (value && selected.value?.kind === kind && selected.value.id === id) detail.value = value;
  }
  // 局部关联读取沿用版本和会话保护，不替换当前选中的设备。
  async function fetchObject(kind: ResourceObjectKind, id: string, key: string) {
    return run(key, signal => previewService.getResourceObject({ ...versioned(signal), kind, id }));
  }
  function closeDetail() {
    cancelGroup('detail'); detail.value = null; selected.value = null; delete errors.value.detail;
    // 新增台账关联通道随详情关闭，避免无选中对象时残留节点错误。
    delete errors.value['detail:ledger-node'];
  }
  function setViewport(bbox: Bounds, zoom: number) {
    const previous=viewport.value;
    if(previous&&Math.abs(previous.zoom-zoom)<0.005&&bbox.every((part,i)=>Math.abs(part-previous.bbox[i])<1e-7))return false;
    viewport.value = { bbox: [...bbox], zoom };return true;
  }
  function setMapFilter(filter: ResourceReadFilter) { if (!frozen.value) mapFilter.value = { ...filter }; }
  async function refresh() {
    if (!readable.value || refreshing.value) return false;
    stop(); const token = generation, session = auth.generation, requestedContext = context.value;
    const controller = new AbortController(); controllers.set('refresh', controller); refreshing.value = true; errors.value = {};
    const oldSelected = selected.value ? { ...selected.value } : null;
    let objectMissing = false;
    try {
      const next = await previewService.loadResourceReadContext({ context: requestedContext, signal: controller.signal });
      const common = { context: requestedContext, revision: next.revision, signal: controller.signal };
      const query = { ...ledgerQuery.value, pageNum: 1 };
      // 新资源版本使旧观测失效；同版本手动刷新继续使用已应用快照。
      if (workspace.value && workspace.value.revision !== next.revision) { query.statusMode = 'baseline'; query.observationSnapshotId = undefined; }
      const view = viewport.value ?? { bbox: next.bounds, zoom: 9 };
      // 新版本的主视图与已选详情齐备后一次替换；失败仍保留整个旧版本。
      const [nextLedger, nextFrame, nextDetail] = await Promise.all([
        requestedContext === 'ledger' ? previewService.queryResourceDevices({ ...query, ...common }) : Promise.resolve(null),
        requestedContext !== 'ledger' ? previewService.queryResourceMap({ ...mapFilter.value, ...view, ...common, showNodes: showNodes.value, showInterferences: requestedContext === 'planning' ? false : showInterferences.value }) : Promise.resolve(null),
        oldSelected ? previewService.getResourceObject({ ...oldSelected, ...common,observationSnapshotId:requestedContext==='ledger'?query.observationSnapshotId:undefined }).catch(reason => {
          if (reason instanceof ApiError && reason.code === 'RESOURCE_NOT_FOUND') { objectMissing = true; return null; }
          throw reason;
        }) : Promise.resolve(null),
      ]);
      if (token !== generation || session !== auth.generation || controller.signal.aborted || !readable.value) return false;
      workspace.value = next; ledger.value = nextLedger; frame.value = nextFrame;
      // 刷新期间关闭的详情不会被迟到的刷新结果重新打开。
      detail.value = selected.value?.id === oldSelected?.id && selected.value?.kind === oldSelected?.kind ? nextDetail : null;
      if (requestedContext === 'ledger') { ledgerQuery.value = query; ledgerApplied.value = query; }
      if (objectMissing) selected.value = null;
      stale.value = false; notice.value = objectMissing ? '所选对象已不存在，已关闭旧详情。' : ''; refreshKey.value++;
      return true;
    } catch (reason) {
      if (token === generation && session === auth.generation && !controller.signal.aborted) handleFailure(reason, 'workspace');
      return false;
    } finally {
      if (controllers.get('refresh') === controller) controllers.delete('refresh');
      if (token === generation) refreshing.value = false;
    }
  }
  async function activate(value: ResourceReadContext) {
    if (context.value !== value) { stop(); refreshing.value = false; closeDetail(); context.value = value; errors.value = {}; if(value==='planning')frame.value=null; }
    if (!workspace.value) return refresh();
    if (value === 'ledger') await loadLedger(); else await loadMap();
    return true;
  }
  function clearForSession() {
    stop(); workspace.value = null; ledger.value = null; frame.value = null; closeDetail();
    stale.value = false; refreshing.value = false; errors.value = {}; pending.value = {}; notice.value = '';
    ledgerQuery.value = { pageNum: 1, pageSize: 10, sort: 'id', order: 'asc' }; ledgerApplied.value = null;
    viewport.value = null; mapFilter.value = {}; showNodes.value = true; showInterferences.value = true; refreshKey.value++;
  }
  return { context, workspace, stale, notice, errors, pending, ledger, ledgerQuery, ledgerApplied, frame, detail, selected, viewport, mapFilter, showNodes, showInterferences, readable, frozen, refreshing, refreshKey,
    activate, refresh, loadLedger, loadMap, fetchNodes, fetchDevices, fetchInterferences, fetchObject, selectObject, closeDetail, setViewport, setMapFilter, cancelGroup, stop, clearForSession };
});
