import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import GisFrozenPlanPanel from '../src/components/GisFrozenPlanPanel.vue';
import type { GisFrozenPlanServices } from '../src/stores/gis-frozen-plan';
import type { GisNetwork } from '../src/types/gis-plan';
import type { PlanningCoverage } from '../src/types/coverage';
import { gisDeviceStatusKey, type GisDeviceStatusOverlay } from '../src/maps/gis-device-status-layer';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
vi.mock('../src/components/MapCanvas.vue', () => ({ default: defineComponent({ name: 'MapCanvas', props: ['frozenNetwork', 'frozenDeviceStatus', 'planningOverlay', 'showCoverage', 'coverageDisplay'], emits: ['deviceStatusRendered'], setup(props, { emit }) { return () => h('frozen-map-probe', { snapshot: props.frozenNetwork?.identity.snapshot_id, status: props.frozenDeviceStatus, overlay: props.planningOverlay, showCoverage: props.showCoverage, coverageDisplay: props.coverageDisplay, onDraw: (value: unknown) => emit('deviceStatusRendered', value) }); } }) }));
// 子组业务组件须在总集成验证；本文件只执行目录/网络宿主，避免把组件桩当真实联调。
vi.mock('../src/components/GisPlanOperations.vue', () => ({ default: defineComponent({ emits: ['deviceStatus'], setup(_, { emit, expose }) { expose({ requestLeave: async () => true, selectDevice() {} }); return () => h('operations-probe', { onStatus: (value: unknown) => emit('deviceStatus', value) }); } }) }));
// 重新挂载共享配置组件时探针会出现；不得用隐藏样式代替从 GIS 结构移除。
vi.mock('../src/components/FrozenCoveragePanel.vue', () => ({ default: defineComponent({ setup() { return () => h('coverage-probe'); } }) }));
await clientTemplate(GisFrozenPlanPanel, 'src/components/GisFrozenPlanPanel.vue', 'gis-frozen-plan-render.ts');
let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; });
async function settle() { for (let i = 0; i < 16; i++) await nextTick(); }
function setup(empty = false, operations = false, coverage: PlanningCoverage | null = null) {
  const network: GisNetwork = { identity: { plan_id: 'P', task_id: 'T', snapshot_id: 'S', input_version: 'I', condition_version: 'C', resource_revision: 'R', state: 'CONFIRMED', source_changed: true, source: 'SR4', data_origin: 'SYNTHETIC_INTEGRATION' },
    nodes: [{ id: 'A', name: '冻结节点A', coordinate: [114, 37], status: null, alert: null }], devices: [], links: [], demands: [], routes: [], paths_state: 'missing', paths_message: '未提供路径' };
  const summary = { id: 'P', taskId: 'T', name: '冻结方案', version: 'V1', state: 'CONFIRMED' as const, current: true, sourceChanged: true, savedAt: '2026-10-23T00:00:00Z' };
  const services: GisFrozenPlanServices = { queryPlans: vi.fn(async input => ({ items: empty ? [] : [summary], total: empty ? 0 : 1, pageNum: input.pageNum, pageSize: input.pageSize })),
    plans: { getNetwork: vi.fn(async () => network), getSurface: vi.fn(async () => ({ identity: network.identity, terrain: null, terrain_notice: '历史地形未提供', coverage, coverage_notice: coverage ? '' : '覆盖未提供' })), getLink: vi.fn(), getPaths: vi.fn() } };
  const props = reactive({ services, sessionGeneration: 1, ...(operations ? { operations: {} as import('../src/types/gis-plan').GisPlanOperationServices } : {}) }), root = node('root');
  app = renderer.createApp({ render: () => h(GisFrozenPlanPanel, props) }); app.provide(ssrContextKey, {}); app.mount(root);
  return { root, props, services };
}
async function click(root: HostNode, label: string) {
  const button = find(root, row => row.tag === 'button' && textOf(row).trim() === label); expect(button, label).toBeDefined();
  await (button!.props.onClick as () => unknown)(); await settle();
}
describe('GIS冻结方案专用面板', () => {
  it('打开目录不默认打开任何网络，显示真实来源和可操作按钮', async () => {
    const s = setup(); await settle(); expect(s.services.queryPlans).toHaveBeenCalledOnce(); expect(s.services.plans.getNetwork).not.toHaveBeenCalled();
    expect(textOf(s.root)).toContain('冻结方案'); expect(textOf(s.root)).toContain('来源已变化，历史保留');
  });
  it('显式打开读取冻结网络/地形，保留未知地形而不显示实测成功', async () => {
    const s = setup(); await settle(); await click(s.root, '打开冻结网络');
    expect(s.services.plans.getNetwork).toHaveBeenCalledWith({ planId: 'P', taskId: 'T' }, expect.any(AbortSignal));
    expect(find(s.root, row => row.tag === 'frozen-map-probe')?.props.snapshot).toBe('S');
    expect(textOf(s.root)).toContain('算法预测'); expect(textOf(s.root)).toContain('历史地形未提供');
    expect(textOf(s.root)).toContain('方案 V1 · P'); expect(textOf(s.root)).toContain('所属任务：T');
    await click(s.root, '关闭网络'); expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeUndefined();
  });
  it('空目录明确提示，不能凭空显示网络', async () => {
    const s = setup(true); await settle(); expect(textOf(s.root)).toContain('暂无已保存方案');
    expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeUndefined();
  });
  it('打开及重新打开冻结网络均不挂载覆盖配置，仍保留地图详情和业务宿主', async () => {
    const s = setup(false, true); await settle(); await click(s.root, '打开冻结网络');
    const assertWorkspace = () => {
      expect(find(s.root, row => row.tag === 'coverage-probe')).toBeUndefined();
      expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeDefined();
      expect(find(s.root, row => row.tag === 'operations-probe')).toBeDefined();
      expect(textOf(find(s.root, row => row.tag === 'aside')!)).toContain('1 节点 / 0 链路');
      expect(textOf(s.root)).not.toContain('冻结规划覆盖');
      expect(textOf(s.root)).not.toContain('读取覆盖缓存');
    };
    assertWorkspace();
    await click(s.root, '关闭网络'); await click(s.root, '打开冻结网络'); assertWorkspace();
    expect(s.services.plans.getNetwork).toHaveBeenCalledTimes(2);
    expect(s.services.plans.getSurface).toHaveBeenCalledTimes(2);
  });
  it('已有覆盖仍通过同快照只读结果交给地图，显示偏好不再读取或计算', async () => {
    const coverage: PlanningCoverage = { contour: { type: 'FeatureCollection', features: [{
      type: 'Feature', id: 'C1', properties: { level: 'strong', field_strength_dbuvm_min: 40 },
      geometry: { type: 'Polygon', coordinates: [[[114, 37], [114.1, 37], [114, 37.1], [114, 37]]] },
    }] }, rasterPng: null };
    const s = setup(false, false, coverage); await settle(); await click(s.root, '打开冻结网络');
    expect(s.services.plans.getSurface).toHaveBeenCalledWith({ planId: 'P', taskId: 'T', snapshotId: 'S' }, expect.anything(), expect.any(AbortSignal));
    const map = () => find(s.root, row => row.tag === 'frozen-map-probe')!;
    expect(map().props.overlay).toEqual({ nodes: [], coverage, snapshotId: 'S' });
    expect(map().props.showCoverage).toBe(true); expect(map().props.coverageDisplay).toBe('auto');
    const toggle = find(s.root, row => row.tag === 'input' && row.props.type === 'checkbox')!;
    expect(toggle.props.disabled).toBe(false);
    (toggle.props['onUpdate:modelValue'] as Function)(false);
    const display = find(s.root, row => row.props['aria-label'] === '覆盖显示方式')!;
    (display.props['onUpdate:modelValue'] as Function)('contour'); await settle();
    expect(map().props.showCoverage).toBe(false); expect(map().props.coverageDisplay).toBe('contour');
    expect(map().props.overlay).toEqual({ nodes: [], coverage, snapshotId: 'S' });
    expect(s.services.plans.getSurface).toHaveBeenCalledOnce();
    expect(s.services.plans.getNetwork).toHaveBeenCalledOnce();
    await click(s.root, '关闭网络');
    vi.mocked(s.services.plans.getSurface).mockImplementationOnce(async (_query, network) => ({ identity: network.identity, terrain: null, terrain_notice: '历史地形未提供', coverage: null, coverage_notice: '覆盖未提供' }));
    await click(s.root, '打开冻结网络');
    expect(map().props.overlay).toBeNull(); expect(textOf(s.root)).toContain('覆盖未提供');
    expect(find(s.root, row => row.props['aria-label'] === '覆盖显示方式')?.props.disabled).toBe(true);
  });
  it('读取错误保留明确失败，不能假装方案已打开', async () => {
    const s = setup(); vi.mocked(s.services.plans.getNetwork).mockRejectedValueOnce(new Error('方案不可见'));
    await settle(); await click(s.root, '打开冻结网络'); expect(textOf(s.root)).toContain('方案不可见');
    expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeUndefined();
  });
  it('换会话关闭上一身份网络并重新读取目录，无自动轮询', async () => {
    const s = setup(); await settle(); await click(s.root, '打开冻结网络'); s.props.sessionGeneration++; await settle();
    expect(s.services.queryPlans).toHaveBeenCalledTimes(2); expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeUndefined();
    await settle(); expect(s.services.queryPlans).toHaveBeenCalledTimes(2);
  });
  it('shows a visible completion anchor only after the current map reports the matching rendered version', async () => {
    const s = setup(false, true); await settle(); await click(s.root, '打开冻结网络');
    const value: GisDeviceStatusOverlay = { taskId: 'T', planId: 'P', networkSnapshotId: 'S', anchor: { snapshotId: 'DSS-test', snapshotRevision: 'status-v1', resourceRevision: 'R' }, projections: {}, appliedAt: '2026-10-24T10:00:00.000Z', selectedDeviceId: '' };
    const operations = find(s.root, n => n.tag === 'operations-probe')!;
    (operations.props.onStatus as Function)(value); await settle();
    const anchor = () => find(s.root, n => n.props['data-testid'] === 'gis-device-status-render');
    expect(textOf(anchor()!)).toContain('等待地图绘制完成'); expect(anchor()!.props['data-rendered-at']).toBe('');
    const map = find(s.root, n => n.tag === 'frozen-map-probe')!;
    expect(map.props.status).toMatchObject(value);
    const rendered = { key: gisDeviceStatusKey(value), ...value.anchor, appliedAt: value.appliedAt, renderedAt: '2026-10-24T10:00:01.000Z', pointCount: 414 };
    (map.props.onDraw as Function)({ ...rendered, key: 'old' }); await settle(); expect(anchor()!.props['data-rendered-at']).toBe('');
    (map.props.onDraw as Function)(rendered); await settle();
    expect(textOf(anchor()!)).toContain('地图绘制完成 2026-10-24T10:00:01.000Z'); expect(anchor()!.props['data-snapshot-revision']).toBe('status-v1');
    (operations.props.onStatus as Function)({ ...value, anchor: { ...value.anchor, snapshotRevision: 'status-v2' } }); await settle();
    expect(anchor()!.props['data-rendered-at']).toBe('');
    (map.props.onDraw as Function)(rendered); await settle(); expect(anchor()!.props['data-rendered-at']).toBe('');
    (operations.props.onStatus as Function)({ ...value, networkSnapshotId: 'foreign' }); await settle(); expect(anchor()).toBeUndefined();
    await click(s.root, '关闭网络'); expect(anchor()).toBeUndefined();
  });
});
