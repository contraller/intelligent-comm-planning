<template>
  <div class="spectrum-panel">
    <!-- 只展示可用教学频段，不擅自补齐或保存用户配置。 -->
    <p class="spectrum-hint"
      >GIS 频谱态势支持：{{
        SPECTRUM_MONITORING_BANDS.map((b) => b.minKhz + '–' + b.maxKhz + ' kHz').join('、')
      }}。保存完整配置并通过当前版本的 Mock 检查后可播放；其他频段暂无观测预设。</p
    >
    <div class="toolbar spectrum-toolbar"
      ><button
        class="btn primary"
        :disabled="!store.canEdit || store.busy"
        @click="store.open()"
        >新增配置</button
      ><button
        class="btn"
        :disabled="!auth.can('resources.view') || store.loading || store.busy || store.dirty"
        @click="store.load()"
        >刷新</button
      ><button
        class="btn"
        :disabled="!auth.can('resources.reset') || store.busy"
        @click="store.reset()"
        >重置频谱配置</button
      >
      <label class="demo-settings"
        >演示检查<select
          v-model="demo"
          :disabled="store.busy"
          aria-label="Mock 检查场景"
          ><option value="success">模拟成功</option
          ><option value="connection-failed">模拟连接失败</option
          ><option value="format-invalid">模拟格式异常</option></select
        ></label
      >
    </div>
    <p
      v-if="store.loading"
      role="status"
      >读取中…</p
    ><p
      v-if="store.error"
      class="error"
      role="alert"
      >{{ store.error }}</p
    ><p
      v-if="store.notice"
      class="notice"
      role="status"
      >{{ store.notice }}</p
    >
    <!-- 与设备台账共用列表模板，检查结果始终标明所属配置版本。 -->
    <!-- 列表沿用服务返回顺序，不开放表头排序。 -->
    <AppTable
      :rows="store.workspace?.sources ?? []"
      :columns="columns"
      :loading="store.loading"
      :server="true"
      :sortable="false"
      :total="store.total"
      :page-size="store.query.pageSize"
      :first="(store.query.pageNum - 1) * store.query.pageSize"
      @page="
        store.load({ pageNum: Math.floor($event.first / $event.rows) + 1, pageSize: $event.rows })
      "
    >
      <template #name="{ row }"
        ><strong>{{ row.name }}</strong
        ><small class="cell-note">{{ row.id }}</small></template
      >
      <template #range="{ row }"
        ><span class="nowrap"
          >{{ row.minKhz ?? '待补全' }}–{{ row.maxKhz ?? '待补全' }}</span
        ></template
      >
      <template #protocol="{ row }"
        ><span class="nowrap">{{
          row.protocol === 'HTTP_JSON' ? 'HTTP JSON' : 'WebSocket JSON'
        }}</span></template
      >
      <template #enabled="{ row }"
        ><span
          class="chip"
          :class="{ amber: !row.enabled }"
          >{{ row.enabled ? '启用' : '停用' }}</span
        ></template
      >
      <template #connection="{ row }">{{ checkLabel(row, 'connection') }}</template>
      <template #validation="{ row }"
        >{{ checkLabel(row, 'validation')
        }}<small
          v-if="last(row)"
          class="cell-note"
          >{{ last(row)!.message }} · 配置版本 {{ last(row)!.configRevision }}</small
        ></template
      >
      <template #checkedAt="{ row }">{{ last(row)?.checkedAt ?? '未检查' }}</template>
      <template #actions="{ row: source }"
        ><div class="toolbar"
          ><button
            class="btn"
            :disabled="!store.canEdit || store.busy"
            @click="store.open(source)"
            >编辑 / 启停</button
          ><button
            class="btn"
            :disabled="
              !store.canEdit ||
              store.busy ||
              store.dirty ||
              !source.enabled ||
              source.minKhz === null
            "
            @click="store.check(source, demo)"
            >执行 Mock 检查</button
          ></div
        >
      </template>
    </AppTable>
    <AppDrawer
      :visible="!!store.form"
      title="频谱接口配置"
      subtitle="只保存教学配置，不建立真实连接。"
      @update:visible="!$event && store.leave()"
    >
      <form
        v-if="store.form"
        class="fields"
        @submit.prevent="store.save()"
      >
        <p class="readonly-note">{{ store.form.id }}</p>
        <label
          >名称<input
            v-model="store.form.name"
            :disabled="!store.canEdit || store.busy"
            maxlength="60"
        /></label>
        <label
          >协议<select
            v-model="store.form.protocol"
            :disabled="!store.canEdit || store.busy"
            ><option value="HTTP_JSON">HTTP JSON</option
            ><option value="WEBSOCKET_JSON">WebSocket JSON</option></select
          ></label
        >
        <label
          >接入地址<input
            v-model="store.form.endpoint"
            :disabled="!store.canEdit || store.busy"
            maxlength="500"
        /></label>
        <label
          >采集周期 / s<input
            v-model.number="store.form.intervalSeconds"
            type="number"
            :disabled="!store.canEdit || store.busy"
        /></label>
        <label
          >频段下限 / kHz<input
            v-model.number="store.form.minKhz"
            type="number"
            :disabled="!store.canEdit || store.busy"
        /></label>
        <label
          >频段上限 / kHz<input
            v-model.number="store.form.maxKhz"
            type="number"
            :disabled="!store.canEdit || store.busy"
        /></label>
        <label
          ><input
            v-model="store.form.enabled"
            type="checkbox"
            :disabled="!store.canEdit || store.busy"
          />启用</label
        >
        <p
          v-if="store.error"
          class="error"
          >{{ store.error }}</p
        ><button
          class="btn primary"
          :disabled="!store.canEdit || store.busy"
          >{{ store.busy ? '保存中…' : '保存配置' }}</button
        >
      </form>
      <template #footer
        ><p>配置有变化后旧检查失效，需重新检查。</p
        ><button
          class="btn"
          :disabled="store.busy"
          @click="store.leave()"
          >关闭</button
        ></template
      >
    </AppDrawer>
    <DecisionDialog
      :request="store.decision"
      @answer="store.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { SPECTRUM_MONITORING_BANDS } from '../config/demo';
