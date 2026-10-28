import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import GisTaskPlanVersions from '../src/components/GisTaskPlanVersions.vue';
import type { PlanningApiServices, PlanningPlanSummary } from '../src/types/planning-api';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

await clientTemplate(GisTaskPlanVersions, 'src/components/GisTaskPlanVersions.vue', 'task-plan-render.ts');
let app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.restoreAllMocks(); });
async function settle() { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick(); } }
function row(n: number, taskId = 'T1'): PlanningPlanSummary {
  return { id: `${taskId}-P${n}`, taskId, name: '方案1', version: `V${n}`, state: n === 3 ? 'CONFIRMED' : 'SAVED',
    current: n === 3, sourceChanged: n === 1, savedAt: '2026-10-28T08:00:00Z' };
}
function setup(query?: PlanningApiServices['queryPlanningPlanSummaries'], readable = true) {
  const queryPlans = vi.fn<PlanningApiServices['queryPlanningPlanSummaries']>(query ?? (async input => ({
    items: [row(3, input.taskId), row(2, input.taskId), row(1, input.taskId)], total: 3, pageNum: input.pageNum, pageSize: input.pageSize,
  })));
  const open = vi.fn(), props = reactive({ taskId: 'T1', readable, sessionGeneration: 1, queryPlans });
  const root = node('root');
  app = renderer.createApp({ render: () => h(GisTaskPlanVersions, { ...props, onOpenPlan: open }) });
  app.provide(ssrContextKey, {}); app.mount(root);
  return { root, props, open, queryPlans };
}
async function choose(root: HostNode, id: string) {
  (find(root, n => n.tag === 'select')!.props.onChange as Function)({ target: { value: id } }); await settle();
}
async function click(root: HostNode, label: string) {
  const button = find(root, n => n.tag === 'button' && textOf(n).trim() === label)!;
  expect(button, label).toBeDefined(); expect(button.props.disabled).toBe(false);
  await (button.props.onClick as Function)(); await settle();
}

describe('GIS任务关联已保存方案版本', () => {
  it('同名V1/V2/V3分别显示，不自动选择，不把任务输入版本作为方案版本', async () => {
    const f = setup(); await settle();
    expect(f.queryPlans).toHaveBeenCalledWith(expect.objectContaining({ context: 'planning', taskId: 'T1', pageNum: 1, pageSize: 10 }));
    expect(all(f.root, n => n.tag === 'option').map(textOf)).toEqual([
      '请选择方案版本', '方案1 · V3 · 已确认（当前方案）', '方案1 · V2 · 已保存', '方案1 · V1 · 已保存',
    ]);
    expect(f.open).not.toHaveBeenCalled();
    expect(find(f.root, n => n.tag === 'button' && textOf(n) === '查看方案完整网络')!.props.disabled).toBe(true);
  });
  it('选择旧版本保留来源变化提示，只传所选taskId和planId打开完整网络', async () => {
    const f = setup(); await settle(); await choose(f.root, 'T1-P1');
    expect(textOf(f.root)).toContain('来源已变化'); expect(textOf(f.root)).toContain('保存时间：2026-10-28T08:00:00Z');
    await click(f.root, '查看方案完整网络'); expect(f.open).toHaveBeenCalledExactlyOnceWith({ taskId: 'T1', planId: 'T1-P1' });
    expect(f.queryPlans).toHaveBeenCalledOnce();
  });
  it('超过10版提供分页，不只展示最新页，也不沿用上页选择', async () => {
    const f = setup(async q => ({ items: q.pageNum === 1 ? [row(11)] : [row(1)], total: 11, pageNum: q.pageNum, pageSize: q.pageSize }));
    await settle(); await choose(f.root, 'T1-P11'); await click(f.root, '下一页方案');
    expect(textOf(f.root)).toContain('11 个版本 · 第 2 页');
    expect(f.queryPlans).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: 'T1', pageNum: 2 }));
    expect(find(f.root, n => n.tag === 'button' && textOf(n) === '查看方案完整网络')!.props.disabled).toBe(true);
    await click(f.root, '上一页方案'); expect(textOf(f.root)).toContain('V11');
  });
  it('空方案与读取失败分开；失败后能显式重试', async () => {
    const f = setup(async q => ({ items: [], total: 0, pageNum: q.pageNum, pageSize: q.pageSize })); await settle();
    expect(textOf(f.root)).toContain('尚未保存规划方案');
    f.queryPlans.mockRejectedValueOnce(new Error('网络中断')); await click(f.root, '刷新版本');
    expect(textOf(f.root)).toContain('网络中断'); expect(textOf(f.root)).not.toContain('尚未保存规划方案');
    await click(f.root, '刷新版本'); expect(textOf(f.root)).toContain('尚未保存规划方案');
  });
  it('任务切换取消旧请求，即使旧响应晚到也不串入新任务', async () => {
    let finish!: (v: Awaited<ReturnType<PlanningApiServices['queryPlanningPlanSummaries']>>) => void;
    const f = setup(q => q.taskId === 'T1' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({
      items: [row(1, q.taskId)], total: 1, pageNum: q.pageNum, pageSize: q.pageSize,
    }));
    const signal = f.queryPlans.mock.calls[0]![0].signal;
    f.props.taskId = 'T2'; await settle(); expect(signal!.aborted).toBe(true);
    finish({ items: [row(3)], total: 3, pageNum: 1, pageSize: 10 }); await settle();
    await choose(f.root, 'T2-P1'); await click(f.root, '查看方案完整网络');
    expect(f.open).toHaveBeenCalledWith({ taskId: 'T2', planId: 'T2-P1' }); expect(textOf(f.root)).not.toContain('V3');
  });
  it('没有权限时不请求，权限撤回后清空旧选择，恢复权限重新读目录', async () => {
    const f = setup(undefined, false); await settle(); expect(f.queryPlans).not.toHaveBeenCalled();
    f.props.readable = true; await settle(); await choose(f.root, 'T1-P3');
    f.props.readable = false; await settle(); expect(textOf(f.root)).not.toContain('V3');
    expect(textOf(f.root)).toContain('没有方案查看权限'); expect(f.open).not.toHaveBeenCalled();
    f.props.readable = true; f.props.sessionGeneration++; await settle(); expect(f.queryPlans).toHaveBeenCalledTimes(2);
  });
  it.each(['foreign', 'duplicate', 'page'])('错误目录拒绝展示：%s', async kind => {
    const f = setup(async q => ({ items: kind === 'foreign' ? [row(1, 'OTHER')] : kind === 'duplicate' ? [row(1), row(1)] : [row(1)],
      total: 2, pageNum: kind === 'page' ? 2 : q.pageNum, pageSize: q.pageSize }));
    await settle(); expect(textOf(f.root)).toContain('身份或分页不一致'); expect(all(f.root, n => n.tag === 'option')).toHaveLength(1);
  });
  it('卸载取消在途目录，不触发打开或自动轮询', async () => {
    const f = setup(() => new Promise(() => {})); const signal = f.queryPlans.mock.calls[0]![0].signal;
    app!.unmount(); app = undefined; await settle(); expect(signal!.aborted).toBe(true); expect(f.queryPlans).toHaveBeenCalledOnce(); expect(f.open).not.toHaveBeenCalled();
  });
});
