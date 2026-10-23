<template>
  <section class="deployment-summary"
    ><h4>{{ label || '部署筛选条件' }}</h4
    ><p v-if="!value">未设置</p
    ><template v-else
      ><dl
        ><template
          v-for="key in deploymentFields.slice(0, 7)"
          :key="key"
          ><dt>{{ deploymentLabels[key] }}</dt
          ><dd>{{ deploymentValue(value[key]) }}</dd></template
        ></dl
      ><p
        >强制部署点 {{ value.forcedInclude.length }} 个 · 禁部署区
        {{ value.forcedExcludePolygons.length }} 个</p
      ><details v-if="value.forcedInclude.length || value.forcedExcludePolygons.length"
        ><summary>查看原始输入坐标（WGS84）</summary
        ><pre>{{
          JSON.stringify(
            {
              forcedInclude: value.forcedInclude,
              forcedExcludePolygons: value.forcedExcludePolygons,
            },
            null,
            2,
          )
        }}</pre>
      </details></template
    ></section
  >
</template>
<script setup lang="ts">
import type { DeploymentConstraints } from '../types/deployment-constraints';
import {
  deploymentFields,
  deploymentLabels,
  deploymentValue,
} from '../services/deployment-constraints';
// 只读传入的草稿/冻结容器；历史缺项不从当前预设补值。
defineProps<{ value?: DeploymentConstraints | null; label?: string }>();
</script>
<style scoped>
.deployment-summary {
  font-size: 12px;
  border: 1px solid var(--line);
  padding: 12px;
  margin: 10px 0;
}
dl {
  display: grid;
  grid-template-columns: minmax(100px, 1fr) 2fr;
  gap: 8px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow: auto;
}
</style>
