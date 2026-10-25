import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, nextTick, ssrContextKey, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import LoginView from '../src/views/LoginView.vue';
import SystemPasswordDrawer from '../src/components/SystemPasswordDrawer.vue';
import { useAuthStore } from '../src/stores/auth';
import { ApiError } from '../src/services/types';
import type { AuthIdentity } from '../src/types/system';
import type { LocalIdentityCapabilities } from '../src/types/local-identity';
import { all, clientTemplate, find, node, textOf, type HostNode } from './helpers/vue-client';

const probes = vi.hoisted(() => ({
  capabilities: vi.fn(), login: vi.fn(), session: vi.fn(), password: vi.fn(), receipt: vi.fn(), release: vi.fn(),
}));
vi.mock('../src/config/env', async getOriginal => {
  const original = await getOriginal<typeof import('../src/config/env')>();
  return { ...original, env: { ...original.env, mode: 'http' } };
});
vi.mock('../src/services', () => ({
  previewService: { login: probes.login, getSession: probes.session, changeOwnPassword: probes.password, getSystemOperation: probes.receipt },
  releasePageSessionBinding: probes.release, switchIntegrationIdentity: vi.fn(),
}));
vi.mock('../src/services/local-identity-http', () => ({ readLocalIdentityCapabilities: probes.capabilities }));
// 只替换弹层外壳；真实登录模板、密码表单、事件及 auth store 均参与挂载。
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'], setup: (props, { slots }) => () =>
    props.visible ? h('section', { 'data-password-drawer': props.title }, [slots.default?.(), slots.footer?.()]) : null,
  }) };
});
vi.mock('primevue/dialog', () => ({ default: { render: () => null } }));

type InputHost = HostNode & { listeners: Map<string, EventListener[]>; type?: string };
function host(tag: string, text = ''): InputHost {
  const el = Object.assign(node(tag, text), { listeners: new Map<string, EventListener[]>() }) as InputHost;
  // 捕获 v-model 原生 input 监听，避免用 setup ref 赋值代替实际输入事件。
  el.addEventListener = ((name: string, listener: EventListener) => {
    el.listeners.set(name, [...(el.listeners.get(name) ?? []), listener]);
  }) as HostNode['addEventListener'];
  return el;
}
function remove(el: HostNode) {
  if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
  el.parent = null;
}
function insert(el: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(el); el.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, el);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => host(tag), createText: text => host('#text', text), createComment: text => host('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; if (key === 'type') (el as InputHost).type = String(value); },
  insertStaticContent: (text, parent, anchor) => { const el = host('#static', text); insert(el, parent, anchor); return [el, el]; },
});

function capabilities(passwordChangeRequired = false, initialized = true): LocalIdentityCapabilities {
  return { authMode: 'LOCAL_PASSWORD', initialized, passwordChangeRequired, passwordPolicy: { minScalars: 8, maxScalars: 128 },
    capabilities: { passwordMaintenance: true, anonymousRecovery: false } };
}
function identity(id = 'account-a', revision = 'SYS-1'): AuthIdentity {
  return { id, username: id, name: id, sessionId: 'session-' + id, roleId: 'role-reader', roleName: '只读人员',
    permissions: ['situation.view'], epoch: 'epoch-1', revision };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick(); } }
