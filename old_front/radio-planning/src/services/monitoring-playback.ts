// 两路观测共用有限播放机制；不持久化游标，不补播后台遗漏的时间。
export interface PlaybackState {
  index: number; count: number; intervalSeconds: number; busy: boolean; finished: boolean; active: boolean; error: string;
}
export const initialPlaybackState = (): PlaybackState => ({
  index:-1,count:0,intervalSeconds:30,busy:false,finished:false,active:false,error:'',
});
export function createMonitoringPlayback<T>(
  state: PlaybackState,
  fetchFrame: (index: number) => Promise<T>,
  accept: (value: T, index: number) => void,
  fail: (reason: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serial = 0, pending: Promise<void> | null = null;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer);timer=undefined; };
  function schedule() {
    clearTimer();
    if (state.active && !state.busy && !state.finished && !state.error && state.count > 0)
      timer=setTimeout(()=>{void next();},state.intervalSeconds*1000);
  }
  function invalidate() { serial++;pending=null;state.busy=false;clearTimer(); }
  function configure(count: number, intervalSeconds: number) {
    state.count=count;state.intervalSeconds=intervalSeconds;
    state.finished=count>0&&state.index>=count-1;
    schedule();
  }
  function setActive(active: boolean) {
    if (state.active===active) return;
    state.active=active;
    if (!active) invalidate();else schedule();
  }
  function next(): Promise<void> {
    if (pending) return pending;
    if (!state.active || state.finished || state.count<=0) return Promise.resolve();
    clearTimer();state.busy=true;state.error='';
    const token=serial,index=state.index+1;
    // 延后一拍开始请求，使同一事件循环内的手动/定时调用共享同一个 Promise。
    pending=Promise.resolve().then(()=>fetchFrame(index)).then(value=>{
      if(token!==serial)return;
      accept(value,index);
      if(token!==serial)return;
      state.index=index;state.finished=index>=state.count-1;
    }).catch(reason=>{
      if(token!==serial)return;
      state.error=reason instanceof Error?reason.message:'观测读取失败';fail(reason);
    }).finally(()=>{
      if(token!==serial)return;
      state.busy=false;pending=null;schedule();
    });
    return pending;
  }
  function reset() { invalidate();state.index=-1;state.finished=false;state.error=''; }
  async function restart() { reset();await next(); }
  function clear() { invalidate();Object.assign(state,initialPlaybackState()); }
  return {configure,setActive,next,restart,reset,clear};
}
