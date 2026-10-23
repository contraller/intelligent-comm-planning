<template>
  <AppDrawer
    :visible="config.visible"
    title="工作参数配置与记录"
    subtitle="配置下发与回执独立记录；台账参数通过资源编辑保存。"
    @update:visible="!$event && config.leave()"
  >
    <div class="toolbar"
      ><button
        class="btn"
        :disabled="!config.data"
        @click="config.tab = 'configure'"
        >本次配置</button
      ><button
        class="btn"
        :disabled="config.busy || !config.readable"
        @click="config.queryHistory()"
        >配置记录</button
      ></div
    >
    <p
      v-if="config.busy"
      role="status"
      >正在读取或处理请求…</p
    >
    <p
      v-if="config.error"
      class="notice warn"
      role="alert"
      >{{ config.error }}</p
    ><p
      v-if="config.notice"
      class="notice"
      role="status"
      >{{ config.notice }}</p
    >
    <p
      v-if="!config.readable"
      class="notice warn"
      >当前无访问权限，输入与待核实请求已保留。</p
    >
    <section
      v-if="config.pending"
      class="config-section"
      aria-label="待核实配置"
    >
      <h3>请求待核实</h3
      ><p>设备 {{ config.pending.deviceId }} · 请求 {{ config.pending.requestId }}</p
      ><p
        >请求值：{{ config.pending.values.txPowerDbm }} dBm /
        {{ config.pending.values.workFreqKhz }} kHz</p
      >
      <button
        class="btn"
        :disabled="config.busy || !config.readable"
        @click="config.verify"
        >核实原请求</button
      >
      <template v-if="config.notFound"
        ><button
          class="btn"
          :disabled="config.busy || !config.editable"
          @click="config.resend"
          >用原请求编号重发</button
        ><button
          class="btn"
          :disabled="config.busy || !config.readable"
          @click="config.discardNotFound"
          >放弃未受理请求</button
        ></template
      >
    </section>
    <template v-if="config.tab === 'configure'">
      <section
        v-if="config.data"
        class="config-section"
      >
        <h3>{{ config.data.deviceId }} · {{ config.data.model.name }}</h3>
        <details class="source-details"
          ><summary>配置来源与版本</summary><p>{{ config.data.source }}</p
          ><p
            >来源 {{ config.data.resourceEpoch }} / 设备版本 {{ config.data.deviceVersion }}</p
          ></details
        >
        <dl class="kv"
          ><dt>台账当前功率</dt><dd>{{ config.data.device.txPowerDbm ?? '未提供' }} dBm</dd
          ><dt>台账当前频率</dt><dd>{{ config.data.device.workFreqKhz ?? '未提供' }} kHz</dd
          ><dt>型号频率范围</dt
          ><dd>{{ config.data.model.freqMinKhz }}–{{ config.data.model.freqMaxKhz }} kHz</dd
          ><dt>功率上限／档位</dt
          ><dd
            >{{ config.data.model.txPowerMaxDbm }} dBm /
            {{ config.data.powerLevels?.join('、') || '未提供' }}</dd
          ></dl
        >
        <p
          v-if="config.disabledReason || config.data.unavailableReason || !config.editable"
          class="notice"
          >{{
            config.disabledReason ||
            config.data.unavailableReason ||
            '当前为只读记录；GIS 编辑模式或台账维护权限下可配置。'
          }}</p
        >
        <label
          >本次发射功率（dBm）<input
            v-model="config.power"
            type="number"
            step="any"
            aria-label="配置发射功率"
            :disabled="config.locked"
        /></label>
        <label
          >本次工作频率（kHz）<input
            v-model="config.frequency"
            type="number"
            step="any"
            aria-label="配置工作频率"
            :disabled="config.locked"
        /></label>
        <label
          >本次工作模式<select
            v-model="config.mode"
            aria-label="配置工作模式"
            :disabled="config.locked"
            ><option value="">未提供，请明确选择</option
            ><option
              v-for="mode in config.data.modeOptions"
              :key="mode.value"
              :value="mode.value"
              >{{ mode.label }}</option
            ></select
          ></label
        >
        <label
          >执行场景<select
            v-model="config.scenario"
            aria-label="配置执行场景"
            :disabled="config.locked"
            ><option
              v-for="s in config.data.scenarios"
              :key="s.id"
              :value="s.id"
              >{{ configurationLabel(s.name) }}</option
            ></select
          ></label
        >
        <div class="toolbar"
          ><button
            class="btn"
            :disabled="config.locked || !config.data.defaultPresetId"
            @click="config.data.defaultPresetId && config.usePreset(config.data.defaultPresetId)"
            >恢复默认</button
          ><button
            v-for="p in config.data.presets.filter((p) => p.id !== config.data!.defaultPresetId)"
            :key="p.id"
            class="btn"
            :disabled="config.locked"
            @click="config.usePreset(p.id)"
            >{{ configurationLabel(p.name) }}</button
          ><button
            class="btn"
            :disabled="config.busy || !!config.pending || !config.readable"
            @click="config.refreshContext"
            >重新读取来源</button
          ></div
        >
        <p>默认值来自当前配置预设；超出预设范围时仅提供校验。</p>
        <ul
          v-if="config.validation && !config.validation.valid"
          class="notice warn"
          ><li
            v-for="issue in config.validation.issues"
            :key="issue.field"
            >{{ issue.field }}：{{ issue.message }}</li
          ></ul
        >
        <div class="toolbar"
          ><button
            class="btn"
            :disabled="config.locked"
            @click="config.validate"
            >校验</button
          ><button
            class="btn primary"
            :disabled="config.locked || !config.validated"
            @click="config.submit"
            >{{ config.retryOf ? '重试下发' : '下发配置' }}</button
          ></div
        >
      </section>
      <p>{{ config.progressFromRecord ? '所选记录的三步进度' : '本次输入的三步进度' }}</p>
      <ol
        class="config-stages"
        aria-label="配置三步进度"
        ><li>校验：{{ validationState }}</li
        ><li>下发：{{ dispatchState }}</li
        ><li>回执：{{ receiptState }}</li></ol
      >
      <section
        v-if="operation"
        class="config-section"
        aria-label="配置回执"
      >
        <h3>{{ statusNames[operation.status] }} · {{ operation.request.deviceId }}</h3
        ><p>{{ operation.message }}</p
        ><p
          v-if="config.result?.sourceChanged"
          class="notice warn"
          >历史来源已变化，此记录保留，不能重试旧配置。</p
        >
        <dl class="kv"
          ><dt>请求编号</dt><dd>{{ operation.request.requestId }}</dd
          ><dt>设备／型号</dt
          ><dd
            >{{ operation.device.id }} / {{ operation.modelName }} /
            {{ operation.device.modelId }}</dd
          ><dt>来源版本</dt
          ><dd>{{ operation.request.resourceEpoch }} / {{ operation.request.deviceVersion }}</dd
          ><dt>冻结请求</dt
          ><dd
            >{{ operation.request.values.txPowerDbm }} dBm /
            {{ operation.request.values.workFreqKhz }} kHz</dd
          ><dt>服务报告的执行值</dt
          ><dd>{{
            operation.appliedValues
              ? `${operation.appliedValues.txPowerDbm} dBm / ${operation.appliedValues.workFreqKhz} kHz`
              : '未提供成功执行值'
          }}</dd
          ><dt>受理／更新</dt><dd>{{ operation.acceptedAt }}<br />{{ operation.updatedAt }}</dd
          ><dt>执行场景</dt
          ><dd>{{
            config.data?.scenarios.find((s) => s.id === operation!.request.scenario)?.name ??
            operation.request.scenario
          }}</dd
          ><dt>重试来源</dt><dd>{{ operation.request.retryOf ?? '首次请求' }}</dd></dl
        >
        <p
          >请求模式：{{ operation.request.values.currentWorkMode ?? '未提供' }} · 执行模式：{{
            operation.appliedValues?.currentWorkMode ?? '未提供'
          }}
          · 操作人：{{ operation.actor?.name ?? '未提供' }}</p
        >
        <button
          v-if="operation.status === 'FAILED'"
          class="btn"
          :disabled="
            config.locked ||
            config.result?.sourceChanged ||
            config.data?.deviceId !== operation.request.deviceId
          "
          @click="config.prepareRetry"
          >准备失败重试</button
        >
        <button
          v-if="operation.status === 'RUNNING'"
          class="btn"
          :disabled="config.busy || !config.readable"
          @click="config.selectRecord(config.result!)"
          >继续查看进度</button
        >
      </section>
    </template>
    <section
      v-else
      class="config-section"
      aria-label="配置历史记录"
    >
      <p
        >仅展示服务记录；资源重置后历史仍保留。{{
          config.deviceId ? '当前设备：' + config.deviceId : '全部设备'
        }}</p
      >
      <p v-if="!config.history?.items.length">暂无配置记录。</p>
      <article
        v-for="item in config.history?.items"
        :key="item.id"
        class="config-record"
        ><strong>{{ item.deviceId }} · {{ statusNames[item.status] }}</strong
        ><p>{{ item.acceptedAt }} · {{ item.sourceChanged ? '历史来源' : '当前来源' }}</p
        ><p>{{ item.values.txPowerDbm }} dBm / {{ item.values.workFreqKhz }} kHz</p
        ><button
          class="text-link"
          :disabled="config.busy || !!config.pending || !config.readable"
          @click="config.selectRecord(item)"
          >查看冻结请求与回执</button
        ></article
      >
      <div
        v-if="config.history"
        class="toolbar"
        ><button
          class="btn"
          :disabled="config.busy || config.history.pageNum <= 1 || !config.readable"
          @click="config.queryHistory(config.history.pageNum - 1)"
          >上页</button
        ><span>共 {{ config.history.total }} 条 · 第 {{ config.history.pageNum }} 页</span
        ><button
          class="btn"
          :disabled="
            config.busy ||
            config.history.pageNum * config.history.pageSize >= config.history.total ||
            !config.readable
          "
          @click="config.queryHistory(config.history.pageNum + 1)"
          >下页</button
        ></div
      >
    </section>
    <template #footer
      ><button
        class="btn"
        :disabled="config.busy"
        @click="config.leave()"
        >关闭</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
