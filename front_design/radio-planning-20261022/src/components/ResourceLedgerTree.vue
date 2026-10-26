<template>
  <aside class="panel ledger-tree">
    <div class="panel-head"><h3>资源分类</h3><small>设备 / 台</small></div>
    <button
      class="tree-row"
      :class="{ active: category === '全部设备' }"
      :disabled="disabled"
      @click="emit('select', '全部设备', '')"
    >
      <span>全部设备</span><small>{{ counts.devices ?? '未提供' }}</small>
    </button>
    <div
      v-for="kind in kinds"
      :key="kind.code"
      class="tree-group"
    >
      <div class="tree-heading">
        <button
          class="fold"
          :aria-label="(open[kind.code] ? '收起' : '展开') + kind.label"
          :aria-expanded="open[kind.code]"
          @click="open[kind.code] = !open[kind.code]"
          >{{ open[kind.code] ? '▾' : '▸' }}</button
        >
        <button
          class="tree-row"
          :class="{ active: category === kind.code && !mobility }"
          :disabled="disabled"
          @click="emit('select', kind.code, '')"
          ><span>{{ kind.label }}</span
          ><small>{{ (kind.code === 'HF' ? counts.hf : counts.vuhf) ?? '未提供' }}</small></button
        >
      </div>
      <div
        v-show="open[kind.code]"
        class="tree-children"
      >
        <button
          v-for="item in deployments"
          :key="item.code"
          class="tree-row"
          :class="{ active: category === kind.code && mobility === item.code }"
          :disabled="disabled"
          @click="emit('select', kind.code, item.code)"
        >
          <span>{{ item.label }}</span
          ><small>{{
            counts.deployments ? (counts.deployments[kind.code][item.code] ?? 0) : '未提供'
          }}</small>
        </button>
      </div>
    </div>
    <p class="tree-note">按设备所属站点的部署方式分组</p>
  </aside>
</template>
<script setup lang="ts">
import { reactive } from 'vue';
import type { LedgerCounts } from '../types/resource-ledger';
defineProps<{
  category: string;
  mobility: string;
  counts: LedgerCounts;
  disabled: boolean;
}>();
const emit = defineEmits<{ select: [category: string, mobility: string] }>();
// 展开状态只影响目录展示，不改变筛选、勾选或资源数据。
const open = reactive({ HF: true, VUHF: true });
const kinds = [
  { code: 'HF', label: '短波设备 HF' },
  { code: 'VUHF', label: '超短波设备 VUHF' },
] as const;
const deployments = [
  { code: 'FIXED', label: '固定部署' },
  { code: 'VEHICLE', label: '车载／移动部署' },
  { code: 'MANPACK', label: '背负／便携部署' },
];
</script>
<style scoped>
.tree-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  border: 0;
  color: var(--text);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.tree-row.active {
  background: #173a5b;
  color: #8dccff;
}
.tree-row small,
.panel-head small {
  color: var(--muted);
}
.tree-heading {
  display: flex;
  align-items: center;
}
.fold {
  padding: 10px;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.tree-heading .tree-row {
  padding-left: 0;
}
.tree-children {
  margin: 0 12px 10px 24px;
  border-left: 1px solid var(--line);
}
.tree-note {
  padding: 0 14px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
