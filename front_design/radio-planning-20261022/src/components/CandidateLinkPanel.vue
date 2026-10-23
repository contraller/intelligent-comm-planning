<template>
  <section
    class="candidate-detail"
    aria-label="GIS 候选链路详情"
    ><p
      v-if="!auth.can('situation.view')"
      class="detail-note"
      role="status"
      >当前角色没有 GIS 查看权限，无法查看候选链路详情。</p
    ><template v-else
      ><h4>{{ link.id }} <span>候选链路</span></h4
      ><p
        class="detail-note"
        role="status"
        >{{
          link.assessmentState === 'PENDING'
            ? '待评估：尚未取得当前配置的评估结果。'
            : link.source.kind === 'SOURCE'
              ? '来源样例／非当前评估'
              : '外部参考／非当前评估'
        }}</p
      ><p
        v-if="dirty"
        class="detail-note"
        role="status"
        >尚未保存，结果以服务返回为准；以下结果属于服务上次返回的记录。</p
      ><p
        v-if="hidden"
        class="detail-note"
        role="status"
        >当前候选因筛选或图层关闭而不可见，详情与定位仍可使用；可在图层管理开启候选。</p
      ><h5>{{ dirty ? '当前配置草稿' : '当前配置' }}</h5
      ><dl class="kv"
        ><dt>A 端节点</dt
        ><dd
          >{{ stationName(link.nodeAId) }}<small>{{ link.nodeAId }}</small></dd
        ><dt>A 端设备</dt><dd>{{ link.deviceAId }}</dd
        ><dt>B 端节点</dt
        ><dd
          >{{ stationName(link.nodeBId) }}<small>{{ link.nodeBId }}</small></dd
        ><dt>B 端设备</dt><dd>{{ link.deviceBId }}</dd
        ><dt>设备类别</dt><dd>{{ link.deviceClass }}</dd
        ><dt>频率</dt><dd>{{ value(link.freqKhz, 'kHz') }}</dd
        ><dt>带宽</dt><dd>{{ value(link.bandwidthKhz, 'kHz') }}</dd
        ><dt>备用标识</dt><dd>{{ value(link.isBackup) }}</dd></dl
      ><h5>{{ dirty ? '服务上次返回的结果' : '服务返回的结果' }}</h5
      ><dl class="kv"
        ><template
          v-for="row in assessmentRows(link)"
          :key="row.label"
          ><dt>{{ row.label }}</dt
          ><dd>{{ row.text }}</dd></template
        ></dl
      ><p class="detail-note">来源：{{ sourceLabel(link.source) }}</p
      ><p
        v-for="note in notes"
        :key="note"
        class="detail-note"
        role="status"
        >{{ note }}</p
      ><!-- 参考完整保留当时输入，不能与上方的新配置拼成当前评估。 --><details
        v-if="link.reference"
        class="reference-record"
        ><summary>最近一次外部参考（含当时配置）</summary
        ><p class="detail-note">以下数值仅对应本段列出的参考输入，不表示当前配置已重新评估。</p
        ><dl class="kv"
          ><dt>参考编号</dt><dd>{{ link.reference.data.id }}</dd
          ><dt>A 端节点／设备</dt
          ><dd>{{ link.reference.data.nodeAId }} / {{ link.reference.data.deviceAId }}</dd
          ><dt>B 端节点／设备</dt
          ><dd>{{ link.reference.data.nodeBId }} / {{ link.reference.data.deviceBId }}</dd
          ><dt>参考类别</dt><dd>{{ link.reference.data.deviceClass }}</dd
          ><dt>参考频率</dt><dd>{{ value(link.reference.data.freqKhz, 'kHz') }}</dd
          ><dt>参考带宽</dt><dd>{{ value(link.reference.data.bandwidthKhz, 'kHz') }}</dd
          ><dt>参考备用标识</dt><dd>{{ value(link.reference.data.isBackup) }}</dd
          ><template
            v-for="row in assessmentRows(link.reference.data)"
            :key="row.label"
            ><dt>{{ row.label }}</dt
            ><dd>{{ row.text }}</dd></template
          ></dl
        ><p class="detail-note">参考来源：{{ sourceLabel(link.reference.source) }}</p></details
      ><button
        v-if="editable && auth.can('resources.edit')"
        class="btn small"
        @click="edit"
        >编辑候选链路</button
      ></template
    ></section
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { candidateSourceNotes } from '../services/candidate-link';
import type {
  CandidateLink,
  CandidateLinkData,
  CandidateLinkSource,
} from '../types/candidate-link';
import type { GisResourceIndex } from '../types/gis-workspace';

const props = defineProps<{
  link: CandidateLink;
  resources: Pick<GisResourceIndex, 'stations'>;
  hidden?: boolean;
  dirty?: boolean;
  editable?: boolean;
}>();
const emit = defineEmits<{ edit: [id: string] }>();
const auth = useAuthStore();
const notes = computed(() => [
  ...new Set([...candidateSourceNotes(props.link), ...(props.link.notices ?? [])]),
]);
const states = { EXCELLENT: '优', GOOD: '良好', WARNING: '告警', FAULT: '故障' };
const stationName = (id: string) =>
  props.resources.stations.find((row) => row.id === id)?.name ?? '节点未提供';
const value = (data: number | boolean | null, unit = '') =>
  data === null
    ? '未提供'
    : typeof data === 'boolean'
      ? data
        ? '是'
        : '否'
      : `${data}${unit ? ' ' + unit : ''}`;
const sourceLabel = (source: CandidateLinkSource) =>
  source.file
    ? `${source.file}${source.row === null ? '' : ` · 第 ${source.row} 行`}`
    : source.kind === 'MANUAL'
      ? '手工录入'
      : '来源位置未提供';
function assessmentRows(data: CandidateLinkData) {
  // 只格式化服务字段，零值、false 和空值分别保留，不根据余量推导等级。
  return [
    { label: '距离', text: value(data.distanceM, 'm') },
    { label: '传播损耗', text: value(data.pathLossDb, 'dB') },
    { label: '接收功率', text: value(data.rxPowerDbm, 'dBm') },
    { label: '链路余量', text: value(data.linkMarginDb, 'dB') },
    { label: '可用性', text: value(data.isAvailable) },
    { label: '质量等级', text: data.linkState === null ? '未提供' : states[data.linkState] },
  ];
}
function edit() {
  if (props.editable && auth.can('situation.view') && auth.can('resources.edit'))
    emit('edit', props.link.id);
}
</script>

<style scoped>
.candidate-detail {
  padding: 14px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.candidate-detail h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.candidate-detail h4 span {
  margin-left: 8px;
  font-size: 12px;
  color: #aab8c7;
}
.candidate-detail h5 {
  margin: 14px 0 6px;
  font-size: 12px;
}
.detail-note,
.kv small {
  color: var(--muted);
  font-size: 11px;
}
.kv dd {
  min-width: 0;
}
.kv small {
  display: block;
}
.reference-record {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  margin-bottom: 12px;
}
.reference-record summary {
  cursor: pointer;
  color: #b8cadd;
}
</style>
