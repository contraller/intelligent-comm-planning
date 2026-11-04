import { computed } from 'vue';
import type { RouteLocationNormalized, RouteLocationNormalizedLoaded, RouteLocationRaw, Router } from 'vue-router';
import type { Permission } from './permissions';

export const embeddedModules = [
  { id: 'situation', title: 'GIS态势', permission: 'situation.view' },
  { id: 'gis-workbench', title: 'GIS工作台', permission: 'situation.view' },
  { id: 'resources', title: '资源管理', permission: 'resources.view' },
  { id: 'planning', title: '网络规划', permission: 'planning.view' },
  { id: 'diagnosis', title: '故障诊断', permission: 'diagnosis.view' },
  { id: 'knowledge', title: '知识图谱', permission: 'knowledge.view' },
  { id: 'system', title: '系统管理', permission: 'system.view' },
] as const satisfies readonly { id: string; title: string; permission: Permission }[];

export type EmbeddedModuleId = typeof embeddedModules[number]['id'];
export const embeddedModuleIds = embeddedModules.map(module => module.id);
const moduleIds = new Set<string>(embeddedModuleIds);
const splitPath = (value: string) => {
  const index = value.search(/[?#]/);
  return index < 0 ? [value, ''] as const : [value.slice(0, index), value.slice(index)] as const;
};

/** Only the dedicated, known module routes identify an embedded page. */
export function isEmbeddedPath(value: string): boolean {
  const [path] = splitPath(value);
  return path === '/embed' || path === '/embed/' ||
    path.startsWith('/embed/') && moduleIds.has(path.slice(7).replace(/\/$/, ''));
}

/** Business components use their original logical path; query/hash values are untouched. */
export function modulePath(value: string): string {
  const [path, suffix] = splitPath(value);
  if (!isEmbeddedPath(path)) return value;
  return (path === '/embed' || path === '/embed/' ? '/situation' : path.slice(6).replace(/\/$/, '')) + suffix;
}

/** Scope a known business destination, never a login or an external/unknown location. */
export function embeddedPath(value: string): string {
  const [path, suffix] = splitPath(value);
  if (isEmbeddedPath(path)) return '/embed' + modulePath(path) + suffix;
  if (path === '/') return '/embed/situation' + suffix;
  const normal = path.replace(/\/$/, '');
  return moduleIds.has(normal.slice(1)) && normal.startsWith('/')
    ? '/embed' + normal + suffix : value;
}

export function embeddedNavigationTarget(to: RouteLocationRaw): RouteLocationRaw {
  if (typeof to === 'string') return embeddedPath(to);
  return 'path' in to && typeof to.path === 'string' ? { ...to, path: embeddedPath(to.path) } : to;
}

export function moduleRoute<T extends RouteLocationNormalized | RouteLocationNormalizedLoaded>(route: T): T {
  return new Proxy(route, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return (key === 'path' || key === 'fullPath') && typeof value === 'string' ? modulePath(value) : value;
    },
  });
}

/** Preserve existing module URL synchronization and leave cleanup inside the embed namespace. */
export function createEmbeddedRouter(router: Router): Router {
  const currentRoute = computed(() => moduleRoute(router.currentRoute.value));
  const resolve = ((to: RouteLocationRaw, current?: RouteLocationNormalizedLoaded) => {
    const resolved = router.resolve(embeddedNavigationTarget(to), current);
    // RouterLink uses the actual iframe URL; module comparisons use the logical fullPath.
    return { ...resolved, path: modulePath(resolved.path), fullPath: modulePath(resolved.fullPath) };
  }) as Router['resolve'];
  const push: Router['push'] = to => router.push(embeddedNavigationTarget(to));
  const replace: Router['replace'] = to => router.replace(embeddedNavigationTarget(to));
  const afterEach: Router['afterEach'] = guard => router.afterEach((to, from, failure) =>
    guard(moduleRoute(to), moduleRoute(from), failure));
  return new Proxy(router, {
    get(target, key, receiver) {
      if (key === 'currentRoute') return currentRoute;
      if (key === 'resolve') return resolve;
      if (key === 'push') return push;
      if (key === 'replace') return replace;
      if (key === 'afterEach') return afterEach;
      return Reflect.get(target, key, receiver);
    },
  });
}

