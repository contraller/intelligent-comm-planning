import { computed,ref,toRaw } from 'vue';
import { defineStore } from 'pinia';
import type { SpectrumSource,SpectrumWorkspace,SpectrumDemo } from '../types/spectrum';
import type { Decision,DecisionRequest } from '../types/resource-edit';
import { previewService } from '../services';
import { useAuthStore } from './auth';
import { resourceSignature } from '../services/resource-validation';

// 表单和检查响应按会话代次隔离；只有明确离开才清理未保存输入。
export const useSpectrumStore=defineStore('spectrum',()=>{
  const auth=useAuthStore(),workspace=ref<SpectrumWorkspace|null>(null),form=ref<SpectrumSource|null>(null);
  const initial=ref(''),error=ref(''),notice=ref(''),busy=ref(false),loading=ref(false),decision=ref<DecisionRequest|null>(null);
  const canEdit=computed(()=>auth.can('resources.edit')),dirty=computed(()=>!!form.value&&resourceSignature(form.value)!==initial.value);
  let generation=0,resolve:((v:Decision)=>void)|null=null,requestId='',signature='';
  function answer(v:Decision){const fn=resolve;resolve=null;decision.value=null;fn?.(v);}
  function ask(request:DecisionRequest){if(decision.value||busy.value)return Promise.resolve('cancel' as Decision);decision.value=request;return new Promise<Decision>(r=>{resolve=r;});}
  async function load(){
    if(loading.value)return;loading.value=true;const token=++generation,session=auth.generation;error.value='';
    try{const value=await previewService.loadSpectrumWorkspace();if(token===generation&&session===auth.generation)workspace.value=value;}
    catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'频谱读取失败';}
    finally{if(token===generation)loading.value=false;}
  }
  async function save(){
    if(!canEdit.value||busy.value||!form.value||!workspace.value)return false;
    const session=auth.generation,token=generation;
    const key=resourceSignature([workspace.value.revision,form.value]);
    if(key!==signature){signature=key;requestId=crypto.randomUUID();}
    busy.value=true;error.value='';
    try{
      const result=await previewService.saveSpectrumSource({baseRevision:workspace.value.revision,requestId,source:structuredClone(toRaw(form.value))});
      if(token!==generation||session!==auth.generation)return false;
      workspace.value=result.workspace;form.value=structuredClone(result.workspace.sources.find(s=>s.id===result.objectId)!);initial.value=resourceSignature(form.value);
      notice.value=result.changed?'配置已保存，旧检查结果已失效，请重新检查':'配置无变化';return true;
    }catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'保存失败';return false;}
    finally{if(token===generation)busy.value=false;}
  }
  async function leave(defer=false){
    if(busy.value)return false;
    if(dirty.value){
      const choice=await ask({title:'频谱配置尚未保存',message:'保存仅更新频谱配置，不发起真实采集。',saveLabel:'保存并继续',discardLabel:'放弃修改'});
      if(choice==='cancel'||choice==='save'&&!await save())return false;
    }
    if(!defer){form.value=null;initial.value='';}return true;
  }
  async function open(source?:SpectrumSource){
    if(!canEdit.value||!(await leave()))return;
    form.value=source?structuredClone(toRaw(source)):{id:crypto.randomUUID(),name:'',endpoint:'',protocol:'HTTP_JSON',intervalSeconds:30,minKhz:null,maxKhz:null,enabled:true,revision:'new'};
    initial.value=source?resourceSignature(form.value):'';error.value='';notice.value='';
  }
  async function check(source:SpectrumSource,demo:SpectrumDemo){
    if(!canEdit.value||busy.value||dirty.value||!workspace.value)return;
    const session=auth.generation,token=generation;busy.value=true;error.value='';
    try{
      const result=await previewService.checkSpectrumSource({baseRevision:workspace.value.revision,requestId:crypto.randomUUID(),sourceId:source.id,configRevision:source.revision,demo});
      if(token===generation&&session===auth.generation){workspace.value=result.workspace;notice.value=result.check!.message;}
    }catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'检查失败';}
    finally{if(token===generation)busy.value=false;}
  }
  async function reset(){
    if(!auth.can('resources.reset')||busy.value)return;
    const choice=await ask({title:'重置频谱配置',message:'恢复两条未验证初始配置，清除检查记录和当前频谱输入；资源与其他工作区不变。',saveLabel:'确认重置'});
    if(choice!=='save')return;
    busy.value=true;const token=generation,session=auth.generation;
    try{const result=await previewService.resetSpectrumWorkspace(workspace.value?.revision??null);if(token===generation&&session===auth.generation){workspace.value=result.workspace;form.value=null;initial.value='';error.value='';notice.value='频谱配置已重置';}}
    catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'重置失败';}
    finally{if(token===generation)busy.value=false;}
  }
  function clearForSession(){generation++;answer('cancel');workspace.value=null;form.value=null;initial.value='';error.value='';notice.value='';busy.value=false;loading.value=false;}
  return {workspace,form,dirty,error,notice,busy,loading,decision,canEdit,answer,load,open,leave,save,check,reset,clearForSession};
});
