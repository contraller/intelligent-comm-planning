import type { ReadRequest } from './data-access';
import type { SystemMutation, SystemResult } from './system';

export type SystemOperationReceipt = { status: 'NOT_FOUND' } | ({ status: 'FOUND' } & SystemResult);
export interface AccountPasswordInput extends SystemMutation { accountId: string; operatorPassword: string; newPassword: string }
export interface ResetParametersInput extends SystemMutation { parameterIds: string[]; reason: string; confirm: 'RESTORE_PARAMETER_DEFAULTS' }
export interface ArchiveLogsInput { baseAuditRevision: string; requestId: string; throughSequence: number; reason: string; confirm: 'ARCHIVE_LOG_VIEW' }
export interface SystemManagementActions {
  getSystemOperation(input: ReadRequest & { requestId: string }): Promise<SystemOperationReceipt>;
  maintainSystemAccountPassword(input: AccountPasswordInput): Promise<SystemResult>;
  resetSystemParameters(input: ResetParametersInput): Promise<SystemResult>;
  archiveSystemLogs(input: ArchiveLogsInput): Promise<SystemResult>;
}
