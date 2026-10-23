import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import { ApiError } from './types';

// 对外只暴露同一读取版本；旧事务的内部修订仅在 Mock 适配边界转换。
export function mockResourceRevision(source: { resources: ResourcesData; meta: ResourceMeta }): string {
  return `${source.resources.version}:${source.meta.resourceEpoch}:${source.meta.revision}`;
}
export function requireMockResourceRevision(source: { resources: ResourcesData; meta: ResourceMeta }, revision: string): string {
  if (revision !== mockResourceRevision(source)) throw new ApiError('资源版本已变化，请刷新已保存资源引用', 'RESOURCE_VERSION_CHANGED');
  return source.meta.revision;
}
