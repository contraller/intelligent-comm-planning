<template>
  <AppDrawer
    :visible="
      !!editor.form &&
      !editor.portsEditing &&
      editor.form.kind !== 'interference' &&
      !editor.picking
    "
    :title="
      (editor.form?.creating ? '新增' : '编辑') +
      (editor.form?.kind === 'station'
        ? '固定站'
        : editor.form?.kind === 'candidate'
          ? '候选链路'
          : '设备参数')
    "
    subtitle="应用后预览，保存后提交本页全部草稿。"
    @update:visible="!$event && editor.closeForm()"
    @after-show="focusIssue"
  >
    <template v-if="editor.form && editor.form.kind !== 'interference'"
      ><p
        v-if="!editor.canEdit"
        class="notice"
        >编辑权限已收回，当前输入仍保留。</p
      >
      <dl class="kv">
        <dt>对象 ID（只读）</dt>
        <dd>{{ editor.form.id }}</dd>
        <template v-if="device && editor.form.kind === 'device'">
          <dt>所属节点（只读）</dt>
          <dd>{{ device.stationId }}</dd>
          <dt>型号（只读）</dt>
          <dd>{{ model?.name }} · {{ device.modelId }}</dd>
          <!-- 观测只用于展示，不写入此配置表单。 -->
          <dt>运行状态（台账基线，只读）</dt>
          <dd>{{ device.status }}</dd>
          <dt>功率上限</dt>
          <dd>{{ model?.txPowerMaxDbm }} dBm</dd>
          <dt>频率范围</dt>
          <dd>{{ model?.freqMinKhz }}–{{ model?.freqMaxKhz }} kHz</dd>
        </template>
      </dl>
      <p
        v-if="warning"
        class="notice"
      >
        来源功率 {{ device?.txPowerDbm }} dBm
        超出型号上限，未修改时可保留；新输入须符合上限，原因待甲方确认。
      </p>
      <p
        v-if="editor.form.kind === 'station'"
        class="readonly-note"
      >
        规划范围：经度 {{ DEMO_BBOX[0] }}–{{ DEMO_BBOX[2] }}，纬度 {{ DEMO_BBOX[1] }}–{{
          DEMO_BBOX[3]
        }}；保存六位小数。
      </p>
      <p
        v-if="editor.form.creating && editor.form.kind !== 'candidate'"
        class="notice"
        >新登记对象初始为离线、无告警；固定站可稍后添加设备。</p
      >
      <p
        v-if="editor.form.kind === 'candidate'"
        class="notice"
        >尚未保存，结果以服务返回为准。此处只填写候选配置；距离、损耗、接收功率、余量、可用性和质量等级在详情中只读展示。</p
      >
      <p
        v-if="editor.form.creating && editor.form.kind === 'station'"
        class="readonly-note"
        >层级 {{ stationTypes[editor.form.fields.subtype]?.echelon }} · 能力
        {{ stationTypes[editor.form.fields.subtype]?.classes.join(' / ') }} · 固定站角色
        FIXED_STATION · 移动类型 FIXED</p
      >
      <p
        v-if="model"
        class="readonly-note"
        >型号功率上限 {{ model.txPowerMaxDbm }} dBm；频率 {{ model.freqMinKhz }}–{{
          model.freqMaxKhz
        }}
        kHz。</p
      >
      <button
        v-if="editor.context === 'gis' && editor.form.kind === 'station'"
        class="btn small"
        :disabled="!editor.canEdit || editor.busy"
        @click="editor.picking = true"
        >{{
          editor.form.creating && !editor.form.fields.longitude
            ? '在地图上取点'
            : '在地图上重新取点'
        }}</button
      >
      <!-- 取点来源仅说明当前输入，应用和保存仍由原按钮完成。 -->
      <p
        v-if="editor.form.kind === 'station' && editor.pickNotice"
        class="notice"
        role="status"
        >{{ editor.pickNotice }}</p
      >
      <!-- 表单只应用到 GIS 草稿，持久化统一由页脚保存入口处理。 -->
      <form
        ref="fieldRoot"
        tabindex="-1"
        class="edit-fields"
        @submit.prevent="editor.applyForm()"
      >
        <label
          v-for="(_, key) in formFields"
          :key="key"
          :for="'resource-' + key"
        >
          {{ labels[key] }}
          <select
            :data-validation-field="key"
            v-if="key === 'currentWorkMode'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
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
            :data-validation-field="key"
            v-else-if="key === 'subtype'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="I_FIXED">Ⅰ 短波固定站</option
            ><option value="II_FIXED">Ⅱ 双频固定站</option></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'nodeAId' || key === 'nodeBId'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            @change="changeCandidateNode(key)"
            ><option value="">请选择节点</option
            ><option
              v-for="station in editor.resources.stations"
              :key="station.id"
              :value="station.id"
              >{{ station.name }} · {{ station.id }}</option
            ></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'deviceAId' || key === 'deviceBId'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="">请选择端点设备</option
            ><option
              v-for="item in candidateDevices(key)"
              :key="item.id"
              :value="item.id"
              >{{ item.id }} · {{ item.modelId }}</option
            ></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'deviceClass'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="HF">HF</option
            ><option value="VUHF">VUHF</option></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'isBackup'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="">未提供</option
            ><option value="true">是</option
            ><option value="false">否</option></select
          >
          <select
            :data-validation-field="key"
            v-else-if="['key', 'relayCapable'].includes(key)"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="true">是</option
            ><option value="false">否</option></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'stationId'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy || editor.context === 'gis'"
            ><option value="">请选择站点</option
            ><option
              v-for="station in editor.resources.stations"
              :key="station.id"
              :value="station.id"
              >{{ station.name }} · {{ station.id }}</option
            ></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'modelId'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="">请选择型号</option
            ><option
              v-for="item in editor.resources.models.filter((m) =>
                editor.resources.stations
                  .find((s) => s.id === editor.form?.fields.stationId)
                  ?.classes.includes(m.deviceClass),
              )"
              :key="item.id"
              :value="item.id"
              >{{ item.name }} · {{ item.deviceClass }}</option
            ></select
          >
          <select
            :data-validation-field="key"
            v-else-if="key === 'antennaId'"
            v-model="editor.form.fields[key]"
            :id="'resource-' + key"
            :disabled="!editor.canEdit || editor.busy"
            ><option value="">请选择天线型号</option
            ><option
              v-for="item in editor.resources.antennas"
              :key="item.id"
              :value="item.id"
              >{{ item.name }} · {{ item.id }}</option
            ></select
          >
          <input
            v-else
            :data-validation-field="key"
            :id="'resource-' + key"
            v-model="editor.form.fields[key]"
            :disabled="!editor.canEdit || editor.busy"
            :aria-invalid="!!errors(key)"
            :aria-describedby="errors(key) ? 'error-' + key : undefined"
            :inputmode="
              ['name', 'region', 'remark', 'parentIds', 'installedAt'].includes(key)
                ? 'text'
                : 'decimal'
            "
            @input="editor.message = ''"
          />
          <small
            v-if="errors(key)"
            :id="'error-' + key"
            class="field-error"
            >{{ errors(key) }}</small
          >
        </label>
        <button
          type="submit"
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
        >
          {{ editor.busy ? '保存中…' : '应用到草稿' }}
        </button>
      </form>
    </template>
    <div
      v-if="editor.error"
      class="error-box"
      role="alert"
    >
      {{ editor.error }}
      <ul v-if="editor.issues.length">
        <li
          v-for="issue in editor.issues"
          :key="issue.objectId + issue.field"
          ><button
            v-if="editor.context === 'gis'"
            type="button"
            class="text-link"
            :disabled="!editor.canEdit || editor.busy || !canLocateIssue(issue)"
            @click="canLocateIssue(issue) && locateField(issue.field)"
            >定位字段</button
          >
          {{ issue.objectId }} · {{ issue.field }}：{{ issue.message }}
        </li>
      </ul>
    </div>
    <p
      v-if="editor.message"
      class="notice"
      role="status"
      >{{ editor.message }}</p
    >
    <p
      v-if="editor.context === 'gis' && gis.saveState === 'succeeded'"
      role="status"
      >保存成功</p
    >
    <p
      v-if="editor.context === 'gis' && gis.saveState === 'validation-failed'"
      role="alert"
      >校验失败，请检查错误清单。</p
    >
    <template #footer>
      <div class="edit-footer">
        <span class="muted">{{ editor.formDirty ? '当前输入未应用' : '当前表单无未提交输入' }}</span
        ><button
          v-if="editor.context === 'gis'"
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
          @click="editor.save()"
        >
          {{ gis.busy ? '保存中…' : '保存全部草稿' }}</button
        ><button
          class="btn"
          :disabled="!editor.canEdit || editor.busy"
          @click="editor.closeForm()"
          >关闭</button
        >
      </div>
    </template>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useGisIssueFocus } from '../composables/useGisIssueFocus';