import { onMounted, onBeforeUnmount, ref } from 'vue';
import AppDrawer from './AppDrawer.vue';
import AppTable from './AppTable.vue';
import DecisionDialog from './DecisionDialog.vue';
import { useSpectrumStore } from '../stores/spectrum';
import { useAuthStore } from '../stores/auth';
import type { SpectrumDemo, SpectrumSource } from '../types/spectrum';
const store = useSpectrumStore(),
  auth = useAuthStore(),
  demo = ref<SpectrumDemo>('success');
onMounted(() => {
  if (!store.workspace) void store.load();
});
onBeforeUnmount(store.stopReading);
// 行摘要直接带最近检查，页面不下载或扫描完整检查历史。
const last = (
  s: SpectrumSource & { latestCheck?: import('../types/spectrum').SpectrumCheck | null },
) => s.latestCheck;
const label = (state: string) =>
  ({ SUCCESS: '成功', FAILED: '失败', NOT_RUN: '未执行' })[state] ?? state;
const columns = [
  { field: 'name', header: '采集源名称' },
  { field: 'endpoint', header: '接入地址', sortable: false },
  { field: 'protocol', header: '协议', sortable: false },
  { field: 'intervalSeconds', header: '周期（s）' },
  { field: 'range', header: '采集频段（kHz）', sortable: false },
  { field: 'enabled', header: '启停状态', sortable: false },
  { field: 'connection', header: '连接检查', sortable: false },
  { field: 'validation', header: '数据校验', sortable: false },
  { field: 'checkedAt', header: '最近检查时间', sortable: false },
];
function checkLabel(source: SpectrumSource, field: 'connection' | 'validation') {
  const check = last(source);
  if (!check) return '未检查';
  return !source.enabled || check.configRevision !== source.revision
    ? '旧检查已失效，请重新检查'
    : label(check[field]);
}
</script>
<style scoped>
.spectrum-panel {
  padding: 20px;
}
.cell-note {
  display: block;
  margin-top: 6px;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.nowrap {
  white-space: nowrap;
}
.demo-settings {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.demo-settings select {
  width: auto;
}
.spectrum-hint {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
@media (max-width: 900px) {
  .demo-settings {
    flex-basis: 100%;
    margin-left: 0;
  }
}
.spectrum-panel > .toolbar {
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.spectrum-panel :deep(td) {
  max-width: 280px;
  overflow-wrap: anywhere;
}
.fields {
  display: grid;
  gap: 15px;
}
.fields label {
  display: grid;
  gap: 7px;
}
.error {
  color: #ffb4b4;
  margin: 12px 0;
}
dd {
  overflow-wrap: anywhere;
}
</style>
