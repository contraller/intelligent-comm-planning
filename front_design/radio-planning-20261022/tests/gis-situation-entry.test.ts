import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { all, clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';
import { allPermissions, safeReturnPath } from '../src/config/permissions';

const probes = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, fit: vi.fn(), terrain: vi.fn(), dispose: vi.fn(), preview: vi.fn(), hover: undefined as ((ids: string[]) => void) | undefined }));
vi.mock('../src/config/env', () => ({ env: { mode: 'mock', apiBaseUrl: '/api/v1', sampleData: true } }));
vi.mock('../src/services/terrain-basemap', () => ({ loadTerrainBasemap: probes.terrain }));
vi.mock('../src/components/MapCanvas.vue', () => ({ default: {
  props: { stations: Array, frozenNetwork: Object, terrainBasemap: Object, frozenCoverage: Object, hoverPreview: Object,
    readonlySituation: Boolean, showRoads: Boolean, showLinks: Boolean, showCoverage: Boolean },
  emits: ['hoverFrozenDevices'],
  setup(props: Record<string, unknown>, { expose, emit }: { expose: (value: unknown) => void; emit: (name: string, ids: string[]) => void }) {
    probes.hover = ids => emit('hoverFrozenDevices', ids);
    probes.props = props; expose({ fitAll: probes.fit, returnFrozenNetwork: vi.fn(), focusFrozenCoverage: vi.fn() }); return () => h('div', { 'data-map': 'readonly' });
  },
} }));
vi.mock('../src/components/RequestState.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceEditDrawer.vue', () => ({ default: { render: () => h('div', { 'data-drawer': 'edit' }) } }));
vi.mock('../src/components/ResourceImportDrawer.vue', () => ({ default: { render: () => h('div', { 'data-drawer': 'import' }) } }));
vi.mock('../src/components/IntegrationIdentitySwitcher.vue', () => ({ default: { render: () => h('div', { 'data-identity-switch': true }) } }));

import AppShell from '../src/layouts/AppShell.vue';
import GisSituationView from '../src/views/GisSituationView.vue';
import { useAuthStore } from '../src/stores/auth';
import { usePreviewStore } from '../src/stores/preview';

const Shell = { ...AppShell }, Situation = { ...GisSituationView };
beforeAll(async () => {
  await clientTemplate(Shell, 'src/layouts/AppShell.vue', 'gis-situation-shell-render.ts');
  await clientTemplate(Situation, 'src/views/GisSituationView.vue', 'gis-situation-entry-render.ts');
});
let pinia: ReturnType<typeof createPinia> | undefined, app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; probes.props = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); probes.fit.mockReset(); probes.terrain.mockReset(); probes.dispose.mockReset(); });
async function settle() { for (let index = 0; index < 12; index++) await nextTick(); }
async function mount() {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {}); vi.stubGlobal('window', new EventTarget());
  probes.terrain.mockResolvedValue({ url: 'blob:verified', source: '本地受控DEM', extent: [113, 36, 115, 38], dispose: probes.dispose });
  pinia = createPinia(); setActivePinia(pinia);
  const auth = useAuthStore(); auth.accept({ id: 'local-single-user', sessionId: 'local-session', username: 'local', name: '本机使用', roleId: 'local', roleName: '统一业务权限', epoch: 'one', revision: '1', permissions: [...allPermissions], singleUserMode: true, allowSelfReview: true, authSource: 'LOCAL_SINGLE_USER' });
  const preview = usePreviewStore(), load = vi.spyOn(preview, 'load');
  // 现用资源即使不可读取，也不能使随包提供的默认态势消失。
  preview.error = '当前资源服务不可用';
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: Shell, children: [
    { path: 'situation', component: Situation },
    ...['gis-workbench', 'resources', 'planning', 'diagnosis', 'knowledge', 'system'].map(path => ({ path, component: { render: () => h('div', { 'data-module': path }, path) } })),
  ] }] });
  await router.push('/situation'); await router.isReady();
  const root = node('root'); app = renderer.createApp({ render: () => h(RouterView) });
  app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
  return { root, router, auth, load };
}

