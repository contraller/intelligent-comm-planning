<template>
  <div
    class="app-shell"
    @click="closeResourceMenus"
    @keydown.esc="closeResourceMenus"
  >
    <header class="app-header">
      <RouterLink
        :to="auth.firstPath()"
        class="brand"
        ><span class="brand-symbol"><i class="pi pi-wifi" /></span
        ><span
          ><strong>无线网络智能规划系统</strong><small>RADIO NETWORK PLANNING</small></span
        ></RouterLink
      >
      <nav aria-label="主导航">
        <RouterLink
          v-for="item in visibleNavigation"
          :key="item.path"
          :to="item.path"
          :class="{ active: route.path === item.path }"
          ><i
            class="pi"
            :class="item.icon"
          />{{ item.title }}</RouterLink
        >
      </nav>
      <div class="header-tools">
        <IntegrationIdentitySwitcher />
        <!-- 使用界面保留当前身份，数据来源由各业务记录保存。 -->
        <span class="user-entry"
          ><span class="avatar">{{ auth.identity?.name.slice(0, 1) }}</span
          ><span
            class="user-label"
            :title="auth.identity ? auth.identity.name + ' · ' + auth.identity.roleName : undefined"
            >{{ auth.identity?.name }} · {{ auth.identity?.roleName }}</span
          ></span
        ><button
          class="btn"
          :disabled="!!auth.busy || auth.transition"
          @click="logout"
          >退出</button
        >
      </div>
    </header>
    <div
      v-if="resetError || auth.notice"
      class="reset-error"
      role="alert"
      >{{ resetError || auth.notice }}</div
    >
    <div v-if="resetNotice" class="reset-notice" role="status">{{ resetNotice }}</div>
    <main class="app-content">
      <RequestState
        v-if="!entered"
        state="forbidden"
        message="当前角色无此页面权限。"
      />
      <!-- 独立模块不受资源读取错误影响，冻结时保留已进入的组件。 -->
      <template v-else-if="independent">
        <div
          v-if="store.error && route.path === '/diagnosis'"
          class="reset-error"
          >源资源读取失败：{{ store.error }}。{{
            route.path === '/diagnosis'
              ? '诊断历史仍可查看，新任务需先恢复来源。'
              : '知识工作区独立加载，资源修改仍需先恢复来源。'
          }}</div
        >
        <RouterView :key="auth.identity?.sessionId" />
      </template>
      <RequestState
        v-else-if="store.loading"
        state="loading"
      /><RequestState
        v-else-if="store.error"
        state="error"
        :message="store.error"
        @retry="store.load"
      /><RouterView v-else-if="store.data" />
    </main>
    <footer class="app-footer">
      <span><i class="pi pi-database" />资源与业务结果以各自版本及采集时间为准
        <template v-if="runtime.error && !auth.blocked"> · 运行参数未就绪
          <button class="text-link" title="重新读取运行参数" aria-label="重新读取运行参数" :disabled="runtime.loading" @click="runtime.refresh().catch(() => {})"><i class="pi pi-refresh" /></button>
        </template>
      </span><span>WGS84 / EPSG:4326 <b>·</b> 资源编辑与规划方案管理</span>
    </footer>
    <ResourceEditDrawer
      v-if="
        route.path === '/situation' ||
        (!['/resources', '/planning'].includes(route.path) && env.mode === 'mock' && store.data)
      "
    /><ResourceImportDrawer
      v-if="
        route.path === '/situation' ||
        (!['/resources', '/planning'].includes(route.path) && env.mode === 'mock' && store.data)
      "
    />
    <DecisionDialog />
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { routePermissions } from '../config/permissions';
import { usePreviewStore } from '../stores/preview';
import { env } from '../config/env';
import RequestState from '../components/RequestState.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import ResourceEditDrawer from '../components/ResourceEditDrawer.vue';
import ResourceImportDrawer from '../components/ResourceImportDrawer.vue';
import { useResourceEditStore } from '../stores/resource-edit';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { usePlanningStore } from '../stores/planning';
import { useResourceReadStore } from '../stores/resource-read';
import { useResourceLedgerEditStore } from '../stores/resource-ledger-edit';
import { useDeviceConfigurationAcceptanceStore } from '../stores/device-configuration-acceptance';
import { previewService } from '../services';
import IntegrationIdentitySwitcher from '../components/IntegrationIdentitySwitcher.vue';
import { randomUuid } from '../services/random-uuid';
import { ApiError } from '../services/types';
import { useRuntimeParametersStore } from '../stores/runtime-parameters';
import { applyHttpRuntimeParameters, collaborationHttp } from '../services/http';
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore();
const visibleNavigation = computed(() =>
  navigation.filter((n) => auth.can(routePermissions[n.path])),
);
const runtime = useRuntimeParametersStore();
const runtimeSession = () => env.mode === 'http' && auth.identity && !auth.transition && !auth.blocked
  ? JSON.stringify([auth.generation, auth.identity.id, auth.identity.sessionId, auth.identity.revision]) : null;