export type EmbeddedPageId = EmbeddedModuleId | 'resource-ledger' | 'resource-frequencies' |
  'spectrum-config' | 'spectrum-monitor' | 'knowledge-browse' | 'knowledge-changes' |
  'knowledge-versions' | 'system-accounts' | 'system-roles' | 'system-logs' | 'system-parameters';
export interface EmbeddedPage {
  id: EmbeddedPageId;
  module: EmbeddedModuleId;
  title: string;
  path: string;
  query?: Readonly<Record<string, string>>;
}

/** Fixed links select the corresponding business function within the embedded shell. */
export const embeddedPages = [
  ...embeddedModules.map(module => ({ id: module.id, module: module.id, title: module.title, path: '/embed/' + module.id })),
  { id: 'resource-ledger', module: 'resources', title: '短波／超短波设备', path: '/embed/resources', query: { tab: 'ledger' } },
  { id: 'resource-frequencies', module: 'resources', title: '规划频点', path: '/embed/resources', query: { tab: 'frequencies' } },
  { id: 'spectrum-config', module: 'resources', title: '频谱接口管理', path: '/embed/resources', query: { tab: 'spectrum-config' } },
  { id: 'spectrum-monitor', module: 'resources', title: '频谱观测', path: '/embed/resources', query: { tab: 'spectrum-monitor' } },
  { id: 'knowledge-browse', module: 'knowledge', title: '图谱浏览', path: '/embed/knowledge', query: { tab: 'browse' } },
  { id: 'knowledge-changes', module: 'knowledge', title: '知识维护', path: '/embed/knowledge', query: { tab: 'changes' } },
  { id: 'knowledge-versions', module: 'knowledge', title: '知识发布历史', path: '/embed/knowledge', query: { tab: 'versions' } },
  { id: 'system-accounts', module: 'system', title: '账号管理', path: '/embed/system', query: { tab: 'accounts' } },
  { id: 'system-roles', module: 'system', title: '角色权限', path: '/embed/system', query: { tab: 'roles' } },
  { id: 'system-logs', module: 'system', title: '操作日志', path: '/embed/system', query: { tab: 'logs' } },
  { id: 'system-parameters', module: 'system', title: '参数配置', path: '/embed/system', query: { tab: 'parameters' } },
] satisfies readonly EmbeddedPage[];

/** URLs inherit the actual local host, port and application pathname; no credentials are added. */
export function embeddedPageUrl(baseUrl: string, page: EmbeddedPage): string {
  const url = new URL(baseUrl);
  const query = new URLSearchParams(page.query);
  url.search = '';
  url.username = '';
  url.password = '';
  url.hash = page.path + (query.size ? '?' + query.toString() : '');
  return url.toString();
}

// These are existing contextual routes, not links with invented task/device identifiers.
export const embeddedContextRoutes = [
  { id: 'gis-device', title: '工作台设备定位', path: '/embed/gis-workbench', parameters: ['stationId', 'deviceId'] },
  { id: 'gis-interference-source', title: '工作台干扰源定位', path: '/embed/gis-workbench', parameters: ['interferenceId'] },
  { id: 'gis-task', title: '工作台任务态势', path: '/embed/gis-workbench', parameters: ['taskId'] },
  { id: 'gis-diagnosis', title: '诊断冻结态势', path: '/embed/gis-workbench', parameters: ['diagnosisId'] },
  { id: 'gis-analysis', title: '冻结方案干扰分析', path: '/embed/gis-workbench', parameters: ['analysisTaskId', 'analysisPlanId'] },
] as const;
