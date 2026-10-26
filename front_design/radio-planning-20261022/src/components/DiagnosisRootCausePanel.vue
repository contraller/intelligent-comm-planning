<template>
  <section
    class="root-cause"
    aria-label="根因定位链"
  >
    <ol class="root-stages">
      <li
        ><h4>现象</h4
        ><ul v-if="root.symptoms.length"
          ><li
            v-for="(item, index) in root.symptoms"
            :key="index"
            >{{ item.label }}<small>{{ item.id }}</small></li
          ></ul
        ><p v-else>未提供结构化现象</p></li
      >
      <li
        ><h4>原因</h4><p>{{ root.cause }}</p></li
      >
      <li
        ><h4>部件</h4><p>{{ root.component }}</p></li
      >
    </ol>
    <details
      class="original-chain"
      v-if="root.chain.length"
      ><summary>原始根因链（{{ root.chain.length }} 段）</summary
      ><ol
        ><li
          v-for="(item, index) in root.chain"
          :key="index"
          >{{ item }}</li
        ></ol
      ></details
    >
    <p
      v-else
      class="missing"
      >未提供原始根因链</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DiagnosisConclusion } from '../types/diagnosis';
import { diagnosisRootDisplay, type DiagnosisSymptomLabel } from '../services/diagnosis-display';
const props = defineProps<{ conclusion: DiagnosisConclusion; symptoms: DiagnosisSymptomLabel[] }>();
// 每次选择结论都直接读取该记录，历史缺项不从当前资源或其他结论补值。
const root = computed(() => diagnosisRootDisplay(props.conclusion, props.symptoms));
</script>
<style scoped>
.root-cause {
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.root-stages {
  list-style: none;
  padding: 0;
  margin: 0 0 16px;
  display: grid;
  gap: 24px;
}
.root-stages > li {
  padding: 12px;
  border: 1px solid #355575;
  border-radius: 5px;
  background: #152a42;
  position: relative;
}
.root-stages > li + li::before {
  content: '↓';
  position: absolute;
  top: -26px;
  left: 50%;
  color: #82bbdf;
}
.root-stages h4 {
  margin: 0 0 6px;
  color: #a1d6f7;
  font-size: 12px;
}
.root-stages p {
  margin: 0;
  color: #c3d7e8;
}
.root-stages ul {
  padding-left: 17px;
  margin: 0;
}
.root-stages small {
  display: block;
  color: #91aec8;
}
.original-chain {
  border-top: 1px solid #2c425b;
  padding-top: 12px;
}
.original-chain summary {
  color: #9dbed9;
  cursor: pointer;
}
.original-chain ol {
  padding-left: 20px;
}
.missing {
  color: #859eb9;
}
</style>
