import type { SystemData } from './domain';
import type { Permission } from '../config/permissions';
import type { PageQuery, PageResult, ReadRequest, SearchQuery } from './data-access';
import type { SystemManagementActions } from './system-management';
import type { LocalIdentityActions } from './local-identity';

// 登录身份与业务对象分离，历史日志保存操作时身份而非当前角色名称。
export interface SystemAccount { id: string; username: string; name: string; department: string; roleId: string; enabled: boolean; mustChangePassword?: boolean }
export interface SystemRole { id: string; name: string; description: string; permissions: Permission[] }
export interface SystemParameter { id: string; name: string; value: number | string; unit: string; description: string; readonly: boolean; min: number | null; max: number | null; applicationState?: 'STORED_ONLY' | 'APPLIED'; appliesTo?: string }
export interface SystemWorkspace {
  schemaVersion: number; presetVersion: string; revision: string; epoch: string;
  accounts: SystemAccount[]; roles: SystemRole[]; parameters: SystemParameter[];
  receipts: { requestId: string; signature: string; objectId: string; changed: boolean }[];
}
export interface SessionRecord { schemaVersion: 1; state: 'ACTIVE' | 'SIGNED_OUT'; id: string; accountId: string; epoch: string; loginAt: string }
export interface AuthIdentity { sessionId: string; id: string; username: string; name: string; roleId: string; roleName: string; permissions: Permission[]; epoch: string; revision: string; integrationMode?: boolean }
export interface ActorSnapshot { id: string; name: string; roleId: string; roleName: string }
export interface OperationEvent {
  id: string; epoch: string; time: string; actor: ActorSnapshot | null; attemptedUsername: string;
  module: string; action: string; objectId: string; requestId: string | null;
  outcome: 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNCHANGED'; summary: string; errorCode: string; dedupeKey: string;
  sequence?: number; changes?: Record<string, unknown>; authSource?: 'LOCAL_PASSWORD';
}
export interface OperationJournal { schemaVersion: 1; revision: string; epoch: string; events: OperationEvent[] }
// 系统列表只查询、筛选和分页，展示顺序由数据服务提供。
export interface SystemQuery extends Partial<PageQuery>, SearchQuery {
  roleId?: string; enabled?: boolean;
  actorId?: string; module?: string; action?: string; outcome?: string; date?: string; includeArchived?: boolean;
}
export interface SystemPage<T> extends PageResult<T> { revision: string; epoch?: string; auditRevision?: string; snapshotSequence?: number }
export interface SystemMutation { baseRevision: string; requestId: string }
export interface SystemResult { revision: string; objectId: string; changed: boolean; operationId?: string; replayed?: boolean; reauthenticationRequired?: boolean; applicationState?: 'STORED_ONLY' | 'APPLIED'; appliesTo?: string; auditRevision?: string; archivedThroughSequence?: number }
export interface SystemCatalog {
  revision: string; roles: { id: string; name: string }[]; parameters: SystemParameter[];
  permissions: { code: Permission; name: string; group: string; requires: Permission[] }[]; legacy: SystemData;
}
export interface LoginCatalog { passwordHint: string; accounts: { username: string; name: string; role: string; enabled: boolean }[] }
// 各表有独立筛选，页面不把其他页签的条件交给当前查询。
export interface SystemAccountQuery extends ReadRequest, Partial<PageQuery>, SearchQuery { roleId?:string;enabled?:boolean }
export interface SystemRoleQuery extends ReadRequest, Partial<PageQuery>, SearchQuery {}
export interface SystemParameterQuery extends ReadRequest, Partial<PageQuery>, SearchQuery {}
// date 为北京时间日历日期 YYYY-MM-DD，省略或空字符串表示不限日期。
export interface SystemLogQuery extends ReadRequest, Partial<PageQuery>, SearchQuery { actorId?:string;module?:string;action?:string;outcome?:string;date?:string;includeArchived?:boolean }
export type SystemOptions = Omit<SystemCatalog,'parameters'|'legacy'>;
export type SystemRoleSummary = Omit<SystemRole,'permissions'> & {permissionCount:number;accountCount:number};
export type OperationSummary = Omit<OperationEvent,'dedupeKey'|'epoch'|'requestId'>;
export interface SystemServices extends Partial<SystemManagementActions>, Partial<LocalIdentityActions> {
  loadSystemOptions(input?:ReadRequest):Promise<SystemOptions>;
  queryAccountSummaries(query?:SystemAccountQuery):ReturnType<SystemServices['querySystemAccounts']>;
  queryRoleSummaries(query?:SystemRoleQuery):Promise<SystemPage<SystemRoleSummary>>;
  queryParameterSummaries(query?:SystemParameterQuery):ReturnType<SystemServices['querySystemParameters']>;
  queryOperationSummaries(query?:SystemLogQuery):Promise<SystemPage<OperationSummary>>;
  getSystemAccount(input:ReadRequest & {id:string}):Promise<{revision:string;account:SystemAccount}>;
  getSystemRole(input:ReadRequest & {id:string}):Promise<{revision:string;role:SystemRole}>;
  getSystemParameter(input:ReadRequest & {id:string}):Promise<{revision:string;parameter:SystemParameter}>;
  getOperationEvent(input:ReadRequest & {id:string}):Promise<OperationEvent>;
  getLoginCatalog(): Promise<LoginCatalog>;
  login(request: { username: string; password: string }): Promise<AuthIdentity>;
  logout(): Promise<void>;
  getSession(): Promise<AuthIdentity | null>;
  loadSystemCatalog(): Promise<SystemCatalog>;
  querySystemAccounts(query?: SystemQuery): Promise<SystemPage<SystemAccount & { roleName: string; lastLogin: string | null }>>;
  saveSystemAccount(request: SystemMutation & { account: Omit<SystemAccount, 'enabled' | 'id'> & { id: string | null }; initialPassword?: string }): Promise<SystemResult>;
  setSystemAccountState(request: SystemMutation & { accountId: string; enabled: boolean }): Promise<SystemResult>;
  querySystemRoles(query?: SystemQuery): Promise<SystemPage<SystemRole & { accountCount: number }>>;
  saveSystemRole(request: SystemMutation & { role: Omit<SystemRole, 'id'> & { id: string | null } }): Promise<SystemResult>;
  querySystemParameters(query?: SystemQuery): Promise<SystemPage<SystemParameter>>;
  saveSystemParameter(request: SystemMutation & { parameterId: string; value: number | string }): Promise<SystemResult>;
  queryOperationLogs(query?: SystemQuery): Promise<SystemPage<OperationEvent>>;
  resetSystemWorkspace(request: SystemMutation): Promise<SystemResult>;
  recoverSystemWorkspace(request: { username: string; password: string }): Promise<SystemResult>;
  resetOperationLogs(request: { baseRevision: string | null }): Promise<SystemResult>;
}
