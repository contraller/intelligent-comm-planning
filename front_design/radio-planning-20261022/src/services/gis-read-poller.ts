// 同一轮读取完成后再安排下一次；停止/重启的旧轮次不能恢复计时器。
export function createGisReadPoller(read: () => Promise<void>, intervalMs = 30_000) {
  let running = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(owner: number) {
    timer = setTimeout(async () => {
      timer = undefined;
      if (!running || owner !== generation) return;
      try { await read(); } catch { /* 业务读取负责展示错误，计时器继续只读检查。 */ }
      finally { if (running && owner === generation) schedule(owner); }
    }, intervalMs);
  }
  return {
    start() { if (running) return; running = true; schedule(++generation); },
    stop() { running = false; generation++; clearTimeout(timer); timer = undefined; },
  };
}