const config = useDeviceConfigurationStore();
const operation = computed(() => config.result?.operation);
// 预设名称使用业务文案，标识、来源原文和执行结果保持服务提供的值。
const configurationLabel = (value: string) => value.replace(/教学|演示|Mock\s*/g, '').trim();
const statusNames = { RUNNING: '进行中', SUCCEEDED: '成功', FAILED: '失败', NOT_FOUND: '未找到' };
// 三阶段直接展示服务结果；成功不把参数复制到台账。
const progressOperation = computed(() => (config.progressFromRecord ? operation.value : null));
const validationState = computed(() =>
  progressOperation.value
    ? '已通过'
    : config.validation?.valid
      ? '已通过'
      : config.validation
        ? '未通过'
        : '未校验',
);
const dispatchState = computed(() =>
  !progressOperation.value
    ? '未执行'
    : progressOperation.value.phase === 'DISPATCH'
      ? progressOperation.value.status === 'FAILED'
        ? '发送失败'
        : '发送中'
      : '已发送',
);
const receiptState = computed(() =>
  !progressOperation.value || progressOperation.value.phase === 'DISPATCH'
    ? '未执行'
    : progressOperation.value.status === 'RUNNING'
      ? '等待回执'
      : statusNames[progressOperation.value.status],
);
</script>
<style scoped>
.source-details {
  font-size: 12px;
  color: var(--muted);
}
.source-details summary {
  cursor: pointer;
}
.config-section {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.config-section p {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  margin: 9px 0;
}
.config-section label {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.config-stages {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin: 16px 0;
  padding-left: 20px;
  font-size: 12px;
}
.config-record {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.kv dd {
  overflow-wrap: anywhere;
}
.warn {
  color: #ffbd97;
}
</style>
