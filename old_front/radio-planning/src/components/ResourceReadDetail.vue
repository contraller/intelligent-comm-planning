<template>
  <section class="read-detail"
    ><div class="detail-title"
      ><h3>对象详情</h3
      ><button
        v-if="store.selected"
        class="text-link"
        @click="store.closeDetail()"
        >关闭</button
      ></div
    ><p v-if="store.pending.detail">正在读取所选对象…</p
    ><p
      v-else-if="store.errors.detail"
      role="alert"
      >{{ store.errors.detail }}
      <button
        class="text-link"
        :disabled="store.frozen"
        @click="store.selected && store.selectObject(store.selected.kind, store.selected.id)"
        >重试</button
      ></p
    ><template v-else-if="object"
      ><h3>{{ object.kind === 'device' ? object.modelName : object.name }}</h3
      ><p class="muted">{{ object.id }}</p
      ><div v-if="object.kind !== 'interference'"
        ><StatusBadge
          :status="object.status"
          :alert="object.alert === true"
        /><span
          class="unknown"
          v-if="object.alert === null"
          >附加告警：未提供</span
        ><span
          class="muted"
          v-else-if="!object.alert"
        >
          · 无附加告警</span
        ></div
      ><p v-else>{{ object.active ? '生效干扰源' : '未生效干扰源' }}</p
      ><dl class="kv"
        ><dt>创建来源</dt><dd>{{ object.origin ? origins[object.origin] : '未提供' }}</dd
        ><dt>经度 / 纬度</dt><dd>{{ coordinate?.map((n) => n.toFixed(6)).join(' / ') }} °</dd
        ><template v-if="object.kind === 'node'"
          ><dt>区域</dt><dd>{{ object.region || '未提供' }}</dd
          ><dt>层级 / 子类型</dt><dd>{{ object.echelon }} / {{ object.subtype || '未提供' }}</dd
          ><dt>上级节点</dt><dd>{{ object.parentIds.join('、') || '根节点' }}</dd
          ><dt>频段能力</dt><dd>{{ object.classes.join(' / ') || '未提供' }}</dd
          ><dt>角色 / 移动类型</dt><dd>{{ object.role || '未提供' }} / {{ object.mobility }}</dd
          ><dt>中继能力</dt><dd>{{ object.relayCapable ? '支持' : '不支持' }}</dd
          ><dt>高程</dt><dd>{{ object.elevationM ?? '未提供' }} m</dd><dt>备注</dt
          ><dd>{{ object.remark || '未提供' }}</dd></template
        ><template v-else-if="object.kind === 'device'"
          ><dt>所属节点</dt
          ><dd
            ><button
              v-if="store.context === 'gis'"
              class="text-link"
              :disabled="store.frozen"
              @click="store.selectObject('node', object.stationId)"
              >{{ object.stationName }}</button
            ><span v-else>{{ object.stationName }}</span
            ><br />{{ object.stationId }}</dd
          ><dt>类别 / 在架状态</dt
          ><dd>{{ object.deviceClass }} / {{ availability(object.availability) }}</dd
          ><dt>设备型号</dt><dd>{{ object.modelName }} · {{ object.modelId }}</dd
          ><dt>天线型号</dt><dd>{{ object.antennaName }} · {{ object.antennaId }}</dd
          ><dt>天线高度</dt><dd>{{ object.antennaHeightM ?? '未提供' }} m</dd><dt>发射功率</dt
          ><dd>{{ object.txPowerDbm ?? '未提供' }} dBm</dd><dt>工作频率</dt
          ><dd>{{ object.workFreqKhz ?? '未提供' }} kHz</dd><dt>倾角 / 方位角</dt
          ><dd>{{ object.tiltDeg ?? '未提供' }} / {{ object.azimuthDeg ?? '未提供' }} °</dd
          ><dt>安装时间</dt><dd>{{ object.installedAt || '未提供' }}</dd
          ><template v-if="store.detail?.model"
            ><dt>厂家</dt><dd>{{ store.detail.model.manufacturer || '未提供' }}</dd
            ><dt>型号频率范围</dt
            ><dd>{{ store.detail.model.freqMinKhz }}–{{ store.detail.model.freqMaxKhz }} kHz</dd
            ><dt>型号功率上限</dt><dd>{{ store.detail.model.txPowerMaxDbm }} dBm</dd></template
          ></template
        ><template v-else
          ><dt>类型</dt><dd>{{ object.interferenceType }}</dd
          ><dt>中心频率</dt><dd>{{ object.centerFreqKhz }} kHz</dd><dt>带宽</dt
          ><dd>{{ object.bandwidthKhz }} kHz</dd><dt>发射功率</dt
          ><dd>{{ object.txPowerDbm }} dBm</dd><dt>天线高度</dt
          ><dd>{{ object.antennaHeightM }} m</dd><dt>天线增益</dt
          ><dd>{{ object.antennaGainDbi ?? '未提供' }} dBi</dd><dt>方向图 / 方位角</dt
          ><dd>{{ object.patternType || '未提供' }} / {{ object.azimuthDeg ?? '未提供' }} °</dd
          ><dt>占空比</dt><dd>{{ object.dutyCycle ?? '未提供' }}</dd></template
        ></dl
      ><button
        v-if="canLocate"
        class="btn small"
        :disabled="store.frozen"
        @click="emit('locate', object)"
        >地图定位</button
      ><div
        v-if="object.kind === 'node'"
        class="associated"
        ><h4>关联设备 · {{ object.deviceCount }} 台</h4
        ><p v-if="store.pending['detail:devices']">正在读取设备…</p
        ><p
          v-if="store.errors['detail:devices']"
          role="alert"
          >{{ store.errors['detail:devices'] }}
          <button
            class="text-link"
            :disabled="store.frozen"
            @click="loadDevices"
            >重试</button
          ></p
        ><template v-if="devices && devices.revision === store.workspace?.revision"
          ><button
            v-for="device in devices.items"
            :key="device.id"
            class="device-row"
            :disabled="store.frozen"
            @click="store.selectObject('device', device.id)"
            ><span>{{ device.id }} · {{ device.modelName }}</span
            ><small>{{ availability(device.availability) }}</small></button
          ><div class="pager"
            ><button
              class="btn small"
              :disabled="store.frozen || devices.page <= 1"
              @click="
                page = devices.page - 1;
                loadDevices();
              "
              >上一页</button
            ><span>{{ devices.page }} / {{ Math.max(1, Math.ceil(devices.total / 10)) }}</span
            ><button
              class="btn small"
              :disabled="store.frozen || devices.page * 10 >= devices.total"
              @click="
                page = devices.page + 1;
                loadDevices();
              "
              >下一页</button
            ></div
          ></template
        ></div
      ><p class="muted section-gap">显示已保存资源。编辑、型号知识及业务分析尚未接入。</p></template
    ><p
      v-else
      class="muted"
      >选择资源查看详情。</p
    ></section
  >
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useResourceReadStore } from '../stores/resource-read';
import StatusBadge from './StatusBadge.vue';
import type { ReadDevice, ReadObject, ResourcePage } from '../types/resource-read';
defineProps<{ canLocate?: boolean }>();
const emit = defineEmits<{ locate: [object: ReadObject] }>();
const store = useResourceReadStore(),
  page = ref(1),
  devices = ref<ResourcePage<ReadDevice> | null>(null);
