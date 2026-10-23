<template>
  <AppDrawer
    :visible="editor.visible && !editor.portsEditing"
    :title="editor.form?.creating ? '新增设备' : '编辑设备参数'"
    subtitle="参数按设备单条保存，成功后同步台账与 GIS。"
    @update:visible="!$event && editor.closeForm()"
  >
    <p
      v-if="editor.loading"
      role="status"
      >正在读取设备维护信息…</p
    >
    <p
      v-if="editor.error"
      class="error"
      role="alert"
      >{{ editor.error }}</p
    >
    <button
      v-if="!editor.loading && !editor.form"
      class="btn"
      :disabled="!editor.canEdit"
      @click="editor.retryForm()"
      >重试读取</button
    >
    <template v-if="editor.form">
      <dl class="kv"
        ><dt>设备编号</dt><dd>{{ editor.form.id }}</dd
        ><template v-if="!editor.form.creating"
          ><dt>所属节点</dt><dd>{{ editor.context?.device?.stationId }}</dd
          ><dt>设备型号</dt><dd>{{ model?.name }}</dd
          ><dt>运行状态</dt><dd>{{ editor.context?.device?.status ?? '未提供' }}</dd></template
        ></dl
      >
      <p
        v-if="model"
        class="readonly-note"
        >型号功率上限 {{ model.txPowerMaxDbm }} dBm；支持频段 {{ model.freqMinKhz }}–{{
          model.freqMaxKhz
        }}
        kHz。</p
      >
      <!-- 下拉选择也是字段修改；只有净差异才触发未保存保护。 -->
      <form
        class="fields"
        @submit.prevent="editor.save()"
      >
        <label
          v-for="(_, key) in formFields"
          :key="key"
          :for="'ledger-device-' + key"
          >{{ labels[key] || key }}
          <select
            v-if="key === 'currentWorkMode'"
            :id="'ledger-device-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="">未提供</option
            ><option
              v-for="mode in maintenanceModes"
              :key="mode.value"
              :value="mode.value"
              >{{ mode.label }}</option
            ></select
          >
          <select
            v-else-if="key === 'stationId'"
            :id="'ledger-device-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
          >
            <option value="">请选择所属节点</option
            ><option
              v-for="station in editor.context?.stations"
              :key="station.id"
              :value="station.id"
              >{{ station.name }} · {{ station.id }}</option
            >
          </select>
          <select
            v-else-if="key === 'modelId'"
            :id="'ledger-device-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
          >
            <option value="">请选择设备型号</option
            ><option
              v-for="item in models"
              :key="item.id"
              :value="item.id"
              >{{ item.name }} · {{ item.id }}</option
            >
          </select>
          <select
            v-else-if="key === 'antennaId'"
            :id="'ledger-device-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
          >
            <option value="">请选择天线</option
            ><option
              v-for="antenna in editor.context?.antennas"
              :key="antenna.id"
              :value="antenna.id"
              >{{ antenna.name }} · {{ antenna.id }}</option
            >
          </select>
          <input
            v-else
            :id="'ledger-device-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
            :inputmode="key === 'installedAt' ? 'text' : 'decimal'"
            :placeholder="key === 'installedAt' ? '带时区的 ISO 8601 时间' : undefined"
          />
          <small
            v-for="issue in editor.issues.filter(
              (i) => i.objectId === editor.form?.id && i.field === key,
            )"
            :key="issue.message"
            class="error"
            >{{ issue.message }}</small
          >
        </label>
        <button
          class="btn primary"
          type="submit"
          :disabled="!editor.canEdit || editor.busy"
          >{{ editor.saving ? '保存中…' : '保存当前设备' }}</button
        >
      </form>
      <ul
        v-if="editor.issues.length"
        class="error"
        ><li
          v-for="(issue, index) in editor.issues"
          :key="index"
          ><button
            v-if="editor.form && Object.hasOwn(editor.form.fields, issue.field)"
            class="text-link"
            :disabled="editor.busy"
            @click="focusIssue(issue.field)"
            >{{ issue.objectId }} / {{ issue.field }}</button
          ><span v-else>{{ issue.objectId }} / {{ issue.field }}</span
          >：{{ issue.message }}</li
        ></ul
      >
      <p
        v-if="editor.message"
        role="status"
        >{{ editor.message }}</p
      >
    </template>
    <template #footer
      ><span class="readonly-note">{{
        editor.formDirty ? '当前输入尚未保存' : '当前没有未保存修改'
      }}</span
      ><button
        class="btn"
        :disabled="editor.busy"
        @click="editor.closeForm()"
        >关闭</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { maintenanceModes } from '../services/device-maintenance';
import { useResourceLedgerEditStore } from '../stores/resource-ledger-edit';
const editor = useResourceLedgerEditStore();
const formFields = computed<Record<string, string>>(() =>
  Object.fromEntries(Object.entries(editor.form?.fields ?? {}).filter(([key]) =>
    key !== 'ports' && key !== 'currentWorkMode' && (editor.form?.creating || editor.canMaintainAll || ['antennaHeightM','txPowerDbm','workFreqKhz'].includes(key)))),
);
// 校验问题只定位当前设备表单中的真实字段，不改变输入内容。
function focusIssue(field: string) {
  if (editor.visible && editor.form && Object.hasOwn(editor.form.fields, field))
    document.getElementById('ledger-device-' + field)?.focus();
}
const model = computed(() =>
  editor.context?.models.find(
    (m) =>
      m.id ===
      (editor.form?.creating ? editor.form.fields.modelId : editor.context?.device?.modelId),
  ),
);
const models = computed(
  () =>
    editor.context?.models.filter((m) =>
      editor.context?.stations
        .find((s) => s.id === editor.form?.fields.stationId)
        ?.classes.includes(m.deviceClass),
    ) ?? [],
);
const labels: Record<string, string> = {
  currentWorkMode: '当前工作模式',
  stationId: '所属节点',
  modelId: '设备型号',
  antennaId: '天线',
  antennaHeightM: '天线高度 / m',
  txPowerDbm: '发射功率 / dBm',
  workFreqKhz: '工作频点 / kHz（可空）',
  tiltDeg: '下倾角 / °（可空）',
  azimuthDeg: '方位角 / °（可空）',
  installedAt: '安装时间',
};
</script>
<style scoped>
.fields {
  display: grid;
  gap: 16px;
  margin-top: 20px;
}
.fields label {
  display: grid;
  gap: 7px;
  font-size: 12px;
}
.error {
  color: #f5a6b2;
}
</style>
