import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePinia } from 'pinia';
import { nextTick, toRaw } from 'vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { apiJob, apiPlan, storeFixture } from './fixtures/planning-api';
const sessions:Awaited<ReturnType<typeof storeFixture>>[]=[];
async function setup(){const f=await storeFixture();sessions.push(f);const planning=usePlanningApiStore();await nextTick();return {...f,planning};}
afterEach(()=>{for(const f of sessions.splice(0)){usePlanningApiStore().clearForSession();f.task.clearForSession();disposePinia(f.pinia);}vi.useRealTimers();vi.restoreAllMocks();});
describe('规划作业与方案状态',()=>{
  it('转正弹窗期间切换普通方案，不能提交旧版本', async () => {
    const { planning, task } = await setup();planning.selectedPlan = apiPlan('P-1');
    const request = vi.spyOn(previewService, 'confirmPlanningReceipt');
    const action = planning.confirm();planning.selectedPlan = apiPlan('P-2');task.answer('save');await action;
    expect(request).not.toHaveBeenCalled();expect(planning.selectedPlan.id).toBe('P-2');
  });
  it('转正回执返回另一方案时保留原请求待核实', async () => {
    const { planning, task } = await setup();planning.selectedPlan = apiPlan('P-1');
    vi.spyOn(previewService, 'confirmPlanningReceipt').mockResolvedValue({ objectId: 'P-2', taskId: task.taskId, revision: 'p2', changed: true });
    vi.spyOn(previewService, 'getPlanningPlan').mockResolvedValue({ ...apiPlan('P-2'), state: 'CONFIRMED', confirmedAt: '2026-10-05T01:00:00Z' });
    const action = planning.confirm();task.answer('save');await action;
    expect(planning.selectedPlan.id).toBe('P-1');expect(planning.pending).toMatchObject({ kind: 'confirm', planId: 'P-1' });
  });
  it('跨任务方案确认超时按方案所属任务核实，不绑定当前编辑草稿', async () => {
    const { planning, task } = await setup();
    const plan = { ...apiPlan(), taskId: 'OTHER' }; planning.selectedPlan = plan;
    vi.spyOn(previewService, 'confirmPlanningPlan').mockRejectedValue(new ApiError('超时', 'REQUEST_TIMEOUT'));
    const action = planning.confirm(); task.answer('save'); await action;
    expect(planning.pending?.taskId).toBe('OTHER');
    const receipt = vi.spyOn(previewService, 'getPlanningOperation').mockResolvedValue({ ...planning.pending!, state: 'SUCCEEDED', entityId: plan.id, message: '已确认' });
    vi.spyOn(previewService, 'getPlanningPlan').mockResolvedValue({ ...plan, state: 'CONFIRMED', current: true, confirmedAt: '2026-10-05T01:00:00Z' });
    await planning.reconcile(); expect(receipt).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'OTHER' })); expect(planning.selectedPlan?.current).toBe(true);
  });
  it('旧会话写入返回不能解除新会话写入锁', async () => {
    const { planning } = await setup(); let first!: (value: ReturnType<typeof apiJob>) => void, second!: (value: ReturnType<typeof apiJob>) => void;
    vi.spyOn(previewService, 'submitPlanningTask').mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const old = planning.submit(); planning.clearForSession(); const current = planning.submit();
    first(apiJob()); await old; expect(planning.busy).toBe(true);
    second(apiJob()); await current; expect(planning.busy).toBe(false);
  });
  it('损坏记录经明确确认可重置；普通目录错误不绕过版本读取', async () => {
    const { planning, task } = await setup();
    vi.mocked(previewService.loadPlanningOptions).mockRejectedValueOnce(new ApiError('记录损坏', 'PLANNING_CORRUPT')).mockRejectedValueOnce(new ApiError('离线', 'NETWORK_ERROR'));
    const reset = vi.spyOn(previewService, 'resetPlanningReceipt').mockResolvedValue({revision:'reset',objectId:'planning-workspace',changed:true});
    const action = planning.reset(); await vi.waitFor(() => expect(task.decision).not.toBeNull()); task.answer('save'); await action;
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({ revision: null }));
    await planning.reset(); expect(reset).toHaveBeenCalledTimes(1); expect(task.decision).toBeNull();
  });
  it('取消重置不发起写入，并保留未保存草稿和已选结果', async () => {
    const { planning, task } = await setup();
    planning.job = apiJob(); planning.selectedPlan = apiPlan(); task.draft!.name = '尚未保存的任务修改';
    const draft = structuredClone(toRaw(task.draft)), saved = structuredClone(toRaw(task.saved)), taskId = task.taskId;
    const reset = vi.spyOn(previewService, 'resetPlanningReceipt');
    // 当前入口先异步核对版本，等待真实确认框后再取消。
    const action = planning.reset(); await vi.waitFor(() => expect(task.decision).not.toBeNull()); task.answer('cancel');
    expect(await action).toBe(false); expect(reset).not.toHaveBeenCalled();
    expect(task.taskId).toBe(taskId); expect(task.saved).toEqual(saved); expect(task.draft).toEqual(draft); expect(task.dirty).toBe(true);
    expect(planning.job).toEqual(apiJob()); expect(planning.selectedPlan).toEqual(apiPlan());
  });
  it('重置写入失败保留草稿和已选结果，并反馈错误', async () => {
    const { planning, task } = await setup();
    planning.job = apiJob(); planning.selectedPlan = apiPlan(); task.draft!.name = '尚未保存的任务修改';
    const draft = structuredClone(toRaw(task.draft)), saved = structuredClone(toRaw(task.saved)), taskId = task.taskId, revision = 'reset-base-r2';
    vi.mocked(previewService.loadPlanningOptions).mockResolvedValueOnce({ ...task.catalog!, workspaceRevision: revision });
    const reset = vi.spyOn(previewService, 'resetPlanningReceipt').mockRejectedValue(new ApiError('重置写入失败', 'STORAGE_ERROR'));
    // 写入失败只反馈错误，不能先清空编辑现场。
    const action = planning.reset(); await vi.waitFor(() => expect(task.decision).not.toBeNull()); task.answer('save');
    expect(await action).toBe(false); expect(reset).toHaveBeenCalledOnce(); expect(reset).toHaveBeenCalledWith(expect.objectContaining({ revision }));
    expect(task.taskId).toBe(taskId); expect(task.saved).toEqual(saved); expect(task.draft).toEqual(draft); expect(task.dirty).toBe(true);
    expect(planning.job).toEqual(apiJob()); expect(planning.selectedPlan).toEqual(apiPlan());
    expect(planning.error).toContain('重置写入失败'); expect(planning.busy).toBe(false);
  });
  it('重置成功清理规划现场并恢复默认草稿，独立任务列表保留', async () => {
    const { planning, task } = await setup(); await task.queryLibrary();
    const defaults = structuredClone(toRaw(task.draft)), library = structuredClone(toRaw(task.library)), taskId = task.taskId, revision = 'reset-base-r2';
    vi.mocked(previewService.loadPlanningOptions).mockResolvedValueOnce({ ...task.catalog!, workspaceRevision: revision });
    planning.job = apiJob(); planning.selectedPlan = apiPlan(); planning.comparison = [apiPlan()]; planning.parentPlanId = 'P-PARENT'; planning.step = 3;
    task.draft!.name = '尚未保存的任务修改';
    let finish!: (receipt: Awaited<ReturnType<typeof previewService.resetPlanningReceipt>>) => void;
    const reset = vi.spyOn(previewService, 'resetPlanningReceipt').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    // 成功回执到达后才清理现场，不删除独立任务列表。
    const action = planning.reset(); await vi.waitFor(() => expect(task.decision).not.toBeNull()); task.answer('save');
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    expect(task.draft!.name).toBe('尚未保存的任务修改'); expect(planning.selectedPlan).toEqual(apiPlan());
    finish({ revision: 'reset-r2', objectId: 'planning-workspace', changed: true });
    expect(await action).toBe(true); expect(reset).toHaveBeenCalledOnce(); expect(reset).toHaveBeenCalledWith(expect.objectContaining({ revision }));
    expect(planning.job).toBeNull(); expect(planning.selectedPlan).toBeNull(); expect(planning.comparison).toEqual([]); expect(planning.parentPlanId).toBeNull(); expect(planning.step).toBe(1);
    expect(task.taskId).not.toBe(taskId); expect(task.saved).toBeNull(); expect(task.draft).toEqual(defaults); expect(task.dirty).toBe(false);
    expect(task.library).toEqual(library); expect(task.catalog!.workspaceRevision).toBe('reset-r2'); expect(planning.busy).toBe(false);
  });
  it('取消成功后迟到的运行中查询不能恢复作业',async()=>{
    const {planning,task}=await setup(),running={...apiJob(),state:'RUNNING' as const,result:null};planning.job=running;
    let finish!:(value:typeof running)=>void;vi.spyOn(previewService,'getPlanningTask').mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
    const old=planning.refreshJob();vi.spyOn(previewService,'cancelPlanningTask').mockResolvedValue({...apiJob(),state:'CANCELLED',result:null});
    const cancel=planning.cancel();task.answer('save');await cancel;finish(running);await old;expect(planning.job!.state).toBe('CANCELLED');expect(task.editable).toBe(true);
  });
  it('资源引用更新后必须重存任务，已知条件版本变化阻止确认旧方案',async()=>{
    const {planning,task}=await setup();task.resourceRevision='r2';expect(planning.canSubmit).toBe(false);
    task.resourceRevision='r1';planning.selectedPlan=apiPlan();expect(planning.canConfirm).toBe(true);task.saved!.conditionVersion='c2';expect(planning.sourceChanged).toBe(true);expect(planning.canConfirm).toBe(false);
  });
  it('提交返回期间失权保留原请求，恢复查看权限后仍需核实',async()=>{
    const {planning,auth}=await setup(),identity={...auth.identity!};
    const submit=vi.spyOn(previewService,'submitPlanningTask').mockImplementationOnce(async()=>{auth.accept({...identity,permissions:[]});planning.stop();return apiJob();});
    await planning.submit();expect(planning.pending?.kind).toBe('submit');expect(planning.job).toBeNull();auth.accept(identity);await planning.submit();expect(submit).toHaveBeenCalledTimes(1);
  });
  it('未保存修改阻止提交，已保存输入携带版本并锁定运行中的草稿',async()=>{
    const {task,planning}=await setup(),submit=vi.spyOn(previewService,'submitPlanningTask').mockResolvedValue({...apiJob(),state:'RUNNING',result:null,progress:10});task.draft!.name='未保存';await planning.submit();expect(submit).not.toHaveBeenCalled();task.draft!.name=task.saved!.input.name;await planning.submit();expect(submit).toHaveBeenCalledWith(expect.objectContaining({taskId:'T1',inputVersion:'i1',conditionVersion:'c1'}));expect(planning.step).toBe(2);expect(task.editable).toBe(false);planning.stop();
  });
  it('已保存任务真正提交失败后保留输入和服务错误', async () => {
    const { planning, task } = await setup(), draft = structuredClone(toRaw(task.draft)), saved = structuredClone(toRaw(task.saved));
    const submit = vi.spyOn(previewService, 'submitPlanningTask').mockRejectedValue(new ApiError('服务拒绝执行', 'VALIDATION_ERROR'));
    // 先确认当前任务可提交，避免前置检查提前返回形成假覆盖。
    expect(planning.canSubmit).toBe(true); await planning.submit();
    expect(submit).toHaveBeenCalledOnce(); expect(submit).toHaveBeenCalledWith(expect.objectContaining({ taskId: saved!.taskId, inputVersion: saved!.inputVersion, conditionVersion: saved!.conditionVersion }));
    expect(task.draft).toEqual(draft); expect(task.saved).toEqual(saved); expect(planning.job).toBeNull();
    expect(planning.error).toContain('服务拒绝执行'); expect(planning.pending).toBeNull(); expect(planning.busy).toBe(false); expect(task.editable).toBe(true);
  });
  it('同一已保存任务并发点击只发出一次提交', async () => {
    const { planning, task } = await setup();
    let finish!: (job: ReturnType<typeof apiJob>) => void;
    const submit = vi.spyOn(previewService, 'submitPlanningTask').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    // 保持首个请求在途，再触发第二次点击，验证真实写入次数。
    const first = planning.submit(), second = planning.submit(); await second;
    expect(submit).toHaveBeenCalledOnce(); expect(planning.busy).toBe(true); expect(task.editable).toBe(false);
    finish(apiJob()); await first;
    expect(submit).toHaveBeenCalledOnce(); expect(planning.job).toEqual(apiJob()); expect(planning.busy).toBe(false); expect(task.editable).toBe(true);
  });
  it('停止后不再查询，重新启动读取同一作业终态且不继续轮询', async () => {
    const { planning } = await setup(); vi.useFakeTimers(); planning.job = { ...apiJob(), state: 'RUNNING', result: null };
    vi.spyOn(previewService, 'getPlanningTask').mockResolvedValueOnce({ ...apiJob(), state: 'RUNNING', result: null, progress: 35 }).mockResolvedValue(apiJob());
    // 进度与详情共用夹具读取桩，轮询次数按公开进度出口计量。
    const progress = vi.mocked(previewService.getPlanningTaskProgress);
    planning.start(); await vi.waitFor(() => expect(planning.job!.progress).toBe(35), { interval: 0 });
    // 停止只冻结客户端读取，经过时间后仍可重新读取原作业。
    planning.stop(); await vi.advanceTimersByTimeAsync(5000); expect(progress).toHaveBeenCalledOnce();
    planning.start(); await vi.waitFor(() => expect(planning.job!.state).toBe('SUCCESS'), { interval: 0 });
    expect(progress.mock.calls.map(([request]) => request.jobId)).toEqual(['J1', 'J1']); expect(planning.result!.snapshotId).toBe('S1');
    await vi.advanceTimersByTimeAsync(10000); expect(progress).toHaveBeenCalledTimes(2);
  });
  it('轮询为两秒，查询失败保留进度并停止自动重试，手动恢复可接纳终态',async()=>{
    const {planning}=await setup();vi.useFakeTimers();planning.job={...apiJob(),state:'RUNNING',result:null};const query=vi.spyOn(previewService,'getPlanningTask').mockResolvedValueOnce({...apiJob(),state:'RUNNING',result:null,progress:35}).mockRejectedValueOnce(new ApiError('离线','NETWORK_ERROR'));planning.start();
    // 摘要核对包含异步散列，等首帧处理完成后再计量下一次轮询的间隔。
    await vi.waitFor(()=>expect(planning.job!.progress).toBe(35),{interval:0});expect(query).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1999);expect(query).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(query).toHaveBeenCalledTimes(2);expect(planning.job!.progress).toBe(35);expect(planning.queryError).toBe('离线');await vi.advanceTimersByTimeAsync(10000);expect(query).toHaveBeenCalledTimes(2);
    // 显式重试恢复成功后清除查询错误，终态不再触发后续轮询。
    query.mockResolvedValueOnce(apiJob()); await planning.refreshJob();
    expect(previewService.getPlanningTaskProgress).toHaveBeenCalledTimes(3); expect(planning.queryError).toBe(''); expect(planning.job!.state).toBe('SUCCESS'); expect(planning.result!.snapshotId).toBe('S1');
    const reads = query.mock.calls.length; await vi.advanceTimersByTimeAsync(10000); expect(query).toHaveBeenCalledTimes(reads);
  });
  it('取消返回成功终态时保留服务端结果，不强行改成已取消',async()=>{
    const {task,planning}=await setup();planning.job={...apiJob(),state:'RUNNING',result:null};vi.spyOn(previewService,'cancelPlanningTask').mockResolvedValue(apiJob());const call=planning.cancel();task.answer('save');await call;expect(planning.job!.state).toBe('SUCCESS');expect(planning.result!.snapshotId).toBe('S1');
  });
  it('参考版本可保存但不可确认，成功保存后刷新失败仍保留保存事实',async()=>{
    const {planning}=await setup();planning.job=apiJob();const reference={...apiPlan(),state:'REFERENCE' as const};vi.spyOn(previewService,'savePlanningPlan').mockResolvedValue(reference);vi.mocked(previewService.queryPlanningPlans).mockRejectedValue(new ApiError('列表离线','NETWORK_ERROR'));expect(await planning.savePlan('参考','')).toBe(true);expect(planning.selectedPlan!.state).toBe('REFERENCE');expect(planning.job!.savedPlanId).toBe(reference.id);expect(planning.canConfirm).toBe(false);expect(planning.error).toContain('列表离线');
  });
  it('保存请求超时按回执恢复，禁止重复新建版本',async()=>{
    const {planning}=await setup();planning.job=apiJob();const save=vi.spyOn(previewService,'savePlanningPlan').mockRejectedValue(new ApiError('超时','REQUEST_TIMEOUT'));await planning.savePlan('版本','');expect(planning.pending!.kind).toBe('savePlan');await planning.savePlan('版本','');expect(save).toHaveBeenCalledTimes(1);
    const pending=planning.pending!;vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...pending,state:'SUCCEEDED',entityId:'P-1',message:'已保存'});vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(apiPlan());await planning.reconcile();expect(planning.pending).toBeNull();expect(planning.selectedPlan!.id).toBe('P-1');expect(save).toHaveBeenCalledTimes(1);
  });
  it('旧请求或换号迟到结果不覆盖当前现场',async()=>{
    const {planning,auth}=await setup();planning.job=apiJob();let resolve!:(j:ReturnType<typeof apiJob>)=>void;vi.spyOn(previewService,'getPlanningTask').mockImplementationOnce(()=>new Promise(r=>resolve=r));const request=planning.refreshJob();auth.accept({...auth.identity!,sessionId:'another'});resolve({...apiJob(),id:'OLD'});await request;expect(planning.job!.id).toBe('J1');
  });
  it('调整复制输入并记录父版本，不改变保存快照',async()=>{
    const {planning,task}=await setup();planning.selectedPlan=apiPlan();const frozen=JSON.stringify(planning.selectedPlan);await planning.adjust();expect(planning.parentPlanId).toBe('P-1');expect(planning.step).toBe(1);task.draft!.name='调整输入';expect(JSON.stringify(apiPlan())).toBe(frozen);expect(planning.selectedPlan).toBeNull();
  });
  it('来源变化或校验未知时禁止确认',async()=>{
    const {planning}=await setup();planning.selectedPlan={...apiPlan(),sourceChanged:true};expect(planning.canConfirm).toBe(false);planning.selectedPlan=apiPlan();planning.selectedPlan.result.checks[0].passed=null;expect(planning.canConfirm).toBe(false);
  });
});

