interface RefreshOptions {
  active: () => boolean;
  intervalSeconds: () => number | null | undefined;
  identity: () => string;
  read: (signal: AbortSignal) => Promise<unknown>;
}

// 后台目录只按当前可见来源串行读取；不操作业务状态、回放或地图。
export function createGisStatusRefresh(options: RefreshOptions) {
  let alive = true,
    generation = 0,
    key = '',
    running = false;
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
  function stamp() {
    const seconds = options.intervalSeconds(),
      identity = options.identity();
    return options.active() &&
      identity &&
      typeof seconds === 'number' &&
      Number.isInteger(seconds) &&
      seconds >= 1 &&
      seconds <= 3600
      ? JSON.stringify([identity, seconds])
      : '';
  }
  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    if (!alive || !key || running || timer !== undefined) return;
    const owner = generation;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!alive || owner !== generation) return;
        if (stamp() !== key) {
          sync();
          return;
        }
        running = true;
        const request = new AbortController();
        controller = request;
        void Promise.resolve()
          .then(() => {
            if (alive && owner === generation && !request.signal.aborted)
              return options.read(request.signal);
          })
          .catch(() => {
            // 后台失败保留当前目录；显式读取仍由面板报告业务错误。
          })
          .finally(() => {
            running = false;
            if (controller === request) controller = undefined;
            if (!alive) return;
            if (stamp() !== key) sync();
            else schedule();
          });
      },
      Number(options.intervalSeconds()) * 1000,
    );
  }
  function sync() {
    if (!alive) return;
    const next = stamp();
    if (key === next) return;
    key = next;
    generation++;
    clearTimer();
    controller?.abort();
    schedule();
  }
  function dispose() {
    alive = false;
    key = '';
    generation++;
    clearTimer();
    controller?.abort();
  }
  return { sync, dispose };
}
