import type { PageQuery, PageResult, ReadRequest } from '../types/data-access';
import { ApiError } from './types';

// 共用参数边界，各领域可继续使用自己的业务错误码。
export function validPageQuery(query: PageQuery): boolean {
  return Number.isSafeInteger(query.pageNum) && query.pageNum >= 1 && Number.isSafeInteger(query.pageSize) && query.pageSize >= 1 && query.pageSize <= 100;
}
// 内部存储仍可完整保存；出口只对已筛选、稳定排序的结果分页。
export function pageItems<T>(items: readonly T[], query: PageQuery): PageResult<T> {
  if (!validPageQuery(query))
    throw new ApiError('分页参数无效', 'INVALID_PAGE_QUERY');
  return { items: items.slice((query.pageNum - 1) * query.pageSize, query.pageNum * query.pageSize), total: items.length, pageNum: query.pageNum, pageSize: query.pageSize };
}
export function assertReading(input?: ReadRequest) {
  if (input?.signal?.aborted) throw new ApiError('读取已取消', 'REQUEST_ABORTED');
}

// 请求取消只管理当前页面内的传输，不缓存数据或取消已提交业务任务。
export function createReadCancellation() {
  const controllers=new Map<string,AbortController>();
  return {
    signal(key:string){controllers.get(key)?.abort();const controller=new AbortController();controllers.set(key,controller);return controller.signal;},
    stop(...keys:string[]){for(const key of keys.length?keys:[...controllers.keys()]){controllers.get(key)?.abort();controllers.delete(key);}},
  };
}