// 独立方案调整必须冻结父版本，并与任务草稿、回执和迟到响应隔离。
describe('具体方案调整现场',()=>{
  async function opened(){const s=await setup();s.planning.selectedPlan=apiPlan();expect(await s.planning.openPlanAdjustment()).toBe(true);return s;}
  function change(planning:ReturnType<typeof usePlanningApiStore>,power=25){planning.updateAdjustment({...structuredClone(toRaw(planning.adjustmentDraft!)),manualOverrides:[{deviceId:'E1',txPowerDbm:power}]});}
  it('HTTP 任意有限功率独立提交，不依赖本地档位且不保存任务',async()=>{
    const {planning,task}=await opened(),original=JSON.stringify(task.saved),save=vi.spyOn(previewService,'saveTaskInput');change(planning,23.5);
    const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));
    const submit=vi.spyOn(previewService,'submitPlanningTask').mockResolvedValue({...apiJob(),id:'ADJUSTED',parentPlanId:'P-1',adjustment});
    expect(await planning.submitAdjustment()).toBe(true);expect(submit).toHaveBeenCalledWith(expect.objectContaining({taskId:'T1',parentPlanId:'P-1',adjustment}));
    expect(JSON.stringify(task.saved)).toBe(original);expect(save).not.toHaveBeenCalled();expect(planning.adjustmentResult?.snapshotId).toBe('S1');expect(planning.adjustmentOpen).toBe(false);expect(planning.canSave).toBe(true);
    change(planning,22);expect(planning.adjustmentResult).toBeNull();expect(planning.canSave).toBe(false);expect(planning.adjustmentStatus).toContain('暂无预览结果');
  });
  it('失败保留父方案及输入，关闭或切换必须处理草稿',async()=>{
    const {planning,task}=await opened();change(planning);const before=JSON.stringify(planning.adjustmentDraft);
    vi.spyOn(previewService,'submitPlanningTask').mockRejectedValue(new ApiError('暂无对应结果','NO_PRESET',{suggestions:['修改输入']}));
    expect(await planning.submitAdjustment()).toBe(false);expect(planning.adjustmentParent?.id).toBe('P-1');expect(JSON.stringify(planning.adjustmentDraft)).toBe(before);expect(planning.adjustmentResult).toBeNull();
    const close=planning.closeAdjustment();task.answer('cancel');expect(await close).toBe(false);expect(planning.adjustmentOpen).toBe(true);
    const get=vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(apiPlan('P-2')),select=planning.selectPlan('P-2');task.answer('cancel');await select;expect(get).not.toHaveBeenCalled();
    const discard=planning.closeAdjustment();task.answer('discard');expect(await discard).toBe(true);expect(planning.adjustmentDraft).toBeNull();expect(task.auxiliary.planningAdjustment).toBeUndefined();
  });
  it('未知写入冻结输入并核实原请求，再从回执显示调整结果',async()=>{
    const {planning,task}=await opened();change(planning);const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));
    const submit=vi.spyOn(previewService,'submitPlanningTask').mockRejectedValue(new ApiError('超时','REQUEST_TIMEOUT'));
    await planning.submitAdjustment();expect(planning.pending?.kind).toBe('submit');change(planning,19);expect(planning.adjustmentDraft).toEqual(adjustment);
    expect(await planning.closeAdjustment()).toBe(false);await task.open('another');expect(task.taskId).toBe('T1');await planning.submitAdjustment();expect(submit).toHaveBeenCalledTimes(1);
    vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...planning.pending!,state:'SUCCEEDED',entityId:'J2',message:'成功'});
    vi.spyOn(previewService,'getPlanningTask').mockResolvedValue({...apiJob(),id:'J2',adjustment,parentPlanId:'P-1'});
    await planning.reconcile();expect(planning.pending).toBeNull();expect(planning.adjustmentDirty).toBe(false);expect(planning.adjustmentResult).not.toBeNull();expect(planning.step).toBe(3);
  });
  it('权限收回时保留草稿，清理会话后迟到提交不能恢复父方案',async()=>{
    const {planning,auth}=await opened();change(planning);const identity={...auth.identity!};
    auth.accept({...identity,permissions:identity.permissions.filter(p=>p!=='planning.execute')});const before=JSON.stringify(planning.adjustmentDraft);
    change(planning,2);expect(JSON.stringify(planning.adjustmentDraft)).toBe(before);expect(await planning.submitAdjustment()).toBe(false);
    auth.accept(identity);let finish!:(value:ReturnType<typeof apiJob>)=>void;vi.spyOn(previewService,'submitPlanningTask').mockImplementation(()=>new Promise(resolve=>finish=resolve));
    const pending=planning.submitAdjustment();planning.clearForSession();finish(apiJob());await pending;expect(planning.adjustmentParent).toBeNull();expect(planning.adjustmentDraft).toBeNull();expect(planning.job).toBeNull();expect(planning.pending).toBeNull();
  });
  it('查询恢复调整父快照，父版本读取失败时不借当前方案冒充',async()=>{
    const {planning}=await opened(),adjustment=structuredClone(toRaw(planning.adjustmentDraft!));await planning.closeAdjustment();planning.clearForSession();
    vi.spyOn(previewService,'getPlanningTask').mockResolvedValue({...apiJob(),id:'J2',adjustment,parentPlanId:'P-1'});
    const parent=vi.spyOn(previewService,'getPlanningPlan').mockRejectedValueOnce(new ApiError('父版本读取失败','NETWORK_ERROR')).mockResolvedValue(apiPlan());
    await planning.refreshJob('J2');expect(planning.adjustmentParent).toBeNull();expect(planning.error).toContain('父版本读取失败');
    await planning.refreshJob('J2');expect(parent).toHaveBeenCalledTimes(2);expect(planning.adjustmentParent?.id).toBe('P-1');expect(planning.adjustmentDirty).toBe(false);expect(planning.step).toBe(3);
  });
  it.each(['missing','other-input','other-parent'])('保存回执 %s 时不接受丢失或错配的调整输入',async kind=>{
    const {planning}=await opened();change(planning);const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));
    vi.spyOn(previewService,'submitPlanningTask').mockResolvedValue({...apiJob(),parentPlanId:'P-1',adjustment});await planning.submitAdjustment();
    const plan={...apiPlan('P-2'),parentPlanId:'P-1',adjustment:structuredClone(adjustment)};
    if(kind==='missing')delete(plan as {adjustment?:unknown}).adjustment;
    else if(kind==='other-input')plan.adjustment.manualOverrides[0].txPowerDbm=11;
    else plan.parentPlanId='other';
    vi.spyOn(previewService,'savePlanningPlan').mockResolvedValue(plan);expect(await planning.savePlan('调整','')).toBe(false);
    expect(planning.selectedPlan).toBeNull();expect(planning.pending?.kind).toBe('savePlan');expect(planning.error).toContain('调整来源');
    vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...planning.pending!,state:'SUCCEEDED',entityId:'P-2',message:'保存成功'});
    vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(plan);await planning.reconcile();expect(planning.pending?.kind).toBe('savePlan');expect(planning.selectedPlan).toBeNull();
  });
  it('版本查询发出后新填的调整输入不会被迟到版本替换',async()=>{
    const {planning}=await opened();let finish!:(plan:ReturnType<typeof apiPlan>)=>void;
    vi.spyOn(previewService,'getPlanningPlan').mockImplementation(()=>new Promise(resolve=>finish=resolve));
    const selection=planning.selectPlan('P-2');await Promise.resolve();change(planning,19);finish(apiPlan('P-2'));await selection;
    expect(planning.selectedPlan?.id).toBe('P-1');expect(planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(19);expect(planning.adjustmentDirty).toBe(true);
  });
  it.each(['missing','different'])('已知调整作业轮询 %s 回显时保留原作业并阻止保存',async kind=>{
    const {planning}=await opened();change(planning);const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));
    vi.spyOn(previewService,'submitPlanningTask').mockResolvedValue({...apiJob(),parentPlanId:'P-1',adjustment});await planning.submitAdjustment();
    const bad={...apiJob(),parentPlanId:'P-1',adjustment:structuredClone(adjustment)};
    if(kind==='missing')delete(bad as {adjustment?:unknown}).adjustment;else bad.adjustment.manualOverrides[0].txPowerDbm=1;
    vi.spyOn(previewService,'getPlanningTask').mockResolvedValue(bad);await planning.refreshJob();
    expect(planning.job!.adjustment).toEqual(adjustment);expect(planning.queryError).toContain('调整来源');expect(planning.canSave).toBe(false);
  });
  it.each(['missing','different'])('待核实调整提交 %s 回显继续保留原请求',async kind=>{
    const {planning}=await opened();change(planning);const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));
    vi.spyOn(previewService,'submitPlanningTask').mockRejectedValue(new ApiError('网络错误','NETWORK_ERROR'));await planning.submitAdjustment();
    const pending={...planning.pending!};vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...pending,state:'SUCCEEDED',entityId:'J2',message:'已成功'});
    const bad={...apiJob(),parentPlanId:'P-1',adjustment:structuredClone(adjustment)};
    if(kind==='missing')delete(bad as {adjustment?:unknown}).adjustment;else bad.adjustment.manualOverrides[0].txPowerDbm=1;
    vi.spyOn(previewService,'getPlanningTask').mockResolvedValue(bad);await planning.reconcile();
    expect(planning.pending?.requestId).toBe(pending.requestId);expect(planning.job).toBeNull();expect(planning.error).toContain('调整来源');expect(planning.adjustmentDraft).toEqual(adjustment);
  });
  it('确认调整版本的弹窗等待期间失权，不能继续提交确认请求',async()=>{
    const {planning,task,auth}=await opened();const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));await planning.closeAdjustment();
    planning.selectedPlan={...apiPlan('P-2'),parentPlanId:'P-1',adjustment};const confirm=vi.spyOn(previewService,'confirmPlanningPlan');
    const action=planning.confirm();auth.accept({...auth.identity!,permissions:auth.identity!.permissions.filter(p=>p!=='planning.confirm')});task.answer('save');await action;expect(confirm).not.toHaveBeenCalled();
  });
  it.each(['cancel','confirm'] as const)('调整 %s 回包及核实回执必须保留冻结来源',async kind=>{
    const {planning,task}=await opened(),adjustment=structuredClone(toRaw(planning.adjustmentDraft!));await planning.closeAdjustment();
    const knownJob={...apiJob(),adjustment,parentPlanId:'P-1',state:'RUNNING' as const,result:null},knownPlan={...apiPlan('P-2'),adjustment,parentPlanId:'P-1'};
    if(kind==='cancel'){planning.job=knownJob;planning.selectedPlan=null;vi.spyOn(previewService,'cancelPlanningTask').mockResolvedValue({...apiJob(),state:'CANCELLED',result:null});}
    else{planning.selectedPlan=knownPlan;vi.spyOn(previewService,'confirmPlanningPlan').mockResolvedValue({...apiPlan('P-2'),state:'CONFIRMED',confirmedAt:'2026-10-05T01:00:00Z'});}
    const action=kind==='cancel'?planning.cancel():planning.confirm();task.answer('save');await action;
    expect(planning.pending).toMatchObject({kind,adjustment,parentPlanId:'P-1'});expect(kind==='cancel'?planning.job!.state:planning.selectedPlan!.state).toBe(kind==='cancel'?'RUNNING':'SAVED');
    vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...planning.pending!,state:'SUCCEEDED',entityId:kind==='cancel'?'J1':'P-2',message:'已操作'});
    const goodJob={...knownJob,state:'CANCELLED' as const},goodPlan={...knownPlan,state:'CONFIRMED' as const,confirmedAt:'2026-10-05T01:00:00Z'};
    const getJob=vi.spyOn(previewService,'getPlanningTask').mockResolvedValue({...goodJob,parentPlanId:'wrong-parent'}),getPlan=vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue({...goodPlan,adjustment:{...adjustment,sourceSnapshotId:'wrong-snapshot'}});
    await planning.reconcile();expect(planning.pending?.kind).toBe(kind);expect(planning.error).toContain('调整来源');
    getJob.mockResolvedValue(goodJob);getPlan.mockResolvedValue(goodPlan);await planning.reconcile();expect(planning.pending).toBeNull();expect(kind==='cancel'?planning.job!.state:planning.selectedPlan!.state).toBe(kind==='cancel'?'CANCELLED':'CONFIRMED');
  });
  it.each(['task','permission'])('调整取消弹窗等待期间 %s 变化不提交旧操作',async boundary=>{
    const {planning,task,auth}=await opened(),adjustment=structuredClone(toRaw(planning.adjustmentDraft!));await planning.closeAdjustment();planning.job={...apiJob(),adjustment,parentPlanId:'P-1',state:'RUNNING',result:null};
    const cancel=vi.spyOn(previewService,'cancelPlanningTask'),action=planning.cancel();
    if(boundary==='task')task.taskId='T2';else auth.accept({...auth.identity!,permissions:auth.identity!.permissions.filter(p=>p!=='planning.execute')});
    task.answer('save');await action;expect(cancel).not.toHaveBeenCalled();expect(planning.pending).toBeNull();
  });
});

