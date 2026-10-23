<template>
  <AppDrawer
    :visible="!!editor.form && editor.form.kind !== 'interference' && !editor.picking"
    :title="
      (editor.form?.creating ? '新增' : '编辑') +
      (editor.form?.kind === 'station'
        ? '固定站'
        : editor.form?.kind === 'candidate'
          ? '候选链路'
          : '设备参数')
    "
    :subtitle="
      editor.context === 'gis'
        ? '应用后预览草稿；工具栏保存后写入当前浏览器。'
        : '单条保存，成功后同步 GIS 与设备台账。'
    "
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
        >新登记对象初始离线、无告警，属于教学登记值。固定站允许暂不配置设备。</p
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
        >在地图上重新取点</button
      >
      <!-- 取点来源仅说明当前输入，应用和保存仍由原按钮完成。 -->
      <p
        v-if="editor.form.kind === 'station' && editor.pickNotice"
        class="notice"
        role="status"
        >{{ editor.pickNotice }}</p
      >
      <form
        ref="fieldRoot"
        tabindex="-1"
        class="edit-fields"
        @submit.prevent="editor.context === 'gis' ? editor.applyForm() : editor.save()"
      >
        <label
          v-for="(_, key) in editor.form.fields"
          :key="key"
          :for="'resource-' + key"
        >
          {{ labels[key] }}
          <select
            :data-validation-field="key"
            v-if="key === 'subtype'"
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
          {{ editor.busy ? '保存中…' : editor.context === 'gis' ? '应用到草稿' : '保存当前设备' }}
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
          ><button
            v-else-if="canLocateLedgerIssue(issue)"
            type="button"
            class="text-link"
            :disabled="!editor.canEdit || editor.busy"
            v-on="{ click: ledgerIssueAction(issue) }"
            >定位字段</button
          ><span v-else>当前表单没有此对象或字段，请核对错误说明。</span> {{ issue.objectId }} ·
          {{ issue.field }}：{{ issue.message }}
        </li>
      </ul>
    </div>
    <p
      v-if="fieldNotice"
      class="readonly-note"
      role="status"
      >{{ fieldNotice }}</p
    >
    <p
      v-if="editor.message"
      class="notice"
      role="status"
      >{{ editor.message }}</p
    >
    <template #footer>
      <div class="edit-footer">
        <span class="muted">{{
          editor.formDirty
            ? '当前输入未' + (editor.context === 'gis' ? '应用' : '保存')
            : '当前表单无未提交输入'
        }}</span
        ><button
          v-if="editor.context === 'gis'"
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
          @click="editor.save()"
        >
          保存全部草稿</button
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
import { computed, nextTick, ref, watch } from 'vue';
import { focusGisField } from '../services/gis-validation';
import AppDrawer from './AppDrawer.vue';
import { useResourceEditStore } from '../stores/resource-edit';
import { stationTypes } from '../mocks/resource-presets';
import { DEMO_BBOX } from '../config/demo';
import type { ResourceIssue } from '../types/resource-edit';
const editor = useResourceEditStore();
// GIS 定位只操作当前表单，抽屉动画结束后再次核对请求，避免焦点落到旧对象。
const fieldRoot = ref<HTMLElement | null>(null);
const fieldNotice = ref('');
watch(
  () => [editor.form, editor.context, editor.issues],
  () => {
    fieldNotice.value = '';
  },
  { flush: 'sync' },
);
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
// 失权保留字段，阻止应用或保存。
const labels: Record<string, string> = {
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
function canLocateLedgerIssue(issue: ResourceIssue) {
  const form = editor.form,
    field = issue.field === 'coordinate' ? 'longitude' : issue.field;
  const sheets = {
    station: 'nodes',
    device: 'devices',
    interference: 'interference_sources',
    candidate: 'topology_links',
  };
  return (
    !!form &&
    issue.objectId === form.id &&
    (!issue.sheet || issue.sheet === sheets[form.kind]) &&
    Object.hasOwn(form.fields, field)
  );
}
// 定位绑定当时的表单与错误清单，只操作抽屉 DOM，不改写 Hash 路由或未保存输入。
function ledgerIssueAction(issue: ResourceIssue) {
  const form = editor.form,
    issues = editor.issues;
  const valid = () =>
    editor.context === 'ledger' &&
    editor.form === form &&
    editor.issues === issues &&
    issues.includes(issue) &&
    editor.canEdit &&
    !editor.busy &&
    !editor.picking &&
    !!fieldRoot.value;
  return async () => {
    if (!valid()) return;
    fieldNotice.value = '';
    if (!canLocateLedgerIssue(issue)) {
      fieldNotice.value = '当前表单没有此对象或字段，请核对错误说明。';
      return;
    }
    await nextTick();
    if (
      valid() &&
      !focusGisField(fieldRoot.value, issue.field === 'coordinate' ? 'longitude' : issue.field)
    )
      fieldNotice.value = '当前字段没有可聚焦的编辑控件，请核对错误说明。';
  };
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
