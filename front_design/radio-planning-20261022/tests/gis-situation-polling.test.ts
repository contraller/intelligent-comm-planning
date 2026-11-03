import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGisSituation, gisExampleFrame, type GisSituationServices } from '../src/composables/useGisSituation';
import type { PlanningPlanSummary } from '../src/types/planning-api';
import type { ResourceReadWorkspace, ReadInterference } from '../src/types/resource-read';
import type { GisNetwork, GisPlanSurface } from '../src/types/gis-plan';

function row(id: string): PlanningPlanSummary {
  return { id, taskId: 'T1', name: '已转正 '+id, version: 'V1', state: 'CONFIRMED', current: true, sourceChanged: false, savedAt: '2026-11-03T08:00:00+08:00' };
}
function network(id: string): GisNetwork {
  const original = gisExampleFrame().network;
  return { ...original, identity: { ...original.identity, task_id: 'T1', plan_id: id, snapshot_id: 'SNAP-'+id, state: 'CONFIRMED' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function settle() { for (let i=0;i<12;i++) await Promise.resolve(); }
function fixture() {
  let revision = 'resource-one';
  const sources = (count=1): ReadInterference[] => Array.from({ length: count }, (_, index) => ({ ...gisExampleFrame().interferences[0]!, id: 'LIVE-'+index, name: '已保存干扰源 '+index, origin: 'MANUAL', kind: 'interference' }));
  const context = (): ResourceReadWorkspace => ({ revision, source: '本轮已保存资源', updatedAt: '2026-11-03T08:00:00Z', bounds: [113,36,115,38],
    stats: { nodes:132,devices:414,models:16,interferences:1,hf:174,vuhf:240,alerts:null,unknownAlerts:null,active:414,offShelf:0,unknownAvailability:0 } });
  const terrain = vi.fn(async () => ({ url: 'blob:'+Math.random(), extent: gisExampleFrame().terrain.bounds, source: '受控DEM', dispose: vi.fn() }));
  const services: GisSituationServices = {
    queryPlans: vi.fn(async input => ({ items: [], total: 0, pageNum: input.pageNum, pageSize: input.pageSize })),
    plans: { getNetwork: vi.fn(async input => network(input.planId)), getSurface: vi.fn(async (_input, net): Promise<GisPlanSurface> => ({ identity: net.identity,
      terrain: gisExampleFrame().terrain, terrain_notice: '', coverage: null, coverage_notice: '' })) }, terrain,
    resources: { loadResourceReadContext: vi.fn(async () => context()), queryResourceInterferences: vi.fn(async input => ({ revision: input.revision,
      items: sources(), total:1,pageNum:input.pageNum,pageSize:input.pageSize })) },
  };
  return { model:createGisSituation(services), services, context, sources, setRevision: (value:string) => { revision=value; } };
}
afterEach(() => vi.useRealTimers());

describe('首页30秒自动跟随与独立已保存干扰源', () => {
  it('初始示例立即可见；30秒后仅GET服务检查，无已转正方案仍保留示例与冻结网络', async () => {
    vi.useFakeTimers(); const e=fixture(), before=e.model.frame.value, frozen=before.network.interferences;
    e.model.startAutoRefresh(); await vi.advanceTimersByTimeAsync(29_999);
    expect(e.services.queryPlans).not.toHaveBeenCalled(); expect(e.model.frame.value).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.services.queryPlans).toHaveBeenCalledWith(expect.objectContaining({ state:'CONFIRMED',context:'gis' }));
    expect(e.model.frame.value).toBe(before); expect(e.model.frame.value.network.interferences).toBe(frozen);
    expect(e.model.interferences.value[0]?.id).toBe('LIVE-0'); expect(e.model.liveInterferences.value?.revision).toBe('resource-one');
    expect(e.model.interferenceSourceLabel.value).toContain('最新已保存资源 resource-one'); expect(e.model.interferenceSourceLabel.value).toContain('未随干扰源重算');
    expect(e.model.notice.value).toBe('');
    expect(e.services.plans.getNetwork).not.toHaveBeenCalled(); e.model.stop();
  });
  it('只在已提交资源版本变化后取全量分页，未保存草稿不作为输入，同版不反复读全列表', async () => {
    vi.useFakeTimers(); const e=fixture(); e.model.startAutoRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(e.services.resources!.loadResourceReadContext).toHaveBeenCalledTimes(2);
    expect(e.services.resources!.queryResourceInterferences).toHaveBeenCalledOnce();
    e.setRevision('resource-two');
    vi.mocked(e.services.resources!.queryResourceInterferences).mockImplementation(async input => ({ revision: input.revision, items:e.sources(55).slice((input.pageNum-1)*50,input.pageNum*50),
      total:55,pageNum:input.pageNum,pageSize:input.pageSize }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.model.liveInterferences.value?.revision).toBe('resource-two'); expect(e.model.interferences.value).toHaveLength(55);
    expect(e.services.resources!.queryResourceInterferences).toHaveBeenCalledTimes(3);
    expect(e.services.resources!.queryResourceInterferences).toHaveBeenLastCalledWith(expect.objectContaining({ context:'gis',revision:'resource-two',pageNum:2,pageSize:50 })); e.model.stop();
  });
  it('同一已转正帧只做目录/资源检查，不重载DEM或重置覆盖选择、表达与链路开关', async () => {
    vi.useFakeTimers(); const e=fixture();
    vi.mocked(e.services.queryPlans).mockImplementation(async input => ({ items:[row('P1')],total:1,pageNum:input.pageNum,pageSize:input.pageSize }));
    e.services.getCoverage=vi.fn(async query => ({ ...gisExampleFrame().coverage!, anchor:{ ...gisExampleFrame().coverage!.anchor,plan_id:query.planId,task_id:query.taskId,snapshot_id:query.snapshotId } }));
    await e.model.refreshLatest(); const before=e.model.frame.value;
    e.model.selectedDeviceId.value=before.coverage!.result!.devices[0]!.device_id;
    e.model.showCoverage.value=true; e.model.coverageDisplay.value='field'; e.model.showLinks.value=false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(e.model.frame.value).toBe(before); expect(e.services.plans.getNetwork).toHaveBeenCalledOnce(); expect(e.services.terrain).toHaveBeenCalledOnce();
    expect(e.model.selectedDeviceId.value).toBe(before.coverage!.result!.devices[0]!.device_id); expect(e.model.showCoverage.value).toBe(true);
    expect(e.model.coverageDisplay.value).toBe('field'); expect(e.model.showLinks.value).toBe(false); e.model.stop();
  });
  it('最新转正方案改变时发布新冻结帧，仍保留新帧可用的设备覆盖选择与图层偏好', async () => {
    vi.useFakeTimers(); const e=fixture(); let latest='P1';
    vi.mocked(e.services.queryPlans).mockImplementation(async input => ({ items:[row(latest)],total:1,pageNum:input.pageNum,pageSize:input.pageSize }));
    e.services.getCoverage=vi.fn(async query => ({ ...gisExampleFrame().coverage!, anchor:{ ...gisExampleFrame().coverage!.anchor,plan_id:query.planId,task_id:query.taskId,snapshot_id:query.snapshotId } }));
    await e.model.refreshLatest(); const selected=e.model.frame.value.coverage!.result!.devices[0]!.device_id;
    e.model.selectedDeviceId.value=selected; e.model.showCoverage.value=true; e.model.coverageDisplay.value='boundary'; e.model.showLinks.value=false;
    latest='P2'; await vi.advanceTimersByTimeAsync(30_000);
    expect(e.model.frame.value.network.identity.plan_id).toBe('P2'); expect(e.model.coverage.value?.deviceId).toBe(selected);
    expect(e.model.showCoverage.value).toBe(true); expect(e.model.coverageDisplay.value).toBe('boundary'); expect(e.model.showLinks.value).toBe(false); e.model.stop();
  });
  it('资源读取失败保留原网络与干扰源；恢复后的下个周期才发布新版本', async () => {
    vi.useFakeTimers(); const e=fixture(); await e.model.refreshLatest(); const before=e.model.frame.value, sources=e.model.interferences.value;
    e.setRevision('resource-two'); vi.mocked(e.services.resources!.queryResourceInterferences).mockRejectedValueOnce(new Error('资源GET失败'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.model.frame.value).toBe(before); expect(e.model.interferences.value).toBe(sources); expect(e.model.error.value).toContain('当前态势已保留');
    await vi.advanceTimersByTimeAsync(30_000); expect(e.model.liveInterferences.value?.revision).toBe('resource-two'); expect(e.model.error.value).toBe(''); e.model.stop();
  });
  it('只有干扰源版本改变时不替换冻结帧，也不清除正在显示的设备覆盖', async () => {
    vi.useFakeTimers(); const e=fixture(); await e.model.refreshLatest(); const before=e.model.frame.value;
    const selected=before.coverage!.result!.devices[0]!.device_id;
    e.model.selectedDeviceId.value=selected; e.model.showCoverage.value=true; e.model.coverageDisplay.value='boundary';
    e.setRevision('resource-two'); await vi.advanceTimersByTimeAsync(30_000);
    expect(e.model.frame.value).toBe(before); expect(e.model.frame.value.network).toBe(before.network);
    expect(e.model.selectedDeviceId.value).toBe(selected); expect(e.model.showCoverage.value).toBe(true); expect(e.model.coverageDisplay.value).toBe('boundary');
    expect(e.model.liveInterferences.value?.revision).toBe('resource-two'); e.model.stop();
  });
  it('新方案读取失败时，不单独发布已取得的新干扰源版本', async () => {
    vi.useFakeTimers(); const e=fixture(); await e.model.refreshLatest(); const before=e.model.frame.value, sources=e.model.interferences.value;
    e.setRevision('resource-two'); vi.mocked(e.services.queryPlans).mockResolvedValue({ items:[row('P2')],total:1,pageNum:1,pageSize:20 });
    vi.mocked(e.services.plans.getNetwork).mockRejectedValueOnce(new Error('新冻结帧读取失败'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.model.frame.value).toBe(before); expect(e.model.interferences.value).toBe(sources); expect(e.model.liveInterferences.value?.revision).toBe('resource-one'); e.model.stop();
  });
  it.each(['cross-version','duplicate','unknown-origin'])('拒绝%s资料，保留上一成功干扰源与地图', async failure => {
    vi.useFakeTimers(); const e=fixture(); await e.model.refreshLatest(); const before=e.model.frame.value, sources=e.model.interferences.value;
    e.setRevision('resource-two');
    vi.mocked(e.services.resources!.queryResourceInterferences).mockImplementation(async input => ({ revision:failure==='cross-version'?'other-revision':input.revision,
      items:failure==='duplicate'?[e.sources()[0]!,e.sources()[0]!]:failure==='unknown-origin'?[{...e.sources()[0]!,origin:null}]:e.sources(),
      total:failure==='duplicate'?2:1,pageNum:input.pageNum,pageSize:input.pageSize }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(e.model.frame.value).toBe(before); expect(e.model.interferences.value).toBe(sources); expect(e.model.error.value).toContain('当前态势已保留'); e.model.stop();
  });
  it('手选历史方案暂停跟随，只显示该方案冻结干扰源，旧自动目录晚到不能换走历史', async () => {
    vi.useFakeTimers(); const e=fixture(), pending=deferred<Awaited<ReturnType<GisSituationServices['queryPlans']>>>();
    vi.mocked(e.services.queryPlans).mockReturnValueOnce(pending.promise);
    e.model.startAutoRefresh(); await vi.advanceTimersByTimeAsync(30_000);
    const signal=vi.mocked(e.services.queryPlans).mock.calls[0]![0].signal!;
    await e.model.openPlan(row('HISTORY')); expect(e.model.autoFollow.value).toBe(false); expect(signal.aborted).toBe(true);
    pending.resolve({ items:[row('LATE')],total:1,pageNum:1,pageSize:20 }); await settle();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(e.model.frame.value.network.identity.plan_id).toBe('HISTORY'); expect(e.model.displayingLiveInterferences.value).toBe(false);
    expect(e.model.interferences.value).toBe(e.model.frame.value.interferences); expect(e.services.queryPlans).toHaveBeenCalledOnce();
    vi.mocked(e.services.queryPlans).mockResolvedValue({ items:[row('LATEST')],total:1,pageNum:1,pageSize:20 });
    e.model.setAutoFollow(true); await settle();
    expect(e.model.frame.value.network.identity.plan_id).toBe('LATEST'); expect(e.model.autoFollow.value).toBe(true); expect(e.model.displayingLiveInterferences.value).toBe(true); e.model.stop();
  });
  it('离开后取消当前资源读取，忽略迟到响应且清空计时器', async () => {
    vi.useFakeTimers(); const e=fixture(), pending=deferred<ResourceReadWorkspace>();
    vi.mocked(e.services.resources!.loadResourceReadContext).mockReturnValueOnce(pending.promise);
    e.model.startAutoRefresh(); await vi.advanceTimersByTimeAsync(30_000); const before=e.model.frame.value;
    const signal=vi.mocked(e.services.resources!.loadResourceReadContext).mock.calls[0]![0].signal!;
    e.model.stop(); expect(signal.aborted).toBe(true); pending.resolve(e.context()); await settle(); await vi.advanceTimersByTimeAsync(90_000);
    expect(e.model.frame.value).toBe(before); expect(e.model.liveInterferences.value).toBeNull(); expect(e.services.queryPlans).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