// 自动预览只创建作业，方案保存仍显式进行，使用时钟验证真实请求边界。
describe('自动调整预览队列',()=>{
  async function opened(){const s=await setup();s.planning.selectedPlan=apiPlan();await s.planning.openPlanAdjustment();s.planning.setAutomaticPreview(true);vi.useFakeTimers();return s;}
  function change(planning:ReturnType<typeof usePlanningApiStore>,power:number){planning.updateAdjustment({...structuredClone(toRaw(planning.adjustmentDraft!)),manualOverrides:[{deviceId:'E1',txPowerDbm:power}]});}
  it('第三步版本查看保留步骤，外部定位仍默认进入结果步骤',async()=>{
    const {planning}=await setup();planning.step=3;vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(apiPlan('P-2'));
    expect(await planning.selectPlan('P-2','T1',3)).toBe(true);expect(planning.step).toBe(3);
    expect(await planning.selectPlan('P-2')).toBe(true);expect(planning.step).toBe(2);
  });
  it('停顿合并有效输入、相同结果去重且不自动保存方案',async()=>{
    const {planning}=await opened(),submit=vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async r=>({...apiJob(),parentPlanId:'P-1',adjustment:r.adjustment})),save=vi.spyOn(previewService,'savePlanningPlan');
    change(planning,21);await vi.advanceTimersByTimeAsync(400);change(planning,22);await vi.advanceTimersByTimeAsync(699);expect(submit).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);
    expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.calls[0][0].adjustment!.manualOverrides[0].txPowerDbm).toBe(22);expect(planning.adjustmentResult).not.toBeNull();expect(planning.canSave).toBe(true);expect(save).not.toHaveBeenCalled();
    change(planning,22);await vi.advanceTimersByTimeAsync(3000);expect(submit).toHaveBeenCalledTimes(1);
  });
  it('非法输入及恢复原值不创建作业，原始草稿仍用于校验',async()=>{
    const {planning}=await opened(),original=structuredClone(toRaw(planning.adjustmentDraft!)),submit=vi.spyOn(previewService,'submitPlanningTask');
    change(planning,Number.NaN);await vi.advanceTimersByTimeAsync(1000);expect(submit).not.toHaveBeenCalled();expect(planning.adjustmentIssues.length).toBeGreaterThan(0);
    planning.updateAdjustment(original);await vi.advanceTimersByTimeAsync(1000);expect(submit).not.toHaveBeenCalled();expect(planning.adjustmentIssues).toEqual([]);
  });
  it('写入期间继续编辑，迟到结果不允许保存，只接续最新一份输入',async()=>{
    const {planning}=await opened();let finish!:(job:ReturnType<typeof apiJob>)=>void;
    const submit=vi.spyOn(previewService,'submitPlanningTask').mockImplementationOnce(()=>new Promise(resolve=>finish=resolve)).mockImplementation(async r=>({...apiJob(),id:'J2',parentPlanId:'P-1',adjustment:r.adjustment}));
    change(planning,20);await vi.advanceTimersByTimeAsync(700);const old=structuredClone(toRaw(planning.adjustmentDraft!));change(planning,21);change(planning,23);
    await vi.advanceTimersByTimeAsync(1500);expect(submit).toHaveBeenCalledTimes(1);finish({...apiJob(),parentPlanId:'P-1',adjustment:old});await vi.advanceTimersByTimeAsync(0);
    expect(planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(23);expect(planning.adjustmentResult).toBeNull();expect(planning.canSave).toBe(false);
    await vi.advanceTimersByTimeAsync(700);expect(submit).toHaveBeenCalledTimes(2);expect(submit.mock.calls[1][0].adjustment!.manualOverrides[0].txPowerDbm).toBe(23);expect(planning.adjustmentResult).not.toBeNull();
  });
  it('已有运行作业时只排最新输入，终态后再提交',async()=>{
    const {planning}=await opened(),submit=vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async r=>({...apiJob(),state:'RUNNING',result:null,parentPlanId:'P-1',adjustment:r.adjustment}));
    change(planning,20);await vi.advanceTimersByTimeAsync(700);const old=structuredClone(toRaw(planning.job!));change(planning,21);change(planning,24);await vi.advanceTimersByTimeAsync(800);expect(submit).toHaveBeenCalledTimes(1);
    vi.spyOn(previewService,'getPlanningTask').mockResolvedValue({...old,state:'SUCCESS',result:apiJob().result});await planning.refreshJob();await vi.advanceTimersByTimeAsync(700);expect(submit).toHaveBeenCalledTimes(2);expect(submit.mock.calls[1][0].adjustment!.manualOverrides[0].txPowerDbm).toBe(24);
  });
  it('无预生成结果不循环重试；待核实写入冻结输入并阻止新作业',async()=>{
    const {planning}=await opened(),submit=vi.spyOn(previewService,'submitPlanningTask').mockRejectedValueOnce(new ApiError('暂无','NO_PRESET')).mockRejectedValueOnce(new ApiError('超时','REQUEST_TIMEOUT'));
    change(planning,20);await vi.advanceTimersByTimeAsync(5700);expect(submit).toHaveBeenCalledTimes(1);expect(planning.adjustmentStatus).toContain('暂无预生成结果');expect(planning.adjustmentResult).toBeNull();
    await planning.submitAdjustment();expect(planning.pending).not.toBeNull();change(planning,25);await vi.advanceTimersByTimeAsync(3000);expect(submit).toHaveBeenCalledTimes(2);expect(planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(20);
  });
  it('查询中断暂停队列，恢复查询后才接续最新输入',async()=>{
    const {planning}=await opened(),submit=vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async r=>({...apiJob(),state:'RUNNING',result:null,parentPlanId:'P-1',adjustment:r.adjustment}));
    change(planning,20);await vi.advanceTimersByTimeAsync(700);const old=structuredClone(toRaw(planning.job!));
    const get=vi.spyOn(previewService,'getPlanningTask').mockRejectedValue(new ApiError('查询中断','NETWORK_ERROR'));await planning.refreshJob();change(planning,24);await vi.advanceTimersByTimeAsync(5000);
    expect(planning.adjustmentStatus).toContain('恢复查询');expect(submit).toHaveBeenCalledTimes(1);
    get.mockResolvedValue({...old,state:'SUCCESS',result:apiJob().result});await planning.refreshJob();await vi.advanceTimersByTimeAsync(700);expect(submit).toHaveBeenCalledTimes(2);expect(submit.mock.calls[1][0].adjustment!.manualOverrides[0].txPowerDbm).toBe(24);
  });
  it('保存方案期间仍冻结调整输入，不能因自动预览放宽写入保护',async()=>{
    const {planning}=await opened();vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async r=>({...apiJob(),parentPlanId:'P-1',adjustment:r.adjustment}));change(planning,20);await vi.advanceTimersByTimeAsync(700);
    const adjustment=structuredClone(toRaw(planning.adjustmentDraft!));let finish!:(value:ReturnType<typeof apiPlan>)=>void;vi.spyOn(previewService,'savePlanningPlan').mockImplementation(()=>new Promise(resolve=>finish=resolve));
    const saving=planning.savePlan('调整','');expect(planning.adjustmentLocked).toBe(true);change(planning,24);expect(planning.adjustmentDraft).toEqual(adjustment);
    finish({...apiPlan('P-2'),parentPlanId:'P-1',adjustment});expect(await saving).toBe(true);expect(planning.adjustmentLocked).toBe(false);
  });
  it('导航询问暂停，取消后恢复，失权及换任务清理等待请求',async()=>{
    const {planning,auth,task}=await opened(),submit=vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async r=>({...apiJob(),parentPlanId:'P-1',adjustment:r.adjustment}));
    change(planning,20);planning.pauseAutomaticPreview();await vi.advanceTimersByTimeAsync(1000);expect(submit).not.toHaveBeenCalled();planning.resumeAutomaticPreview();await vi.advanceTimersByTimeAsync(700);expect(submit).toHaveBeenCalledTimes(1);
    change(planning,21);const identity={...auth.identity!};auth.accept({...identity,permissions:[]});await vi.advanceTimersByTimeAsync(1000);expect(submit).toHaveBeenCalledTimes(1);
    auth.accept(identity);task.taskId='T2';await vi.advanceTimersByTimeAsync(1000);expect(submit).toHaveBeenCalledTimes(1);expect(planning.adjustmentDraft).toBeNull();
  });
});

