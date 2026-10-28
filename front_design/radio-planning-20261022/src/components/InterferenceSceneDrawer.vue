<template>
  <AppDrawer :visible="visible" title="干扰场景与版本" :subtitle="store.taskContext?.planId" @update:visible="close">
    <p v-if="!store.taskContext">请选择当前确认方案。</p>
    <template v-else>
      <form class="scene-form" @submit.prevent="save">
        <fieldset :disabled="store.locked || !!store.pendingScene">
          <label>场景名称<input v-model="store.draft.name" maxlength="60" required /></label>
          <label>备注<textarea v-model="store.draft.note" maxlength="500" rows="3" /></label>
          <label>搜索干扰源<input v-model="search" type="search" /></label>
          <p>已选 {{ store.draft.interferenceIds.length }} 项</p>
          <p>天线增益必须填写有效数值；0 与负值可用。高程可空；空方向图按全向、空占空比按 1 计算并记录来源。</p>
          <div class="source-list">
            <label v-for="row in filtered" :key="row.interference_id" class="source-option">
              <input v-model="store.draft.interferenceIds" type="checkbox" :value="row.interference_id"
                :disabled="row.active !== 'true' && !store.draft.interferenceIds.includes(row.interference_id)" />
              <span>{{ row.name || row.interference_id }}<small>{{ row.interference_id }} · {{ row.active === 'true' ? '生效' : row.active === 'false' ? '未生效' : '状态未知' }}</small></span>
            </label>
            <p v-if="!filtered.length">没有匹配的干扰源。</p>
          </div>
        </fieldset>
        <div class="toolbar">
          <button class="btn primary" type="submit" :disabled="store.locked || !!store.pendingScene || !canSave"><i class="pi pi-save" aria-hidden="true" /> 保存版本</button>
          <button class="icon-button" type="button" title="重置当前草稿" aria-label="重置当前草稿" :disabled="store.locked || !!store.pendingScene" @click="store.resetDraft()"><i class="pi pi-undo" aria-hidden="true" /></button>
          <button class="btn" type="button" :disabled="store.locked || !!store.pendingScene" @click="newScene">新场景</button>
        </div>
      </form>
      <p v-if="store.dirty" role="status">有未保存更改</p>
      <section v-if="parameterIssues.length" aria-label="场景干扰源参数问题"><p>所选源参数尚不满足分析条件，请先编辑主资源。</p><ul><li v-for="issue in parameterIssues" :key="issue.interferenceId + issue.field">{{ issue.message }}</li></ul></section>
      <p v-if="store.scene">{{ store.scene.version.sceneId }} · 版本 {{ store.scene.version.versionNo }} · {{ store.scene.sourceState.state === 'CURRENT' ? '当前来源' : '冻结历史' }}</p>
      <section v-if="store.pendingScene" aria-label="保存回执待核实">
        <p>保存结果待核实 · {{ store.pendingScene.requestId }}</p>
        <button class="btn" :disabled="store.busy" @click="store.resolveSceneSave()">核实保存回执</button>
        <button class="btn" :disabled="store.busy" @click="store.resolveSceneSave(true)">重试原请求</button>
      </section>
      <h4>已保存场景</h4>
      <div class="toolbar"><input v-model="sceneSearch" type="search" aria-label="搜索场景" /><button class="icon-button" title="搜索场景" aria-label="搜索场景" @click="store.loadScenes(1, sceneSearch)"><i class="pi pi-search" aria-hidden="true" /></button></div>
      <div v-for="row in store.scenes?.items ?? []" :key="row.sceneId" class="version-row">
        <button class="text-link" :disabled="store.locked" @click="choose(row.sceneId, row.versionId)">{{ row.name }} · {{ row.planVersion }} · v{{ row.versionNo }}</button>
        <button class="text-link" @click="store.loadSceneVersions(row.sceneId)">版本历史</button>
      </div>
      <p v-if="!store.scenes?.total">暂无保存场景。</p>
      <div class="toolbar">
        <button class="icon-button" title="场景上一页" aria-label="场景上一页" :disabled="!store.scenes || store.scenes.page <= 1" @click="store.loadScenes((store.scenes?.page ?? 1) - 1, sceneSearch)"><i class="pi pi-angle-left" aria-hidden="true" /></button>
        <span>{{ store.scenes?.page ?? 1 }} · 共 {{ store.scenes?.total ?? 0 }} 项</span>
        <button class="icon-button" title="场景下一页" aria-label="场景下一页" :disabled="!store.scenes || store.scenes.page * store.scenes.pageSize >= store.scenes.total" @click="store.loadScenes((store.scenes?.page ?? 1) + 1, sceneSearch)"><i class="pi pi-angle-right" aria-hidden="true" /></button>
      </div>
      <section v-if="store.sceneVersions" aria-label="场景版本历史">
        <h4>版本历史</h4>
        <button v-for="row in store.sceneVersions.items" :key="row.versionId" class="version-row text-link" @click="choose(row.sceneId, row.versionId)">v{{ row.versionNo }} · {{ row.name }} · {{ row.savedAt }}</button>
        <div class="toolbar"><button class="icon-button" title="版本上一页" aria-label="版本上一页" :disabled="store.sceneVersions.page <= 1" @click="versionPage(-1)"><i class="pi pi-angle-left" aria-hidden="true" /></button><span>{{ store.sceneVersions.page }} · 共 {{ store.sceneVersions.total }} 项</span><button class="icon-button" title="版本下一页" aria-label="版本下一页" :disabled="store.sceneVersions.page * store.sceneVersions.pageSize >= store.sceneVersions.total" @click="versionPage(1)"><i class="pi pi-angle-right" aria-hidden="true" /></button></div>
      </section>
    </template>
    <p v-if="store.error || store.queryError" role="alert">{{ store.error || store.queryError }}</p>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useAuthStore } from '../stores/auth';