const object = computed(() => store.detail?.object ?? null);
const origins = { SOURCE: '原始资料', MANUAL: '手工创建', IMPORT: '文件导入' };
const availability = (value: ReadDevice['availability']) =>
  value === null ? '未知' : value === 'ACTIVE' ? '在架' : '已下架';
const coordinate = computed(() =>
  object.value?.kind === 'device' ? object.value.stationCoordinate : object.value?.coordinate,
);
let ticket = 0;
async function loadDevices() {
  if (object.value?.kind !== 'node') return;
  const id = object.value.id,
    token = ++ticket;
  const value = await store.fetchDevices(id, page.value);
  if (token === ticket && object.value?.id === id && value) devices.value = value;
}
watch(
  () => [object.value?.kind, object.value?.id, store.detail?.revision],
  () => {
    ticket++;
    devices.value = null;
    page.value = 1;
    void loadDevices();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ticket++;
  store.cancelGroup('detail:devices');
});
</script>
<style scoped>
.read-detail {
  padding: 18px;
  line-height: 1.7;
}
.detail-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.read-detail h3 {
  margin: 0 0 10px;
}
.read-detail .kv {
  margin: 18px 0;
  overflow-wrap: anywhere;
}
.unknown {
  display: block;
  color: #c2a87f;
  font-size: 12px;
}
.associated {
  border-top: 1px solid var(--line);
  margin-top: 18px;
}
.device-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px;
  border: 0;
  border-bottom: 1px solid var(--line);
  color: var(--text);
  background: transparent;
  cursor: pointer;
}
.device-row:hover {
  background: #203249;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
  font-size: 11px;
}
</style>
