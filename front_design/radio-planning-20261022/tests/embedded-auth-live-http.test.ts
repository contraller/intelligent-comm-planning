import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const liveOrigin = process.env.EMBED_AUTH_LIVE_BASE_URL;
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

// 可选真实TCP GET专项：只读F验证服务，不启动/修改实例，不把此结果称为浏览器iframe联调。
describe.skipIf(!liveOrigin)('实际交付httpService的独立页初始化读取', () => {
  it('带其他端口遗留Cookie完成资源分页、规划工作区、任务目录及运行参数读取', async () => {
    const origin = new URL(liveOrigin!).origin;
    expect(new URL(origin).hostname).toBe('127.0.0.1');
    expect(new URL(origin).port).not.toBe('18480'); // 不接触用户C盘现用实例。
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const target = resolve('../../data/runtime/module-embed-20261104/auth'); mkdirSync(target, { recursive: true });
    const calls: { path: string; method: string; status: number; code: unknown; embedded: boolean; sessionHeader: boolean; setCookie: boolean }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), origin);
      if (url.origin !== origin || !url.pathname.startsWith('/api/v1/')) throw new Error('真实专项只允许指定F回环API');
      const method = init?.method ?? 'GET';
      if (!['GET', 'HEAD'].includes(method)) throw new Error('真实专项禁止业务写入');
      const headers = new Headers(init?.headers);
      headers.set('Cookie', 'radio_local_session=foreign-port-stale-cookie');
      headers.set('Sec-Fetch-Site', 'same-origin');
      const result = await nativeFetch(url, { ...init, headers });
      const envelope = await result.clone().json();
      calls.push({ path: url.pathname + url.search, method, status: result.status, code: envelope.code,
        embedded: headers.get('X-Radio-Embedded') === '1', sessionHeader: headers.has('X-Session-Id'), setCookie: result.headers.has('set-cookie') });
      writeFileSync(resolve(target, 'transport-fix-live-trace.json'), JSON.stringify({ complete: false, calls }, null, 2));
      return result;
    };
    vi.resetModules();
    vi.stubGlobal('location', { origin, hash: '#/embed/planning' });
    vi.stubGlobal('fetch', fetcher);
    // 导入实际交付组合而非手工工厂探针，确保http.ts装配也在测试范围内。
    const { httpService, collaborationHttp } = await import('../src/services/http');
    const who = await httpService.getSession(); expect(who?.authSource).toBe('LOCAL_SINGLE_USER');
    const workspace = await httpService.loadResourceReadContext({ context: 'planning' });
    const devices = await httpService.queryResourceDevices({ context: 'planning', revision: workspace.revision, pageNum: 1, pageSize: 5 });
    expect(devices.items.length).toBeGreaterThan(0); expect(devices.revision).toBe(workspace.revision);
    const [planning, options, tasks, runtime] = await Promise.all([
      httpService.loadPlanningReadContext({ context: 'planning' }),
      httpService.loadPlanningOptions({ context: 'planning' }),
      httpService.queryTaskSummaries({ context: 'planning', pageNum: 1, pageSize: 5 }),
      collaborationHttp.runtimeParameters.getRuntimeParameters(),
    ]);
    expect(planning.revision).toBeTruthy(); expect(options.presets.length).toBeGreaterThan(0); expect(tasks.total).toBeGreaterThanOrEqual(0); expect(runtime.values['PAR-02']).toBeGreaterThan(0);
    expect((await httpService.getSession())?.sessionId).toBe(who!.sessionId);
    expect(calls.every(call => call.embedded && call.status === 200 && call.code === 0 && !call.setCookie)).toBe(true);
    const business = calls.filter(call => !call.path.startsWith('/api/v1/auth/'));
    expect(business.every(call => call.sessionHeader)).toBe(true);
    expect(calls.some(call => call.path.startsWith('/api/v1/resource/devices?'))).toBe(true);
    expect(calls.some(call => call.path.startsWith('/api/v1/resource/param-presets?'))).toBe(true);
    expect(calls.some(call => call.path.startsWith('/api/v1/resource/frequency-pool?'))).toBe(true);
    expect(calls.some(call => call.path.startsWith('/api/v1/task-inputs?'))).toBe(true);
    expect(calls.some(call => call.path === '/api/v1/system/runtime-parameters')).toBe(true);
    expect(calls.some(call => call.path === '/api/v1/auth/csrf')).toBe(false); // 全程GET，没有新增/重复CSRF请求。
    writeFileSync(resolve(target, 'transport-fix-live.json'), JSON.stringify({ realTCPHTTP: true, actualHttpServiceComposition: true,
      methods: ['GET'], foreignCookieSupplied: true, stableSession: true, resourceDeviceCount: devices.items.length,
      planningWorkspaceReadable: true, taskCatalogReadable: true, runtimeParametersReadable: true, calls,
      browserIframeEndToEnd: false, userInstance18480Accessed: false }, null, 2));
  }, 60_000);
});
