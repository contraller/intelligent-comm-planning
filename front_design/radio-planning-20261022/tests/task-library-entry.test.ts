import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePinia } from 'pinia';
import { storeFixture } from './fixtures/planning-api';
import { previewService } from '../src/services';

let fixture: Awaited<ReturnType<typeof storeFixture>> | undefined;
afterEach(() => { if (fixture) { fixture.task.clearForSession();disposePinia(fixture.pinia);fixture = undefined; }vi.restoreAllMocks(); });
describe('已保存任务入口', () => {
  it('实际抽屉包含整行选择和停止冒泡的打开按钮', () => {
    const source = readFileSync('src/components/TaskApiLibraryDrawer.vue', 'utf8');
    expect(source).toContain('@select="open($event.taskId)"');
    expect(source).toContain('@click.stop="open(row.taskId)"');
    expect(source).toContain('width="900px"');
  });
  it('成功打开给出已加载反馈，进行中操作明确拒绝', async () => {
    fixture = await storeFixture();const { task } = fixture;
    expect(await task.open('T1')).toBe(true);expect(task.notice).toContain('已打开任务');
    const count = vi.mocked(previewService.getTaskInput).mock.calls.length;task.running = true;
    expect(await task.open('T2')).toBe(false);expect(task.error).toContain('当前操作尚未结束');
    expect(previewService.getTaskInput).toHaveBeenCalledTimes(count);
  });
  it('取消放弃草稿时不读取新任务且保留编辑内容', async () => {
    fixture = await storeFixture();const { task } = fixture;task.draft!.name = '未保存草稿';
    const count = vi.mocked(previewService.getTaskInput).mock.calls.length, action = task.open('T2');
    await vi.waitFor(() => expect(task.decision).not.toBeNull());task.answer('cancel');
    expect(await action).toBe(false);expect(task.draft!.name).toBe('未保存草稿');
    expect(previewService.getTaskInput).toHaveBeenCalledTimes(count);
  });
});
