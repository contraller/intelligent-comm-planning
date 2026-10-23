import { allPermissions, type Permission } from '../config/permissions';
import type { OperationEvent, SystemAccount, SystemOptions, SystemPage, SystemParameter, SystemResult, SystemRole } from '../types/system';
import type { SystemOperationReceipt } from '../types/system-management';
import { ApiError } from './types';

const invalid = () => new ApiError('系统管理响应不符合契约', 'INVALID_SYSTEM_RESPONSE');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 2048 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) throw invalid();
  return value;
}
export function integer(value: unknown, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw invalid(); return value as number; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function safe(value: unknown, depth = 0): void {
  if (depth > 8) throw invalid();
  if (Array.isArray(value)) { value.forEach(v => safe(v, depth + 1)); return; }
  if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
    if (/password|credential|csrf|cookie|token|digest|salt|secret/i.test(key) && key !== 'mustChangePassword' && key !== 'passwordMaintenance') throw invalid();
    safe(v, depth + 1);
  }
}
function permissions(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.some(v => !allPermissions.includes(v as Permission)) || new Set(value).size !== value.length) throw invalid();
  return [...value] as Permission[];
}
export function accountDto(value: unknown): SystemAccount & { roleName: string; lastLogin: string | null } {
  safe(value); const v = object(value);
  const lastLogin = v.lastLogin === null ? null : text(v.lastLogin);
  if (lastLogin !== null && !Number.isFinite(Date.parse(lastLogin))) throw invalid();
  return { id: text(v.id), username: text(v.username), name: text(v.name), department: text(v.department), roleId: text(v.roleId), roleName: text(v.roleName), enabled: bool(v.enabled), mustChangePassword: bool(v.mustChangePassword), lastLogin };
}
export function roleDto(value: unknown): SystemRole & { permissionCount: number; accountCount: number } {
  safe(value); const v = object(value), codes = permissions(v.permissions);
  if (integer(v.permissionCount) !== codes.length) throw invalid();
  return { id: text(v.id), name: text(v.name), description: text(v.description, true), permissions: codes, permissionCount: codes.length, accountCount: integer(v.accountCount) };
}
export function parameterDto(value: unknown): SystemParameter {
  safe(value); const v = object(value);
  if (!['STORED_ONLY', 'APPLIED'].includes(String(v.applicationState)) || typeof v.value !== 'string' && !Number.isSafeInteger(v.value)) throw invalid();
  return { id: text(v.id), name: text(v.name), value: v.value as string | number, unit: text(v.unit, true), description: text(v.description), readonly: bool(v.readonly), min: v.min === null ? null : integer(v.min), max: v.max === null ? null : integer(v.max), applicationState: v.applicationState as 'STORED_ONLY' | 'APPLIED', appliesTo: text(v.appliesTo) };
}
export function eventDto(value: unknown): OperationEvent {
  safe(value); const v = object(value), a = v.actor === null ? null : object(v.actor);
  if (!['SUCCESS', 'FAILED', 'DENIED', 'UNCHANGED'].includes(String(v.outcome)) || v.authSource !== 'LOCAL_PASSWORD' || !Number.isFinite(Date.parse(text(v.time)))) throw invalid();
  return { id: text(v.id), epoch: text(v.epoch), sequence: integer(v.sequence, 1), time: text(v.time), actor: a && { id: text(a.id), name: text(a.name), roleId: text(a.roleId), roleName: text(a.roleName) }, attemptedUsername: text(v.attemptedUsername, true), module: text(v.module), action: text(v.action), objectId: text(v.objectId, true), requestId: v.requestId === null ? null : text(v.requestId), outcome: v.outcome as OperationEvent['outcome'], summary: text(v.summary), errorCode: text(v.errorCode, true), dedupeKey: text(v.dedupeKey), changes: structuredClone(object(v.changes)), authSource: 'LOCAL_PASSWORD' };
}
export function optionsDto(value: unknown): SystemOptions {
  safe(value); const v = object(value);
  if (!Array.isArray(v.roles) || !Array.isArray(v.permissions)) throw invalid();
  const rows = v.permissions.map(item => { const p = object(item); const code = permissions([p.code])[0]!; return { code, name: text(p.name), group: text(p.group), requires: permissions(p.requires) }; });
  if (new Set(rows.map(p => p.code)).size !== rows.length || rows.some(p => p.requires.some(c => !rows.some(r => r.code === c)))) throw invalid();
  return { revision: text(v.revision), roles: v.roles.map(item => { const r = object(item); return { id: text(r.id), name: text(r.name) }; }), permissions: rows };
}
export function resultDto(value: unknown): SystemResult {
  safe(value); const v = object(value);
  const result: SystemResult = { revision: text(v.revision), objectId: text(v.objectId), changed: bool(v.changed), operationId: text(v.operationId) };
  for (const key of ['replayed', 'reauthenticationRequired'] as const) if (key in v) result[key] = bool(v[key]);
  if ('applicationState' in v) { if (!['STORED_ONLY', 'APPLIED'].includes(String(v.applicationState))) throw invalid(); result.applicationState = v.applicationState as 'STORED_ONLY' | 'APPLIED'; result.appliesTo = text(v.appliesTo); }
  if ('auditRevision' in v) { result.auditRevision = text(v.auditRevision); result.archivedThroughSequence = integer(v.archivedThroughSequence); }
  return result;
}
export function receiptDto(value: unknown): SystemOperationReceipt {
  const v = object(value); if (v.status === 'NOT_FOUND' && Object.keys(v).length === 1) return { status: 'NOT_FOUND' };
  if (v.status !== 'FOUND') throw invalid(); return { status: 'FOUND', ...resultDto(v) };
}
export function pageDto<T extends { id: string }>(value: unknown, decode: (v: unknown) => T, expected: { pageNum?: number; pageSize?: number }): SystemPage<T> {
  const v = object(value); if (!Array.isArray(v.items)) throw invalid();
  const items = v.items.map(decode), pageNum = integer(v.pageNum, 1), pageSize = integer(v.pageSize, 1), total = integer(v.total);
  if (pageNum !== (expected.pageNum ?? 1) || pageSize !== (expected.pageSize ?? 20) || ![5, 10, 20, 50].includes(pageSize) || items.length !== Math.min(pageSize, Math.max(0, total - (pageNum - 1) * pageSize)) || new Set(items.map(r => r.id)).size !== items.length) throw invalid();
  return { items, pageNum, pageSize, total, revision: text(v.revision), epoch: text(v.epoch), ...('auditRevision' in v ? { auditRevision: text(v.auditRevision), snapshotSequence: integer(v.snapshotSequence) } : {}) };
}
