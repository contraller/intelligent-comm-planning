import { defineStore } from 'pinia';
import { ref } from 'vue';
import { previewService } from '../services';
import type { PlanVersion, PreviewData } from '../types/domain';
import type { ResourceCommit, ResourceSaveResult } from '../types/resource-edit';
import { markChangedPlans } from '../services/mock';
import { useAuthStore } from './auth';

export const usePreviewStore = defineStore('preview', () => {
  const auth=useAuthStore();let generation=0;
  const data = ref<PreviewData | null>(null);
  const loading = ref(false);
  const error = ref('');
  const busy = ref(false);
  const notice = ref('');
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
  async function commit(request: ResourceCommit) {
    if (busy.value) throw new Error('正在保存，请稍候');
    if (!data.value) throw new Error('资源尚未加载');
    busy.value = true;
    const session=auth.generation,token=generation;
    try {
      const result = await previewService.commitResources(request);
      if(session!==auth.generation||token!==generation||!data.value)throw new Error('会话已变化，保存响应未写入当前界面');
      data.value.resources = result.resources;
      data.value.resourceMeta = result.meta;
      markChangedPlans(data.value, result.meta);
      notice.value = result.changed ? '资源已保存到当前浏览器' : '没有需要保存的修改';
      return result;
    } finally {
      if(token===generation)busy.value = false;
    }
  }
  async function reset() {
    if (busy.value) throw new Error('正在保存，请稍候');
    busy.value = true;
    const session=auth.generation,token=generation;
    try {
      const result = await previewService.resetResources(data.value?.resourceMeta.revision ?? null);
      if(session!==auth.generation||token!==generation)throw new Error('会话已变化，重置响应未写入当前界面');
      if (data.value) {
        // 只恢复本批产生的影响；基线已有的方案标记仍由初始数据保留。
        data.value.resources = result.resources;
        data.value.resourceMeta = result.meta;
        data.value.planning.plans.forEach((plan) => {
          plan.sourceChanged =
            result.preview.planning.plans.find((item) => item.id === plan.id)?.sourceChanged ??
            plan.sourceChanged;
        });
        markChangedPlans(data.value, result.meta);
      } else data.value = result.preview;
      error.value = '';
      notice.value = '资源演示数据已重置';
    } finally {
      if(token===generation)busy.value = false;
    }
  }
  // 会话清理仅清内存，旧响应不再进入新账号页面。
  function clearForSession(){generation++;data.value=null;loading.value=false;busy.value=false;error.value='';notice.value='';}
  return { data, loading, error, busy, notice, load, commit, reset, mergePlanning, clearForSession, acceptResources };
});
