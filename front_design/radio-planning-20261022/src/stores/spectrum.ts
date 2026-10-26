// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed,ref,toRaw } from 'vue';
import { defineStore } from 'pinia';
import type { SpectrumSource,SpectrumRow,SpectrumDemo } from '../types/spectrum';
import type { Decision,DecisionRequest } from '../types/resource-edit';
import { previewService } from '../services';
import { useAuthStore } from './auth';
import { createReadCancellation } from '../services/data-access';
import { resourceSignature } from '../services/resource-validation';

// 表单和检查响应按会话代次隔离；只有明确离开才清理未保存输入。
export const useSpectrumStore=defineStore('spectrum',()=>{
  const requests=createReadCancellation();
  const auth=useAuthStore(),workspace=ref<{revision:string;sources:SpectrumRow[]}|null>(null),form=ref<SpectrumSource|null>(null);
  const total=ref(0),query=ref({pageNum:1,pageSize:20,sort:'name' as 'name'|'intervalSeconds',order:'asc' as 'asc'|'desc'});
  let readSerial=0,formSerial=0;
  const initial=ref(''),error=ref(''),notice=ref(''),busy=ref(false),loading=ref(false),decision=ref<DecisionRequest|null>(null);
  // 空数字输入的 null／空串仅在修改比较时等价，不改变提交或校验数据。
  const emptyNumber=(value:unknown)=>value==null||value===''?null:value;
  const formSignature=(value:SpectrumSource)=>resourceSignature({...value,intervalSeconds:emptyNumber(value.intervalSeconds),minKhz:emptyNumber(value.minKhz),maxKhz:emptyNumber(value.maxKhz)});
  const canEdit=computed(()=>auth.can('resources.edit')),dirty=computed(()=>!!form.value&&formSignature(form.value)!==initial.value);
  let generation=0,resolve:((v:Decision)=>void)|null=null,requestId='',signature='';
  function answer(v:Decision){const fn=resolve;resolve=null;decision.value=null;fn?.(v);}
  function ask(request:DecisionRequest){if(decision.value||busy.value)return Promise.resolve('cancel' as Decision);decision.value=request;return new Promise<Decision>(r=>{resolve=r;});}
  async function load(input:Partial<typeof query.value>={}){
    if(!auth.can('resources.view'))return;query.value={...query.value,...input};loading.value=true;const token=++readSerial,owner=generation,session=auth.generation;error.value='';
    try{const value=await previewService.querySpectrumSources({...query.value,signal:requests.signal('list')});if(token===readSerial&&owner===generation&&session===auth.generation){workspace.value={revision:value.revision,sources:value.items};total.value=value.total;}}
    catch(e){if(token===readSerial&&owner===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'频谱读取失败';}
    finally{if(token===readSerial)loading.value=false;}
  }
  async function save(){
    if(!canEdit.value||busy.value||!form.value)return false;
    if(!workspace.value){error.value='配置工作区尚未读取，请先刷新配置';return false;}
    const session=auth.generation,token=generation;
    const key=resourceSignature([workspace.value.revision,form.value]);
    if(key!==signature){signature=key;requestId=randomUuid();}
    busy.value=true;error.value='';
    try{
      const result=await previewService.saveSpectrumReceipt({baseRevision:workspace.value.revision,requestId,source:structuredClone(toRaw(form.value))});
      if(token!==generation||session!==auth.generation)return false;
      workspace.value.revision=result.revision;if(result.source)form.value=structuredClone(result.source);initial.value=formSignature(form.value);
      notice.value=result.changed?'配置已保存，旧检查结果已失效，请重新检查':'配置无变化';await load();
      if(error.value)notice.value+='；保存已成功，列表刷新失败';return token===generation&&session===auth.generation;
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
    const serial=++formSerial,owner=generation,session=auth.generation;
    if(source){
      if(!workspace.value)return;
      try{const detail=await previewService.getSpectrumSource({sourceId:source.id,revision:workspace.value.revision,signal:requests.signal('detail')});if(serial!==formSerial||owner!==generation||session!==auth.generation)return;form.value=detail;}
      catch(e){if(owner===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'配置读取失败';return;}
    }else form.value={id:randomUuid(),name:'',endpoint:'',protocol:'HTTP_JSON',intervalSeconds:30,minKhz:null,maxKhz:null,enabled:true,revision:'new'};
    initial.value=formSignature(form.value);error.value='';notice.value='';
  }
  async function check(source:SpectrumSource,demo:SpectrumDemo){
    if(!canEdit.value||busy.value||dirty.value||!workspace.value)return;
    const session=auth.generation,token=generation;busy.value=true;error.value='';
    try{
      const result=await previewService.checkSpectrumReceipt({baseRevision:workspace.value.revision,requestId:randomUuid(),sourceId:source.id,configRevision:source.revision,demo});
      if(token===generation&&session===auth.generation){workspace.value.revision=result.revision;const row=workspace.value.sources.find(item=>item.id===source.id);if(row)row.latestCheck=result.check;notice.value=result.check!.message;}
    }catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'检查失败';}
    finally{if(token===generation)busy.value=false;}
  }
  async function reset(){
    if(!auth.can('resources.reset')||busy.value)return;
    const choice=await ask({title:'重置频谱配置',message:'恢复两条未验证初始配置，清除检查记录和当前频谱输入；资源与其他工作区不变。',saveLabel:'确认重置'});
    if(choice!=='save')return;
    busy.value=true;const token=generation,session=auth.generation;
    try{const result=await previewService.resetSpectrumReceipt(workspace.value?.revision??null);if(token===generation&&session===auth.generation){if(workspace.value)workspace.value.revision=result.revision;form.value=null;initial.value='';error.value='';notice.value='频谱配置已重置';await load({pageNum:1});if(error.value)notice.value+='；重置已成功，列表刷新失败';}}
    catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'重置失败';}
    finally{if(token===generation)busy.value=false;}
  }
  function stopReading(){requests.stop();readSerial++;formSerial++;loading.value=false;}
  function clearForSession(){stopReading();generation++;total.value=0;query.value={pageNum:1,pageSize:20,sort:'name',order:'asc'};answer('cancel');workspace.value=null;form.value=null;initial.value='';error.value='';notice.value='';busy.value=false;loading.value=false;}
  return {workspace,total,query,form,dirty,error,notice,busy,loading,decision,canEdit,answer,load,open,leave,save,check,reset,stopReading,clearForSession};
});
