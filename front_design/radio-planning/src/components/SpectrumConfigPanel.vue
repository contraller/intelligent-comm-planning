<template>
  <div class="spectrum-panel">
    <p class="notice"
      >Mock 配置与检查；不会访问填写的地址，不代表真实采集已接入。原始配置的频段需补全，HTTP_JSON
      为我方默认建议。</p
    >
    <!-- 只展示可用教学频段，不擅自补齐或保存用户配置。 -->
    <p class="notice"
      >GIS 频谱态势支持：{{
        SPECTRUM_MONITORING_BANDS.map((b) => b.minKhz + '–' + b.maxKhz + ' kHz').join('、')
      }}。保存完整配置并通过当前版本的 Mock 检查后可播放；其他频段暂无观测预设。</p
    >
    <div class="toolbar"
      ><button
        class="btn primary"
        :disabled="!store.canEdit || store.busy"
        @click="store.open()"
        >新增配置</button
      ><button
        class="btn"
        :disabled="store.busy || store.dirty"
        @click="store.load()"
        >刷新</button
      ><button
        class="btn"
        :disabled="!auth.can('resources.reset') || store.busy"
        @click="store.reset()"
        >重置频谱配置</button
      >
      <select
        v-model="demo"
        aria-label="Mock 检查场景"
        ><option value="success">模拟成功</option
        ><option value="connection-failed">模拟连接失败</option
        ><option value="format-invalid">模拟格式异常</option></select
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
    <article
      v-for="source in store.workspace?.sources"
      :key="source.id"
      class="source-card"
    >
      <div
        ><h3>{{ source.name }}</h3
        ><p class="muted"
          >{{ source.id }} · {{ source.enabled ? '启用' : '停用' }} ·
          {{ source.minKhz === null ? '待补全' : '配置已保存' }}</p
        ></div
      >
      <dl class="kv"
        ><dt>接入地址</dt><dd>{{ source.endpoint }}</dd
        ><dt>协议 / 周期</dt><dd>{{ source.protocol }} / {{ source.intervalSeconds }} s</dd
        ><dt>频段 / kHz</dt
        ><dd>{{ source.minKhz ?? '待填写' }}–{{ source.maxKhz ?? '待填写' }}</dd></dl
      >
      <template v-if="last(source)"
        ><p
          :class="
            !source.enabled || last(source)!.configRevision !== source.revision ? 'notice' : 'muted'
          "
          >{{
            !source.enabled || last(source)!.configRevision !== source.revision
              ? '旧检查已失效，请重新检查'
              : '当前配置的 Mock 检查'
          }}
          · {{ last(source)!.checkedAt }}</p
        ><p
          >连接：{{ label(last(source)!.connection) }}；数据校验：{{
            label(last(source)!.validation)
          }}</p
        ><p class="readonly-note">{{ last(source)!.message }}</p
        ><small>配置版本 {{ last(source)!.configRevision }}</small></template
      >
      <p
        v-else
        class="muted"
        >未验证 · 未连接真实服务</p
      >
      <div class="toolbar"
        ><button
          class="btn"
          :disabled="!store.canEdit || store.busy"
          @click="store.open(source)"
          >编辑 / 启停</button
        ><button
          class="btn"
          :disabled="
            !store.canEdit || store.busy || store.dirty || !source.enabled || source.minKhz === null
          "
          @click="store.check(source, demo)"
          >执行 Mock 检查</button
        ></div
      >
    </article>
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
import { onMounted, ref } from 'vue';
import AppDrawer from './AppDrawer.vue';
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
const last = (s: SpectrumSource) =>
  store.workspace?.checks.filter((c) => c.sourceId === s.id).at(-1);
const label = (state: string) =>
  ({ SUCCESS: '成功', FAILED: '失败', NOT_RUN: '未执行' })[state] ?? state;
</script>
<style scoped>
.spectrum-panel {
  padding: 20px;
}
.source-card {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 20px;
  margin-top: 18px;
  display: grid;
  gap: 14px;
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
