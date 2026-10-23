import type { AuthIdentity } from '../types/system';
import { ApiError } from './types';

type SessionOwner = Pick<AuthIdentity, 'sessionId' | 'id' | 'epoch'>;

// Cookie 共享而页面现场独立；绑定仅存内存，不保存认证凭据或新的用户草稿。
export function createHttpSessionBinding() {
  let owner: SessionOwner | null = null;
  let generation = 0;
  let replaced = false;

  function assertReady() {
    if (replaced) throw new ApiError('登录会话已变化，请先明确丢弃旧页面现场再重新进入', 'SESSION_REPLACED');
  }
  function replace(error?: ApiError): never {
    replaced = true;
    throw error ?? new ApiError('其他标签页已更换登录会话，当前页面保持冻结', 'SESSION_REPLACED');
  }
  return {
    get generation() { return generation; },
    get owner() { return owner ? { ...owner } : null; },
    assertReady,
    replace,
    assertGeneration(expected: number) {
      if (expected !== generation) throw new ApiError('旧会话请求已失效，响应未应用', 'SESSION_CHANGED');
    },
    accept(identity: AuthIdentity | null) {
      assertReady();
      // 未登录不释放旧绑定，避免之后新账号继承尚未丢弃的页面现场。
      if (identity && owner && (identity.sessionId !== owner.sessionId || identity.id !== owner.id || identity.epoch !== owner.epoch)) replace();
      if (identity && !owner) owner = { sessionId: identity.sessionId, id: identity.id, epoch: identity.epoch };
      return identity;
    },
    beginMutation() { assertReady(); return ++generation; },
    release() { generation++; owner = null; replaced = false; },
  };
}
