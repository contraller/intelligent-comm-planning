import { describe, expect, it, vi } from 'vitest';
import { verifyPlanningInterferenceEntry } from '../src/services/planning-interference-entry';
import type { RunProgress, WorkbenchContext } from '../src/types/interference-workbench';

function fixture() {
  const target = { taskId: 'T', planId: 'P', planVersion: 'V3' };
  const context: WorkbenchContext = {
    task_id: 'T',
    resource_revision: 'R',
    scene_count: 0,
    run_count: 0,
    active_run_ids: [],
    data_origin: 'SYNTHETIC_INTEGRATION',
    interference_sources: [],
    source_options: [
      {
        task_id: 'T',
        plan_id: 'P',
        plan_version: 'V3',
        input_version: 'I',
        condition_version: 'C',
        resource_revision: 'R',
        source: 'SR4',
        data_origin: 'SYNTHETIC_INTEGRATION',
        name: '方案',
        plan_snapshot_id: 'S',
        current: true,
        eligible: true,
        unavailable_reasons: [],
      },
    ],
    capabilities: {
      scene_save: { enabled: true, reasons: [] },
      analyze: { enabled: true, reasons: [] },
      cancel: { enabled: true, reasons: [] },
      preview: { enabled: true, reasons: [] },
      adopt_replan: { enabled: true, reasons: [] },
    },
  };
  const progress: RunProgress = {
    run_id: 'RUN',
    task_id: 'T',
    scene_id: 'SC',
    scene_version_id: 'SCV',
    plan_id: 'P',
    plan_version: 'V3',
    resource_revision: 'R',
    run_version: 1,
    state: 'RUNNING',
    progress: 10,
    phase: 'ANALYZE',
    cancel_requested: false,
    error: null,
    source_hash: 'hash',
    source_state: { state: 'CURRENT', reasons: [] },
    data_origin: 'SYNTHETIC_INTEGRATION',
    started_at: '',
    updated_at: '',
  };
  const services = {
    getContext: vi.fn(async () => context),
    getProgress: vi.fn(async () => progress),
  };
  return { target, context, progress, services, controller: new AbortController() };
}

// 服务桩验证入口的只读契约与迟到保护，不替代真实HTTP/浏览器验收。
describe('规划到新版干扰工作流入口', () => {
  it('指定任务/方案/版本核验通过，不提交任何分析', async () => {
    const f = fixture();
    expect(await verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal)).toBe(
      true,
    );
    expect(f.services.getContext).toHaveBeenCalledWith({ task_id: 'T' }, f.controller.signal);
    expect(f.services.getProgress).not.toHaveBeenCalled();
  });
  it.each(['version', 'plan', 'task', 'ineligible'] as const)(
    '拒绝%s错误，不替换成其他确认方案',
    async (mode) => {
      const f = fixture();
      if (mode === 'version') f.context.source_options[0].plan_version = 'V4';
      if (mode === 'plan') f.context.source_options[0].plan_id = 'OTHER';
      if (mode === 'task') f.context.task_id = 'OTHER';
      if (mode === 'ineligible') {
        f.context.source_options[0].eligible = false;
        f.context.source_options[0].unavailable_reasons = ['来源已变化'];
      }
      await expect(
        verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal),
      ).rejects.toThrow();
      expect(f.services.getProgress).not.toHaveBeenCalled();
    },
  );
  it('同一方案运行可进入，取消待确认的其他版本也须阻止切入', async () => {
    const f = fixture();
    f.context.active_run_ids = ['RUN'];
    expect(await verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal)).toBe(
      true,
    );
    expect(f.services.getProgress).toHaveBeenCalledWith(
      { task_id: 'T', run_id: 'RUN' },
      f.controller.signal,
    );
    f.progress.plan_version = 'V2';
    f.progress.state = 'CANCEL_REQUESTED';
    await expect(
      verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal),
    ).rejects.toThrow('其他方案');
  });
  it('活动分析身份错误和请求失败均传播，不静默跳转', async () => {
    const f = fixture();
    f.context.active_run_ids = ['RUN'];
    f.progress.task_id = 'OTHER';
    await expect(
      verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal),
    ).rejects.toThrow('身份');
    f.services.getContext.mockRejectedValueOnce(new Error('权限失效'));
    await expect(
      verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal),
    ).rejects.toThrow('权限失效');
  });
  it('等待中切换输入不会改变原入口，取消后晚响应不继续', async () => {
    const f = fixture();
    let resolve!: (value: WorkbenchContext) => void;
    f.services.getContext.mockImplementationOnce(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const done = verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal);
    f.target.planId = 'OTHER';
    resolve(f.context);
    expect(await done).toBe(true);
    f.controller.abort();
    expect(await verifyPlanningInterferenceEntry(f.services, f.target, f.controller.signal)).toBe(
      false,
    );
    expect(f.services.getProgress).not.toHaveBeenCalled();
  });
});
