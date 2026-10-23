<template>
  <section
    class="result-layer-panel"
    aria-label="结果图层独立控制"
  >
    <div
      v-for="row in rows"
      :key="row.id"
      class="result-layer-row"
    >
      <!-- 说明随标签悬停查看，不可用原因保持直接展示。 -->
      <div class="layer-heading">
        <label
          class="layer-toggle"
          :title="row.hint"
          ><input
            type="checkbox"
            :checked="row.visible"
            :disabled="!row.available"
            :aria-label="`显示${row.label}`"
            @change="
              row.available &&
              emit('change', row.id, { visible: ($event.target as HTMLInputElement).checked })
            "
          />{{ row.label }}</label
        >
        <span class="layer-opacity-value">透明度 {{ Math.round(row.opacity * 100) }}%</span>
      </div>
      <input
        class="layer-opacity"
        type="range"
        min="0"
        max="1"
        step="0.1"
        :value="row.opacity"
        :disabled="!row.available"
        :aria-label="`${row.label}透明度`"
        @input="
          row.available &&
          emit('change', row.id, { opacity: Number(($event.target as HTMLInputElement).value) })
        "
      />
      <p
        v-if="row.reason"
        class="layer-reason"
        role="status"
        >{{ row.reason }}</p
      >
    </div>
  </section>
</template>
<script setup lang="ts">
import type {
  GisResultLayerId,
  GisResultLayerRow,
  GisResultLayerSetting,
} from '../maps/gis-result-layers';

defineProps<{ rows: GisResultLayerRow[] }>();
const emit = defineEmits<{
  change: [id: GisResultLayerId, patch: Partial<GisResultLayerSetting>];
}>();
// 面板只发显示意图，不修改来源数据或替用户切换地图模式。
</script>
<style scoped>
.result-layer-panel {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}
.result-layer-row {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid #2a405a;
  border-radius: 5px;
  font-size: 12px;
}
.layer-toggle {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.layer-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
}
.layer-opacity-value {
  margin-left: auto;
  white-space: nowrap;
  color: #a6bfd7;
}
.layer-opacity {
  width: 100%;
  height: 18px;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.result-layer-row p {
  margin: 0;
  color: #8faac4;
  line-height: 1.5;
  font-size: 11px;
}
.result-layer-row .layer-reason {
  color: #d9bd89;
}
</style>
