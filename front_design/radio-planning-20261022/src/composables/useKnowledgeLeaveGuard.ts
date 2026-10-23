import { onBeforeUnmount, onMounted } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useKnowledgeStore } from '../stores/knowledge';

export function useKnowledgeLeaveGuard() {
  const store=useKnowledgeStore();
  const auth=useAuthStore(),release=auth.registerLeave(()=>store.allowLeave(false,true),()=>store.dirty);
  onBeforeUnmount(release);
  // 只保存显式提交的草稿；刷新由浏览器提示，不在卸载时异步写入。
  const beforeUnload=(event:BeforeUnloadEvent)=>{if(store.dirty||store.locked){event.preventDefault();event.returnValue='';}};
  const focus=()=>{void store.load();};
  onMounted(()=>{window.addEventListener('beforeunload',beforeUnload);window.addEventListener('focus',focus);void store.load();});
  // 正常离开沿用原提示；失效时留在原组件，由统一对话框处理。
  onBeforeRouteLeave(async()=>{if(auth.bypassLeave)return true;await auth.check();return !auth.blocked&&store.allowLeave();});
  onBeforeUnmount(()=>{store.stopQueries();store.answer('cancel');window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('focus',focus);});
}
