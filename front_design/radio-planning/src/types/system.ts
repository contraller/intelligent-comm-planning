import type { SystemData } from './domain';
import type { Permission } from '../config/permissions';

// 登录身份与业务对象分离，历史日志保存操作时身份而非当前角色名称。
export interface SystemAccount { id: string; username: string; name: string; department: string; roleId: string; enabled: boolean }
export interface SystemRole { id: string; name: string; description: string; permissions: Permission[] }
export interface SystemParameter { id: string; name: string; value: number | string; unit: string; description: string; readonly: boolean; min: number | null; max: number | null }
export interface SystemWorkspace {
  schemaVersion: number; presetVersion: string; revision: string; epoch: string;
  accounts: SystemAccount[]; roles: SystemRole[]; parameters: SystemParameter[];
  receipts: { requestId: string; signature: string; objectId: string; changed: boolean }[];
}
export interface SessionRecord { schemaVersion: 1; state: 'ACTIVE' | 'SIGNED_OUT'; id: string; accountId: string; epoch: string; loginAt: string }
export interface AuthIdentity { sessionId: string; id: string; username: string; name: string; roleId: string; roleName: string; permissions: Permission[]; epoch: string; revision: string }
export interface ActorSnapshot { id: string; name: string; roleId: string; roleName: string }
export interface OperationEvent {
  id: string; epoch: string; time: string; actor: ActorSnapshot | null; attemptedUsername: string;
  module: string; action: string; objectId: string; requestId: string | null;
  outcome: 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNCHANGED'; summary: string; errorCode: string; dedupeKey: string;
}
export interface OperationJournal { schemaVersion: 1; revision: string; epoch: string; events: OperationEvent[] }
export interface SystemQuery {
  query?: string; page?: number; sort?: string; descending?: boolean; roleId?: string; enabled?: boolean;
  actorId?: string; module?: string; action?: string; outcome?: string; from?: string; to?: string;
}
export interface SystemPage<T> { items: T[]; total: number; page: number; revision: string; epoch?: string }
export interface SystemMutation { baseRevision: string; requestId: string }
export interface SystemResult { revision: string; objectId: string; changed: boolean }
export interface SystemCatalog {
  revision: string; roles: { id: string; name: string }[]; parameters: SystemParameter[];
  permissions: { code: Permission; name: string; group: string; requires: Permission[] }[]; legacy: SystemData;
}
export interface LoginCatalog { passwordHint: string; accounts: { username: string; name: string; role: string; enabled: boolean }[] }
export interface SystemServices {
  getLoginCatalog(): Promise<LoginCatalog>;
  login(request: { username: string; password: string }): Promise<AuthIdentity>;
  logout(): Promise<void>;
  getSession(): Promise<AuthIdentity | null>;
  loadSystemCatalog(): Promise<SystemCatalog>;
  querySystemAccounts(query?: SystemQuery): Promise<SystemPage<SystemAccount & { roleName: string; lastLogin: string | null }>>;
  saveSystemAccount(request: SystemMutation & { account: Omit<SystemAccount, 'enabled' | 'id'> & { id: string | null } }): Promise<SystemResult>;
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
