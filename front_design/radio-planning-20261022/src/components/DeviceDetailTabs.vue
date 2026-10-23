<template>
  <!-- 非懒加载保留同一设备的检索；设备 ID 变化才重建内容、清空旧检索。 -->
  <Tabs
    :key="deviceId"
    v-model:value="activeTab"
    :lazy="false"
    class="device-tabs"
  >
    <TabList aria-label="设备详情页签">
      <Tab value="info">设备信息</Tab>
      <Tab value="knowledge">运维知识</Tab>
    </TabList>
    <TabPanels>
      <TabPanel value="info">
        <details
          class="info-group"
          open
        >
          <summary>基础信息</summary>
          <slot name="basic" />
        </details>
        <!-- 可选资料分组沿用同一折叠样式，不改变原页签及知识检索生命周期。 -->
        <details
          v-if="$slots.structure"
          class="info-group"
        >
          <summary>组成结构</summary>
          <slot name="structure" />
        </details>
        <details
          v-if="$slots.functions"
          class="info-group"
        >
          <summary>功能信息</summary>
          <slot name="functions" />
        </details>
        <details class="info-group">
          <summary>参数信息</summary>
          <slot name="parameters" />
        </details>
        <!-- 网络分组默认折叠；同设备切换页签不重建原有内容。 -->
        <details
          v-if="$slots.network"
          class="info-group"
        >
          <summary>关联链路与承载业务</summary>
          <slot name="network" />
        </details>
        <slot name="actions" />
      </TabPanel>
      <TabPanel value="knowledge">
        <DeviceKnowledgePanel
          v-if="knowledgeAvailable !== false"
          :model-id="modelId"
        />
        <p
          v-else
          class="detail-note"
          >运维知识服务尚未接入</p
        >
      </TabPanel>
    </TabPanels>
  </Tabs>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import DeviceKnowledgePanel from './DeviceKnowledgePanel.vue';

// 旧调用默认保留知识页，只有明确缺少能力时显示未接入。
const props = withDefaults(
  defineProps<{ deviceId: string; modelId: string; knowledgeAvailable?: boolean }>(),
  { knowledgeAvailable: true },
);
const activeTab = ref('info');
// 只响应父级已接受的设备选择；取消切换不会清空当前页签和知识检索。
watch(
  () => props.deviceId,
  () => {
    activeTab.value = 'info';
  },
);
</script>
<style scoped>
.device-tabs {
  min-width: 0;
}
.device-tabs :deep(.p-tab) {
  padding: 12px 10px;
  font-size: 12px;
}
.device-tabs :deep(.p-tabpanels) {
  padding: 12px 0 0;
  background: transparent;
}
.info-group {
  margin-bottom: 12px;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 10px;
}
.info-group > summary {
  cursor: pointer;
  color: #bbd8ee;
  font-size: 12px;
  font-weight: 600;
}
.info-group :deep(.kv) {
  margin-top: 12px;
  overflow-wrap: anywhere;
}
</style>
