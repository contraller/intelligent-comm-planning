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
      <label class="layer-toggle"
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
      <label class="layer-opacity"
        >透明度 {{ Math.round(row.opacity * 100) }}%
        <input
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
      </label>
      <p>{{ row.hint }}</p
      ><p
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
  gap: 12px;
  margin-top: 16px;
}
.result-layer-row {
  padding: 12px;
  border: 1px solid #2a405a;
  border-radius: 5px;
  font-size: 12px;
}
.layer-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}
.layer-opacity {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  color: #a6bfd7;
}
.layer-opacity input {
  width: 100%;
  min-width: 0;
}
.result-layer-row p {
  margin: 10px 0 0;
  color: #8faac4;
  line-height: 1.7;
  font-size: 11px;
}
.result-layer-row .layer-reason {
  color: #d9bd89;
}
</style>
