<template>
  <AppDrawer
    :visible="editing ? !editor.picking : !!visible"
    :title="editing ? (editor.form?.creating ? '新增干扰源' : '编辑干扰源') : '干扰源详情'"
    subtitle="仅维护资源参数；影响结果来自预生成数据。"
    @after-show="focusIssue"
    @update:visible="!$event && close()"
    ><template v-if="editing && editor.form"
      ><p class="readonly-note">稳定 ID：{{ editor.form.id }}</p
      ><button
        class="btn small"
        :disabled="!editor.canEdit || editor.busy"
        @click="editor.picking = true"
        >在地图上取点</button
      ><!-- 来源提示不改变干扰参数或生效配置。 --><p
        v-if="editor.pickNotice"
        class="readonly-note"
        role="status"
        >{{ editor.pickNotice }}</p
      ><form
        ref="fieldRoot"
        tabindex="-1"
        class="fields"
        @submit.prevent="editor.applyForm()"
        ><label
          v-for="(_, key) in editor.form.fields"
          :key="key"
          :for="'interference-' + key"
          >{{ labels[key] }}
          <select
            v-if="options[key]"
            :data-validation-field="key"
            :id="'interference-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
            ><option
              v-for="value in options[key]"
              :key="value"
              :value="value"
              >{{ value || '未提供' }}</option
            ></select
          ><input
            v-else
            :data-validation-field="key"
            :id="'interference-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
            :inputmode="key === 'name' ? 'text' : 'decimal'" /></label
        ><button
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
          >应用到 GIS 草稿</button
        ></form
      ></template
    ><dl
      v-else-if="source"
      class="kv"
      ><dt>ID</dt><dd>{{ source.id }}</dd
      ><dt>名称</dt><dd>{{ source.name }}</dd
      ><dt>位置</dt><dd>{{ source.coordinate.join(', ') }}</dd
      ><dt>来源</dt><dd>{{ resourceOrigins[source.origin] }}</dd
      ><dt>生效配置</dt><dd>{{ source.active ? '是' : '否' }}</dd
      ><template
        v-for="(label, key) in labels"
        :key="key"
        ><template v-if="!['name', 'longitude', 'latitude', 'active'].includes(key)"
          ><dt>{{ label }}</dt
          ><!-- 保留泛型中的空格，避免格式器将类型参数误判为 HTML 标签。 --><!-- prettier-ignore --><dd>{{ (source as unknown as Record< string, unknown>)[key] ?? '—' }}</dd></template
        ></template
      ></dl
    ><button
      v-if="!editing && source && editor.context === 'gis'"
      class="btn"
      :disabled="!editor.canEdit || editor.busy"
      @click="
        editor.openForm('interference', source.id, 'gis');
        emit('update:visible', false);
      "
      >编辑参数</button
    ><p
      v-if="editor.error"
      class="error"
      role="alert"
      >{{ editor.error }}</p
    ><ul v-if="editing"
      ><li
        v-for="issue in editor.issues"
        :key="issue.objectId + issue.field"
        ><button
          type="button"
          class="text-link"
          :disabled="!editor.canEdit || editor.busy || issue.objectId !== editor.form?.id"
          @click="locateField(issue.field)"
          >{{ issue.field }} · 定位字段</button
        >：{{ issue.message }}</li
      ></ul
    ><p
      v-if="editing && editor.message"
      role="status"
      >{{ editor.message }}</p
    ><template #footer
      ><div class="toolbar"
        ><button
          v-if="editing"
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
          @click="editor.save()"
          >保存全部草稿</button
        ><button
          class="btn"
          :disabled="editor.busy"
          @click="close"
          >关闭</button
        ></div
      ></template
    ></AppDrawer
  >
</template>
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { focusGisField } from '../services/gis-validation';
import AppDrawer from './AppDrawer.vue';
import { useResourceEditStore } from '../stores/resource-edit';
import type { InterferenceSource } from '../types/domain';
import { resourceOrigins } from '../mocks/resource-presets';
const props = defineProps<{ source?: InterferenceSource; visible?: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const editor = useResourceEditStore();
// GIS 定位只操作当前表单，抽屉动画结束后再次核对请求，避免焦点落到旧对象。
const fieldRoot = ref<HTMLElement | null>(null);
async function focusIssue() {
  const request = editor.issueFocus;
  if (!request || editor.context !== 'gis' || !editor.canEdit || editor.picking) return;
  await nextTick();
  if (
    editor.issueFocus === request &&
    editor.form?.id === request.id &&
    editor.canEdit &&
    !editor.picking
  )
    focusGisField(fieldRoot.value, request.field);
}
watch(
  () => editor.issueFocus,
  () => {
    void focusIssue();
  },
);
function locateField(field: string) {
  if (editor.form)
    void editor.focusGisIssue(
      editor.form.kind,
      editor.form.id,
      field === 'coordinate' ? 'longitude' : field,
    );
}
const editing = computed(() => editor.form?.kind === 'interference');
const labels: Record<string, string> = {
  name: '名称',
  longitude: '经度 / ° E',
  latitude: '纬度 / ° N',
  elevationM: '高程 / m（可空）',
  antennaHeightM: '天线高度 / m',
  centerFreqKhz: '中心频率 / kHz',
  bandwidthKhz: '带宽 / kHz',
  txPowerDbm: '功率 / dBm',
  antennaGainDbi: '增益 / dBi（可空）',
  interferenceType: '干扰类型',
  patternType: '方向图（可空）',
  azimuthDeg: '方位角 / °（定向必填）',
  dutyCycle: '占空比 0–1（可空）',
  active: '是否生效',
};
const options: Record<string, string[]> = {
  interferenceType: ['NARROWBAND', 'BROADBAND', 'SWEEP', 'PULSE', 'NOISE'],
  patternType: ['', 'OMNI', 'DIRECTIONAL'],
  active: ['true', 'false'],
};
// 参数和点位只是资源配置，不绘制推算的影响区域。
async function close() {
  if (editing.value) await editor.closeForm();
  else emit('update:visible', false);
}
</script>
<style scoped>
.fields {
  display: grid;
  gap: 14px;
  margin: 18px 0;
}
.fields label {
  display: grid;
  gap: 7px;
}
.error {
  color: #ffb4b4;
  margin-top: 12px;
}
dd {
  overflow-wrap: anywhere;
}
</style>
