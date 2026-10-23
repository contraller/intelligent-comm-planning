import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type Slots } from 'vue';
import { clientTemplate } from './helpers/vue-client';
import { createRouter, createMemoryHistory } from 'vue-router';
import { previewService, releasePageSessionBinding } from '../src/services';
import { useAuthStore } from '../src/stores/auth';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { input, apiJob } from './fixtures/planning-api';
import { useSessionAccess } from '../src/composables/useSessionAccess';
import { router as applicationRouter } from '../src/router';
import LoginView from '../src/views/LoginView.vue';
import SessionAccessDialog from '../src/components/SessionAccessDialog.vue';

// 使用真实 HTTP 分派、访问包装、Pinia、路由守卫；只替换服务器响应和浏览器宿主。
vi.mock('../src/config/env', async getOriginal => {
  const original = await getOriginal<typeof import('../src/config/env')>();
  return { ...original, env: { ...original.env, mode: 'http' } };
});
vi.mock('vue-router', async getOriginal => {
  const original = await getOriginal<typeof import('vue-router')>();
  return { ...original, createWebHashHistory: original.createMemoryHistory };
});
vi.mock('primevue/dialog', () => ({ default: {
  props: ['visible'], setup: (props: { visible: boolean }, { slots }: { slots: Slots }) =>
    () => props.visible ? h('dialog', {}, [slots.default?.(), slots.footer?.()]) : null,
} }));

const dto = (name = 'alpha') => ({ session_id: `session-${name}`, account_id: name, username: name,
  display_name: name, role_id: 'role-resource', role_name: '资源人员',
  permissions: ['resources.view', 'resources.edit'], identity_revision: 'r1', session_generation: 'e1' });
const response = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, message: code ? '服务拒绝' : 'success', data, request_id: 'request-session' }), { status });
let pinia: ReturnType<typeof createPinia>;
let state: { identity: ReturnType<typeof dto> | null };
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
const apps: App[] = [];
beforeEach(() => {
  releasePageSessionBinding(); pinia = createPinia(); setActivePinia(pinia);
  state = { identity: dto() };
  fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/auth/capabilities')) return response({ authMode: 'LOCAL_PASSWORD', initialized: true,
      passwordChangeRequired: false, passwordPolicy: { minScalars: 15, maxScalars: 128 },
      capabilities: { passwordMaintenance: true, anonymousRecovery: false } });
    if (path.endsWith('/auth/session')) return response(state.identity);
    if (path.endsWith('/auth/csrf')) return response({ csrf_token: 'nonce', session_id: state.identity?.session_id ?? null });
    if (path.endsWith('/auth/login')) { state.identity = dto(JSON.parse(String(init?.body)).username); return response(state.identity); }
    if (path.endsWith('/auth/logout')) { state.identity = null; return response(null); }
    throw new Error('非认证请求不应发到服务器');
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  // 内存宿主仍是Node；动态导入的图表不能把它当作完整浏览器DOM。
  vi.stubGlobal('navigator', { userAgent: 'Node.js auth-session-test' });
  vi.stubGlobal('document', { title: '' });
  // 为 v-model 提供宿主类型判定；实际 DOM 和焦点行为仍由浏览器验证。
  vi.stubGlobal('Document', class {});
  vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  disposePinia(pinia); releasePageSessionBinding(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

// 同一 SFC 编译客户端模板执行挂载；内存宿主不验证真实布局、Cookie 或原生 DOM。
async function mountedView(component: Component, filename: string) {
  // 只编译本地副本，不向原导入组件写入客户端 render。
  const mounted = { ...component };
  await clientTemplate(mounted, filename, 'auth-template.ts');
  return mounted;
}
const MountedLogin = await mountedView(LoginView, 'src/views/LoginView.vue');
const MountedDialog = await mountedView(SessionAccessDialog, 'src/components/SessionAccessDialog.vue');
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, any>; style: Record<string, string>; value?: unknown;
  addEventListener: () => void; removeEventListener: () => void;
  getRootNode: () => { activeElement: null };
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [],
  props: {}, style: {}, addEventListener() {}, removeEventListener() {}, getRootNode: () => ({ activeElement: null }) });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({ insert, remove,
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function text(root: HostNode): string { return root.text + root.children.map(text).join(''); }
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const found = find(child, predicate); if (found) return found; }
}
async function mount(component: Component) {
  const route = createRouter({ history: createMemoryHistory(), routes: ['/login', '/resources'].map(path => ({ path, component: { render: () => null } })) });
  await route.push('/login');
  const root = node('root'), app = renderer.createApp(component); app.use(pinia); app.use(route); app.provide(ssrContextKey, {});
  app.mount(root); apps.push(app); await nextTick(); return { root, route };
}
async function workspace() {
  const auth = useAuthStore(); expect(await auth.check()).toBe(true); auth.currentPath = '/resources';
  const editor = useResourceEditStore();
  editor.form = { kind: 'device', id: 'DV-0001', fields: { antennaHeightM: '19' }, initial: { antennaHeightM: '10' } };
  await mount({ setup() { useSessionAccess(); return () => h(MountedDialog); } });
  return { auth, editor };
}

