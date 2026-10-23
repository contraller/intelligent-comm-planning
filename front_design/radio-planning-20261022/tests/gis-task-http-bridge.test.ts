import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { saveTaskForGis } from '../src/services/gis-task-edit-entry';
import type { ApiTask } from '../src/types/task-api';
function fixture() {
  const saved: Pick<ApiTask, 'taskId' | 'revision' | 'resourceRevision'> = {
    taskId: 'T',
    revision: 'task-r2',
    resourceRevision: 'R',
  };
  const task = { taskId: 'T', saved: saved as typeof saved | null, save: vi.fn(async () => true) };
  return { task, current: vi.fn(() => true) };
}

// 保存服务桩与静态装配门禁；真实TaskApi/同源页面验收另行登记。
describe('GIS任务编辑与独立资源保存', () => {
  it('只在真实保存已接受后返回同任务/资源版本，不写任何资源', async () => {
    const f = fixture();
    expect(await saveTaskForGis(f.task, f.current)).toEqual({
      taskId: 'T',
      revision: 'task-r2',
      resourceRevision: 'R',
    });
    expect(f.task.save).toHaveBeenCalledTimes(1);
  });
  it('保存被拒绝时保持在编辑现场，不生成返回身份', async () => {
    const f = fixture();
    f.task.save.mockResolvedValue(false);
    expect(await saveTaskForGis(f.task, f.current)).toBeNull();
  });
  it.each(['task', 'saved', 'missing', 'revision'] as const)(
    '返回前%s身份核实失败时不冒充保存成功',
    async (mode) => {
      const f = fixture();
      f.task.save.mockImplementationOnce(async () => {
        if (mode === 'task') f.task.taskId = 'OTHER';
        if (mode === 'saved') f.task.saved!.taskId = 'OTHER';
        if (mode === 'missing') f.task.saved = null;
        if (mode === 'revision') f.task.saved!.revision = '';
        return true;
      });
      expect(await saveTaskForGis(f.task, f.current)).toBeNull();
    },
  );
  it('没有来源身份不调用保存，等待期间换身份/离页不继续导航', async () => {
    const f = fixture();
    f.current.mockReturnValueOnce(false);
    expect(await saveTaskForGis(f.task, f.current)).toBeNull();
    expect(f.task.save).not.toHaveBeenCalled();
    let resolve!: (value: boolean) => void;
    f.task.save.mockImplementationOnce(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const done = saveTaskForGis(f.task, f.current);
    f.current.mockReturnValue(false);
    resolve(true);
    expect(await done).toBeNull();
  });
  it('保存异常交由页面显示，不伪造成功回执', async () => {
    const f = fixture();
    f.task.save.mockRejectedValueOnce(new Error('资源版本冲突'));
    await expect(saveTaskForGis(f.task, f.current)).rejects.toThrow('资源版本冲突');
  });
  it('GIS资源与任务使用两条独立真实路径，不再调用旧联合保存', () => {
    const workspace = readFileSync(
      new URL('../src/stores/gis-workspace.ts', import.meta.url),
      'utf8',
    );
    const selection = readFileSync(
      new URL('../src/composables/useGisTaskSelection.ts', import.meta.url),
      'utf8',
    );
    const view = readFileSync(new URL('../src/views/PlanningApiView.vue', import.meta.url), 'utf8');
    expect(workspace).toContain('resources.workspace.edit');
    expect(workspace).toContain('previewService.saveResourceChanges(');
    expect(workspace).not.toContain('commitGisWorkspace(');
    expect(workspace).not.toContain('saveTask(');
    expect(selection).toContain('previewService.queryTaskSummaries(');
    expect(selection).toContain('previewService.getTaskInput(');
    expect(selection).toContain("env.mode !== 'http'");
    expect(selection).not.toContain('loadTaskWorkspace(');
    expect(view).toContain('saveTaskForGis(task, current)');
    expect(view).toContain("path: '/situation', query: { taskId: saved.taskId }");
    expect(view).toContain('保存任务并返回 GIS');
  });
});