import AppDrawer from './AppDrawer.vue';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useResourceEditStore } from '../stores/resource-edit';
import { stationTypes } from '../config/resource-options';
import { DEMO_BBOX } from '../config/demo';
import { maintenanceModes } from '../services/device-maintenance';
const gis = useGisWorkspaceStore();
const editor = useResourceEditStore();
const formFields = computed<Record<string, string>>(() =>
  Object.fromEntries(Object.entries(editor.form?.fields ?? {}).filter(([key]) => key !== 'ports')),
);
const { fieldRoot, focusIssue, locateField } = useGisIssueFocus(editor);
// 失权保留字段，阻止应用或保存。
const labels: Record<string, string> = {
  currentWorkMode: '当前工作模式',
  nodeAId: 'A 端节点',
  nodeBId: 'B 端节点',
  deviceAId: 'A 端设备',
  deviceBId: 'B 端设备',
  deviceClass: '设备类别',
  freqKhz: '频率 / kHz（可空）',
  bandwidthKhz: '带宽 / kHz（可空）',
  isBackup: '备用标识（可不提供）',
  name: '节点名称',
  remark: '备注（最多 500 字）',
  subtype: '固定站类型',
  parentIds: '上级节点 ID（多个用分号分隔，可空）',
  key: '关键节点',
  relayCapable: '中继能力',
  stationId: '所属站点',
  modelId: '设备型号',
  antennaId: '天线型号',
  tiltDeg: '倾角 / °（可空）',
  azimuthDeg: '方位角 / °（可空）',
  installedAt: '安装时间（带时区 ISO，可空）',
  longitude: '经度 / ° E',
  latitude: '纬度 / ° N',
  elevationM: '高程 / m（可空）',
  region: '所属区域（可空）',
  antennaHeightM: '天线高度 / m',
  txPowerDbm: '发射功率 / dBm',
  workFreqKhz: '工作频率 / kHz（可空）',
};
const device = computed(() =>
  editor.form?.kind === 'device'
    ? editor.resources.devices.find((row) => row.id === editor.form?.id)
    : undefined,
);
const model = computed(() =>
  editor.form?.kind === 'device'
    ? editor.resources.models.find(
        (row) =>
          row.id === (editor.form?.creating ? editor.form.fields.modelId : device.value?.modelId),
      )
    : undefined,
);
const warning = computed(
  () =>
    device.value?.txPowerDbm != null &&
    model.value &&
    device.value.txPowerDbm > model.value.txPowerMaxDbm,
);
function errors(key: string) {
  const field = key === 'longitude' || key === 'latitude' ? 'coordinate' : key;
  return editor.issues
    .filter(
      (issue) =>
        issue.objectId === editor.form?.id &&
        issue.field === field &&
        (editor.form?.kind !== 'candidate' || issue.sheet === 'topology_links'),
    )
    .map((issue) => issue.message)
    .join('；');
}
// 只列端点已有设备，不代替服务判断物理可通性，也不自动选取另一台设备。
function candidateDevices(key: string) {
  const stationId = editor.form?.fields[key === 'deviceAId' ? 'nodeAId' : 'nodeBId'];
  return editor.resources.devices.filter((row) => row.stationId === stationId);
}
function changeCandidateNode(key: string) {
  if (editor.form?.kind === 'candidate')
    editor.form.fields[key === 'nodeAId' ? 'deviceAId' : 'deviceBId'] = '';
}
function canLocateIssue(issue: import('../types/resource-edit').ResourceIssue) {
  return (
    issue.objectId === editor.form?.id &&
    (editor.form?.kind !== 'candidate' || issue.sheet === 'topology_links')
  );
}
</script>
<style scoped>
.edit-fields {
  display: grid;
  gap: 15px;
  margin: 20px 0;
}
.edit-fields label {
  display: grid;
  gap: 8px;
}
.field-error,
.error-box {
  color: #ffb4b4;
  font-size: 12px;
  line-height: 1.7;
}
.error-box {
  border: 1px solid #864455;
  background: #351f2b;
  padding: 12px;
  border-radius: 5px;
}
.error-box ul {
  padding-left: 18px;
}
.edit-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
[aria-invalid='true'] {
  border-color: #d57583;
}
</style>
