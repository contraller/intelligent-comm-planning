import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from '../layouts/AppShell.vue';
import EmbedShell from '../layouts/EmbedShell.vue';
import { useAuthStore } from '../stores/auth';
import { routePermissions, safeReturnPath } from '../config/permissions';
import { embeddedModules, embeddedPath, isEmbeddedPath, modulePath, type EmbeddedModuleId } from '../config/embedded-pages';

const moduleComponents = {
  situation: () => import('../views/GisSituationView.vue'),
  'gis-workbench': () => import('../views/SituationView.vue'),
  resources: () => import('../views/ResourcesView.vue'),
  planning: () => import('../views/PlanningApiView.vue'),
  diagnosis: () => import('../views/DiagnosisView.vue'),
  knowledge: () => import('../views/KnowledgeView.vue'),
  system: () => import('../views/SystemView.vue'),
} satisfies Record<EmbeddedModuleId, unknown>;

// Hash 路由允许静态服务器直接打开页面，无需后端路由回退规则。
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { title: '登录' } },
    {
      path: '/embed',
      component: EmbedShell,
      meta: { embedded: true },
      children: [
        { path: '', redirect: '/embed/situation' },
        ...embeddedModules.map(module => ({
          path: module.id,
          name: 'embed-' + module.id,
          component: moduleComponents[module.id],
          meta: { title: module.title, embedded: true },
        })),
        { path: ':pathMatch(.*)*', redirect: '/embed/situation' },
      ],
    },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: '/situation' },
        {
          path: 'situation',
          component: moduleComponents.situation,
          meta: { title: 'GIS 态势' },
        },
        {
          path: 'gis-workbench',
          component: moduleComponents['gis-workbench'],
          meta: { title: 'GIS 工作台' },
        },
        {
          path: 'resources',
          // 数据模式只切换适配，资源管理保持同一页面与交互入口。
          component: moduleComponents.resources,
          meta: { title: '资源管理' },
        },
        {
          path: 'planning',
          // Mock 与 HTTP 仅切换服务适配，规划页面和交互入口保持一致。
          component: moduleComponents.planning,
          meta: { title: '网络规划' },
        },
        {
          path: 'diagnosis',
          component: moduleComponents.diagnosis,
          meta: { title: '故障诊断' },
        },
        {
          path: 'knowledge',
          component: moduleComponents.knowledge,
          meta: { title: '知识图谱' },
        },
        {
          path: 'system',
          component: moduleComponents.system,
          meta: { title: '系统管理' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/situation' },
  ],
});
// 直达路由与导航共用权限；已挂载的失效现场由全局冻结层保留。
router.beforeEach(async(to,from)=>{
  if (isEmbeddedPath(to.path) && embeddedPath(to.path) !== to.path)
    return { path: embeddedPath(to.path), query: to.query, hash: to.hash, replace: true };
  // Module links and recovery actions stay in the host's content frame.
  if (isEmbeddedPath(from.path) && embeddedPath(to.path) !== to.path)
    return { path: embeddedPath(to.path), query: to.query, hash: to.hash };
  // 原有资源定位、故障及干扰分析深链继续进入工作台；无参数态势入口始终是只读大地图。
  if (modulePath(to.path) === '/situation' && Object.keys(to.query).length && safeReturnPath(to.fullPath))
    return { path: isEmbeddedPath(to.path) ? '/embed/gis-workbench' : '/gis-workbench', query: to.query, replace: true };
  const auth=useAuthStore();
  if(!auth.bypassLeave)await auth.check();
  // HTTP 共享会话换号时留在原页处理现场，不自动跳转并接纳新账号。
  if(auth.sessionReplaced&&from.path!=='/login'&&!auth.bypassLeave)return false;
  if(auth.blocked&&auth.hasUnsaved()&&from.path!=='/login'&&!auth.bypassLeave)return false;
  if(to.path==='/login')return auth.identity&&!auth.error?auth.firstPath(to.query.next):true;
  if(!auth.identity||auth.error)return {path:'/login',query:{next:safeReturnPath(to.fullPath)??undefined}};
  if(routePermissions[to.path]&&!auth.can(routePermissions[to.path])) {
    const first = auth.firstPath();
    const fallback = isEmbeddedPath(to.path) ? embeddedPath(first) : first;
    return fallback===to.path?true:fallback;
  }
  return true;
});
router.afterEach((to) => {
  const auth=useAuthStore();auth.currentPath=to.path;auth.bypassLeave=false;
  document.title = `${to.meta.title ?? '预览'} · 无线网络智能规划系统`;
});