describe('GIS首页在真实壳层中的入口', () => {
  it('无页眉页脚、菜单默认收起，资源读取失败仍显示随包示例且不装配抽屉', async () => {
    const s = await mount();
    expect(all(s.root, n => n.tag === 'header' || n.tag === 'footer')).toHaveLength(0);
    const button = find(s.root, n => n.props['aria-controls'] === 'application-menu')!;
    expect(button.props['aria-expanded']).toBe(false);
    expect(find(s.root, n => n.props['data-map'] === 'readonly')).toBeDefined();
    expect(find(s.root, n => !!n.props['data-drawer'])).toBeUndefined(); expect(s.load).not.toHaveBeenCalled();
    expect(find(s.root, n => !!n.props['data-identity-switch'])).toBeUndefined();
    expect(probes.props?.readonlySituation).toBe(true);
    expect(probes.props?.showRoads).toBe(false);
    expect(probes.props?.frozenNetwork).toEqual(expect.objectContaining({ identity: expect.objectContaining({ plan_id: 'GIS-EXAMPLE-TAIHANG-1' }) }));
    expect(probes.props?.hoverPreview).toEqual(expect.objectContaining({ source: expect.stringContaining('构造示例') }));
    expect(textOf(s.root)).toContain('非实测');
  });
  it('鼠标进入后再点击仍展开同一菜单；独立收起按钮、Escape与地图外侧点击关闭', async () => {
    const s = await mount(), button = find(s.root, n => n.props['aria-controls'] === 'application-menu')!;
    (button.props.onMouseenter as () => void)(); await settle();
    // 浏览器真实顺序是先mouseenter再click；两者必须幂等打开，不能在第一次点击时反向关闭。
    (button.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation() {} }); await settle();
    expect(button.props['aria-expanded']).toBe(true);
    const menu = find(s.root, n => n.props.id === 'application-menu')!;
    expect(all(menu, n => n.tag === 'a')).toHaveLength(7);
    expect(textOf(menu)).toContain('GIS 工作台'); expect(textOf(menu)).toContain('刷新当前转正态势'); expect(textOf(menu)).toContain('切换已保存方案');
    expect(textOf(menu)).not.toContain('道路');
    const picker = find(menu, n => n.tag === 'details')!, target = { open: false, closest: (_selector: string): unknown => target };
    (picker.props.onMouseenter as (event: { currentTarget: unknown }) => void)({ currentTarget: target }); await settle();
    expect(target.open).toBe(true);
    const summary = find(picker, n => n.tag === 'summary')!;
    (summary.props.onClick as (event: { currentTarget: unknown; preventDefault(): void }) => void)({ currentTarget: target, preventDefault() {} }); await settle();
    expect(target.open).toBe(true);
    const fit = find(menu, n => n.tag === 'button' && textOf(n) === '全域查看')!;
    (fit.props.onClick as () => void)(); expect(probes.fit).toHaveBeenCalledOnce();
    const root = find(s.root, n => String(n.props.class).includes('app-shell'))!;
    const close = find(menu, n => n.props['aria-label'] === '收起功能菜单')!;
    (close.props.onClick as () => void)(); await settle(); expect(button.props['aria-expanded']).toBe(false);
    (button.props.onMouseenter as () => void)(); await settle(); expect(button.props['aria-expanded']).toBe(true);
    (root.props.onKeydown as (event: { key: string }) => void)({ key: 'Escape' }); await settle(); expect(button.props['aria-expanded']).toBe(false);
    (button.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation() {} }); await settle(); expect(button.props['aria-expanded']).toBe(true);
    (root.props.onClick as (event: Event) => void)(new Event('click')); await settle(); expect(button.props['aria-expanded']).toBe(false);
  });
  it('地图悬浮事件只显示该节点已有覆盖，移到缺缓存节点不会保留另一节点覆盖', async () => {
    const s = await mount();
    expect(probes.props?.frozenCoverage).toBeNull();
    probes.hover!(['EXAMPLE-ND-0037-HF']); await settle();
    expect(probes.props?.frozenCoverage).toEqual(expect.objectContaining({ deviceId: 'EXAMPLE-ND-0037-HF' }));
    probes.hover!(['EXAMPLE-ND-0001-HF']); await settle(); expect(probes.props?.frozenCoverage).toBeNull();
    expect(find(s.root, n => !!n.props['data-drawer'])).toBeUndefined(); expect(s.load).not.toHaveBeenCalled();
  });
  it('正常及历史工作台定位均保留同样严格的返回地址校验', () => {
    expect(safeReturnPath('/situation')).toBe('/situation'); expect(safeReturnPath('/gis-workbench')).toBe('/gis-workbench');
    for (const base of ['/situation', '/gis-workbench']) {
      expect(safeReturnPath(base + '?faultEdit=1&scenarioId=SC-1&versionId=V1')).not.toBeNull();
      expect(safeReturnPath(base + '?analysisTaskId=T1&analysisPlanId=P1')).not.toBeNull();
      expect(safeReturnPath(base + '?analysisTaskId=T1')).toBeNull();
      expect(safeReturnPath(base + '?deviceId=A&deviceId=B')).toBeNull();
      expect(safeReturnPath(base + '?unknown=1')).toBeNull();
    }
  });
});
