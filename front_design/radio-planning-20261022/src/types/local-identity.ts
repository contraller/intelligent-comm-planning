import type { SystemResult } from './system';

export interface LocalIdentityCapabilities {
  authMode: 'LOCAL_PASSWORD' | 'LOCAL_SINGLE_USER'; initialized: boolean; passwordChangeRequired: boolean;
  passwordPolicy: { minScalars: number; maxScalars: number };
  capabilities: { passwordMaintenance: boolean; anonymousRecovery: false; automaticLocalSession?: true; unifiedPermissions?: true; selfReview?: true };
}
export interface OwnPasswordInput { requestId: string; currentPassword: string; newPassword: string }
export interface LocalIdentityActions { changeOwnPassword(input: OwnPasswordInput): Promise<SystemResult> }
export interface PasswordFields { currentPassword: string; operatorPassword: string; newPassword: string }
