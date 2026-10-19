import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccessService, isWriteMethod } from '../src/services/access';
import { servicePermissions } from '../src/config/permissions';
import { httpService } from '../src/services/http';
import { previewService } from '../src/services';
import { mockService } from '../src/services/mock';
import { authFixture } from './helpers/auth';
import type { AuthIdentity } from '../src/types/system';

afterEach(() => vi.restoreAllMocks());
const query = { context: 'ledger' as const, resourceRevision: 'initial', deviceIds: ['DV-0001'] };
// 使用真实权限包装，不能只验证底层 Mock 工厂返回成功。
describe('设备状态读取访问边界', () => {
  it.each(['ledger', 'gis'] as const)('%s 只读权限足够，另一上下文不能借用权限', async context => {
    const s = authFixture(), actor = await s.login('viewer');
    const identity: AuthIdentity = { ...actor, permissions: [context === 'gis' ? 'situation.view' : 'resources.view'] };
    const raw = { ...s.raw, getSession: async () => identity }, api = createAccessService(() => raw, null);
    expect((await api.loadDeviceStatusContext({ ...query, context })).examples).toHaveLength(4);
    expect((await api.queryDeviceStatuses({ ...query, context })).items).toHaveLength(1);
    await expect(api.queryDeviceStatuses({ ...query, context: context === 'gis' ? 'ledger' : 'gis' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.loadDeviceStatusContext({ ...query, context: 'planning' as never })).rejects.toMatchObject({ code: 'INVALID_DEVICE_STATUS_QUERY' });
  });
  it.each(['permission', 'session'])('返回前 %s 改变，旧结果被拒绝', async kind => {
    const s = authFixture(), actor = await s.login('viewer'); let reads = 0;
    const raw = { ...s.raw, getSession: async () => ++reads === 1 ? actor
      : { ...actor, ...(kind === 'permission' ? { permissions: [] } : { sessionId: 'new' }) } };
    const api = createAccessService(() => raw, null);
    await expect(api.queryDeviceStatuses(query)).rejects.toMatchObject({ code: kind === 'permission' ? 'FORBIDDEN' : 'SESSION_CHANGED' });
  });
  it('读取不记配置写操作；原始服务与公开方法及权限注册完整', async () => {
    const s = authFixture(); await s.login('viewer'); const before = new Map(s.storage.entries), writes = s.storage.writes;
    await s.service.queryDeviceStatuses(query);
    expect(s.storage.entries).toEqual(before); expect(s.storage.writes).toBe(writes);
    for (const name of ['loadDeviceStatusContext', 'queryDeviceStatuses']) {
      expect(isWriteMethod(name)).toBe(false); expect(servicePermissions[name]).toBeDefined();
      expect(typeof (s.service as any)[name]).toBe('function'); expect(typeof (s.raw as any)[name]).toBe('function');
    }
  });
  it('HTTP 占位明确失败，不请求网络也不自动回退 Mock', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), mock = vi.spyOn(mockService, 'queryDeviceStatuses');
    await expect(httpService.loadDeviceStatusContext(query)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(httpService.queryDeviceStatuses(query)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(fetch).not.toHaveBeenCalled(); expect(mock).not.toHaveBeenCalled();
  });
  it('统一入口实际转发两个读取方法并保留既有权限包装', async () => {
    const s = authFixture(), actor = await s.login('viewer');
    vi.spyOn(mockService, 'getSession').mockResolvedValue(actor);
    const context = vi.spyOn(mockService, 'loadDeviceStatusContext').mockImplementation(s.raw.loadDeviceStatusContext);
    const sync = vi.spyOn(mockService, 'queryDeviceStatuses').mockImplementation(s.raw.queryDeviceStatuses);
    expect((await previewService.loadDeviceStatusContext(query)).resourceRevision).toBe('initial');
    expect((await previewService.queryDeviceStatuses(query)).items).toHaveLength(1);
    expect(context).toHaveBeenCalledWith(query); expect(sync).toHaveBeenCalledWith(query);
  });
});
