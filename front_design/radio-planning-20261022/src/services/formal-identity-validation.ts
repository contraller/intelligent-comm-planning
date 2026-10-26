import { allPermissions, type Permission } from '../config/permissions';
import { ApiError } from './types';

const contractVersion = 'formal-identity-boundary-0.1';
const permissionSet = new Set<unknown>(allPermissions);
const stringFields = [
  'session_id', 'account_id', 'username', 'display_name', 'role_id', 'role_name',
  'identity_revision', 'session_generation',
] as const;
const identityKeys = [
  ...stringFields, 'permissions', 'contract_version', 'integration_mode', 'data_origin',
];

export interface FormalIdentityDto {
  readonly contract_version: typeof contractVersion;
  readonly session_id: string;
  readonly account_id: string;
  readonly username: string;
  readonly display_name: string;
  readonly role_id: string;
  readonly role_name: string;
  readonly permissions: readonly Permission[];
  readonly identity_revision: string;
  readonly session_generation: string;
  readonly integration_mode: false;
  readonly data_origin: 'FORMAL_VERIFIED';
}

const invalid = () => new ApiError('正式身份响应不符合边界契约', 'INVALID_AUTH_RESPONSE');

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => {
    if (typeof key !== 'string' || !keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.enumerable === true && 'value' in descriptor;
  });
}

function nonempty(value: unknown): value is string {
  if (typeof value !== 'string' || /^[\p{White_Space}]|[\p{White_Space}]$/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const scalars = [...value];
  return scalars.length >= 1 && scalars.length <= 512 && scalars.every(scalar => {
    const point = scalar.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
}

export function decodeFormalSession(value: unknown): FormalIdentityDto | null {
  if (value === null) return null;
  if (!record(value) || !exactKeys(value, identityKeys)
    || value.contract_version !== contractVersion || value.integration_mode !== false
    || value.data_origin !== 'FORMAL_VERIFIED' || stringFields.some(key => !nonempty(value[key]))
    || !Array.isArray(value.permissions)) throw invalid();
  const permissions: unknown[] = [...value.permissions];
  if (permissions.some(permission => !nonempty(permission) || !permissionSet.has(permission))
    || new Set(permissions).size !== permissions.length) throw invalid();
  // 只复制已验证的 DTO，不推导角色权限；来源标记不替代服务端身份验证。
  const identity = value as unknown as FormalIdentityDto;
  return Object.freeze({ ...identity, permissions: Object.freeze(permissions as Permission[]) });
}

export function assertFormalSessionBinding(
  identity: FormalIdentityDto | null,
  expected: { sessionId: string; sessionGeneration: string },
): void {
  const current = decodeFormalSession(identity);
  if (current === null) throw new ApiError('正式访问需要登录', 'AUTH_REQUIRED');
  if (!record(expected) || !exactKeys(expected, ['sessionId', 'sessionGeneration'])
    || !nonempty(expected.sessionId) || !nonempty(expected.sessionGeneration)) throw invalid();
  if (current.session_id !== expected.sessionId || current.session_generation !== expected.sessionGeneration) {
    throw new ApiError('正式会话关联或代次已变化', 'SESSION_REPLACED');
  }
}

export function assertFormalPermission(
  identity: FormalIdentityDto | null, requiredPermissions: readonly Permission[],
): void {
  const current = decodeFormalSession(identity);
  if (current === null) throw new ApiError('正式访问需要登录', 'AUTH_REQUIRED');
  if (!Array.isArray(requiredPermissions)) throw invalid();
  const required = [...requiredPermissions];
  if (required.some(permission => !nonempty(permission))
    || new Set(required).size !== required.length) throw invalid();
  if (required.some(permission => !permissionSet.has(permission) || !current.permissions.includes(permission))) {
    throw new ApiError('正式身份无所需权限', 'FORBIDDEN');
  }
}