const event = (target: HostNode) => ({ target, preventDefault() {}, stopPropagation() {} });
async function input(el: HostNode, value: string) {
  el.value = value;
  for (const listener of (el as InputHost).listeners.get('input') ?? []) listener(event(el) as unknown as Event);
  const handler = el.props.onInput as ((e: unknown) => void) | undefined;
  handler?.(event(el)); await settle();
}
function submit(form: HostNode) { return (form.props.onSubmit as (e: unknown) => unknown)(event(form)); }
async function click(el: HostNode) {
  expect(el.props.disabled).not.toBe(true);
  await (el.props.onClick as (e: unknown) => unknown)(event(el)); await settle();
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia>;
let auth: ReturnType<typeof useAuthStore>;
beforeAll(async () => {
  await clientTemplate(LoginView, 'src/views/LoginView.vue', 'login-capabilities-render.ts');
  await clientTemplate(SystemPasswordDrawer, 'src/components/SystemPasswordDrawer.vue', 'login-password-render.ts');
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('Document', class {}); vi.stubGlobal('ShadowRoot', class {});
  pinia = createPinia(); setActivePinia(pinia); auth = useAuthStore(); auth.currentPath = '/login';
  probes.capabilities.mockReset().mockResolvedValue(capabilities());
  probes.login.mockReset().mockResolvedValue(identity());
  probes.session.mockReset().mockImplementation(async () => auth.identity);
  probes.password.mockReset(); probes.receipt.mockReset();
});
afterEach(() => {
  app?.unmount(); app = undefined; disposePinia(pinia);
  vi.useRealTimers(); vi.unstubAllGlobals();
});
async function mount(options: { actor?: AuthIdentity; busy?: number; transition?: boolean } = {}) {
  auth.accept(options.actor ?? null); auth.busy = options.busy ?? 0; auth.transition = options.transition ?? false;
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/login', component: LoginView }, { path: '/situation', component: { render: () => null } },
  ] });
  await router.push('/login'); await router.isReady();
  app = renderer.createApp(LoginView); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = host('root'); app.mount(root); await settle();
  const button = (name: string) => find(root, el => el.tag === 'button' && textOf(el) === name)!;
  return { root, router, button, enter: () => find(root, el => el.props.class === 'btn primary login-enter')!,
    loginForm: () => all(root, el => el.tag === 'form')[0]!,
    drawer: () => find(root, el => !!el.props['data-password-drawer']),
  };
}
async function fillPassword(root: HostNode) {
  const form = find(root, el => el.props.class === 'password-form')!;
  const fields = all(form, el => el.tag === 'input');
  await input(fields[0]!, 'current-test-password'); await input(fields[1]!, 'nexttest8'); await input(fields[2]!, 'nexttest8');
  expect(find(form, el => el.tag === 'button' && el.props.type === 'submit')?.props.disabled).toBe(false);
  return form;
}

