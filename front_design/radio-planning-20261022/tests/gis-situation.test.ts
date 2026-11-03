import {afterEach,describe,it,expect,vi} from 'vitest';
import {effectScope} from 'vue';
const api=vi.hoisted(()=>({querySavedPlanningPlans:vi.fn(),getPlanningPlan:vi.fn()}));
vi.mock('../src/services',()=>({previewService:api}));
vi.mock('../src/config/env',()=>({env:{mode:'mock'}}));
vi.mock('../src/services/http',()=>({collaborationHttp:{}}));
import {useGisSituation} from '../src/composables/useGisSituation';
const row=(id:string)=>({id,taskId:'T',name:id,version:'V1',state:'SAVED' as const,current:false,sourceChanged:false,savedAt:'2026-11-02T00:00:00Z'});
const plan=(id:string)=>({...row(id),inputVersion:'I',conditionVersion:'C',resourceRevision:'R',revision:'R',input:{bbox:[113,36,114,37]},result:{snapshotId:'S-'+id,nodes:[],devices:[],links:[]}});
const scopes:ReturnType<typeof effectScope>[]=[];
afterEach(()=>{scopes.forEach(s=>s.stop());scopes.length=0;vi.resetAllMocks();vi.useRealTimers();vi.unstubAllGlobals();});
const setup=()=>{const scope=effectScope();scopes.push(scope);return scope.run(()=>useGisSituation(()=>true,()=>1))!;};
describe('只读态势的版本与迟到响应隔离',()=>{
  it('默认最近保存结果，刷新发现新方案只提示；读取失败保留旧图',async()=>{
    vi.useFakeTimers();const documentState={hidden:false};vi.stubGlobal('document',documentState);
    api.querySavedPlanningPlans.mockResolvedValue({items:[row('A')],total:1});api.getPlanningPlan.mockImplementation(async({planId})=>plan(planId));
    const state=setup();await state.latest();expect(state.frame.value?.plan.id).toBe('A');expect(state.display.value).toBe('field');expect(state.terrainReference.value).toBe(false);
    state.frequencyKhz.value=30000;state.terrainReference.value=false;
    api.querySavedPlanningPlans.mockResolvedValue({items:[row('B'),row('A')],total:2});await state.refresh();expect(state.frame.value?.plan.id).toBe('A');expect(state.newest.value?.id).toBe('B');expect(state.frequencyKhz.value).toBe(30000);expect(state.terrainReference.value).toBe(false);
    state.autoRefresh.value=false;const reads=api.querySavedPlanningPlans.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(api.querySavedPlanningPlans).toHaveBeenCalledTimes(reads);
    state.autoRefresh.value=true;await vi.advanceTimersByTimeAsync(30000);expect(api.querySavedPlanningPlans).toHaveBeenCalledTimes(reads+1);expect(state.frame.value?.plan.id).toBe('A');
    documentState.hidden=true;await vi.advanceTimersByTimeAsync(30000);expect(api.querySavedPlanningPlans).toHaveBeenCalledTimes(reads+1);
    api.getPlanningPlan.mockRejectedValue(new Error('网络中断'));await state.select(row('B'));expect(state.frame.value?.plan.id).toBe('A');expect(state.error.value).toContain('保留');
    api.getPlanningPlan.mockImplementation(async({planId})=>plan(planId));await state.select(row('B'));expect(state.frequencyKhz.value).toBeUndefined();expect(state.terrainReference.value).toBe(false);
  });
  it('有效频点保留，失效频点回退首项；不可计算设备和换快照不显示旧覆盖',async()=>{
    api.getPlanningPlan.mockImplementation(async({planId})=>plan(planId));const state=setup();await state.select(row('A'));
    const {coverageV5Case}=await import('./helpers/frozen-coverage'),f=coverageV5Case(),d=f.result.devices[0]!;
    d.computations.push({...structuredClone(d.computations[0]!),freq_khz:31000});
    state.frame.value={...state.frame.value!,coverage:f.cache};state.deviceId.value=d.device_id;state.coverageVisible.value=true;
    expect(state.coverageOverlay.value).toMatchObject({frequencyKhz:30000,display:'field',terrainReference:false});
    state.frequencyKhz.value=31000;expect(state.coverageOverlay.value?.frequencyKhz).toBe(31000);
    const unavailable=structuredClone(f.cache);unavailable.result!.devices[0]!.status='UNAVAILABLE';state.frame.value={...state.frame.value!,coverage:unavailable};expect(state.coverageOverlay.value).toBeNull();expect(state.deviceId.value).toBe(d.device_id);
    const reduced=structuredClone(f.cache);reduced.result!.devices[0]!.computations.pop();state.frame.value={...state.frame.value!,coverage:reduced};expect(state.coverageOverlay.value?.frequencyKhz).toBe(30000);
    state.terrainReference.value=true;api.getPlanningPlan.mockResolvedValue({...plan('A'),result:{...plan('A').result,snapshotId:'S-A-NEW'}});await state.select(row('A'));
    expect(state.deviceId.value).toBe('');expect(state.frequencyKhz.value).toBeUndefined();expect(state.terrainReference.value).toBe(false);expect(state.coverageOverlay.value).toBeNull();
  });
  it('切换后旧响应不覆盖新图，已选设备不串入另一方案',async()=>{
    let finish!:(p:unknown)=>void;api.getPlanningPlan.mockImplementation(({planId})=>planId==='A'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(plan(planId)));
    const state=setup(),old=state.select(row('A'));await state.select(row('B'));finish(plan('A'));await old;expect(state.frame.value?.plan.id).toBe('B');expect(state.deviceId.value).toBe('');
  });
});