describe('规划反馈归属与生命周期',()=>{
  it('同操作重试立即清理旧反馈，无关查询成功保留当前失败',async()=>{
    const {planning}=await setup(),data={suggestions:['重新选择场景']};
    vi.spyOn(previewService,'submitPlanningTask').mockRejectedValueOnce(new ApiError('不可行',3001,data,'service-request'));
    await planning.submit();await planning.loadPlans();
    expect(planning.feedback).toMatchObject({operation:'submit',taskId:'T1',code:3001,requestId:'service-request',data});
    let finish!:(value:ReturnType<typeof apiJob>)=>void;
    vi.mocked(previewService.submitPlanningTask).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
    const retry=planning.submit();expect(planning.feedback).toBeNull();expect(planning.businessDetails).toBeNull();
    finish(apiJob());await retry;expect(planning.error).toBe('');expect(planning.step).toBe(2);
  });
  it('作业查询重试清除其详情，其他操作错误不与查询反馈拼接',async()=>{
    const {planning}=await setup();planning.job=apiJob();
    vi.spyOn(previewService,'getPlanningTask').mockRejectedValueOnce(new ApiError('查询离线',2003,{error_detail:'查询详情'},'query-id'));
    await planning.refreshJob();
    vi.spyOn(previewService,'comparePlanningPlans').mockRejectedValueOnce(new ApiError('对比失败',3001,{suggestions:['对比建议']},'compare-id'));
    await planning.compare(['P-1','P-2']);
    expect(planning.queryFeedback).toMatchObject({operation:'job',message:'查询离线',data:{error_detail:'查询详情'}});
    expect(planning.feedback).toMatchObject({operation:'compare',message:'对比失败',data:{suggestions:['对比建议']}});
    expect(planning.businessDetails).toEqual({suggestions:['对比建议']});
    vi.mocked(previewService.getPlanningTask).mockResolvedValueOnce(apiJob());await planning.refreshJob();
    expect(planning.queryError).toBe('');expect(planning.queryFeedback).toBeNull();expect(planning.error).toBe('对比失败');
  });
  it('新写入使更早读取失败失效，不覆盖写入摘要及载荷',async()=>{
    const {planning}=await setup();let reject!:(error:unknown)=>void;
    vi.mocked(previewService.queryPlanningPlans).mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));
    const old=planning.loadPlans();
    vi.spyOn(previewService,'submitPlanningTask').mockRejectedValueOnce(new ApiError('频率不足',3002,{gap:{shortage:0}},'write-id'));
    await planning.submit();reject(new ApiError('旧列表失败',2003,{error_detail:'旧详情'}));await old;
    expect(planning.feedback).toMatchObject({operation:'submit',message:'频率不足',requestId:'write-id',data:{gap:{shortage:0}}});
  });
  it('取消明确失败不解除原查询中断，也不恢复自动轮询',async()=>{
    const {planning,task}=await setup();vi.useFakeTimers();planning.job={...apiJob(),state:'RUNNING',result:null};
    const query=vi.spyOn(previewService,'getPlanningTask').mockRejectedValue(new ApiError('查询离线',2003,{error_detail:'原查询详情'}));
    planning.start();await vi.advanceTimersByTimeAsync(0);expect(planning.queryError).toBe('查询离线');
    vi.spyOn(previewService,'cancelPlanningTask').mockRejectedValue(new ApiError('不能取消',3001,{suggestions:['稍后核实']}));
    const cancel=planning.cancel();task.answer('save');await cancel;await vi.advanceTimersByTimeAsync(10000);
    expect(query).toHaveBeenCalledTimes(1);expect(planning.queryError).toBe('查询离线');expect(planning.feedback).toMatchObject({operation:'cancel',message:'不能取消'});
  });
  it('后来发生的查询失败不会让兼容详情拼到较早的通用错误摘要',async()=>{
    const {planning}=await setup();planning.job=apiJob();
    vi.mocked(previewService.queryPlanningPlans).mockRejectedValue(new ApiError('列表失败',3001,{suggestions:['列表建议']}));await planning.loadPlans();
    vi.spyOn(previewService,'getPlanningTask').mockRejectedValue(new ApiError('查询失败',2003,{error_detail:'作业详情'}));await planning.refreshJob();
    expect(planning.error).toBe('列表失败');expect(planning.businessDetails).toEqual({suggestions:['列表建议']});expect(planning.queryFeedback?.data).toEqual({error_detail:'作业详情'});
  });
  it('被同操作替代的读取和取消后的读取均不能写回失败',async()=>{
    const {planning}=await setup();let reject!:(error:unknown)=>void;
    vi.mocked(previewService.queryPlanningPlans).mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));
    const old=planning.loadPlans();await planning.loadPlans();reject(new ApiError('已取消列表',3001,{suggestions:['过期']}));await old;
    expect(planning.feedback).toBeNull();
    vi.mocked(previewService.queryPlanningPlans).mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));
    const stopped=planning.loadPlans();planning.stop();reject(new ApiError('页面已停止',3001,{suggestions:['过期']}));await stopped;
    expect(planning.feedback).toBeNull();
  });
  it.each(['task','session','permission'] as const)('%s 改变后迟到失败不进入当前反馈',async boundary=>{
    const {planning,task,auth}=await setup();let reject!:(error:unknown)=>void;
    vi.mocked(previewService.queryPlanningPlans).mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));
    const old=planning.loadPlans();
    if(boundary==='task')task.taskId='T2';
    else if(boundary==='session')auth.accept({...auth.identity!,sessionId:'another'});
    else auth.accept({...auth.identity!,permissions:[]});
    reject(new ApiError('过期失败',3001,{suggestions:['旧数据']}));await old;expect(planning.feedback).toBeNull();expect(planning.businessDetails).toBeNull();
  });
  it('任务与会话重置清理已知详情，换任务不会保留错误摘要',async()=>{
    const {planning,task}=await setup();vi.mocked(previewService.queryPlanningPlans).mockRejectedValue(new ApiError('列表失败',3001,false));
    await planning.loadPlans();expect(planning.businessDetails).toBe(false);task.taskId='T2';await nextTick();expect(planning.feedback).toBeNull();
    await planning.loadPlans();expect(planning.error).toBe('列表失败');planning.clearForSession();expect(planning.error).toBe('');expect(planning.businessDetails).toBeNull();
  });
  it('本地前置条件及路由提示均解除旧服务错误载荷',async()=>{
    const {planning,task}=await setup();vi.spyOn(previewService,'submitPlanningTask').mockRejectedValue(new ApiError('不可行',3001,{suggestions:['旧建议']},'old-id'));
    await planning.submit();task.draft!.name='尚未保存';await planning.submit();
    expect(planning.feedback).toMatchObject({operation:'local'});expect(planning.businessDetails).toBeNull();expect(planning.feedback?.requestId).toBeUndefined();
    planning.localError('定位参数无效','route');expect(planning.feedback).toMatchObject({operation:'route',message:'定位参数无效'});expect(planning.feedback?.data).toBeUndefined();
  });
  it('本地提示不解除尚未恢复的作业查询中断及保存限制',async()=>{
    const {planning,task}=await setup();planning.job=apiJob();
    vi.spyOn(previewService,'getPlanningTask').mockRejectedValue(new ApiError('状态查询失败',2003,{error_detail:'查询详情'}));
    await planning.refreshJob();expect(planning.canSave).toBe(false);
    task.draft!.name='尚未保存';await planning.submit();
    expect(planning.queryError).toBe('状态查询失败');expect(planning.canSave).toBe(false);expect(planning.feedback?.operation).toBe('local');expect(planning.feedback?.data).toBeUndefined();expect(planning.businessDetails).toBeNull();
    planning.localError('定位参数无效','route');expect(planning.queryError).toBe('状态查询失败');expect(planning.canSave).toBe(false);expect(planning.feedback?.data).toBeUndefined();
  });
  it('成功调整条件后清理详情，未获离开许可时保留原反馈',async()=>{
    const {planning,task}=await setup();planning.selectedPlan=apiPlan();
    vi.spyOn(previewService,'comparePlanningPlans').mockRejectedValue(new ApiError('对比失败',3001,{suggestions:['旧建议']}));await planning.compare(['P-1','P-2']);
    task.draft!.name='修改中';const refused=planning.adjust();task.answer('cancel');await refused;expect(planning.businessDetails).toEqual({suggestions:['旧建议']});
    task.draft!.name=task.saved!.input.name;await planning.adjust();expect(planning.step).toBe(1);expect(planning.feedback).toBeNull();expect(planning.businessDetails).toBeNull();
  });
  it.each(['SUCCEEDED','FAILED','NOT_FOUND'] as const)('原请求核实为 %s 时移除不确定写入的旧详情',async state=>{
    const {planning}=await setup();planning.job=apiJob();
    vi.spyOn(previewService,'savePlanningPlan').mockRejectedValue(new ApiError('超时','REQUEST_TIMEOUT',{error_detail:'写入详情'},'save-response'));
    await planning.savePlan('版本','');expect(planning.pending).not.toBeNull();
    vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...planning.pending!,state,entityId:state==='SUCCEEDED'?'P-1':null,message:state==='SUCCEEDED'?'已保存':'原请求未成功'});
    vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(apiPlan());await planning.reconcile();
    expect(planning.pending).toBeNull();expect(planning.businessDetails).toBeNull();
    if(state==='SUCCEEDED')expect(planning.feedback).toBeNull();else expect(planning.feedback).toMatchObject({operation:'receipt',message:'原请求未成功'});
  });
  it('写入期间失权的待核对提示在恢复权限并核实成功后清除',async()=>{
    const {planning,auth}=await setup(),identity={...auth.identity!};
    vi.spyOn(previewService,'submitPlanningTask').mockImplementationOnce(async()=>{auth.accept({...identity,permissions:[]});planning.stop();return apiJob();});
    await planning.submit();expect(planning.feedback?.operation).toBe('submit');auth.accept(identity);
    await planning.submit();expect(planning.feedback?.operation).toBe('submit');expect(planning.feedback?.data).toBeUndefined();
    vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...planning.pending!,state:'SUCCEEDED',entityId:'J1',message:'已成功'});
    vi.spyOn(previewService,'getPlanningTask').mockResolvedValue(apiJob());await planning.reconcile();
    expect(planning.pending).toBeNull();expect(planning.error).toBe('');expect(planning.feedback).toBeNull();
  });
  it('退出后迟到的写入失败不恢复反馈或旧会话待核对请求',async()=>{
    const {planning}=await setup();let reject!:(error:unknown)=>void;
    vi.spyOn(previewService,'submitPlanningTask').mockImplementationOnce(()=>new Promise((_resolve,r)=>reject=r));
    const old=planning.submit();planning.clearForSession();reject(new ApiError('过期超时','REQUEST_TIMEOUT',{suggestions:['旧会话']}));await old;
    expect(planning.feedback).toBeNull();expect(planning.pending).toBeNull();
  });
});