if (env.mode === 'http') {
  runtime.bind(collaborationHttp.runtimeParameters, runtimeSession);
  watch(runtimeSession, key => {
    applyHttpRuntimeParameters(null);
    if (key) void runtime.refresh().catch(() => { /* 参数错误由独立状态保留，不卸载业务页面。 */ });
  }, { immediate: true, flush: 'sync' });
  watch(() => [runtime.snapshot, runtime.loading, runtime.error] as const, ([value, loading, error]) => {
    // 快照先于loading落定；只在读取完成后报告真实消费者已应用。
    if (!value) applyHttpRuntimeParameters(null);
    else if (!loading && !error) {
      applyHttpRuntimeParameters(value);
      runtime.reportApplied('http.request-timeout', value.epoch, value.revision);
    }
  }, { immediate: true, flush: 'sync' });
}
// 会话清理会按key重建布局，须在新实例setup前解绑，不能等卸载后置钩子。
onBeforeUnmount(() => { runtime.unbind(); applyHttpRuntimeParameters(null); });
const resourceRead = useResourceReadStore();
const ledger = useResourceLedgerEditStore();
const httpResource = computed(
  () => env.mode === 'http' && ['/resources', '/situation'].includes(route.path),
);
const independent = computed(
  () =>
    route.path === '/situation' ||
    httpResource.value ||
    route.path === '/resources' ||
    route.path === '/planning' ||
    ['/diagnosis', '/knowledge', '/system'].includes(route.path),
);
const entered = ref(false);
async function logout() {
  if (await auth.leaveSession()) await router.replace('/login');
}
const store = usePreviewStore();
const editor = useResourceEditStore();
const planning = usePlanningStore(),
  gis = useGisWorkspaceStore();
