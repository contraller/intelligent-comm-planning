import { afterEach,describe,expect,it,vi } from 'vitest';
import { createMonitoringPlayback,initialPlaybackState } from '../src/services/monitoring-playback';

afterEach(()=>vi.useRealTimers());
function fixture(){
  const state=initialPlaybackState(),fetch=vi.fn(async(index:number)=>index),accept=vi.fn(),fail=vi.fn();
  const player=createMonitoringPlayback(state,fetch,accept,fail);
  player.configure(4,30);player.setActive(true);
  return {state,fetch,accept,fail,player};
}
// 假时钟验证用户可见的序列推进，不依赖真实等待或重复实现调度逻辑。
describe('有限观测播放',()=>{
  it('首帧、配置周期、末帧停止及手动重播',async()=>{
    vi.useFakeTimers();const s=fixture();await s.player.next();expect(s.state.index).toBe(0);
    await vi.advanceTimersByTimeAsync(29999);expect(s.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(s.state.index).toBe(1);
    s.player.configure(4,2);await vi.advanceTimersByTimeAsync(1999);expect(s.state.index).toBe(1);
    await vi.advanceTimersByTimeAsync(2001);expect(s.state.index).toBe(3);expect(s.state.finished).toBe(true);
    await vi.advanceTimersByTimeAsync(100000);expect(s.fetch).toHaveBeenCalledTimes(4);
    await s.player.restart();expect(s.state.index).toBe(0);expect(s.state.finished).toBe(false);s.player.clear();
  });
  it('并发手动刷新共享一个请求，不跳帧',async()=>{
    vi.useFakeTimers();const s=fixture();let resolve!:(value:number)=>void;
    s.fetch.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const first=s.player.next(),second=s.player.next();expect(first).toBe(second);
    await Promise.resolve();expect(s.fetch).toHaveBeenCalledTimes(1);resolve(0);await first;
    expect(s.state.index).toBe(0);expect(s.accept).toHaveBeenCalledTimes(1);s.player.clear();
  });
  it('暂停期间不推进，返回从当前位置等待一个周期',async()=>{
    vi.useFakeTimers();const s=fixture();await s.player.next();s.player.setActive(false);
    await vi.advanceTimersByTimeAsync(90000);expect(s.state.index).toBe(0);
    s.player.setActive(true);await vi.advanceTimersByTimeAsync(29999);expect(s.state.index).toBe(0);
    await vi.advanceTimersByTimeAsync(1);expect(s.state.index).toBe(1);s.player.clear();
  });
  it('暂停、重置或会话清理后的迟到响应不覆盖当前帧',async()=>{
    vi.useFakeTimers();const s=fixture();await s.player.next();
    let resolve!:(value:number)=>void;s.fetch.mockImplementationOnce(()=>new Promise(r=>resolve=r));
    const next=s.player.next();await Promise.resolve();s.player.setActive(false);resolve(1);await next;
    expect(s.state.index).toBe(0);expect(s.accept).toHaveBeenCalledTimes(1);
    s.player.clear();expect(s.state.index).toBe(-1);expect(vi.getTimerCount()).toBe(0);
  });
  it('失败保留上一帧并停自动播放，手动重试同一帧',async()=>{
    vi.useFakeTimers();const s=fixture();await s.player.next();s.fetch.mockRejectedValueOnce(new Error('网络错误'));
    await s.player.next();expect(s.state.index).toBe(0);expect(s.state.error).toBe('网络错误');
    await vi.advanceTimersByTimeAsync(90000);expect(s.fetch).toHaveBeenCalledTimes(2);
    await s.player.next();expect(s.fetch.mock.calls.map(row=>row[0])).toEqual([0,1,1]);expect(s.state.index).toBe(1);s.player.clear();
  });
});
