import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import GisFrozenPlanPanel from '../src/components/GisFrozenPlanPanel.vue';
import type { GisFrozenPlanServices } from '../src/stores/gis-frozen-plan';
import type { GisNetwork } from '../src/types/gis-plan';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
vi.mock('../src/components/MapCanvas.vue', () => ({ default: defineComponent({ name: 'MapCanvas', props: ['frozenNetwork'], setup(props) { return () => h('frozen-map-probe', { snapshot: props.frozenNetwork?.identity.snapshot_id }); } }) }));
await clientTemplate(GisFrozenPlanPanel, 'src/components/GisFrozenPlanPanel.vue', 'gis-frozen-plan-render.ts');
let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; });
async function settle() { for (let i = 0; i < 16; i++) await nextTick(); }
function setup(empty = false) {
  const network: GisNetwork = { identity: { plan_id: 'P', task_id: 'T', snapshot_id: 'S', input_version: 'I', condition_version: 'C', resource_revision: 'R', state: 'CONFIRMED', source_changed: true, source: 'SR4', data_origin: 'SYNTHETIC_INTEGRATION' },
    nodes: [{ id: 'A', name: '冻结节点A', coordinate: [114, 37], status: null, alert: null }], devices: [], links: [], demands: [], routes: [], paths_state: 'missing', paths_message: '未提供路径' };
  const summary = { id: 'P', taskId: 'T', name: '冻结方案', version: 'V1', state: 'CONFIRMED' as const, current: true, sourceChanged: true, savedAt: '2026-10-23T00:00:00Z' };
  const services: GisFrozenPlanServices = { queryPlans: vi.fn(async input => ({ items: empty ? [] : [summary], total: empty ? 0 : 1, pageNum: input.pageNum, pageSize: input.pageSize })),
    plans: { getNetwork: vi.fn(async () => network), getSurface: vi.fn(async () => ({ identity: network.identity, terrain: null, terrain_notice: '历史地形未提供', coverage: null, coverage_notice: '覆盖未提供' })), getLink: vi.fn(), getPaths: vi.fn() } };
  const props = reactive({ services, sessionGeneration: 1 }), root = node('root');
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
    expect(textOf(s.root)).toContain('算法预测，非实测'); expect(textOf(s.root)).toContain('历史地形未提供');
    await click(s.root, '关闭网络'); expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeUndefined();
  });
  it('空目录明确提示，不能凭空显示网络', async () => {
    const s = setup(true); await settle(); expect(textOf(s.root)).toContain('暂无已保存方案');
    expect(find(s.root, row => row.tag === 'frozen-map-probe')).toBeUndefined();
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
});
