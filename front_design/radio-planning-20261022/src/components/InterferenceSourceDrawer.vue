<template>
  <AppDrawer
    :visible="editing ? !editor.picking : !!visible"
    :title="editing ? (editor.form?.creating ? '新增干扰源' : '编辑干扰源') : '干扰源详情'"
    subtitle="应用后预览，保存后提交本页全部草稿。"
    @after-show="focusIssue"
    @update:visible="!$event && close()"
    ><template v-if="editing && editor.form"
      ><p class="readonly-note">稳定 ID：{{ editor.form.id }}</p
      ><p class="readonly-note">天线增益必须明确填写，可填写 0 或负值；系统没有可代用的统一默认增益。高程可空，资源高程不参与当前传播计算，地面高程按冻结地形模型处理。</p
      ><p class="readonly-note">空方向图按全向 OMNI、空占空比按连续发射 1 计算；有效值及来源保存在分析运行快照中。全向不使用方位角，切换为定向时必须填写方位角。</p
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
            :disabled="!editor.canEdit || editor.busy || key === 'azimuthDeg' && editor.form.fields.patternType !== 'DIRECTIONAL'"
            :required="['name', 'longitude', 'latitude', 'antennaHeightM', 'centerFreqKhz', 'bandwidthKhz', 'txPowerDbm', 'antennaGainDbi'].includes(key) || key === 'azimuthDeg' && editor.form.fields.patternType === 'DIRECTIONAL'"
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
    ><p v-if="!editing && source?.antennaGainDbi === null" class="readonly-note" role="status">此历史干扰源缺少天线增益。请编辑资源补充有效增益并保存，再重新保存场景后分析。</p
    ><button
      v-if="!editing && source && editor.context === 'gis'"
      class="btn"
      :disabled="!editor.canEdit || editor.busy"
      @click="
        editor.openForm('interference', source.id);
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
    ><p
      v-if="editing && gis.saveState === 'succeeded'"
      role="status"
      >保存成功</p
    >
    <p
      v-if="editing && gis.saveState === 'validation-failed'"
      role="alert"
      >校验失败，请检查错误清单。</p
    ><template #footer
      ><div class="toolbar"
        ><button
          v-if="editing"
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
          @click="editor.save()"
          >{{ gis.busy ? '保存中…' : '保存全部草稿' }}</button
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
import { computed } from 'vue';
import { useGisIssueFocus } from '../composables/useGisIssueFocus';
import AppDrawer from './AppDrawer.vue';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useResourceEditStore } from '../stores/resource-edit';
import type { InterferenceSource } from '../types/domain';
import { resourceOrigins } from '../config/resource-options';
const props = defineProps<{ source?: InterferenceSource; visible?: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const gis = useGisWorkspaceStore();
const editor = useResourceEditStore();
const { fieldRoot, focusIssue, locateField } = useGisIssueFocus(editor);
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
  antennaGainDbi: '天线增益 / dBi（必填，0 和负值有效）',
  interferenceType: '干扰类型',
  patternType: '方向图（可空，分析按 OMNI）',
  azimuthDeg: '方位角 / °（定向必填）',
  dutyCycle: '占空比 0–1（可空，分析按 1）',
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
