<template>
  <section class="task-quick-start" aria-label="内置构造例程">
    <h4>从示例任务开始</h4>
    <p>内置构造示例沿用三类规划预设和当前资源，载入为新任务草稿；不自动保存或计算。</p>
    <div class="quick-cards">
      <article v-for="preset in presets" :key="preset.id" class="quick-card">
        <div><strong>{{ preset.label }}</strong><small>{{ descriptions[preset.id] }}</small></div>
        <div class="quick-actions">
          <button class="btn small primary" :disabled="disabled" :aria-label="`载入${preset.label}构造例程为新任务`" @click="start(preset.id)">
            {{ action === `start:${preset.id}` ? '正在载入…' : '一键载入' }}
          </button>
          <button class="btn small" :disabled="disabled" :aria-label="`下载${preset.label}完整XLSX导入例程`" @click="download(preset.id)">
            {{ action === `download:${preset.id}` ? '正在生成…' : '下载导入例程' }}
          </button>
        </div>
      </article>
    </div>
    <p v-if="!presets.length" role="status">{{ task.loading ? '正在读取例程目录…' : '例程目录暂不可用，请先读取或刷新资源。' }}</p>
    <p class="quick-guide">① 载入，或下载一个 XLSX 后导入　② 保存任务　③ 提交规划</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="notice warn" role="alert">{{ error }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useTaskInputStore } from '../stores/task-input';
import { useAuthStore } from '../stores/auth';
import { useResourceReadStore } from '../stores/resource-read';
import { downloadFile } from '../services/file-download';
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ started: [] }>();
const task = useTaskInputStore(), auth = useAuthStore(), resources = useResourceReadStore();
const descriptions: Record<string, string> = { balanced: '地形地貌型', reliable: '任务需求型', economical: '干扰环境型' };
const presets = computed(() => task.catalog?.presets.filter(row => Object.hasOwn(descriptions, row.id)) ?? []);
const action = ref(''), error = ref(''), message = ref('');
const disabled = computed(() => !props.active || !!action.value || !task.editable || !!task.decision || task.loading || task.importBusy || resources.refreshing || !resources.workspace || !resources.readable);
let alive = true, controller: AbortController | undefined;
function cancel() { controller?.abort(); controller = undefined; action.value = ''; }
watch(() => props.active, value => { if (!value) cancel(); });
onBeforeUnmount(() => { alive = false; cancel(); });
async function perform(id: string, kind: 'start' | 'download') {
  if (disabled.value) return;
  cancel(); const current = new AbortController(), session = auth.generation;
  controller = current; action.value = `${kind}:${id}`; error.value = ''; message.value = '';
  try {
    if (kind === 'start') {
      const started = await task.startFromPreset(id, current.signal);
      if (started && alive && props.active && !current.signal.aborted && session === auth.generation) emit('started');
    } else {
      const file = await task.getPresetExampleFile(id, current.signal);
      if (!file || !alive || !props.active || current.signal.aborted || session !== auth.generation || !task.readable) return;
      downloadFile(file, 1000);
      message.value = '已下载完整 XLSX，含任务条件和通联需求。选择该文件解析校验，再保存任务。';
    }
  } catch (reason) {
    if (alive && !current.signal.aborted && session === auth.generation) error.value = reason instanceof Error ? reason.message : '例程操作失败，请重试。';
  } finally { if (controller === current) { controller = undefined; action.value = ''; } }
}
const start = (id: string) => perform(id, 'start'), download = (id: string) => perform(id, 'download');
</script>
<style scoped>
.task-quick-start { padding: 12px; margin-bottom: 16px; border: 1px solid #315a73; border-radius: 8px; background: #112b3e; }
h4 { margin: 0 0 6px; color: #c9e8f7; font-size: 14px; }
p { margin: 6px 0; color: var(--muted); font-size: var(--font-secondary); line-height: 1.6; }
.quick-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 8px; margin-top: 10px; }
.quick-card { padding: 10px; background: #0d2032; border: 1px solid #29495f; border-radius: 6px; }
.quick-card > div:first-child { display: flex; gap: 8px; justify-content: space-between; align-items: baseline; }
strong { color: #d5eaf7; font-size: var(--font-control); }
small { color: #9ab7cc; font-size: var(--font-caption); }
.quick-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.quick-guide { margin-top: 10px; color: #b9d8e7; }
</style>
