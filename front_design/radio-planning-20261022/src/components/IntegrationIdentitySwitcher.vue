<template>
  <div v-if="auth.identity?.integrationMode" class="integration-identity">
    <select v-model="selected" aria-label="联调身份" :disabled="auth.transition || !!auth.busy || loading">
      <option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option>
    </select>
    <button class="btn" title="切换联调身份" :disabled="!selected || selected===auth.identity.id || auth.transition || !!auth.busy" @click="change"><i class="pi pi-user-edit" />{{ auth.transition ? '切换中' : '切换' }}</button>
    <RouterLink v-if="auth.can('knowledge.view')" to="/knowledge" class="text-link knowledge-entry"><i class="pi pi-sitemap" />知识图谱</RouterLink>
    <button v-if="error" class="text-link" :title="error" @click="load">重试身份目录</button>
  </div>
</template>
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { loadIntegrationIdentities } from '../services';
const auth=useAuthStore(),router=useRouter(),route=useRoute();
const accounts=ref<{id:string;name:string;role:string}[]>([]),selected=ref(''),error=ref(''),loading=ref(false);
async function load(){if(!auth.identity?.integrationMode)return;loading.value=true;const session=auth.identity.sessionId;try{const value=await loadIntegrationIdentities();if(session===auth.identity?.sessionId){accounts.value=value.accounts;selected.value=value.currentId;error.value='';}}catch(e){error.value=e instanceof Error?e.message:'身份目录读取失败';}finally{loading.value=false;}}
async function change(){const target=selected.value;if(await auth.switchIntegrationIdentity(target)){await router.replace(auth.firstPath(route.fullPath));auth.bypassLeave=false;}else selected.value=auth.identity?.id??'';}
watch(()=>auth.identity?.sessionId,()=>{selected.value=auth.identity?.id??'';});
onMounted(()=>void load());
</script>
<style scoped>
.integration-identity{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.integration-identity select{max-width:150px;font-size:12px}.integration-identity .btn{display:flex;gap:5px;align-items:center;padding:6px;white-space:nowrap}.knowledge-entry{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
</style>
