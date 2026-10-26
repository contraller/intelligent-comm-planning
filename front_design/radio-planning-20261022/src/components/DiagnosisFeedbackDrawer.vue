<template>
  <AppDrawer :visible="visible" title="诊断知识反馈" :subtitle="runId" @update:visible="!$event && close()">
    <fieldset class="feedback-form" :disabled="busy || !auth.can('knowledge.edit')">
      <label>诊断结论<select v-model.number="index" :disabled="dirty" @change="prefill"><option v-for="(c,i) in result.conclusions" :key="i" :value="i">{{ c.label }}</option></select></label>
      <label>人工确认故障类型<select v-model="form.confirmed_fault_type"><option value="HW_FAILURE">硬件故障</option><option value="LINK_DOWN">链路中断</option><option value="SW_CONFIG">软件配置故障</option><option value="EMI">电磁干扰</option></select></label>
      <label>根因<textarea v-model="form.root_cause" maxlength="500" rows="3" /></label>
      <label>故障部件<input v-model="form.fault_component" maxlength="200" /></label>
      <label>处置方案<textarea v-model="form.solution" maxlength="500" rows="3" /></label>
      <label>诊断步骤<textarea v-model="steps" maxlength="3000" rows="4" /></label>
      <p v-if="!result.conclusions[index]?.fault?.symptomIds.length" class="error" role="alert">此冻结场景未记录观察现象，不能提交可复用故障案例。</p>
    </fieldset>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="accepted" role="status">知识草稿已保存：{{ accepted }} <RouterLink to="/knowledge">查看知识维护</RouterLink></p>
    <button class="btn primary" :disabled="busy || !!accepted || !form.root_cause.trim() || !form.solution.trim() || !result.conclusions[index]?.fault?.symptomIds.length || !auth.can('knowledge.edit')" @click="submit"><i class="pi pi-save" />提交知识草稿</button>
    <button class="btn" :disabled="busy" @click="close">关闭</button>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import AppDrawer from './AppDrawer.vue';
import { useAuthStore } from '../stores/auth';
import { useDiagnosisStore } from '../stores/diagnosis';
import { previewService } from '../services';
import { randomUuid } from '../services/random-uuid';
import type { DiagnosisResult } from '../types/diagnosis';
const props=defineProps<{visible:boolean;runId:string;result:DiagnosisResult}>(),emit=defineEmits<{close:[]}>();
const auth=useAuthStore(),diagnosis=useDiagnosisStore();
const index=ref(0),steps=ref(''),form=ref({confirmed_fault_type:'HW_FAILURE',root_cause:'',fault_component:'',solution:''});
const baseline=ref(''),busy=ref(false),error=ref(''),accepted=ref('');
const signature=()=>JSON.stringify([index.value,form.value,steps.value]),dirty=computed(()=>props.visible&&!accepted.value&&signature()!==baseline.value);
let pending:{signature:string;baseRevision:string;requestId:string}|null=null;
function prefill(){const c=props.result.conclusions[index.value];form.value={confirmed_fault_type:c?.faultType??'HW_FAILURE',root_cause:c?.rootCause??'',fault_component:c?.component??'',solution:''};steps.value='';baseline.value=signature();pending=null;error.value='';}
watch(()=>props.visible,value=>{if(value){index.value=0;prefill();accepted.value='';}});
async function leave(){if(busy.value)return false;if(!dirty.value)return true;return await diagnosis.ask({title:'未提交的诊断知识反馈',message:'放弃当前反馈输入？已经保存的知识草稿仍保留。',saveLabel:'放弃输入',cancelLabel:'继续填写'})==='save';}
const release=auth.registerLeave(leave,()=>dirty.value);
onBeforeRouteLeave(()=>auth.bypassLeave||leave());onBeforeUnmount(release);
const beforeUnload=(event:BeforeUnloadEvent)=>{if(props.visible&&!accepted.value&&(dirty.value||busy.value)){event.preventDefault();event.returnValue='';}};
onMounted(()=>window.addEventListener('beforeunload',beforeUnload));
onBeforeUnmount(()=>window.removeEventListener('beforeunload',beforeUnload));
async function close(){if(await leave())emit('close');}
async function submit(){if(busy.value||accepted.value||!auth.can('knowledge.edit'))return;busy.value=true;const session=auth.generation,owner=props.runId;try{const feedback={result_index:index.value,...form.value,diagnosis_steps:steps.value.split('\n').map(s=>s.trim()).filter(Boolean)};const sig=JSON.stringify([owner,feedback]);if(pending?.signature!==sig){const context=await previewService.loadDiagnosisContext();if(!context.revision)throw new Error('诊断工作区不可写');pending={signature:sig,baseRevision:context.revision,requestId:randomUuid()};}const r=await previewService.submitDiagnosisFeedback({runId:owner,feedback,baseRevision:pending.baseRevision,requestId:pending.requestId});if(session!==auth.generation||props.runId!==owner)return;accepted.value=r.entityIds[1]??r.objectId;if(diagnosis.workspace)diagnosis.workspace.revision=r.revision;error.value='';}catch(e){if(session===auth.generation)error.value=e instanceof Error?e.message:'反馈提交失败';}finally{busy.value=false;}}
</script>
<style scoped>
.feedback-form{display:grid;gap:14px;border:0;padding:0;min-width:0}.feedback-form label{display:grid;gap:5px;font-size:13px}.feedback-form textarea,.feedback-form input,.feedback-form select{width:100%;box-sizing:border-box}.error{color:#ff989e}.btn{margin:12px 8px 0 0}
</style>
