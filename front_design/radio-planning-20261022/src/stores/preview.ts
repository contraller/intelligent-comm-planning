import { defineStore } from 'pinia';
import { ref } from 'vue';
import { previewService } from '../services';
import type { PlanVersion, PreviewData } from '../types/domain';
import type { ResourceSaveResult } from '../types/resource-edit';
import { markChangedPlans } from '../services/planning-source-state';
import { useAuthStore } from './auth';

export const usePreviewStore = defineStore('preview', () => {
  const auth=useAuthStore();let generation=0;
  const data = ref<PreviewData | null>(null);
  const loading = ref(false);
  const error = ref('');
  function mergePlanning(plans: PlanVersion[]) {
    if (!data.value) return;
    data.value.planning.plans = [
      ...data.value.planning.plans.filter((plan) => !plan.workflow),
      ...plans,
    ];
    markChangedPlans(data.value, data.value.resourceMeta);
  }
  async function load() {
    if (loading.value) return;
    loading.value = true;
    const token=++generation,session=auth.generation;
    error.value = '';
    try {
      const value=await previewService.loadPreview();
      if(token===generation&&session===auth.generation)data.value=value;
    } catch (reason) {
      if(token===generation)error.value = reason instanceof Error ? reason.message : '数据加载失败';
    } finally {
      if(token===generation)loading.value = false;
    }
  }
  function acceptResources(result:ResourceSaveResult) {
    if(!data.value)return;
    data.value.resources=result.resources;data.value.resourceMeta=result.meta;
    markChangedPlans(data.value,result.meta);
  }
  // 会话清理仅清内存，旧响应不再进入新账号页面。
  // 精简回执不拼装旧完整缓存；需要使用旧缓存时必须明确重新读取。
  function invalidateResources(){data.value=null;}
  function clearForSession(){generation++;data.value=null;loading.value=false;error.value='';}
  return { data, loading, error, load, mergePlanning, clearForSession, acceptResources, invalidateResources };
});
