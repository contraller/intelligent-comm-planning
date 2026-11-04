import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { authorizeStore } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { allPermissions, routePermissions, safeReturnPath } from '../src/config/permissions';
import {
  createEmbeddedRouter, embeddedContextRoutes, embeddedModules, embeddedNavigationTarget,
  embeddedPageUrl, embeddedPages, embeddedPath, isEmbeddedPath, modulePath,
} from '../src/config/embedded-pages';
import AppShell from '../src/layouts/AppShell.vue';
import EmbedShell from '../src/layouts/EmbedShell.vue';

// Run the actual application route records and guards without a browser or business data calls.
vi.mock('vue-router', async original => {
  const actual = await original<typeof import('vue-router')>();
  return { ...actual, createWebHashHistory: () => actual.createMemoryHistory() };
});
vi.mock('../src/views/GisSituationView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/SituationView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/ResourcesView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/PlanningApiView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/DiagnosisView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/KnowledgeView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/SystemView.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/views/LoginView.vue', () => ({ default: { render: () => null } }));
import { router } from '../src/router';

let pinia: ReturnType<typeof createPinia>;
beforeEach(async () => {
  vi.stubGlobal('document', { title: '' });
  pinia = createPinia(); setActivePinia(pinia);
  const auth = useAuthStore();
  auth.accept(null); vi.spyOn(auth, 'check').mockResolvedValue(true);
  await router.replace('/login');
  authorizeStore();
});
afterEach(() => { disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('独立模块路由目录', () => {
  it.each(embeddedModules)('$id复用业务组件但使用独立嵌入外壳和同一权限', async module => {
    await router.push('/' + module.id);
    const normal = router.currentRoute.value;
    await router.push('/embed/' + module.id);
    const embedded = router.currentRoute.value;
    expect(normal.matched[0].components?.default).toBe(AppShell);
    expect(embedded.matched[0].components?.default).toBe(EmbedShell);
    expect(normal.matched.at(-1)?.components?.default).toBe(embedded.matched.at(-1)?.components?.default);
    expect(embedded.meta.embedded).toBe(true);
    expect(routePermissions[embedded.path]).toBe(module.permission);
  });
  it('18个固定功能页均有受校验的独立链接，不带账号或页面查询凭据', () => {
    expect(embeddedPages).toHaveLength(18);
    for (const page of embeddedPages) {
      const url = new URL(embeddedPageUrl('http://user:password@127.0.0.1:18480/radio/?token=private#/planning', page));
      expect(url.origin).toBe('http://127.0.0.1:18480'); expect(url.pathname).toBe('/radio/');
      expect(url.username).toBe(''); expect(url.password).toBe(''); expect(url.search).toBe('');
      expect(safeReturnPath(url.hash.slice(1))).not.toBeNull();
      expect(router.resolve(url.hash.slice(1)).meta.embedded).toBe(true);
    }
  });
  it.each(['/embed', '/embed/', '/embed/planning', '/embed/resources?tab=ledger'])('识别已知独立路由 %s', path => {
    expect(isEmbeddedPath(path)).toBe(true);
  });
  it.each(['/embedded/planning', '/embed/unknown', '/embed/planning/extra', 'https://outside/embed/planning'])('不把未知路径当作独立业务页 %s', path => {
    expect(isEmbeddedPath(path)).toBe(false);
  });
  it('逻辑路径与目标转换保持功能参数，不改外部或登录目标', () => {
    expect(modulePath('/embed/planning?taskId=T%3A1&jobId=J%2F2')).toBe('/planning?taskId=T%3A1&jobId=J%2F2');
    expect(embeddedNavigationTarget({ path: '/planning', query: { taskId: '任务:甲', planId: '方案/乙' }, state: { source: 'GIS' } }))
      .toEqual({ path: '/embed/planning', query: { taskId: '任务:甲', planId: '方案/乙' }, state: { source: 'GIS' } });
    expect(embeddedPath('/login')).toBe('/login'); expect(embeddedPath('https://outside/page')).toBe('https://outside/page');
    expect(embeddedContextRoutes.map(route => route.id)).toContain('gis-analysis');
  });
});

describe('独立页面导航上下文和权限', () => {
  it.each([
    ['', '短波／超短波设备'], ['ledger', '短波／超短波设备'], ['frequencies', '规划频点'],
    ['spectrum-config', '频谱接口管理'], ['spectrum-monitor', '频谱观测'],
  ])('资源独立入口 %s 使用对应功能的页面标题，完整系统仍使用资源管理标题', async (tab, title) => {
    await router.replace('/login');
    await router.push('/resources');
    expect(document.title).toBe('资源管理 · 无线网络智能规划系统');
    await router.push({ path: '/embed/resources', query: tab ? { tab } : {} });
    expect(document.title).toBe(title + ' · 无线网络智能规划系统');
  });
  it('工作台定位和干扰入口保留参数，旧态势定位仍进入独立工作台', async () => {
    await router.push('/embed/planning?taskId=T1');
    const scoped = createEmbeddedRouter(router);
    await scoped.push({ path: '/situation', query: { stationId: '节点:甲', deviceId: '设备/乙' } });
    expect(router.currentRoute.value.path).toBe('/embed/gis-workbench');
    expect(router.currentRoute.value.query).toEqual({ stationId: '节点:甲', deviceId: '设备/乙' });
    expect(scoped.currentRoute.value.path).toBe('/gis-workbench');
    await scoped.push({ path: '/situation', query: { analysisTaskId: '任务/1', analysisPlanId: '方案:2' } });
    expect(router.currentRoute.value.path).toBe('/embed/gis-workbench');
    expect(router.currentRoute.value.query).toEqual({ analysisTaskId: '任务/1', analysisPlanId: '方案:2' });
  });
  it('模块URL同步使用逻辑fullPath，RouterLink href仍指向独立页面', async () => {
    await router.push('/embed/planning?taskId=T1');
    const scoped = createEmbeddedRouter(router), events: string[] = [];
    const release = scoped.afterEach((to, from) => { events.push(from.path + '→' + to.path); });
    try {
      const target = scoped.resolve({ path: '/planning', query: { taskId: 'T1', jobId: 'J1' } });
      expect(target.fullPath).toBe('/planning?taskId=T1&jobId=J1'); expect(target.href).toContain('/embed/planning');
      await scoped.replace(target.fullPath);
      expect(router.currentRoute.value.fullPath).toBe('/embed/planning?taskId=T1&jobId=J1');
      expect(scoped.currentRoute.value.fullPath).toBe(target.fullPath);
      await scoped.push('/diagnosis?scenarioId=S1&versionId=V1');
      expect(events.at(-1)).toBe('/planning→/diagnosis');
      expect(router.currentRoute.value.path).toBe('/embed/diagnosis');
    } finally { release(); }
  });
  it('全局业务链接与后退仍保留嵌入外壳，普通系统继续使用原路由', async () => {
    await router.push('/planning'); await router.push('/diagnosis');
    expect(router.currentRoute.value.path).toBe('/diagnosis');
    await router.push('/embed/resources?tab=frequencies');
    await router.push('/planning?taskId=T1&planId=P1');
    expect(router.currentRoute.value.path).toBe('/embed/planning');
    await new Promise<void>(resolve => { const off = router.afterEach(() => { off(); resolve(); }); router.back(); });
    expect(router.currentRoute.value.fullPath).toBe('/embed/resources?tab=frequencies');
  });
  it('无权限独立直达回落到允许的独立页，不进入带菜单的完整系统', async () => {
    const auth = useAuthStore(); auth.accept({ ...auth.identity!, permissions: ['resources.view'] });
    await router.push('/embed/knowledge');
    expect(router.currentRoute.value.path).toBe('/embed/resources');
  });
  it('会话不可用时保留独立页返回目标，不通过路由放开权限', async () => {
    useAuthStore().accept(null);
    await router.push('/embed/planning?taskId=T1&planId=P1');
    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.next).toBe('/embed/planning?taskId=T1&planId=P1');
  });
  it('未知独立页与尾斜线回落仍在独立命名空间', async () => {
    await router.push('/embed/unknown'); expect(router.currentRoute.value.path).toBe('/embed/situation');
    await router.push('/embed/planning/'); expect(router.currentRoute.value.path).toBe('/embed/planning');
  });
  it.each([
    '/embed/resources?tab=unknown', '/embed/system?tab=accounts&tab=roles',
    '/embed/planning?taskId=T1&planId=P1&jobId=J1', '/embed/gis-workbench?analysisTaskId=T1',
    '/embed/gis-workbench?analysisTaskId=T1&analysisPlanId=P1&deviceId=D1',
    '/embed/diagnosis?scenarioId=S1', '/embed/unknown', '/embed/knowledge?next=https://outside',
  ])('返回地址继续拒绝未知或混合上下文 %s', path => expect(safeReturnPath(path)).toBeNull());
});

describe('原生无导航业务装配', () => {
  async function render(embedded: boolean) {
    const memory = createRouter({ history: createMemoryHistory(), routes: embeddedModules.map(module => ({ path: '/' + module.id, component: { render: () => h('div', { 'data-business': true }, '业务主体') } })) });
    await memory.push('/planning');
    const app = createSSRApp(AppShell, { embedded }); app.use(pinia); app.use(memory);
    return renderToString(app);
  }
  it('嵌入业务壳不生成汉堡、全局导航或账号菜单，业务主体仍可显示', async () => {
    useAuthStore().accept({ ...useAuthStore().identity!, permissions: allPermissions });
    const html = await render(true);
    expect(html).toContain('业务主体'); expect(html).toContain('embedded-business-shell');
    expect(html).not.toContain('application-menu-toggle'); expect(html).not.toContain('aria-label="主导航"');
    expect(html).not.toContain('id="application-menu"');
  });
  it('完整系统仍生成自己的功能菜单和汉堡', async () => {
    const html = await render(false);
    expect(html).toContain('application-menu-toggle'); expect(html).toContain('id="application-menu"');
    expect(html).toContain('业务主体');
  });
});
