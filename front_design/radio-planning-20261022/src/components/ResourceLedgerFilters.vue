<template>
  <fieldset
    class="ledger-filters panel-body"
    :disabled="disabled"
  >
    <div class="toolbar ledger-basic-filters">
      <div class="search"
        ><i class="pi pi-search" /><input
          :value="query"
          aria-label="搜索设备"
          placeholder="设备编号、型号或所属节点"
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      /></div>
      <select
        :value="state"
        aria-label="筛选设备状态"
        @change="emit('update:state', ($event.target as HTMLSelectElement).value)"
      >
        <option>全部状态</option
        ><option value="NORMAL">正常</option
        ><option value="FAULT">故障</option
        ><option value="OFFLINE">离线</option>
        <option
          v-if="observed"
          value="UNKNOWN"
          >状态未提供</option
        >
      </select>
      <button
        class="btn small"
        type="button"
        :aria-expanded="advanced"
        aria-controls="ledger-more-filters"
        @click="advanced = !advanced"
        >更多筛选<span v-if="appliedAdvancedCount">（{{ appliedAdvancedCount }}）</span></button
      >
      <button
        class="btn small"
        type="button"
        @click="emit('clear')"
        >重置</button
      >
      <span
        class="match-count"
        role="status"
        >匹配 {{ count }} 台设备</span
      >
      <span
        v-if="observed"
        class="filter-caption"
        >状态/告警按同步观测筛选</span
      >
    </div>
    <div
      v-show="advanced"
      id="ledger-more-filters"
    >
      <form
        class="ledger-frequency-form"
        aria-label="频率筛选"
        novalidate
        @submit.prevent="emit('apply')"
      >
        <label
          >{{ frequency.mode === 'DEVICE' ? '工作频点下限' : '支持频段下限' }}（kHz）<input
            :value="frequency.min"
            :disabled="!rangeEnabled"
            inputmode="decimal"
            aria-label="频率下限（kHz）"
            placeholder="不限"
            @input="updateFrequency({ min: ($event.target as HTMLInputElement).value })"
        /></label>
        <label
          >{{ frequency.mode === 'DEVICE' ? '工作频点上限' : '支持频段上限' }}（kHz）<input
            :value="frequency.max"
            :disabled="!rangeEnabled"
            inputmode="decimal"
            aria-label="频率上限（kHz）"
            placeholder="不限"
            @input="updateFrequency({ max: ($event.target as HTMLInputElement).value })"
        /></label>
        <button
          class="btn small"
          type="submit"
          >应用频率条件</button
        >
        <div class="toolbar ledger-extra-filters">
          <select
            :value="availability"
            aria-label="在架状态"
            @change="emit('update:availability', ($event.target as HTMLSelectElement).value)"
          >
            <option value="ALL">全部在架状态</option
            ><option value="ACTIVE">在架</option
            ><option value="OFF_SHELF">已下架</option>
            <option
              v-if="unknownAvailability"
              value="UNKNOWN"
              >在架状态未提供</option
            >
          </select>
          <label
            >频率筛选依据<select
              :value="frequency.mode"
              aria-label="频率筛选依据"
              @change="
                updateFrequency({
                  mode: ($event.target as HTMLSelectElement).value as LedgerFrequencyMode,
                })
              "
            >
              <option value="ALL">不限频率</option
              ><option value="MODEL">型号支持频段</option
              ><option value="DEVICE">设备工作频点</option>
            </select></label
          >
          <label v-if="frequency.mode === 'DEVICE'"
            >工作频点<select
              :value="frequency.presence"
              aria-label="工作频点是否有值"
              @change="
                updateFrequency({
                  presence: ($event.target as HTMLSelectElement).value as LedgerFrequencyPresence,
                })
              "
            >
              <option value="ALL">全部工作频点</option
              ><option value="PRESENT">频点有值</option
              ><option value="MISSING">频点为空</option>
            </select></label
          >
          <label
            >附加告警<select
              :value="alert"
              aria-label="筛选附加告警"
              @change="
                emit(
                  'update:alert',
                  ($event.target as HTMLSelectElement).value as LedgerAlertFilter,
                )
              "
            >
              <option value="ALL">全部告警状态</option
              ><option value="YES">有告警</option
              ><option value="NO">无告警</option
              ><option
                v-if="observed || unknownAvailability"
                value="UNKNOWN"
                >告警未提供</option
              >
            </select></label
          >
          <label
            >节点角色<select
              :value="classification.role"
              aria-label="筛选节点角色"
              @change="updateClassification({ role: ($event.target as HTMLSelectElement).value })"
            >
              <option value="">全部节点角色</option
              ><option value="TASK">任务节点</option
              ><option value="FIXED_STATION">已有固定站</option
              ><option value="RELAY">中继站</option
              ><option value="CANDIDATE">候选部署点</option>
            </select></label
          >
          <label
            >中继能力<select
              :value="classification.relay"
              aria-label="筛选中继能力"
              @change="updateClassification({ relay: ($event.target as HTMLSelectElement).value })"
            >
              <option value="">全部中继能力</option
              ><option value="YES">支持中继</option
              ><option value="NO">不支持中继</option>
            </select></label
          >
        </div>
      </form>
      <p class="filter-caption"
        >型号支持频段按范围交集匹配；设备工作频点只读取已保存配置，空值不使用型号频段补齐。</p
      >
    </div>
    <p
      v-if="appliedAdvancedCount || pending || queryPending"
      class="filter-caption"
      role="status"
      >已应用：<template v-if="appliedSummary">{{ appliedSummary }}</template
      ><template v-else
        >{{ ledgerFrequencySummary(appliedFrequency) }} · {{ category || '全部设备'
        }}{{ classification.mobility ? ' · ' + mobilityLabel[classification.mobility] : '' }} ·
        {{ state }} · {{ availabilityLabel[availability]
        }}{{ alert !== 'ALL' ? ' · ' + alertLabel[alert] : ''
        }}{{ classification.role ? ' · ' + roleLabel[classification.role] : ''
        }}{{
          classification.relay
            ? ' · ' + (classification.relay === 'YES' ? '支持中继' : '不支持中继')
            : ''
        }}{{ query ? ' · 搜索：' + query : '' }}</template
      ><span v-if="pending">；频率条件尚未应用，列表仍使用上次条件。</span
      ><span v-if="queryPending">；查询条件尚未应用，列表仍使用上次成功条件。</span></p
    >
    <p
      v-if="error"
      class="filter-error"
      role="alert"
      >{{ error }}</p
    >
  </fieldset>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  LedgerAlertFilter,
  LedgerFrequencyFilter,
  LedgerFrequencyInput,
  LedgerFrequencyMode,
  LedgerFrequencyPresence,
} from '../services/resource-ledger-filter';
import { ledgerFrequencySummary } from '../services/resource-ledger-filter';
import type { LedgerClassification } from '../types/resource-ledger';

