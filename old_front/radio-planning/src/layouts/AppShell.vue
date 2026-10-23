<template>
  <div class="app-shell">
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
        <span class="chip cyan">{{ env.mode === 'mock' ? 'Mock 演示' : env.mode + ' 模式' }}</span
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
    <div class="context-bar">
      <span><i class="pi pi-th-large" />教学演示工作区 <b>/</b> {{ route.meta.title }}</span
      ><span
        ><i class="pi pi-circle-fill" />{{
          env.mode === 'http'
            ? httpResource && resourceRead.workspace
              ? '接口资源 · ' +
                (resourceRead.stale ? '版本待刷新' : resourceRead.workspace.revision)
              : 'HTTP 接口环境'
            : editor.dirty
              ? '资源编辑中 · 未保存'
              : store.data?.resourceMeta.savedAt
                ? '资源保存于 ' + new Date(store.data.resourceMeta.savedAt).toLocaleString()
                : '初始演示资源'
        }}<button
          v-if="env.mode === 'mock' && auth.can('resources.reset')"
          class="text-link"
          :disabled="
            store.busy ||
            store.loading ||
            editor.busy ||
            !!auth.busy ||
            configuration.busy ||
            !!configuration.pending
          "
          @click="resetResources"
        >
          重置资源演示数据
        </button></span
      >
    </div>
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
        <RouterView />
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
      <span
        ><i class="pi pi-database" />{{ env.mode === 'mock' ? '前端演示环境' : 'HTTP 接口环境' }}
        <b>·</b>
        {{ env.mode === 'mock' ? '结果来自预生成快照' : '资源与业务结果以接口响应为准' }}</span
      ><span>WGS84 / EPSG:4326 <b>·</b> 资源编辑与规划方案管理</span>
    </footer>
    <ResourceEditDrawer v-if="env.mode === 'mock' && store.data" /><ResourceImportDrawer
      v-if="env.mode === 'mock' && store.data"
    />
    <DeviceConfigurationDrawer v-if="env.mode === 'mock'" />
    <DecisionDialog
      :request="configuration.decision"
      @answer="configuration.answer"
    />
    <DecisionDialog />
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
import DeviceConfigurationDrawer from '../components/DeviceConfigurationDrawer.vue';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
const route = useRoute(),
  router = useRouter(),
  auth = useAuthStore();
const visibleNavigation = computed(() =>
  navigation.filter((n) => auth.can(routePermissions[n.path])),
);
const resourceRead = useResourceReadStore();
const httpResource = computed(
  () => env.mode === 'http' && ['/resources', '/situation'].includes(route.path),
);
const independent = computed(
  () =>
    httpResource.value ||
    route.path === '/sr4-live' ||
    (env.mode === 'http' && route.path === '/planning') ||
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
async function resetResources() {
  if (!auth.can('resources.reset')) return;
  // handler 同样保护旧事件；最后确认重置后才放弃配置输入。
  if (!(await configuration.leave(true))) return;
  const choice = await editor.ask({
    title: '重置资源演示数据',
    message:
      '将清除新增资源、参数修改、上下架、导入回执、干扰源修改、候选链路新增与修改、未保存表单、GIS 草稿与撤销历史，恢复本批初始资源和 500 条候选来源参考。频谱配置和已保存任务独立保留；任务中的失效引用需手工修正，任务草稿保留待校验。后来生成的规划任务与方案保留为历史记录，配置需重新规划；不会清空规划工作区。已提交诊断继续使用冻结快照，并标记为历史记录。设备配置回执独立保留，旧来源记录不能再次提交。',
    saveLabel: '确认重置资源',
  });
  if (
    choice !== 'save' ||
    !auth.can('resources.reset') ||
    configuration.busy ||
    configuration.pending
  )
    return;
  resetError.value = '';
  try {
    await store.reset();
    configuration.clearForSession();
    editor.clearSession();
    gis.clearHistory();
  } catch (reason) {
    resetError.value = reason instanceof Error ? reason.message : '重置失败，当前输入已保留';
  }
}
const navigation = [
  ...(import.meta.env.VITE_SR4_LIVE === '1' ? [{ path: '/sr4-live', title: 'SR4 联调', icon: 'pi-sync' }] : []),
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
    if (
      env.mode === 'mock' &&
      ['/planning', '/situation'].includes(route.path) &&
      auth.can('planning.view') &&
      !planning.workspace
    )
      void planning.load();
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
  height: 75px;
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
.context-bar {
  flex-shrink: 0;
  display: flex;
  justify-content: space-between;
  padding: 11px 28px;
  font-size: 11px;
  background: #0a1424;
  color: #738ca8;
  border-bottom: 1px solid #1d2b41;
}
.context-bar span {
  display: flex;
  gap: 10px;
  align-items: center;
}
.context-bar .pi-circle-fill {
  font-size: 5px;
  color: #50c4a2;
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
    gap: 15px;
    padding: 0 20px;
  }
  .brand {
    min-width: 245px;
  }
  .brand strong {
    font-size: 15px;
  }
  nav a {
    padding: 0 12px;
  }
  .header-tools {
    gap: 12px;
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
    padding: 0 8px;
  }
}
</style>