describe('HTTP 共享会话与实际状态层', () => {
  it('换号只冻结任务与规划现场，明确丢弃才清理共享状态',async()=>{
    const {auth}=await workspace(),task=useTaskInputStore(),planning=usePlanningApiStore();
    task.draft=input();task.taskId='T1';await nextTick();planning.job=apiJob();
    state.identity=dto('beta');await auth.check();expect(task.draft).not.toBeNull();expect(planning.job?.id).toBe('J1');
    expect(await auth.discardRestricted()).toBe(true);expect(task.draft).toBeNull();expect(planning.job).toBeNull();
  });
  it('业务未接入仅报能力错误，不清除已登录身份', async () => {
    const auth = useAuthStore(); await auth.check();
    await expect(previewService.loadPreview()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(auth.identity?.id).toBe('alpha'); expect(auth.error).toBe(''); expect(auth.blocked).toBe(false);
  });
  it('业务前置会话读取失败冻结，不能沿用缓存权限继续执行', async () => {
    const { auth, editor } = await workspace(); fetcher.mockRejectedValueOnce(new TypeError('offline'));
    await expect(previewService.loadPreview()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(auth.blocked).toBe(true); expect(auth.can('resources.edit')).toBe(false); expect(editor.form?.fields.antennaHeightM).toBe('19');
  });
  it('其他标签换号后焦点校验冻结旧输入，重复校验不能自动接纳新身份', async () => {
    const { auth, editor } = await workspace(); state.identity = dto('beta');
    const focus = vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === 'focus')![1] as () => void;
    focus(); await vi.waitFor(() => expect(auth.sessionReplaced).toBe(true));
    expect(auth.identity).toBeNull(); expect(auth.blocked).toBe(true); expect(editor.form?.fields.antennaHeightM).toBe('19');
    expect(await auth.check()).toBe(false); expect(auth.identity).toBeNull();
    await expect(previewService.setDeviceAvailability({ baseRevision: 'r', requestId: 'x', ids: ['DV-0001'], availability: 'OFF_SHELF' })).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  });
  it('明确丢弃清理各页面现场后接纳新会话，不退出新账号', async () => {
    const { auth, editor } = await workspace(); state.identity = dto('beta'); await auth.check();
    expect(await auth.discardRestricted()).toBe(true);
    expect(editor.form).toBeNull(); expect(auth.identity?.id).toBe('beta'); expect(auth.sessionReplaced).toBe(false); expect(auth.blocked).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/logout'))).toBe(false);
    expect(state.identity?.account_id).toBe('beta');
  });
  it('会话过期保留现场；明确丢弃后停留未登录，不自动发送退出', async () => {
    const { auth, editor } = await workspace(); state.identity = null; await auth.check();
    expect(auth.blocked).toBe(true); expect(editor.form).not.toBeNull();
    expect(await auth.discardRestricted()).toBe(true); expect(editor.form).toBeNull(); expect(auth.identity).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/logout'))).toBe(false);
  });
  it('原会话权限恢复可解冻；身份变化不得通过赋值新权限解冻', async () => {
    const { auth, editor } = await workspace(); state.identity = { ...dto(), permissions: [], identity_revision: 'r2' }; await auth.check();
    expect(auth.blocked).toBe(true); expect(editor.form).not.toBeNull();
    state.identity = dto(); expect(await auth.check()).toBe(true); expect(auth.blocked).toBe(false);
    state.identity = dto('beta'); await auth.check();
    auth.accept({ sessionId: 'session-beta', id: 'beta', username: 'beta', name: 'B', roleId: 'r', roleName: 'R', epoch: 'e1', revision: 'r1', permissions: ['resources.view'] });
    expect(auth.blocked).toBe(true); expect(auth.identity).toBeNull();
  });
  it('退出失败保留输入与服务端会话，成功才清理', async () => {
    const { auth, editor } = await workspace();
    auth.registerLeave(async () => true, () => true);
    fetcher.mockResolvedValueOnce(response(dto())).mockResolvedValueOnce(response({ csrf_token: 'nonce', session_id: 'session-alpha' })).mockRejectedValueOnce(new TypeError('offline'));
    expect(await auth.leaveSession()).toBe(false); expect(editor.form).not.toBeNull(); expect(state.identity?.account_id).toBe('alpha');
    expect(await auth.leaveSession()).toBe(true); expect(editor.form).toBeNull(); expect(auth.identity).toBeNull(); expect(state.identity).toBeNull();
  });
  it('取消退出不请求服务端，不清理草稿', async () => {
    const { auth, editor } = await workspace(); auth.registerLeave(async () => false, () => true);
    const count = fetcher.mock.calls.length; expect(await auth.leaveSession()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(count); expect(editor.form).not.toBeNull();
  });
  it('写操作期间不接受明确丢弃，迟到校验不覆盖重新进入后的身份', async () => {
    const { auth, editor } = await workspace(); auth.busy = 1;
    expect(await auth.discardRestricted()).toBe(false); expect(editor.form).not.toBeNull(); auth.busy = 0;
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = auth.check(); state.identity = dto('beta');
    expect(await auth.discardRestricted()).toBe(true); finish(response(dto())); await old;
    expect(auth.identity?.id).toBe('beta'); expect(auth.error).toBe('');
  });
  it('实际路由守卫阻止换号后的自动跳转，即使没有脏表单', async () => {
    const auth = useAuthStore(); await auth.check(); await applicationRouter.push('/resources');
    auth.currentPath = '/resources'; expect(auth.hasUnsaved()).toBe(false);
    state.identity = dto('beta'); await applicationRouter.push('/login');
    expect(applicationRouter.currentRoute.value.path).toBe('/resources'); expect(auth.sessionReplaced).toBe(true);
    await auth.discardRestricted(); await applicationRouter.push('/resources');
    expect(auth.identity?.id).toBe('beta'); expect(auth.error).toBe('');
  // 真实资源视图首次动态加载含地图/图表模块，F盘冷缓存允许有限加载余量。
  }, 30_000);
});

describe('HTTP 登录与冻结界面挂载', () => {
  it('HTTP 登录页不请求演示目录、不展示公开口令或恢复入口', async () => {
    state.identity = null; const catalog = vi.spyOn(previewService, 'getLoginCatalog');
    const { root } = await mount(MountedLogin);
    expect(catalog).not.toHaveBeenCalled(); expect(text(root)).toContain('标签页共享登录');
    expect(text(root)).not.toContain('公开演示口令'); expect(text(root)).not.toContain('恢复损坏');
    expect(find(root, n => n.tag === 'input' && n.props['aria-label'] === '账号')).toBeDefined();
  });
  it('实际登录表单发送认证请求，完成后清空密码并跳到有权页面', async () => {
    state.identity = null; const { root, route } = await mount(MountedLogin);
    await vi.waitFor(() => expect(find(root, n => n.tag === 'button' && text(n).startsWith('登录工作区'))?.props.disabled).toBe(false));
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/capabilities'))).toBe(true);
    const account = find(root, n => n.tag === 'input' && n.props['aria-label'] === '账号')!;
    const password = find(root, n => n.tag === 'input' && n.props['aria-label'] === '密码')!;
    account.props['onUpdate:modelValue']('beta'); password.props['onUpdate:modelValue']('test-password'); await nextTick();
    await find(root, n => n.tag === 'form')!.props.onSubmit({ preventDefault() {} }); await nextTick();
    const loginRequest = fetcher.mock.calls.find(([url]) => String(url).endsWith('/auth/login'));
    expect(loginRequest).toBeDefined(); expect(JSON.parse(String(loginRequest![1]?.body)).username).toBe('beta');
    expect(useAuthStore().identity?.id).toBe('beta'); expect(route.currentRoute.value.path).toBe('/resources'); expect(password.value).toBe('');
  });
  it('冻结对话框明确丢弃按钮清理现场且不向新身份发送退出', async () => {
    const { auth, editor } = await workspace(); state.identity = dto('beta'); await auth.check();
    const { root } = await mount(MountedDialog); expect(text(root)).toContain('清理本页不会退出其他标签页的新账号');
    const button = find(root, n => n.tag === 'button' && text(n).startsWith('明确丢弃输入'))!;
    await button.props.onClick(); await nextTick();
    expect(editor.form).toBeNull(); expect(auth.identity?.id).toBe('beta');
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/logout'))).toBe(false);
  });
});
