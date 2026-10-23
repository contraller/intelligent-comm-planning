import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGisStatusRefresh } from '../src/services/gis-status-refresh';

afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const input = { active: true, seconds: 30 as number | null, identity: 'session:R1:config1' };
  const read = vi.fn(async (_signal: AbortSignal) => true);
  const refresh = createGisStatusRefresh({
    active: () => input.active,
    intervalSeconds: () => input.seconds,
    identity: () => input.identity,
    read,
  });
  refresh.sync();
  return { input, read, refresh };
}

describe('GIS状态目录后台刷新调度', () => {
  it('等待完整间隔，不立即请求；完成后再排下一轮', async () => {
    const f = setup();
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.refresh.dispose();
  });
  it.each([null, 0, -1, 1.2, NaN, Infinity, 3601])('无效间隔%s不回退默认值', async (seconds) => {
    const f = setup();
    f.input.seconds = seconds;
    f.refresh.sync();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(f.read).not.toHaveBeenCalled();
    f.refresh.dispose();
  });
  it('不可见、无权限或有脏输入时停用，恢复不补发遗漏轮次', async () => {
    const f = setup();
    f.input.active = false;
    f.refresh.sync();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(f.read).not.toHaveBeenCalled();
    f.input.active = true;
    f.refresh.sync();
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.refresh.dispose();
  });
  it('参数新版本替换旧计时，不提前读取', async () => {
    const f = setup();
    await vi.advanceTimersByTimeAsync(20000);
    f.input.seconds = 10;
    f.input.identity = 'session:R1:config2';
    f.refresh.sync();
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.refresh.dispose();
  });
  it('慢读不重入；切资源取消旧signal，晚完成后仍等待新间隔', async () => {
    const f = setup();
    let resolve!: (value: boolean) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(30000);
    const signal = f.read.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(300000);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.input.identity = 'session:R2:config1';
    f.refresh.sync();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.read).toHaveBeenCalledTimes(1);
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.refresh.dispose();
  });
  it('回调到达前来源已变化时重新等待，不读旧来源', async () => {
    const f = setup();
    f.input.identity = 'other-session:R1:config1';
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.read).toHaveBeenCalledTimes(1);
    f.refresh.dispose();
  });
  it('失败不终止后续读取，卸载后不再排队或回调', async () => {
    const f = setup();
    f.read.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.refresh.dispose();
    await vi.advanceTimersByTimeAsync(3600000);
    f.refresh.sync();
    expect(f.read).toHaveBeenCalledTimes(2);
  });
});