const resetError = ref('');
const resetNotice = ref(''), resetBusy = ref(false);
// 网络结果未核实时保留原请求号和原版本，重试不产生第二次恢复操作。
let resetPending: { generation: number; input: { baseRevision: string; requestId: string } } | null = null;
// 配置抽屉由所属业务页单点装配，布局只参与未核实请求的忙态保护。
const configuration = useDeviceConfigurationAcceptanceStore();
// 页面只迁移恢复入口，确认流程与忙碌保护仍由公共布局统一维护。
const resourceResetDisabled = computed(
  () =>
    store.loading ||
    editor.busy ||
    !!auth.busy ||
    configuration.busy ||
    !!configuration.pending ||
    resetBusy.value ||
    ledger.busy,
);
provide('resourceResetAction', { disabled: resourceResetDisabled, run: resetResources });
// 原生折叠菜单保留键盘行为；外部点击、选择操作及 Esc 统一收起。
function closeResourceMenus(event: Event) {
  if (typeof Element === 'undefined' || !(event.target instanceof Element)) return;
  const menu = event.target.closest<HTMLDetailsElement>('.resource-more');
  if (event.type !== 'keydown' && menu && !event.target.closest('.resource-more-panel button'))
    return;
  document.querySelectorAll<HTMLDetailsElement>('.resource-more[open]').forEach((item) => {
    item.open = false;
  });
  if (event.type === 'keydown') menu?.querySelector('summary')?.focus();
}
async function resetResources() {
  if (
    !['/resources', '/situation'].includes(route.path) ||
    !auth.can('resources.reset') ||
    resourceResetDisabled.value
  )
    return;
  const resourcePath = route.path,
    session = auth.generation;
  // handler 同样保护旧事件；最后确认重置后才放弃配置输入。
  if (!configuration.close()) return;
  if (route.path !== resourcePath || session !== auth.generation) return;
  const choice = await editor.ask({
    title: '恢复初始资源',
    message:
      resetPending?.generation === session
        ? '上次恢复请求尚未核实，将使用原请求号查询或重试。不会另建一次恢复操作。'
        : '将基于数据库初始资源快照生成新的当前资源版本，并放弃本地未保存的资源与 GIS 草稿。历史资源版本、导入及配置回执、已保存任务、规划方案和诊断记录全部保留，不删除原始文件。历史任务可能需要重新校验资源引用、重新规划。',
    saveLabel: '确认恢复资源',
  });
  if (
    choice !== 'save' ||
    route.path !== resourcePath ||
    session !== auth.generation ||
    !auth.can('resources.reset') ||
    configuration.busy ||
    configuration.pending ||
    ledger.busy
  )
    return;
  resetError.value = '';
  resetNotice.value = '';
  const baseRevision = resourceRead.workspace?.revision ?? gis.scene?.resourceMeta.revision ?? ledger.context?.baseRevision;
  if (!resetPending || resetPending.generation !== session) {
    if (!baseRevision) { resetError.value = '请先刷新资源，取得当前版本后再恢复。'; return; }
    resetPending = { generation: session, input: { baseRevision, requestId: randomUuid() } };
  }
  const operation = resetPending;
  resetBusy.value = true;
  try {
    const receipt = await previewService.resetResourceData(operation.input);
    if (session !== auth.generation) return;
    resetPending = null;
    resetNotice.value = receipt.changed ? '已恢复初始资源并生成新版本，历史记录保留。' : '当前资源已是初始版本，无需变更。';
    store.invalidateResources();
    configuration.cancel();
    configuration.visible = false;
    editor.clearSession();
    ledger.clearForSession();
    gis.clearHistory();
    // 写入已成功；后续读取失败不能把它误报成恢复失败。
    try {
      await resourceRead.refresh();
      if (session === auth.generation && Object.keys(resourceRead.errors).length)
        resetError.value = '恢复已成功，但刷新资源失败，请手动刷新。';
    } catch {
      if (session === auth.generation) resetError.value = '恢复已成功，但刷新资源失败，请手动刷新。';
    }
  } catch (reason) {
    if (session !== auth.generation) return;
    const definitive = reason instanceof ApiError && (!!reason.status && reason.status >= 400 && reason.status < 500);
    if (definitive) resetPending = null;
    resetError.value = (reason instanceof Error ? reason.message : '恢复请求失败，当前输入已保留')
      + (definitive ? '' : '；结果尚未核实，再次恢复将重试原请求。');
  } finally {
    resetBusy.value = false;
  }
}
watch(() => auth.generation, () => { resetPending = null; resetError.value = ''; resetNotice.value = ''; });
const navigation = [
  { path: '/situation', title: 'GIS 态势', icon: 'pi-globe' },
  { path: '/resources', title: '资源管理', icon: 'pi-server' },
  { path: '/planning', title: '网络规划', icon: 'pi-share-alt' },
  { path: '/diagnosis', title: '故障诊断', icon: 'pi-wave-pulse' },
  { path: '/knowledge', title: '知识图谱', icon: 'pi-sitemap' },
  { path: '/system', title: '系统管理', icon: 'pi-cog' },
];
// 按当前页面加载，知识与系统不依赖资源；失权不卸载已有表单。
watch(
  () => route.path,
  () => {
    entered.value = auth.can(routePermissions[route.path]);
    if (entered.value && !independent.value && !store.data) void store.load();
    if (route.path === '/situation' && auth.can('planning.view'))
      void planning.refreshReadContext();
  },
  { immediate: true },
);
</script>
<style scoped>
.reset-error {
  padding: 10px 28px;
  color: #ffb4b4;
  background: #392333;
  font-size: 12px;
}
.reset-notice {
  padding: 10px 28px;
  color: #a1e9d9;
  background: #163d37;
  font-size: 12px;
}
.app-shell {
  height: 100vh;
  min-height: 640px;
  display: flex;
  flex-direction: column;
}
.app-header {
  /* 各页面统一使用紧凑顶栏高度。 */
  height: 60px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 27px;
  gap: 35px;
  background: #0d192b;
  border-bottom: 1px solid #253c57;
}
.brand {
  display: flex;
  gap: 12px;
  align-items: center;
  min-width: 278px;
}
.brand-symbol {
  background: linear-gradient(135deg, #318ada, #135097);
  border: 1px solid #57b4ff;
  border-radius: 10px;
  height: 39px;
  width: 39px;
  display: grid;
  place-items: center;
  font-size: 22px;
  box-shadow: 0 0 22px #1275c528;
}
.brand strong {
  font-size: 17px;
  letter-spacing: 1px;
  display: block;
}
.brand small {
  display: block;
  font-size: 8px;
  margin-top: 6px;
  letter-spacing: 2.5px;
  color: #638bb7;
}
nav {
  display: flex;
  align-self: stretch;
  gap: 5px;
  flex: 1;
}
nav a {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 0 20px;
  color: #8fa4bf;
  border-bottom: 3px solid transparent;
  font-size: 13px;
  position: relative;
  white-space: nowrap;
}
nav a.active {
  color: #86c4ff;
  border-color: #4bafff;
  background: linear-gradient(0deg, #203e634f, transparent);
}
nav a:hover {
  color: #cde7ff;
}
.header-tools {
  display: flex;
  align-items: center;
  gap: 22px;
  flex-shrink: 0;
}
.user-entry {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12px;
  white-space: nowrap;
  min-width: 0;
  max-width: 260px;
}
/* 合法长姓名及角色只省略展示，完整文字保留在提示中，不挤占退出入口。 */
.user-label {
  min-width: 0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-entry .pi {
  margin-left: 10px;
  color: #7f94ac;
}
.avatar {
  width: 29px;
  flex-shrink: 0;
  height: 29px;
  background: #24405e;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: #93c8f1;
}
b {
  margin: 0 6px;
  color: #334b67;
  font-weight: 400;
}
.app-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  /* 状态刷新不由浏览器自动改滚动锚点，滚动条出现也不改变工作区宽度。 */
  overflow-anchor: none;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}
.app-footer {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  background: #0a1322;
  border-top: 1px solid #1d2d43;
  padding: 7px 26px;
  color: #637b96;
  font-size: 10px;
}
.app-footer .pi {
  font-size: 9px;
  margin-right: 6px;
}
@media (max-width: 1450px) {
  .app-header {
    /* 功能增加后导航单独占行，图谱入口不能被身份控件挤出屏幕。 */
    height: auto;
    min-height: 60px;
    flex-wrap: wrap;
    gap: 8px 15px;
    padding: 8px 20px 0;
  }
  .brand {
    min-width: 245px;
    flex: 1;
  }
  nav {
    order: 3;
    flex: 1 0 100%;
    min-width: 0;
    flex-wrap: wrap;
  }
  .brand strong {
    font-size: 15px;
  }
  nav a {
    padding: 10px 12px;
  }
  .header-tools {
    gap: 12px;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
  }
  .user-entry > span:last-child {
    display: none;
  }
}
@media (max-width: 1100px) {
  .brand {
    min-width: unset;
  }
  .brand > span:last-child {
    display: none;
  }
  nav a {
    padding: 10px 8px;
  }
}
</style>
