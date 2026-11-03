import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import example from '../config/gis-situation-example.json';
import exampleCoverage from '../config/gis-situation-coverage.json';
import { env } from '../config/env';
import { previewService } from '../services';
import { collaborationHttp } from '../services/http';
import { readGisNetwork } from '../services/gis-plan-validation';
import { readFrozenCoverageCache } from '../services/frozen-coverage-decode';
import { loadTerrainBasemap, type TerrainBasemap } from '../services/terrain-basemap';
import { createGisReadPoller } from '../services/gis-read-poller';
import type { GisNetwork, GisPlanServices } from '../types/gis-plan';
import type { FrozenCoverageCache, FrozenCoverageClient, FrozenCoverageOverlay } from '../types/frozen-coverage';
import type { ApiPage } from '../types/task-api';
import type { PlanningPlanSummary, SavedPlanningPlansQuery } from '../types/planning-api';
import type { ResourceReadServices, ResourceTerrain } from '../types/resource-read';
import type { InterferenceSource } from '../types/domain';

export interface GisSituationFrame {
  key: string;
  label: string;
  version: string;
  example: boolean;
  network: GisNetwork;
  terrain: ResourceTerrain;
  basemap: TerrainBasemap | null;
  coverage: FrozenCoverageCache | null;
  interferences: InterferenceSource[];
  notice: string;
}
export interface GisSituationServices {
  queryPlans(input: SavedPlanningPlansQuery): Promise<ApiPage<PlanningPlanSummary>>;
  plans: Pick<GisPlanServices, 'getNetwork' | 'getSurface'>;
  getCoverage?: FrozenCoverageClient['getLatestCache'];
  terrain?: typeof loadTerrainBasemap;
  resources?: Pick<ResourceReadServices, 'loadResourceReadContext' | 'queryResourceInterferences'>;
}
export interface GisSavedInterferences {
  revision: string; source: string; updatedAt: string; sources: InterferenceSource[];
}

let verifiedExampleCoverage: FrozenCoverageCache | undefined;
function readExampleCoverage() {
  return verifiedExampleCoverage ??= readFrozenCoverageCache(exampleCoverage, {
    context: 'gis', planId: example.network.identity.plan_id, taskId: example.network.identity.task_id,
    snapshotId: example.network.identity.snapshot_id, resourceRevision: example.network.identity.resource_revision,
    engineVersion: 'V01-6', bandwidthSelection: { selectionId: exampleCoverage.bandwidth_selection_id,
      selectionHash: exampleCoverage.bandwidth_selection_hash },
  }, exampleCoverage.parameters);
}
// 示例在软件内随包交付；首次进入不读取资源工作区、不选择用户账号、不产生计算或数据库写入。
export function gisExampleFrame(): GisSituationFrame {
  const network = readGisNetwork(example.network, {
    planId: example.network.identity.plan_id,
    taskId: example.network.identity.task_id,
  });
  return {
    key: network.identity.snapshot_id,
    label: example.label,
    version: example.version,
    example: true,
    network,
    terrain: { ...example.terrain, bounds: [...example.terrain.bounds] as [number, number, number, number] },
    basemap: null,
    coverage: readExampleCoverage(),
    interferences: example.interferences.map(source => ({ ...source, origin: 'SOURCE', coordinate: [...source.coordinate] as [number, number] })),
    notice: example.notice,
  };
}

const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : '读取失败，请重试';

