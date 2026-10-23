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
        <span
          v-if="env.sampleData"
          class="chip cyan sample-data-label"
          ><span>构造联调数据</span><small>非生产 / 非实测</small></span
        ><span class="user-entry"
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
      <span><i class="pi pi-database" />资源与业务结果以各自版本及采集时间为准</span
      ><span>WGS84 / EPSG:4326 <b>·</b> 资源编辑与规划方案管理</span>
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
    <DeviceConfigurationDrawer
      v-if="
        route.path === '/situation' ||
        (!['/resources', '/planning'].includes(route.path) && env.mode === 'mock')
      "
    />
    <DecisionDialog
      :request="configuration.decision"
      @answer="configuration.answer"
    />
    <DecisionDialog />
  </div>
</template>
<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
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
import DeviceConfigurationDrawer from '../components/DeviceConfigurationDrawer.vue';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import { previewService } from '../services';
import IntegrationIdentitySwitcher from '../components/IntegrationIdentitySwitcher.vue';
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore();
const visibleNavigation = computed(() =>
  navigation.filter((n) => auth.can(routePermissions[n.path])),
);
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
const configuration = useDeviceConfigurationStore();
// 页面只迁移恢复入口，确认流程与忙碌保护仍由公共布局统一维护。
const resourceResetDisabled = computed(
  () =>
    store.loading ||
    editor.busy ||
    !!auth.busy ||
    configuration.busy ||
    !!configuration.pending ||
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
  const resourcePage = route.path === '/resources',
    resourcePath = route.path,
    session = auth.generation;
  // handler 同样保护旧事件；最后确认重置后才放弃配置输入。
  if (!(await configuration.leave(true))) return;
  if (route.path !== resourcePath || (resourcePage && session !== auth.generation)) return;
  const choice = await editor.ask({
    title: '恢复初始资源',
    message:
      '将清除新增资源、参数修改、上下架、导入回执、干扰源修改、候选链路新增与修改、未保存表单、GIS 草稿与撤销历史，恢复本批初始资源和 500 条候选来源参考。频谱配置和已保存任务独立保留；任务中的失效引用需手工修正，任务草稿保留待校验。后来生成的规划任务与方案保留为历史记录，配置需重新规划；不会清空规划工作区。已提交诊断继续使用冻结快照，并标记为历史记录。设备配置回执独立保留，旧来源记录不能再次提交。',
    saveLabel: '确认重置资源',
  });
  if (
    choice !== 'save' ||
    route.path !== resourcePath ||
    (resourcePage && session !== auth.generation) ||
    !auth.can('resources.reset') ||
    configuration.busy ||
    configuration.pending ||
    ledger.busy
  )
    return;
  resetError.value = '';
  try {
    // 两次确认后仍绑定原入口，统一使用当前资源重置接口。
    await previewService.resetResourceData({
      baseRevision: gis.scene?.resourceMeta.revision ?? ledger.context?.baseRevision ?? null,
    });
    if (session !== auth.generation) return;
    store.invalidateResources();
    await resourceRead.refresh();
    if (resourcePage && session !== auth.generation) return;
    configuration.clearForSession();
    editor.clearSession();
    ledger.clearForSession();
    gis.clearHistory();
    if (route.path === '/resources') await resourceRead.refresh();
  } catch (reason) {
    if (resourcePage && session !== auth.generation) return;
    resetError.value = reason instanceof Error ? reason.message : '重置失败，当前输入已保留';
  }
}
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
/* 数据来源分两行显示，保持头部控件的可用宽度。 */
.sample-data-label {
  flex-direction: column;
  gap: 2px;
  line-height: 1.3;
  text-align: center;
}
.sample-data-label small {
  font-size: 10px;
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
