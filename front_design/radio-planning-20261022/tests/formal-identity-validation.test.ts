import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../src/config/permissions';
import {
  assertFormalPermission, assertFormalSessionBinding, decodeFormalSession,
  type FormalIdentityDto,
} from '../src/services/formal-identity-validation';
import { ApiError } from '../src/services/types';

// 所有正式标记均为构造测试输入，不证明任何真实身份源已接入。
function dto(changes: Record<string, unknown> = {}) {
  return {
    contract_version: 'formal-identity-boundary-0.1', session_id: 'fixture-session',
    account_id: 'fixture-account', username: 'fixture-user', display_name: '构造主体',
    role_id: 'fixture-role', role_name: '构造角色', permissions: ['resources.view'],
    identity_revision: 'fixture-identity-1', session_generation: 'fixture-generation-1',
    integration_mode: false, data_origin: 'FORMAL_VERIFIED', ...changes,
  };
}
const binding = { sessionId: 'fixture-session', sessionGeneration: 'fixture-generation-1' };

function reject(action: () => unknown, code = 'INVALID_AUTH_RESPONSE') {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ code });
}

afterEach(() => vi.unstubAllGlobals());

describe('正式 DTO 结构与来源边界', () => {
  it('匿名保持 null，不补规划员', () => {
    expect(decodeFormalSession(null)).toBeNull();
    reject(() => assertFormalSessionBinding(null, binding), 'AUTH_REQUIRED');
    reject(() => assertFormalPermission(null, []), 'AUTH_REQUIRED');
  });

  it('复制并冻结身份与权限，重复解码不修改输入', () => {
    const input = dto();
    const original = structuredClone(input);
    const result = decodeFormalSession(input)!;
    expect(input).toEqual(original);
    expect(result).toEqual(decodeFormalSession(input));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.permissions)).toBe(true);
    input.permissions.push('resources.device.edit');
    expect(result.permissions).toEqual(['resources.view']);
  });

  it.each(['session_id', 'account_id', 'username', 'display_name', 'role_id', 'role_name', 'identity_revision', 'session_generation'])(
    '%s 拒绝空白、控制字符、错误类型和超长标量', field => {
      for (const value of [undefined, null, true, 1, [], {}, '', ' ', ' a', 'a ', 'a\n', 'a\0b', 'a\x7fb', '\ud800', 'x'.repeat(513)]) {
        reject(() => decodeFormalSession(dto({ [field]: value })));
      }
    },
  );

  it.each([
    undefined, [], 'identity', 1, false, new Date(), { session_id: 'missing' },
    dto({ contract_version: 'next' }), dto({ integration_mode: true }), dto({ integration_mode: 0 }),
    dto({ integration_mode: null }), dto({ data_origin: 'SYNTHETIC_INTEGRATION' }),
    dto({ data_origin: 'UNKNOWN' }), dto({ data_origin: null }), dto({ extra: 'not-allowed' }),
    dto({ permissions: 'resources.view' }), dto({ permissions: ['resources.view', 'resources.view'] }),
    dto({ permissions: ['not.registered'] }), dto({ permissions: [false] }), dto({ permissions: [[]] }),
    dto({ permissions: [' resources.view'] }), dto({ permissions: new Array(1) }),
  ])('拒绝无效结构与来源 #%#', value => reject(() => decodeFormalSession(value)));

  it.each(['contract_version', 'integration_mode', 'data_origin', 'permissions'])('必须显式包含 %s', field => {
    const value: Record<string, unknown> = dto();
    delete value[field];
    reject(() => decodeFormalSession(value));
  });

  it('拒绝原样联调 DTO、继承字段和隐藏的多余字段', () => {
    const integration: Record<string, unknown> = dto({ integration_mode: true });
    delete integration.contract_version;
    delete integration.data_origin;
    reject(() => decodeFormalSession(integration));
    reject(() => decodeFormalSession(Object.create(dto())));
    reject(() => decodeFormalSession({ ...dto(), [Symbol('unexpected')]: true }));
    reject(() => decodeFormalSession(Object.defineProperty(dto(), 'hidden', { value: true })));
  });

  it('拒绝已知字段的访问器和非枚举属性，不执行访问器', () => {
    const getter = vi.fn(() => false);
    reject(() => decodeFormalSession(Object.defineProperty(dto(), 'integration_mode', { get: getter })));
    expect(getter).not.toHaveBeenCalled();
    reject(() => decodeFormalSession(Object.defineProperty(dto(), 'session_id', { enumerable: false })));
  });

  it('权限先复制再校验，不把后续变化带入已验证结果', () => {
    let reads = 0;
    const permissions = Object.defineProperty(['resources.view'], 0, {
      get: () => ++reads === 1 ? 'resources.view' : 'not.registered',
    });
    expect(decodeFormalSession(dto({ permissions }))?.permissions).toEqual(['resources.view']);
    expect(reads).toBe(1);
  });

  it.each(['x'.repeat(512), '\u{1f600}'.repeat(512), '中é', 'a\u0085b'])(
    '按 Unicode 标量计数并保留非 ASCII #%#', value => {
      expect(decodeFormalSession(dto({ display_name: value }))?.display_name).toBe(value);
    },
  );

  it.each(['\u{1f600}'.repeat(513), '\u0085a', 'a\u00a0', '\u3000a', 'a\u2028', '\udfff'])(
    '拒绝 Unicode 边缘空白、代理项和超长标量 #%#', value => reject(() => decodeFormalSession(dto({ display_name: value }))),
  );
});

