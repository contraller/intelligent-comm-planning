import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAuthHttp } from '../src/services/auth-http';
import { createResourceReadHttp } from '../src/services/resource-read-http';

afterEach(() => vi.useRealTimers());

// 请求桩只验证计时和取消；正式参数HTTP及页面验收另行登记。
it.each(['auth', 'resource'] as const)('%s在下一请求读取新超时，在途请求保留原值', async kind => {
  vi.useFakeTimers();
  let timeout = 1000;
  const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const options = { baseUrl: () => '/api/v1', origin: () => 'http://localhost', fetcher, timeoutMs: () => timeout };
  const client = kind === 'auth' ? createAuthHttp(options) : createResourceReadHttp(options);
  const send = () => 'getSession' in client ? client.getSession() : client.loadResourceReadContext({ context: 'ledger' });
  const first = send();
  const firstCheck = expect(first).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  timeout = 2000;
  await vi.advanceTimersByTimeAsync(999);
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await firstCheck;
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  const second = send();
  const secondCheck = expect(second).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await secondCheck;
});

it.each([0, -1, NaN, Infinity])('非法动态超时%s在发送前拒绝', async timeout => {
  const fetcher = vi.fn<typeof fetch>();
  const options = { baseUrl: () => '/api/v1', origin: () => 'http://localhost', fetcher, timeoutMs: () => timeout };
  await expect(createAuthHttp(options).getSession()).rejects.toMatchObject({ code: 'INVALID_REQUEST_TIMEOUT' });
  await expect(createResourceReadHttp(options).loadResourceReadContext({ context: 'ledger' })).rejects.toMatchObject({ code: 'INVALID_REQUEST_TIMEOUT' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('宿主单点绑定正式快照、身份清理及成功写入后独立刷新', () => {
  const read = (path: string) => readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
  expect(read('layouts/AppShell.vue')).toContain('runtime.bind(collaborationHttp.runtimeParameters, runtimeSession)');
  expect(read('layouts/AppShell.vue')).toContain('runtime.unbind(); applyHttpRuntimeParameters(null)');
  expect(read('services/http.ts')).toContain("decodeRuntimeParameters(value).values['PAR-02'] * 1000");
  expect(read('services/http.ts')).toContain('baseUrl: () => env.apiBaseUrl, timeoutMs');
  expect(read('stores/system.ts')).toContain('useRuntimeParametersStore().refresh().catch');
});