describe('登录能力稳定重读：真实登录与密码抽屉挂载', () => {
  it('能力未返回时保持禁用，读取成功后才允许普通登录', async () => {
    const read = deferred<LocalIdentityCapabilities>(); probes.capabilities.mockReturnValueOnce(read.promise);
    const f = await mount(); expect(f.enter().props.disabled).toBe(true);
    await submit(f.loginForm()); expect(probes.login).not.toHaveBeenCalled();
    read.resolve(capabilities()); await settle(); expect(f.enter().props.disabled).toBe(false);
    expect(probes.capabilities).toHaveBeenCalledTimes(1);
  });

  it.each([[false, false], [true, true]])('initialized=%s、强制改密=%s仍不能绕过登录限制', async (initialized, required) => {
    probes.capabilities.mockResolvedValue(capabilities(required, initialized));
    const f = await mount({ actor: required ? identity() : undefined });
    expect(f.enter().props.disabled).toBe(true); await submit(f.loginForm());
    expect(probes.login).not.toHaveBeenCalled(); expect(!!f.drawer()).toBe(required);
  });

  it('成功本人改密后即使旧抽屉卸载，也能直接在当前页面用新密码重登', async () => {
    probes.capabilities.mockResolvedValueOnce(capabilities(true)).mockResolvedValue(capabilities());
    const f = await mount({ actor: identity() }), write = deferred<void>();
    probes.password.mockImplementation(async () => {
      auth.busy = 1; auth.accept(null); await settle(); await write.promise;
      auth.busy = 0; return { changed: true, objectId: 'account-a', revision: 'SYS-2', reauthenticationRequired: true };
    });
    const form = await fillPassword(f.root); const pending = submit(form); await settle();
    expect(f.drawer()).toBeUndefined(); expect(probes.capabilities).toHaveBeenCalledTimes(1);
    write.resolve(); await pending; await settle();
    expect(probes.password).toHaveBeenCalledTimes(1); expect(f.enter().props.disabled).toBe(false);
    await input(find(f.root, el => el.props['aria-label'] === '账号')!, 'account-a');
    await input(find(f.root, el => el.props['aria-label'] === '密码')!, 'nexttest8');
    await submit(f.loginForm()); await settle();
    expect(probes.login).toHaveBeenCalledTimes(1);
    expect(probes.login).toHaveBeenCalledWith({ username: 'account-a', password: 'nexttest8' });
    expect(f.router.currentRoute.value.path).toBe('/situation');
    expect(find(f.root, el => el.props['aria-label'] === '密码')?.value).toBe('');
  });

  it.each(['busy', 'transition'] as const)('%s期间挂载不读，结束后只补一次', async field => {
    const f = await mount(field === 'busy' ? { busy: 1 } : { transition: true });
    expect(probes.capabilities).not.toHaveBeenCalled(); expect(f.enter().props.disabled).toBe(true);
    if (field === 'busy') auth.busy = 0; else auth.transition = false;
    await settle(); expect(probes.capabilities).toHaveBeenCalledTimes(1); expect(f.enter().props.disabled).toBe(false);
  });

  it('busy与transition交叠时丢弃旧能力，两者都结束且新读成功才解禁', async () => {
    const f = await mount(), read = deferred<LocalIdentityCapabilities>();
    probes.capabilities.mockReturnValueOnce(read.promise);
    auth.busy = 1; auth.transition = true; await settle(); expect(f.enter().props.disabled).toBe(true);
    auth.busy = 0; await settle(); expect(probes.capabilities).toHaveBeenCalledTimes(1);
    auth.transition = false; await settle(); expect(probes.capabilities).toHaveBeenCalledTimes(2);
    expect(f.enter().props.disabled).toBe(true); read.resolve(capabilities()); await settle();
    expect(f.enter().props.disabled).toBe(false); expect(probes.capabilities).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)('换号后旧能力迟到%s不能覆盖新身份的强制改密状态', async outcome => {
    const old = deferred<LocalIdentityCapabilities>();
    probes.capabilities.mockReturnValueOnce(old.promise).mockResolvedValue(capabilities(true));
    const f = await mount({ actor: identity() });
    await input(find(f.root, el => el.props['aria-label'] === '密码')!, 'old-input');
    const signal = probes.capabilities.mock.calls[0]![0].signal as AbortSignal;
    auth.accept(identity('account-b')); expect(signal.aborted).toBe(true);
    await settle(); expect(find(f.root, el => el.props['aria-label'] === '密码')?.value).toBe('');
    if (outcome === 'resolve') old.resolve(capabilities()); else old.reject(new Error('旧请求失败'));
    await settle(); expect(f.enter().props.disabled).toBe(true); expect(f.drawer()).toBeDefined();
    expect(textOf(f.root)).not.toContain('本地认证服务尚未就绪');
    expect(probes.capabilities).toHaveBeenCalledTimes(2);
  });

  it('同账号代次或revision变化也立即清空并读取当前版本', async () => {
    const f = await mount({ actor: identity() });
    const read = deferred<LocalIdentityCapabilities>(); probes.capabilities.mockReturnValueOnce(read.promise);
    auth.accept(identity('account-a', 'SYS-2')); await settle();
    expect(f.enter().props.disabled).toBe(true); expect(probes.capabilities).toHaveBeenCalledTimes(2);
    read.resolve(capabilities()); await settle(); auth.generation++; await settle();
    expect(probes.capabilities).toHaveBeenCalledTimes(3); expect(f.enter().props.disabled).toBe(false);
  });

  it('卸载即Abort，迟到成功和后续身份/busy变化不能重开读取', async () => {
    const read = deferred<LocalIdentityCapabilities>(); probes.capabilities.mockReturnValueOnce(read.promise);
    const f = await mount(), signal = probes.capabilities.mock.calls[0]![0].signal as AbortSignal;
    app!.unmount(); app = undefined; expect(signal.aborted).toBe(true);
    read.resolve(capabilities(true)); auth.accept(identity('account-b')); auth.busy = 1; auth.busy = 0; await settle();
    expect(probes.capabilities).toHaveBeenCalledTimes(1); expect(f.root.children).toHaveLength(0);
  });

  it('超时Abort后即使服务忽略signal返回，也不应用能力或自动重试', async () => {
    vi.useFakeTimers(); const read = deferred<LocalIdentityCapabilities>(); probes.capabilities.mockReturnValueOnce(read.promise);
    const f = await mount(); await vi.advanceTimersByTimeAsync(15_000);
    expect((probes.capabilities.mock.calls[0]![0].signal as AbortSignal).aborted).toBe(true);
    read.resolve(capabilities()); await settle(); expect(f.enter().props.disabled).toBe(true);
    expect(probes.capabilities).toHaveBeenCalledTimes(1);
  });

  it('新读失败保持禁用且不循环重试，明确重新读取可恢复', async () => {
    probes.capabilities.mockRejectedValueOnce(new Error('服务不可用'));
    const f = await mount(); expect(f.enter().props.disabled).toBe(true);
    expect(textOf(f.root)).toContain('本地认证服务尚未就绪'); await settle();
    expect(probes.capabilities).toHaveBeenCalledTimes(1);
    await click(f.button('重新读取登录状态')); expect(f.enter().props.disabled).toBe(false);
    expect(probes.capabilities).toHaveBeenCalledTimes(2);
  });

  it('SESSION_REPLACED不自动读或复用旧能力，只允许显式清理页面后重新读取', async () => {
    const f = await mount({ actor: identity() });
    auth.accept(null, '其他标签页已更换会话', 'SESSION_REPLACED'); await settle();
    expect(f.enter().props.disabled).toBe(true); expect(probes.capabilities).toHaveBeenCalledTimes(1);
    expect(probes.login).not.toHaveBeenCalled(); expect(auth.sessionReplaced).toBe(true);
    await click(f.button('重新读取登录状态')); expect(probes.release).toHaveBeenCalledTimes(1);
    expect(auth.sessionReplaced).toBe(false); expect(probes.capabilities).toHaveBeenCalledTimes(2);
  });

  it('未知改密回执跨换号保留原请求，补读不重提、不把NOT_FOUND判成功', async () => {
    probes.capabilities.mockResolvedValue(capabilities(true));
    const f = await mount({ actor: identity() });
    probes.password.mockImplementation(async () => {
      auth.busy = 1; auth.accept(null); await settle(); auth.busy = 0;
      throw new ApiError('连接中断', 'NETWORK_ERROR');
    });
    await submit(await fillPassword(f.root)); await settle();
    const requestId = probes.password.mock.calls[0]![0].requestId;
    expect(textOf(f.root)).toContain(requestId); expect(textOf(f.root)).toContain('改密结果待核实');
    auth.accept(identity('account-b')); await settle(); await click(f.button('核实改密回执'));
    expect(probes.receipt).not.toHaveBeenCalled(); expect(textOf(f.root)).toContain(requestId);
    expect(textOf(f.root)).toContain('请使用原账号');
    auth.accept(identity()); await settle(); probes.receipt.mockResolvedValue({ status: 'NOT_FOUND' });
    await click(f.button('核实改密回执'));
    expect(probes.receipt).toHaveBeenCalledWith({ requestId }); expect(textOf(f.root)).toContain('不能判定失败');
    const form = find(f.root, el => el.props.class === 'password-form')!;
    expect(all(form, el => el.tag === 'input').every(el => el.props.disabled === true)).toBe(true);
    await submit(form); expect(probes.password).toHaveBeenCalledTimes(1); expect(f.enter().props.disabled).toBe(true);
  });
});