describe('正式会话绑定与权限前置校验', () => {
  it('当前会话与代次通过；同账户的旧会话或旧代次拒绝', () => {
    const identity = decodeFormalSession(dto());
    expect(assertFormalSessionBinding(identity, binding)).toBeUndefined();
    reject(() => assertFormalSessionBinding(identity, { ...binding, sessionId: 'old-session' }), 'SESSION_REPLACED');
    reject(() => assertFormalSessionBinding(identity, { ...binding, sessionGeneration: 'old-generation' }), 'SESSION_REPLACED');
  });

  it.each([null, {}, { ...binding, extra: true }, { ...binding, sessionId: 1 }, { ...binding, sessionGeneration: '' }])(
    '绑定条件必须有效 #%#', value => reject(() => assertFormalSessionBinding(decodeFormalSession(dto()), value as typeof binding)),
  );

  it('必须拥有全部已登记权限，空权限和管理员角色名均不产生授权', () => {
    const identity = decodeFormalSession(dto());
    expect(assertFormalPermission(identity, ['resources.view'])).toBeUndefined();
    expect(assertFormalPermission(identity, [])).toBeUndefined();
    reject(() => assertFormalPermission(identity, ['resources.view', 'resources.device.edit']), 'FORBIDDEN');
    reject(() => assertFormalPermission(identity, ['not.registered' as Permission]), 'FORBIDDEN');
    const empty = decodeFormalSession(dto({ role_name: '管理员', permissions: [] }));
    expect(empty?.permissions).toEqual([]);
    reject(() => assertFormalPermission(empty, ['resources.view']), 'FORBIDDEN');
  });

  it.each([null, 'resources.view', [true], ['resources.view', 'resources.view'], [''], new Array(1)])(
    '运行时拒绝非法权限条件 #%#', value => reject(() => assertFormalPermission(decodeFormalSession(dto()), value as readonly Permission[])),
  );

  it('类型断言不能绕过来源或 DTO 结构校验', () => {
    for (const value of [dto({ integration_mode: true }), dto({ data_origin: 'UNKNOWN' }), dto({ permissions: ['not.registered'] })]) {
      const forged = value as unknown as FormalIdentityDto;
      reject(() => assertFormalSessionBinding(forged, binding));
      reject(() => assertFormalPermission(forged, []));
    }
  });

  it('前置校验不访问网络、Cookie 或浏览器存储', () => {
    const fail = vi.fn(() => { throw new Error('unexpected side effect'); });
    vi.stubGlobal('fetch', fail);
    vi.stubGlobal('document', { get cookie() { return fail(); } });
    vi.stubGlobal('localStorage', { getItem: fail, setItem: fail });
    vi.stubGlobal('sessionStorage', { getItem: fail, setItem: fail });
    const identity = decodeFormalSession(dto());
    assertFormalSessionBinding(identity, binding);
    assertFormalPermission(identity, ['resources.view']);
    expect(fail).not.toHaveBeenCalled();
  });
});
