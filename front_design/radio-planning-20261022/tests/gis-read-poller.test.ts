import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGisReadPoller } from '../src/services/gis-read-poller';

afterEach(() => vi.useRealTimers());
describe('GIS30秒只读计时器', () => {
  it('默认30秒才读取，未完成时不并发，完成后安排下一次', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const read = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const poller = createGisReadPoller(read); poller.start(); poller.start();
    await vi.advanceTimersByTimeAsync(29_999); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(90_000); expect(read).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(29_999); expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(2); poller.stop(); finish();
  });
  it('离开或暂停清除计时器，晚到旧轮次不能重新开始', async () => {
    vi.useFakeTimers(); let finish!: () => void;
    const read = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const poller = createGisReadPoller(read); poller.start(); await vi.advanceTimersByTimeAsync(30_000);
    poller.stop(); finish(); await vi.advanceTimersByTimeAsync(300_000);
    expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('读取失败仍按下一周期检查，停止后不再重试', async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => { throw new Error('只读服务暂不可用'); });
    const poller = createGisReadPoller(read); poller.start(); await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2); poller.stop(); await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
