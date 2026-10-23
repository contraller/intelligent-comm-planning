import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from '../layouts/AppShell.vue';
import { useAuthStore } from '../stores/auth';
import { routePermissions, safeReturnPath } from '../config/permissions';

// Hash 路由允许静态服务器直接打开页面，无需后端路由回退规则。
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { title: '登录' } },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', redirect: '/situation' },
        {
          path: 'situation',
          // 数据模式只切换服务适配，GIS 产品页面保持一致。
          component: () => import('../views/SituationView.vue'),
          meta: { title: 'GIS 态势' },
        },
        {
          path: 'resources',
          // 数据模式只切换适配，资源管理保持同一页面与交互入口。
          component: () => import('../views/ResourcesView.vue'),
          meta: { title: '资源管理' },
        },
        {
          path: 'planning',
          // Mock 与 HTTP 仅切换服务适配，规划页面和交互入口保持一致。
          component: () => import('../views/PlanningApiView.vue'),
          meta: { title: '网络规划' },
        },
        {
          path: 'diagnosis',
          component: () => import('../views/DiagnosisView.vue'),
          meta: { title: '故障诊断' },
        },
        {
          path: 'knowledge',
          component: () => import('../views/KnowledgeView.vue'),
          meta: { title: '知识图谱' },
        },
        {
          path: 'system',
          component: () => import('../views/SystemView.vue'),
          meta: { title: '系统管理' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/situation' },
  ],
});
// 直达路由与导航共用权限；已挂载的失效现场由全局冻结层保留。
router.beforeEach(async(to,from)=>{
  const auth=useAuthStore();
  if(!auth.bypassLeave)await auth.check();
  // HTTP 共享会话换号时留在原页处理现场，不自动跳转并接纳新账号。
  if(auth.sessionReplaced&&from.path!=='/login'&&!auth.bypassLeave)return false;
  if(auth.blocked&&auth.hasUnsaved()&&from.path!=='/login'&&!auth.bypassLeave)return false;
  if(to.path==='/login')return auth.identity&&!auth.error?auth.firstPath(to.query.next):true;
  if(!auth.identity||auth.error)return {path:'/login',query:{next:safeReturnPath(to.fullPath)??undefined}};
  if(routePermissions[to.path]&&!auth.can(routePermissions[to.path]))return auth.firstPath()===to.path?true:auth.firstPath();
  return true;
});
router.afterEach((to) => {
  const auth=useAuthStore();auth.currentPath=to.path;auth.bypassLeave=false;
  document.title = `${to.meta.title ?? '预览'} · 无线网络智能规划系统`;
});
