// 只复用传输小类型，业务分类、身份和版本仍由各领域定义。
export interface ReadRequest { signal?: AbortSignal }
export interface PageQuery { pageNum: number; pageSize: number }
export interface PageResult<T> extends PageQuery { items: T[]; total: number }
export type SortDirection = 'asc' | 'desc';
// 复用公共字段，各领域继续限定自己的筛选与可排序字段。
export interface SearchQuery { search?: string }
export interface SortQuery<T extends string> { sort?: T; order?: SortDirection }
export interface MutationReceipt { objectId: string; changed: boolean; revision: string }