const props = defineProps<{
  query: string;
  state: string;
  availability: string;
  alert: LedgerAlertFilter;
  frequency: LedgerFrequencyInput;
  appliedFrequency: LedgerFrequencyFilter;
  pending: boolean;
  error: string;
  count: number;
  observed?: boolean;
  classification: LedgerClassification;
  appliedAdvancedCount?: number;
  unknownAvailability?: boolean;
  disabled?: boolean;
  category?: string;
  appliedSummary?: string;
  queryPending?: boolean;
}>();
const advanced = ref(false);
const emit = defineEmits<{
  'update:query': [value: string];
  'update:state': [value: string];
  'update:availability': [value: string];
  'update:alert': [value: LedgerAlertFilter];
  'update:frequency': [value: LedgerFrequencyInput];
  'update:classification': [value: LedgerClassification];
  apply: [];
  clear: [];
}>();
const rangeEnabled = computed(
  () =>
    props.frequency.mode !== 'ALL' &&
    !(props.frequency.mode === 'DEVICE' && props.frequency.presence === 'MISSING'),
);
// 输入保留在页面，切换页签不丢条件；控件不读取资源或提交业务数据。
function updateFrequency(patch: Partial<LedgerFrequencyInput>) {
  if (props.disabled) return;
  emit('update:frequency', { ...props.frequency, ...patch });
}
// 筛选标签直接展示已选维度，不将角色转换成部署方式。
const mobilityLabel: Record<string, string> = {
  FIXED: '固定部署',
  VEHICLE: '车载／移动部署',
  MANPACK: '背负／便携部署',
};
const roleLabel: Record<string, string> = {
  TASK: '任务节点',
  FIXED_STATION: '已有固定站',
  RELAY: '中继站',
  CANDIDATE: '候选部署点',
};
const availabilityLabel: Record<string, string> = {
  ALL: '全部在架状态',
  ACTIVE: '在架',
  OFF_SHELF: '已下架',
  UNKNOWN: '在架状态未提供',
};
const alertLabel: Record<string, string> = { YES: '有告警', NO: '无告警', UNKNOWN: '告警未提供' };
function updateClassification(patch: Partial<LedgerClassification>) {
  if (!props.disabled) emit('update:classification', { ...props.classification, ...patch });
}
</script>
<style scoped>
.ledger-filters {
  display: grid;
  gap: 12px;
  margin: 0;
  min-width: 0;
  border: 0;
}
.ledger-basic-filters {
  flex-wrap: wrap;
}
.ledger-basic-filters .search {
  max-width: 350px;
  flex: 1 1 210px;
}
.ledger-basic-filters select {
  width: auto;
}
.match-count {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.ledger-frequency-form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
}
.ledger-extra-filters {
  flex-basis: 100%;
}
.ledger-advanced summary {
  cursor: pointer;
  color: var(--muted);
  padding: 4px 0;
}
.ledger-extra-filters {
  flex-wrap: wrap;
  margin-top: 10px;
  align-items: end;
}
.ledger-frequency-form label {
  display: grid;
  gap: 6px;
  flex: 0 1 160px;
  min-width: 130px;
  font-size: 12px;
}
.ledger-frequency-form input,
.ledger-frequency-form select {
  width: 100%;
  min-width: 0;
}
.filter-caption,
.filter-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
.filter-caption {
  color: #9eb4cf;
}
.filter-error {
  color: #ffb4b4;
}
</style>
