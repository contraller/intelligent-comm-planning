import type { AuthenticatedRequest } from './auth-http';
import type { GisLinkQuery, GisNetwork, GisPathsQuery, GisPlanQuery } from '../types/gis-plan';
import { readGisLinkDetail, readGisNetwork, readGisPaths, readGisPlanSurface, validateGisPlanQuery } from './gis-plan-validation';

function path(query: GisPlanQuery, suffix: string, demandId?: string): string {
  const params = new URLSearchParams({ context: 'gis', task_id: query.taskId });
  if (query.snapshotId !== undefined) params.set('snapshot_id', query.snapshotId);
  if (demandId !== undefined) params.set('demand_id', demandId);
  return `/gis/plans/${encodeURIComponent(query.planId)}/${suffix}?${params.toString()}`;
}

// 不选择“最新”方案、不退回 Mock；详情必须核对页面当前打开的冻结网络。
export function createGisPlanHttp(request: AuthenticatedRequest) {
  return {
    async getSurface(query: GisPlanQuery & { snapshotId: string }, network: GisNetwork, signal?: AbortSignal) {
      const expected = { ...query };
      validateGisPlanQuery(expected, 'paths');
      const source = readGisNetwork(network, expected);
      return readGisPlanSurface(await request<unknown>(path(expected, 'surface'), { method: 'GET', signal }), expected, source);
    },
    async getNetwork(query: GisPlanQuery, signal?: AbortSignal) {
      const expected = { ...query };
      validateGisPlanQuery(expected, 'network');
      return readGisNetwork(await request<unknown>(path(expected, 'network'), { method: 'GET', signal }), expected);
    },
    async getLink(query: GisLinkQuery, network: GisNetwork, signal?: AbortSignal) {
      const expected = { ...query };
      validateGisPlanQuery(expected, 'link');
      // 异步读取期间即使页面切换选择，也不能改用新对象解释旧响应。
      const source = readGisNetwork(network, { planId: expected.planId, taskId: expected.taskId, snapshotId: expected.snapshotId });
      return readGisLinkDetail(await request<unknown>(path(expected, `links/${encodeURIComponent(expected.linkId)}`), { method: 'GET', signal }), expected, source);
    },
    async getPaths(query: GisPathsQuery, network: GisNetwork, signal?: AbortSignal) {
      const expected = { ...query };
      validateGisPlanQuery(expected, 'paths');
      const source = readGisNetwork(network, { planId: expected.planId, taskId: expected.taskId, snapshotId: expected.snapshotId });
      return readGisPaths(await request<unknown>(path(expected, 'paths', expected.demandId), { method: 'GET', signal }), expected, source);
    },
  };
}
