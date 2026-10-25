import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import GisPlanOperations from '../src/components/GisPlanOperations.vue';
import type { GisNetwork, GisPlanOperationServices } from '../src/types/gis-plan';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

const stores = vi.hoisted(() => ({ auth: null as any, analysis: null as any, status: null as any, config: null as any, runtime: null as any }));
vi.mock('../src/stores/auth', () => ({ useAuthStore: () => stores.auth }));
vi.mock('../src/stores/interference', () => ({ useInterferenceStore: () => stores.analysis }));
vi.mock('../src/stores/resource-status', () => ({ useResourceStatusStore: () => stores.status }));
vi.mock('../src/stores/device-configuration-acceptance', () => ({ useDeviceConfigurationAcceptanceStore: () => stores.config }));
vi.mock('../src/stores/runtime-parameters', () => ({ useRuntimeParametersStore: () => stores.runtime }));
vi.mock('../src/components/MapCanvas.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceAnalysisPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceHistoryDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceMonitoringPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/LinkMonitoringPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SpectrumMonitoringPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceStatusPanel.vue', () => ({ default: defineComponent({ setup(_, { expose }) {
  expose({ requestLeave: async () => true, canRefreshDirectoryInBackground: () => false }); return () => null;
} }) }));
vi.mock('../src/components/InterferenceMeasureDrawer.vue', () => ({ default: defineComponent({ emits: ['openAdoption'], setup(_, { emit }) {
  return () => h('measure-probe', { onAdoption: (value: { adoptionId: string }) => emit('openAdoption', value) });
} }) }));
vi.mock('../src/components/InterferenceAdoptionDetailDrawer.vue', () => ({ default: defineComponent({
  props: ['visible', 'taskId', 'adoptionId', 'services'], emits: ['update:visible'], setup(props, { emit }) {
    return () => h('adoption-probe', { taskId: props.taskId, adoptionId: props.adoptionId, services: props.services,
      onClose: () => emit('update:visible', false) });
  },
}) }));
await clientTemplate(GisPlanOperations, 'src/components/GisPlanOperations.vue', 'gis-plan-operations-render.ts');
const component = readFileSync(
  new URL('../src/components/GisPlanOperations.vue', import.meta.url),
  'utf8',
);
const host = readFileSync(
  new URL('../src/components/GisFrozenPlanPanel.vue', import.meta.url),
  'utf8',
);
const situation = readFileSync(new URL('../src/views/SituationView.vue', import.meta.url), 'utf8');
const legacyMonitoring = readFileSync(
  new URL('../src/components/SituationMonitoringDrawer.vue', import.meta.url),
  'utf8',
);
const map = readFileSync(new URL('../src/components/MapCanvas.vue', import.meta.url), 'utf8');
// 静态接线门禁不替代子组实际组件、共享类型或真实页面验收。
describe('GIS跨组宿主静态边界', () => {
  it('只消费冻结网络和P06读取投影，不造监控帧或状态', () => {
    expect(component).toContain(':frozen-network="network"');
    expect(component).toContain(
      'status.project(device.id, props.network.identity.resource_revision)',
    );
    expect(component).not.toContain('loadMonitoringContext');
    expect(component).not.toContain('loadMonitoringFrame');
    expect(component).toContain('if (value) result[device.id] = value');
  });
  it('历史版本和专项权限共同限制写入，不借宽资源权限', () => {
    expect(component).toContain(':allow-import="sameResource && canImportStatus"');
    expect(component).toContain("can('resources.device.status.import')");
    expect(component).toContain("can('resources.device.edit')");
    expect(component).not.toContain("can('resources.edit')");
  });
  it('未核实写入/脏频谱保护贯穿方案切换和离页', () => {
    expect(component).toMatch(
      /configurationVisible\.value\s*&&\s*\(config\.pending\s*\|\|\s*config\.busy\)/,
    );
    expect(component).toMatch(/auth\.registerLeave\(\s*requestLeave/);
    expect(host).toContain('if (await requestLeave()) await model.openPlan(row)');
    expect(host).toContain('if (await requestLeave()) model.closeNetwork()');
    expect(situation).toContain('await frozenPanel.value.requestLeave()');
  });
  it('HTTP禁用旧自动观测宿主，频谱显式进入后挂载', () => {
    expect(situation).toContain('<SituationMonitoringDrawer v-if="!httpMode');
    expect(situation).toContain("() => !httpMode && auth.can('situation.view')");
    expect(component).toMatch(/<SpectrumMonitoringPanel\s+v-if="tab === 'spectrum'"/);
  });
  it('状态原始输入和配置抽屉接最终离开保护，未知提交不静默关闭', () => {
    expect(component).toContain('statusPanel.value.requestLeave()');
    expect(component).toContain('configurationPanel.value.requestLeave()');
    expect(component).toContain('@dirty="statusDirty = $event"');
    expect(component).toContain(':resource-revision="network.identity.resource_revision"');
    expect(situation).toContain('httpConfigurationPanel.value.requestLeave()');
  });
  it('干扰使用原始冻结投影和真实版本，采纳结果只有成功才可打开', () => {
    expect(component).toContain(':source-editable="false"');
    expect(component).toContain(':interference-projection="analysis.mapProjection"');
    expect(component).toContain("row.state === 'SUCCESS'");
    expect(component).not.toContain("planVersion: 'V1'");
    expect(situation).toContain('frozenPanel.value?.openIdentity({ taskId, planId })');
    expect(situation).not.toContain('analysis.selected.run.network');
  });
  it('采纳详情接E只读抽屉，查询身份取自已匹配的真实采纳而非猜当前任务', () => {
    expect(component).toContain('@open-adoption="openAdoptionDetail"');
    expect(component).toContain('<InterferenceAdoptionDetailDrawer');
    expect(component).toContain(':task-id="adoptionDetail.taskId"');
    expect(component).toContain(':adoption-id="adoptionDetail.adoptionId"');
    expect(component).toContain(':services="services.interferenceWorkbench"');
    expect(component).toContain('row.task_id !== run.task_id');
    expect(component).toContain('row.run_id !== run.run_id');
    expect(component).toContain('row.measure_id !== analysis.measureId');
    expect(component).toContain('row.source_hash !== run.source_hash');
    expect(component).toContain('taskId: row.task_id, adoptionId: row.adoption_id');
    expect(component).toContain('props.sessionGeneration, auth.generation');
    expect(component).toContain('props.services.interferenceWorkbench, analysis.readable, tab.value');
    expect(component).toContain('@update:visible="!$event && (adoptionDetail = null)"');
  });
  it('频谱只接显式成员引用，查看历史引用使用P06真实查询且可取消', () => {
    expect(component).toContain(':device-status-ref="observationStatusRef"');
    expect(component).toContain('@select-status-ref="viewObservationStatus"');
    expect(component).toContain('@select-dataset="cancelStatusRefRead"');
    expect(component).toContain('v-model="statusRefMembers"');
    expect(component).toContain('status.select(header, { complete: true })');
    expect(component).toMatch(/readObservationStatusHeader\(\s*props\.services\.deviceStatuses/);
    expect(component).not.toContain('deviceIds: props.network.devices.map');
  });
  it('按下来源用原生捕获和对称释放，故障快照仍保留真实站点转换', () => {
    expect(map).not.toContain("map.on('pointerdown'");
    expect(map).toContain("addEventListener('pointerdown', captureReadPress, true)");
    expect(map).toContain("removeEventListener('pointerdown', captureReadPress, true)");
    expect(situation).toContain("import { planStations } from '../services/planning-snapshot'");
    expect(situation).toContain('planStations(fault.network.value)');
  });
  it('独立分析保留显示控件，地图回调捕获投影身份，冻结入口可返回规划', () => {
    for (const label of [
      '显示干扰分析影响区域',
      '干扰分析影响区域透明度',
      '显示规划后链路',
      '拓扑透明度',
    ])
      expect(component).toContain(`aria-label="${label}"`);
    expect(component).toContain('@select-frozen-link="mapSelection.link"');
    expect(component).toContain('guardedAnalysisMapSelection(');
    expect(situation).toContain('v-if="frozenView && analysisReturn"');
  });
  it('刷新保护保留本地输入，明确保留原号关闭后不永远封锁离页', () => {
    expect(component).toContain("window.addEventListener('beforeunload', beforeUnload)");
    expect(component).toContain("window.removeEventListener('beforeunload', beforeUnload)");
    expect(component).toContain('auth.registerLeave(requestLeave, hasPending)');
    expect(situation).toContain('additionalPending: () => httpMode');
  });
  it('PAR1默认目录检查，显式跟随可读取全集，离页取消且不重启旧观测', () => {
    expect(component).toContain('useRuntimeParametersStore()');
    expect(component).toContain("runtime.snapshot?.values['PAR-01']");
    expect(component).toContain('canRefreshDirectoryInBackground()');
    expect(component).toContain('refreshDirectoryInBackground(signal)');
    expect(component).toContain('directoryRefresh.dispose()');
    expect(component).not.toContain('runtime.bind(');
    expect(component).not.toContain('status.list()');
    expect(component).not.toContain('setInterval(');
    expect(component).toContain(':allow-follow="sameResource"');
    expect(component).toContain('complete-snapshot');
    expect(component).toContain('验收风险：配置周期超过 60 秒');
    expect(component).toContain("emit('deviceStatus', value)");
    expect(host).toContain(':frozen-device-status="deviceStatus"');
    expect(map).toContain('observeGisDeviceStatusRender(map, statusDevices');
    expect(map).toContain("watch(() => props.frozenDeviceStatus, updateStatusDevices)");
  });
  it('旧监控包装不再裸挂需要HTTP服务的新组件，也不创建第二个客户端', () => {
    expect(legacyMonitoring).not.toContain('<SpectrumMonitoringPanel v-else />');
    expect(legacyMonitoring).toContain('v-else-if="observations"');
    expect(legacyMonitoring).toContain(':services="observations.services"');
    expect(legacyMonitoring).not.toContain('createHttpClient');
  });
  it('冻结页使隐藏资源控件旧回调失效，往返也不恢复旧代次', () => {
    const directory=situation.slice(situation.indexOf('const directoryEpoch = ref(0)'),situation.indexOf('const drawableTopologyIds'));
    expect(directory).toContain('() => frozenView.value');
    const actions=situation.slice(situation.indexOf('const topologyActions = computed'),situation.indexOf('const mapLayerInputs'));
    expect(actions).toMatch(/!frozenView\.value\s*&&\s*epoch === topologyEpoch\.value/);
    expect(actions).toContain('if (!current()) return');
    expect(actions).toContain('if (current()) links.value');
  });
});

let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
function mountAdoptionParent() {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  stores.auth = reactive({ blocked: false, generation: 1, identity: { permissions: ['resources.view', 'situation.view'] }, registerLeave: () => vi.fn() });
  stores.analysis = reactive({ mapProjection: null, filteredImpact: null, readable: true,
    selected: { task_id: 'adoption-task', run_id: 'run', source_hash: 'source' }, measureId: 'measure',
    adoptions: [{ adoption_id: 'adoption', task_id: 'adoption-task', run_id: 'run', measure_id: 'measure', source_hash: 'source' }],
    bindServices: vi.fn(), start: vi.fn(), stop: vi.fn(), prepareLeave: vi.fn(async () => true),
    dirty: false, busy: false, pendingScene: null, pendingWrites: [] });
  stores.status = reactive({ mode: 'baseline', batch: null, refreshMode: 'fixed', pendingImport: null,
    busy: false, cancel: vi.fn(), project: vi.fn(), setRefreshMode: vi.fn() });
  stores.config = reactive({ busy: false, pending: null });
  stores.runtime = reactive({ snapshot: null, loading: false, error: '', clearApplied: vi.fn(), reportApplied: vi.fn() });
  const network = { identity: { task_id: 'network-task', plan_id: 'plan', snapshot_id: 'network', resource_revision: 'resource' }, devices: [] } as unknown as GisNetwork;
  const props = reactive({ network, services: { interferenceWorkbench: { getAdoption: vi.fn(), getRun: vi.fn() } } as unknown as GisPlanOperationServices,
    sessionGeneration: 1, currentResourceRevision: 'resource', planVersion: 'V1', initialTab: 'interference' as const });
  const root = node('root');
  app = renderer.createApp({ render: () => h(GisPlanOperations, props) }); app.provide(ssrContextKey, {}); app.mount(root);
  return { root, props };
}
async function openAdoption(root: HostNode, adoptionId = 'adoption') {
  const measure = find(root, n => n.tag === 'measure-probe')!;
  expect(measure).toBeDefined();
  (measure.props.onAdoption as (value: { adoptionId: string }) => void)({ adoptionId }); await settle();
}

describe('GIS采纳详情真实父模板接线', () => {
  it('按钮事件打开E抽屉，使用真实采纳任务身份而非冻结网络任务，关闭后销毁', async () => {
    const s = mountAdoptionParent(); await openAdoption(s.root);
    const detail = find(s.root, n => n.tag === 'adoption-probe')!;
    expect(detail.props.taskId).toBe('adoption-task'); expect(detail.props.adoptionId).toBe('adoption');
    expect(detail.props.services).toBe(s.props.services.interferenceWorkbench);
    expect(s.props.services.interferenceWorkbench.getAdoption).not.toHaveBeenCalled();
    (detail.props.onClose as () => void)(); await settle(); expect(find(s.root, n => n.tag === 'adoption-probe')).toBeUndefined();
  });
  it.each(['task_id', 'run_id', 'measure_id', 'source_hash'] as const)('拒绝%s错配的原采纳，不向E抽屉传入猜测身份', async field => {
    const s = mountAdoptionParent(); stores.analysis.adoptions[0][field] = 'different'; await openAdoption(s.root);
    expect(find(s.root, n => n.tag === 'adoption-probe')).toBeUndefined(); expect(textOf(s.root)).toContain('该采纳与当前分析、措施或来源不一致');
  });
  it('拒绝不存在的采纳编号', async () => {
    const s = mountAdoptionParent(); await openAdoption(s.root, 'missing');
    expect(find(s.root, n => n.tag === 'adoption-probe')).toBeUndefined();
  });
  it.each(['network', 'session', 'generation', 'permission', 'analysis', 'measure', 'services', 'tab'] as const)('在%s切换时清理E抽屉选择，旧上下文不保留', async change => {
    const s = mountAdoptionParent(); await openAdoption(s.root); expect(find(s.root, n => n.tag === 'adoption-probe')).toBeDefined();
    if (change === 'network') s.props.network = { ...s.props.network, identity: { ...s.props.network.identity, snapshot_id: 'next-network' } };
    if (change === 'session') s.props.sessionGeneration++;
    if (change === 'generation') stores.auth.generation++;
    if (change === 'permission') stores.analysis.readable = false;
    if (change === 'analysis') stores.analysis.selected.run_id = 'next-run';
    if (change === 'measure') stores.analysis.measureId = 'next-measure';
    if (change === 'services') s.props.services = { ...s.props.services, interferenceWorkbench: { ...s.props.services.interferenceWorkbench } };
    if (change === 'tab') {
      const tab = find(s.root, n => n.props.role === 'tab' && textOf(n) === '链路态势')!;
      await (tab.props.onClick as () => Promise<void>)();
    }
    await settle(); expect(find(s.root, n => n.tag === 'adoption-probe')).toBeUndefined();
  });
});
