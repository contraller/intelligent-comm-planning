import { describe, expect, it } from 'vitest';
import { createFrequencyResourceHttp } from '../src/services/frequency-resource-http';
import { createHttpClient } from '../src/services/http-client';
import type { AuthenticatedRequest } from '../src/services/auth-http';

// 仅连接显式确认过的本组 R2 服务；不提供旧服务、主库或演示身份回退。
const baseUrl = process.env.P04_R2_API_BASE_URL;
const configured = !!baseUrl && process.env.P04_R2_DATASET_CONFIRMED === 'r2.sqlite'
  && !!process.env.P04_R2_COOKIE && !!process.env.P04_R2_SESSION_ID;
function fixture() {
  const url = new URL(baseUrl!);
  if (url.origin !== 'http://127.0.0.14:8114' || url.pathname.replace(/\/$/, '') !== '/api/v1') {
    throw new Error('频点实联仅允许明确分配的本组 R2 API 地址');
  }
  const client = createHttpClient(baseUrl!, (input, init) => fetch(input, { ...init, headers: {
    ...init?.headers, Cookie: process.env.P04_R2_COOKIE!, 'X-Session-Id': process.env.P04_R2_SESSION_ID!,
    ...(process.env.P04_R2_CSRF ? { 'X-CSRF-Token': process.env.P04_R2_CSRF } : {}),
  } }));
  const request: AuthenticatedRequest = (path, init, responseType) => client(path, init, responseType);
  return { client, api: createFrequencyResourceHttp(request) };
}
describe.skipIf(!configured)('P04 明确隔离的 R2 真实 HTTP', () => {
  it('同源资源身份、服务器查询、本人历史和原回执一致', async () => {
    const { client, api } = fixture();
    const context = await client<{ revision: string }>('/resource/context?context=ledger');
    const page = await api.queryFrequencyResources({ context: 'ledger', revision: context.revision, page: 1, pageSize: 5 });
    expect(page.revision).toBe(context.revision); expect(page.dataOrigin).toBe('SYNTHETIC_INTEGRATION');
    expect(page.items.length).toBe(Math.min(5, page.total));
    const history = await api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 });
    if (history.items.length) {
      const operation = await api.getFrequencyOperation({ context: 'ledger', requestId: history.items[0].requestId });
      expect(operation.receipt.revision).toBe(history.items[0].revision);
    }
  }, 30000);
  it.skipIf(process.env.P04_R2_ALLOW_DISABLE !== '1' || !process.env.P04_R2_CSRF)('预检、停用、原请求重放和原回执核实', async () => {
    const { client, api } = fixture();
    const context = await client<{ revision: string }>('/resource/context?context=ledger');
    const page = await api.queryFrequencyResources({ context: 'ledger', revision: context.revision,
      page: 1, pageSize: 5, availability: 'AVAILABLE' });
    if (!page.items.length) throw new Error('R2 缺少可用构造频点，未伪造成功');
    const ids = [page.items[0].freqId];
    await api.validateFrequencyDisable({ context: 'ledger', revision: context.revision, ids });
    const input = { context: 'ledger' as const, baseRevision: context.revision, requestId: `r2-p04-${crypto.randomUUID()}`, ids };
    const receipt = await api.disableFrequencyResources(input);
    expect(await api.disableFrequencyResources(input)).toEqual(receipt);
    expect((await api.getFrequencyOperation({ context: 'ledger', requestId: input.requestId })).receipt).toEqual(receipt);
  }, 30000);
});
