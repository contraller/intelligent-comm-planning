<template>
  <AppDrawer
    :visible="visible"
    title="导出已保存方案"
    :subtitle="
      '只导出所选方案冻结快照；包含 ' + (sourceLabel ?? 'Mock') + ' 来源、状态和历史标记。'
    "
    @update:visible="!busy && emit('update:visible', $event)"
  >
    <template v-if="plan"
      ><p
        >{{ plan.name }} · {{ plan.version }} · {{ plan.state
        }}{{ plan.sourceChanged ? ' · 来源已变化' : '' }}</p
      >
      <label
        >格式<select
          v-model="format"
          :disabled="busy"
          ><option value="xlsx">XLSX · 多工作表</option
          ><option value="json">JSON · 完整快照</option></select
        ></label
      >
      <p
        >任务输入、需求、节点与设备快照、部署、路由、频率、指标和校验依据。抗干扰版本同时包含分析、措施来源及规划输出坐标。历史缺失字段标为未提供。</p
      ></template
    ><p v-else>请先选择已保存方案。</p
    ><p
      v-if="error"
      role="alert"
      >{{ error }}</p
    >
    <template #footer
      ><button
        class="btn primary"
        :disabled="busy || !plan || !auth.can('planning.view')"
        @click="download"
        >{{ busy ? '生成中…' : '下载方案' }}</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { previewService } from '../services';
import { downloadFile } from '../services/file-download';
import { useAuthStore } from '../stores/auth';
import type { PlanVersion } from '../types/domain';
import type { ResourceFile } from '../types/resource-edit';
// 允许接口页面注入导出动作，默认仍使用原 Mock 服务。
const props = defineProps<{
  visible: boolean;
  plan: Pick<PlanVersion, 'id' | 'name' | 'version' | 'state' | 'sourceChanged'> | null;
  sourceLabel?: string;
  exporter?: (id: string, format: 'json' | 'xlsx') => Promise<ResourceFile>;
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const auth = useAuthStore(),
  format = ref<'json' | 'xlsx'>('xlsx'),
  busy = ref(false),
  error = ref('');
async function download() {
  if (!props.plan || busy.value) return;
  const id = props.plan.id,
    session = auth.generation;
  busy.value = true;
  error.value = '';
  try {
    const file = await (props.exporter
      ? props.exporter(id, format.value)
      : previewService.exportPlanVersion({ planId: id, format: format.value }));
    if (session !== auth.generation || !auth.can('planning.view') || props.plan?.id !== id) return;
    downloadFile(file, 1000);
  } catch (e) {
    if (session === auth.generation) error.value = e instanceof Error ? e.message : '导出失败';
  } finally {
    busy.value = false;
  }
}
</script>