import { useInterferenceStore } from '../stores/interference';
import type { TaskContext } from '../types/interference-workbench';
import { interferenceParameterIssues } from '../services/interference-workbench-validation';
defineProps<{ visible: boolean; taskContext: TaskContext | null }>();
const emit = defineEmits<{ 'update:visible': [value: boolean]; saved: [value: { sceneId: string; versionId: string }]; selected: [value: { sceneId: string; versionId: string }] }>();
const store = useInterferenceStore(), auth = useAuthStore(), search = ref(''), sceneSearch = ref('');
const parameterIssues = computed(() => interferenceParameterIssues((store.context?.interference_sources ?? []).filter(row => store.draft.interferenceIds.includes(row.interference_id!))));
const canSave = computed(() => auth.can('planning.save') && store.selectedSource?.eligible && !!store.draft.name.trim() && !parameterIssues.value.length);
const filtered = computed(() => (store.context?.interference_sources ?? []).filter(row => (row.name + ' ' + row.interference_id).toLocaleLowerCase().includes(search.value.toLocaleLowerCase())));
async function close(value: boolean) { if (value || await store.prepareLeave()) emit('update:visible', value); }
async function save() { const previous = store.lastSceneReceipt?.requestId; await store.saveScene(); const receipt = store.lastSceneReceipt; if (receipt && receipt.requestId !== previous) emit('saved', { sceneId: receipt.sceneId, versionId: receipt.versionId }); }
async function choose(sceneId: string, versionId: string) { await store.selectScene({ sceneId, versionId }); if (store.scene?.version.versionId === versionId) emit('selected', { sceneId, versionId }); }
async function newScene() { if (await store.prepareLeave()) store.newDraft(); }
function versionPage(delta: number) { const page = store.sceneVersions; if (page?.items[0]) void store.loadSceneVersions(page.items[0].sceneId, page.page + delta); }
</script>
<style scoped>
.scene-form,fieldset{display:grid;gap:12px}fieldset{border:0;padding:0;min-width:0}label{display:grid;gap:6px}input,textarea{width:100%;min-width:0}.source-list{max-height:240px;overflow:auto}.source-option{grid-template-columns:18px minmax(0,1fr);align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}.source-option input{width:auto}.source-option span{min-width:0;overflow-wrap:anywhere}small{display:block;color:var(--muted)}.version-row{display:flex;flex-wrap:wrap;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.toolbar input{flex:1;min-width:120px}.icon-button{width:32px;height:32px;flex:0 0 32px}p{overflow-wrap:anywhere}
</style>