// 新帧的网络、地形和覆盖只在核对完毕后一起发布；失败及迟到响应均不清空已显示的帧。
export function createGisSituation(services?: GisSituationServices) {
  const frame = shallowRef<GisSituationFrame>(gisExampleFrame());
  const catalog = shallowRef<ApiPage<PlanningPlanSummary> | null>(null);
  const busy = ref(false), listing = ref(false), error = ref(''), notice = ref(''), catalogError = ref('');
  const selectedDeviceId = ref(''), coverageDisplay = ref<'strength' | 'field' | 'boundary'>('strength');
  const showCoverage = ref(false), showLinks = ref(true);
  const autoFollow = ref(!!services), lastCheckedAt = ref<number | null>(null);
  const useLiveInterferences = ref(false);
  const liveInterferences = shallowRef<GisSavedInterferences | null>(null);
  const canAutoFollow = !!services;
  let alive = true, serial = 0, listSerial = 0;
  let loadedPlanSignature = '';
  let read: AbortController | undefined, listRead: AbortController | undefined;
  const terrainLoader = services?.terrain ?? loadTerrainBasemap;

  function begin() {
    read?.abort();
    const controller = new AbortController(), owner = ++serial;
    read = controller;
    busy.value = true; error.value = ''; notice.value = '';
    return { controller, valid: () => alive && serial === owner && !controller.signal.aborted };
  }
  function replace(next: GisSituationFrame, preserveSelection = false) {
    const previous = frame.value;
    frame.value = next;
    const available = next.coverage?.result?.devices.filter(d => d.status === 'COMPLETE') ?? [];
    if (preserveSelection) {
      if (!available.some(device => device.device_id === selectedDeviceId.value)) {
        selectedDeviceId.value = ''; showCoverage.value = false;
      }
    } else {
      selectedDeviceId.value = (available.find(d => d.band === 'HF') ?? available[0])?.device_id ?? '';
      showCoverage.value = false;
    }
    if (previous.basemap !== next.basemap) previous.basemap?.dispose();
  }
  async function initialize() {
    const token = begin(), initial = frame.value;
    let basemap: TerrainBasemap | undefined;
    try {
      basemap = await terrainLoader(initial.terrain, globalThis.fetch, import.meta.env.BASE_URL, token.controller.signal);
      if (!token.valid()) { basemap.dispose(); return; }
      replace({ ...initial, basemap });
    } catch (reason) {
      if (token.valid()) error.value = `示例地形尚未显示：${reasonText(reason)}。示例点线已保留。`;
    } finally { if (token.valid()) busy.value = false; }
  }
  async function readPlan(row: PlanningPlanSummary, token: ReturnType<typeof begin>) {
    if (!services) throw new Error('当前数据模式只提供内置受控示例');
    const query = { taskId: row.taskId, planId: row.id };
    const network = await services.plans.getNetwork(query, token.controller.signal);
    if (!token.valid()) return;
    const frozen = { ...query, snapshotId: network.identity.snapshot_id };
    const surface = await services.plans.getSurface(frozen, network, token.controller.signal);
    if (!token.valid()) return;
    if (!surface.terrain) throw new Error(surface.terrain_notice || '该方案未提供可核验的冻结 DEM');
    let basemap: TerrainBasemap | undefined;
    try {
      basemap = await terrainLoader(surface.terrain, globalThis.fetch, import.meta.env.BASE_URL, token.controller.signal);
      if (!token.valid()) { basemap.dispose(); return; }
      const coverage = services.getCoverage ? await services.getCoverage({
        ...frozen, context: 'gis', resourceRevision: network.identity.resource_revision, engineVersion: 'V01-6',
      }, token.controller.signal) : null;
      if (!token.valid()) { basemap.dispose(); return; }
      const sources = network.interferences;
      return { key: network.identity.snapshot_id, label: row.name, version: row.version,
        example: false, network, terrain: surface.terrain, basemap, coverage,
        interferences: sources ?? [],
        notice: '已保存构造规划结果 · 算法预测，未提供现场实测。' +
          (network.identity.source_changed ? ' 来源已变化，按原冻结版本显示。' : '') +
          (row.state === 'REFERENCE' ? ' 未达标参考方案。' : '') +
          (network.interferences_notice ? ' ' + network.interferences_notice
            : sources ? '' : ' 该历史方案未冻结干扰源，未借用当前资源替代。') } satisfies GisSituationFrame;
    } catch (reason) { basemap?.dispose(); throw reason; }
  }
  async function openPlan(row: PlanningPlanSummary) {
    pauseFollowing();
    const token = begin(), captured = { ...row };
    try {
      const next = await readPlan(captured, token);
      if (next && token.valid()) {
        replace(next); useLiveInterferences.value = false; loadedPlanSignature = planSignature(captured);
        if (!next.coverage?.result) notice.value = '该方案暂无已保存的 V6 地形覆盖；未绘制推测覆盖。';
      } else if (next?.basemap) next.basemap.dispose();
    }
    catch (reason) { if (token.valid()) error.value = `${reasonText(reason)}。当前态势已保留。`; }
    finally { if (token.valid()) busy.value = false; }
  }
  const planSignature = (row: PlanningPlanSummary) => JSON.stringify([row.taskId, row.id, row.version, row.state, row.sourceChanged]);
  async function readSavedInterferences(token: ReturnType<typeof begin>) {
    if (!services?.resources) return undefined;
    const context = await services.resources.loadResourceReadContext({ context: 'gis', signal: token.controller.signal });
    if (!token.valid()) return;
    if (liveInterferences.value?.revision === context.revision) return liveInterferences.value;
    const sources: InterferenceSource[] = [];
    let total: number | undefined;
    for (let pageNum = 1; ; pageNum++) {
      const page = await services.resources.queryResourceInterferences({ context: 'gis', revision: context.revision,
        pageNum, pageSize: 50, sort: 'id', order: 'asc', signal: token.controller.signal });
      if (!token.valid()) return;
      if (page.revision !== context.revision || total !== undefined && total !== page.total)
        throw new Error('已保存干扰源版本在读取期间发生变化');
      total = page.total;
      for (const row of page.items) {
        if (!row.origin) throw new Error(`干扰源 ${row.id} 的来源未提供`);
        const { kind: _kind, ...source } = row;
        sources.push({ ...source, origin: row.origin, coordinate: [...row.coordinate] });
      }
      if (pageNum * page.pageSize >= page.total) break;
      if (!page.items.length) throw new Error('已保存干扰源分页不完整');
    }
    if (sources.length !== total || new Set(sources.map(source => source.id)).size !== sources.length)
      throw new Error('已保存干扰源数量或编号不一致');
    return { revision: context.revision, source: context.source, updatedAt: context.updatedAt, sources } satisfies GisSavedInterferences;
  }
  async function updateLatest(automatic: boolean) {
    if (!alive || automatic && (!autoFollow.value || busy.value)) return;
    const token = begin();
    let next: GisSituationFrame | undefined;
    try {
      if (!services) throw new Error('当前数据模式只提供内置受控示例');
      // 自动刷新只采用已转正方案，已保存及参考结果留在手动选择目录。
      const page = await services.queryPlans({
        context: 'gis', pageNum: 1, pageSize: 20, state: 'CONFIRMED', signal: token.controller.signal,
      });
      if (!token.valid()) return;
      // CONFIRMED目录由服务按转正时间倒序；保存时间不能代表转正先后。
      const latest = page.items.find(plan => plan.state === 'CONFIRMED');
      const saved = await readSavedInterferences(token);
      if (!token.valid()) return;
      if (latest && planSignature(latest) !== loadedPlanSignature) next = await readPlan(latest, token);
      if (!token.valid()) return;
      if (next && latest) { replace(next, true); loadedPlanSignature = planSignature(latest); }
      if (saved) { liveInterferences.value = saved; useLiveInterferences.value = true; }
      lastCheckedAt.value = Date.now();
      notice.value = automatic ? '' : latest ? `已刷新：${latest.name} · ${latest.version}` +
        (frame.value.coverage?.result ? '' : '；该方案暂无已保存的 V6 地形覆盖。')
        : '暂无已转正方案，当前态势已保留。';
    } catch (reason) {
      if (next?.basemap && next.basemap !== frame.value.basemap) next.basemap.dispose();
      next = undefined;
      if (token.valid()) error.value = `${reasonText(reason)}。当前态势已保留。`;
    }
    finally {
      if (!token.valid() && next?.basemap && next.basemap !== frame.value.basemap) next.basemap.dispose();
      if (token.valid()) busy.value = false;
    }
  }
  const poller = createGisReadPoller(() => updateLatest(true));
  function startAutoRefresh() { if (alive && services && autoFollow.value) poller.start(); }
  function pauseFollowing() {
    autoFollow.value = false; poller.stop(); read?.abort(); serial++; busy.value = false;
  }
  async function refreshLatest() {
    autoFollow.value = !!services; startAutoRefresh();
    await updateLatest(false);
  }
  function setAutoFollow(enabled: boolean) {
    if (!enabled) { pauseFollowing(); return; }
    if (!services || !alive) return;
    autoFollow.value = true; startAutoRefresh(); void updateLatest(false);
  }
  const displayingLiveInterferences = computed(() => useLiveInterferences.value && !!liveInterferences.value);
  const interferences = computed(() => displayingLiveInterferences.value ? liveInterferences.value!.sources : frame.value.interferences);
  const interferenceSourceLabel = computed(() => displayingLiveInterferences.value
    ? `干扰源：最新已保存资源 ${liveInterferences.value!.revision} · ${liveInterferences.value!.source}；规划链路仍为原冻结计算，未随干扰源重算。`
    : `干扰源：${frame.value.example ? '受控示例' : '冻结规划资源 ' + frame.value.network.identity.resource_revision}。`);
  async function queryPlans(pageNum = 1) {
    if (!services) { catalogError.value = '当前数据模式只提供内置受控示例。'; return; }
    listRead?.abort(); const controller = new AbortController(), owner = ++listSerial;
    listRead = controller; listing.value = true; catalogError.value = '';
    try {
      const result = await services.queryPlans({ context: 'gis', pageNum, pageSize: 20, signal: controller.signal });
      if (alive && owner === listSerial && !controller.signal.aborted) catalog.value = result;
    } catch (reason) {
      if (alive && owner === listSerial && !controller.signal.aborted) catalogError.value = reasonText(reason);
    } finally { if (alive && owner === listSerial) listing.value = false; }
  }
  async function showExample() {
    pauseFollowing();
    const token = begin(), example = gisExampleFrame();
    let basemap: TerrainBasemap | undefined;
    try {
      basemap = await terrainLoader(example.terrain, globalThis.fetch, import.meta.env.BASE_URL, token.controller.signal);
      if (!token.valid()) { basemap.dispose(); return; }
      replace({ ...example, basemap }); useLiveInterferences.value = false; loadedPlanSignature = '';
    } catch (reason) { if (token.valid()) error.value = `${reasonText(reason)}。当前态势已保留。`; }
    finally { if (token.valid()) busy.value = false; }
  }
  const coverage = computed<FrozenCoverageOverlay | null>(() => {
    const cache = frame.value.coverage;
    return showCoverage.value && cache?.state === 'HIT' && cache.result && selectedDeviceId.value
      ? { anchor: cache.anchor, result: cache.result, deviceId: selectedDeviceId.value, display: coverageDisplay.value,
        ...(cache.bandwidth_selection_id && cache.bandwidth_selection_hash ? { bandwidthSelection: {
          selectionId: cache.bandwidth_selection_id, selectionHash: cache.bandwidth_selection_hash,
        } } : {}) } : null;
  });
  function previewDevices(ids: string[]) {
    const available = frame.value.coverage?.state === 'HIT' ? frame.value.coverage.result?.devices : undefined;
    const selected = ids.find(id => available?.some(device => device.device_id === id && device.status === 'COMPLETE'));
    selectedDeviceId.value = selected ?? '';
    showCoverage.value = !!selected;
  }
  function stop() {
    poller.stop();
    alive = false; serial++; listSerial++; read?.abort(); listRead?.abort();
    frame.value.basemap?.dispose(); busy.value = false; listing.value = false;
  }
  return { frame, catalog, busy, listing, error, notice, catalogError, selectedDeviceId, coverageDisplay,
    autoFollow, canAutoFollow, lastCheckedAt, liveInterferences, interferences, displayingLiveInterferences, interferenceSourceLabel,
    startAutoRefresh, setAutoFollow,
    showCoverage, showLinks, coverage, initialize, openPlan, refreshLatest, queryPlans, showExample, previewDevices, stop };
}

export function useGisSituation() {
  const model = createGisSituation(env.mode === 'http' ? {
    queryPlans: input => previewService.querySavedPlanningPlans(input),
    plans: collaborationHttp.gisPlans,
    getCoverage: collaborationHttp.frozenCoverage.getLatestCache,
    resources: { loadResourceReadContext: input => previewService.loadResourceReadContext(input),
      queryResourceInterferences: input => previewService.queryResourceInterferences(input) },
  } : undefined);
  onBeforeUnmount(model.stop);
  return model;
}

export const gisExampleMetadata = example;
