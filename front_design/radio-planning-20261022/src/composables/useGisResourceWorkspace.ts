import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useResourceReadStore } from '../stores/resource-read';
import { useAuthStore } from '../stores/auth';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useResourceEditStore } from '../stores/resource-edit';
import { validateGisDirectory } from '../services/gis-workspace';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import type { GisBrowse, GisCategory, GisClassification, GisResourceDirectory } from '../types/gis-workspace';
import type { Bounds, ResourceMapCluster, ResourceObjectKind } from '../types/resource-read';

// 完整轻目录只在进入和刷新版本时读取；搜索与分类不再重复请求实例分页。
export function useGisResourceWorkspace() {
  const read = useResourceReadStore(), auth = useAuthStore();
  const gis = useGisWorkspaceStore(), editor = useResourceEditStore();
  const editing = computed(() => editor.context === 'gis');
  const browse = ref<GisBrowse>('devices'), category = ref<GisCategory>('all');
  const classification = ref<GisClassification>({ mobility: '', role: '', relay: '' });
  const directory = ref<GisResourceDirectory | null>(null), search = ref('');
  const cluster = ref<ResourceMapCluster | null>(null);
  const clusterIds = ref<string[] | null>(null);
  const activated = ref(false);
  const ready = computed(() => !!read.workspace && activated.value && read.context === 'gis'), error = computed(() => read.errors);
  const counts = computed(() => {
    if (editing.value) {
      const r = editor.resources, models = new Map(r.models.map(m => [m.id, m.deviceClass]));
      return { nodes: r.stations.length, devices: r.devices.length, hf: r.devices.filter(d => models.get(d.modelId) === 'HF').length,
        vuhf: r.devices.filter(d => models.get(d.modelId) === 'VUHF').length, interferences: r.interferences?.length ?? null };
    }
    return { nodes: read.workspace?.stats.nodes ?? null, devices: read.workspace?.stats.devices ?? null,
      hf: read.workspace?.stats.hf ?? null, vuhf: read.workspace?.stats.vuhf ?? null, interferences: read.workspace?.stats.interferences ?? null };
  });
  let attached = false, serial = 0, clusterSerial = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let directoryAbort: AbortController | undefined;
  const identity = () => JSON.stringify([auth.identity?.id, auth.identity?.sessionId, auth.generation]);
  async function query() {
    if (!attached || !read.workspace || read.frozen) return;
    const token = ++serial, owner = identity();
    const revision = read.workspace.revision;
    directoryAbort?.abort(); directoryAbort = new AbortController();
    read.pending['gis:directory'] = true;
    try {
      const value = validateGisDirectory(await previewService.loadGisResourceDirectory({ context: 'gis', revision, signal: directoryAbort.signal }), revision);
      if (attached && token === serial && owner === identity() && !read.frozen && revision === read.workspace?.revision) { directory.value = value; delete read.errors['gis:directory']; }
    } catch (reason) {
      if (attached && token === serial && owner === identity() && !directoryAbort.signal.aborted) {
        read.errors['gis:directory'] = reason instanceof Error ? reason.message : '目录读取失败';
        if (reason instanceof ApiError && reason.code === 'RESOURCE_VERSION_CHANGED') read.stale = true;
      }
    } finally { if (token === serial) read.pending['gis:directory'] = false; }
  }
  async function refresh() { if (await read.refresh()) await gis.loadScene(); }
  async function select(kind: ResourceObjectKind, id: string) { await read.selectObject(kind, id); }
  function viewport(bbox: Bounds, zoom: number) {
    if (!attached) return;
    if(!read.setViewport(bbox, zoom))return;
    read.cancelGroup('map'); clearTimeout(timer);
    timer = setTimeout(() => { if (attached && !read.frozen) void read.loadMap(false); }, 250);
  }
  async function selectCluster(value: ResourceMapCluster) {
    if (!attached || read.frozen || editing.value) return;
    if (value.kind === 'node') { browse.value = 'stations'; category.value = 'all'; }
    else category.value = 'interferences';
    const token = ++clusterSerial, owner = identity(), revision = read.workspace?.revision;
    cluster.value = value; clusterIds.value = [];
    // 聚合成员仍使用服务给出的准确身份，不以包围盒猜测成员；汇齐后一次显示。
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const input = { clusterId: value.id, pageNum: page, pageSize: 50, sort: 'id' as const };
      const result = value.kind === 'node' ? await read.fetchNodes(input, 'gis:cluster') : await read.fetchInterferences(input, 'gis:cluster');
      if (!result || token !== clusterSerial || owner !== identity() || revision !== read.workspace?.revision || read.frozen) return;
      ids.push(...result.items.map(row => row.id));
      if (ids.length >= result.total || !result.items.length) break;
    }
    clusterIds.value = ids;
  }
  // 切换分类或搜索后退出聚合成员范围，避免隐含筛选一直生效。
  watch([browse, category, search], () => { clusterSerial++; cluster.value = null; clusterIds.value = null; }, { flush: 'sync' });
  watch(() => read.refreshKey, () => { if (attached && activated.value) { serial++; if (directory.value?.revision !== read.workspace?.revision) directory.value = null; clusterSerial++; cluster.value = null; clusterIds.value = null; void query(); } });
  // 失权清理显示缓存，恢复权限或换身份时重新读取同一契约。
  watch([() => auth.generation, () => auth.identity?.id, () => auth.identity?.sessionId], () => {
    serial++; directoryAbort?.abort(); delete read.pending['gis:directory']; directory.value = null; clusterSerial++; cluster.value = null; clusterIds.value = null;
    if (attached && activated.value && read.workspace && !read.frozen) void query();
  });
  onMounted(async () => { attached = true; await read.activate('gis'); activated.value = true; await query(); });
  onBeforeUnmount(() => { attached = false; serial++; clusterSerial++; directoryAbort?.abort(); clearTimeout(timer); delete read.pending['gis:directory']; read.cancelGroup('gis:'); });
  return { editing, read, ready, error, counts, browse, category, classification, directory,
    search, cluster, clusterIds, query, refresh, select, viewport, selectCluster };
}
