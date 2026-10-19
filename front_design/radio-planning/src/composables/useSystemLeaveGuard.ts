import { onBeforeUnmount, onMounted } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useSystemStore } from '../stores/system';
import { useAuthStore } from '../stores/auth';
export function useSystemLeaveGuard(){
  const store=useSystemStore(),auth=useAuthStore();
  const release=auth.registerLeave(()=>store.allowLeave(true),()=>store.dirty);
  // 强制失效由全局冻结层处理；成功退出后无需再弹第二次确认。
  onBeforeRouteLeave(()=>auth.bypassLeave||(!auth.blocked&&store.allowLeave()));
  const beforeUnload=(e:BeforeUnloadEvent)=>{if(store.dirty||store.busy){e.preventDefault();e.returnValue='';}};
  onMounted(()=>window.addEventListener('beforeunload',beforeUnload));
  onBeforeUnmount(()=>{release();store.stopQueries();window.removeEventListener('beforeunload',beforeUnload);});
}
