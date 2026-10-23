import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { allPermissions } from '../src/config/permissions';
import { ApiError } from '../src/services/types';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';

const service = vi.hoisted(() => ({ loadSystemOptions: vi.fn(), queryAccountSummaries: vi.fn(), queryRoleSummaries: vi.fn(), queryParameterSummaries: vi.fn(), queryOperationSummaries: vi.fn(), getSystemAccount: vi.fn(), getSystemRole: vi.fn(), getSystemParameter: vi.fn(), saveSystemAccount: vi.fn(), saveSystemRole: vi.fn(), saveSystemParameter: vi.fn(), setSystemAccountState: vi.fn(), getSession: vi.fn(), getSystemOperation: vi.fn(), changeOwnPassword: vi.fn(), maintainSystemAccountPassword: vi.fn(), resetSystemParameters: vi.fn(), archiveSystemLogs: vi.fn(), login: vi.fn(), getLoginCatalog: vi.fn() }));
const capabilityReader = vi.hoisted(() => vi.fn());
vi.mock('../src/services/local-identity-http', () => ({ readLocalIdentityCapabilities: capabilityReader }));
vi.mock('../src/services', () => ({ previewService: service, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/config/env', () => ({ env: { mode: 'http', apiBaseUrl: '/api/v1', sampleData: true } }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { h } = await import('vue');
  return { default: { props: ['visible'], setup(props: {visible:boolean}, context: {slots:Record<string,()=>import('vue').VNode[]>}) { return () => props.visible ? h('section', [context.slots.default?.(), context.slots.footer?.()]) : null; } } };
});
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import SystemPasswordDrawer from '../src/components/SystemPasswordDrawer.vue';
import LoginView from '../src/views/LoginView.vue';
import { all, clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';
let pinia: ReturnType<typeof createPinia>;
let app: App | undefined;
beforeAll(async () => {
  await clientTemplate(SystemPasswordDrawer, 'src/components/SystemPasswordDrawer.vue', 'r2-p05-password-render.ts');
  await clientTemplate(LoginView, 'src/views/LoginView.vue', 'r2-p05-login-render.ts');
});
const identity = () => ({ id: 'ACC-one', sessionId: 'SID-one', username: 'operator', name: '维护', roleId: 'ROLE-one', roleName: '维护角色', epoch: 'session-generation', revision: '1', permissions: [...allPermissions] });
const row = () => ({ id: 'ACC-two', username: 'viewer', name: '查看人员', department: '测试', roleId: 'ROLE-one', enabled: true, roleName: '角色', lastLogin: null });
const result = () => ({ revision: 'SYS-2', objectId: 'ACC-two', changed: true, operationId: 'OP-one' });
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
  vi.resetAllMocks(); pinia = createPinia(); setActivePinia(pinia); useAuthStore().accept(identity());
  service.getSession.mockResolvedValue(identity());
  capabilityReader.mockResolvedValue({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: false, passwordPolicy: { minScalars: 15, maxScalars: 128 }, capabilities: { passwordMaintenance: true, anonymousRecovery: false } });
  service.loadSystemOptions.mockResolvedValue({ revision: 'SYS-1', roles: [{ id: 'ROLE-one', name: '角色' }], permissions: [] });
  service.queryAccountSummaries.mockResolvedValue({ items: [row()], total: 1, pageNum: 1, pageSize: 20, revision: 'SYS-1' });
  service.queryOperationSummaries.mockResolvedValue({ items: [], total: 0, pageNum: 1, pageSize: 20, revision: 'AUD-3', snapshotSequence: 3 });
  service.getSystemAccount.mockImplementation(async () => ({ revision: 'SYS-1', account: row() }));
  service.saveSystemAccount.mockResolvedValue(result());
});
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
describe('本地系统页面状态闭环', () => {
  it('初始密码不进入 Pinia，资料保存走真实适配签名', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount(); store.accountForm!.username = 'viewer'; store.accountForm!.name = '查看人员'; store.accountForm!.department = '测试';
    const password = crypto.randomUUID(); expect(await store.save(false, { initialPassword: password })).toBe(true);
    expect(service.saveSystemAccount).toHaveBeenCalledWith(expect.objectContaining({ initialPassword: password, requestId: expect.any(String) }));
    expect(JSON.stringify(pinia.state.value)).not.toContain(password); expect(store.accountForm).toBeNull();
  });
  it('超时保留请求编号与输入，核实前禁止重复提交', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '保留输入';
    service.saveSystemAccount.mockRejectedValueOnce(new ApiError('超时', 'REQUEST_TIMEOUT'));
    expect(await store.save()).toBe(false); const requestId = store.pendingMutation!.requestId;
    expect(store.accountForm!.name).toBe('保留输入'); expect(await store.save()).toBe(false); expect(service.saveSystemAccount).toHaveBeenCalledTimes(1);
    service.getSystemOperation.mockResolvedValueOnce({ status: 'NOT_FOUND' }); expect(await store.reconcilePending()).toBe(false); expect(store.pendingMutation!.requestId).toBe(requestId);
    service.getSystemOperation.mockResolvedValueOnce({ status: 'FOUND', ...result() }); expect(await store.reconcilePending()).toBe(true); expect(store.pendingMutation).toBeNull(); expect(store.accountForm).toBeNull();
  });
  it('确定的版本拒绝保留普通输入，不挂结果未知状态', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '输入';
    service.saveSystemAccount.mockRejectedValueOnce(new ApiError('版本变化', 1203)); expect(await store.save()).toBe(false); expect(store.pendingMutation).toBeNull(); expect(store.accountForm!.name).toBe('输入');
  });
  it('迟到详情不能替换新表单', async () => {
    const store = useSystemStore(); await store.load(); let resolve!: (v: any) => void;
    service.getSystemAccount.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const reading = store.openAccount({ id: 'ACC-two' }); await settle(); await store.openAccount(); store.accountForm!.name = '新输入'; resolve({ revision: 'OLD', account: row() }); await reading;
    expect(store.accountForm!.id).toBeNull(); expect(store.accountForm!.name).toBe('新输入');
  });
  it('他人密码维护只保留目标，不保存密码值', async () => {
    const store = useSystemStore(); await store.load(); await store.openPassword({ id: 'ACC-two' }); service.maintainSystemAccountPassword.mockResolvedValue(result());
    const fields = { currentPassword: '', operatorPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() };
    await store.submitPassword(fields); expect(JSON.stringify(pinia.state.value)).not.toContain(fields.newPassword); expect(JSON.stringify(pinia.state.value)).not.toContain(fields.operatorPassword);
    expect(service.maintainSystemAccountPassword).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'ACC-two', baseRevision: 'SYS-1', operatorPassword: fields.operatorPassword }));
  });
  it('正式重置恢复参数，日志归档保留快照和历史', async () => {
    const store = useSystemStore(); await store.load(); service.resetSystemParameters.mockResolvedValue(result());
    const resetting = store.reset('system'); await settle(); expect(store.decision!.message).not.toContain('恢复初始账号'); store.answer('save'); await resetting;
    expect(service.resetSystemParameters).toHaveBeenCalledWith(expect.objectContaining({ parameterIds: ['PAR-01', 'PAR-02'], confirm: 'RESTORE_PARAMETER_DEFAULTS' }));
    await store.changeTab('logs'); service.archiveSystemLogs.mockResolvedValue(result()); const archive = store.reset('logs'); await settle(); store.answer('save'); await archive;
    expect(service.archiveSystemLogs).toHaveBeenCalledWith(expect.objectContaining({ baseAuditRevision: 'AUD-3', throughSequence: 3, confirm: 'ARCHIVE_LOG_VIEW' }));
  });
  it.each(['SELF', 'ADMIN'] as const)('真实密码抽屉 %s 提交后清空局部输入', async mode => {
    const submit = vi.fn().mockResolvedValue({ ...result(), reauthenticationRequired: true }), saved = vi.fn(), dirty = vi.fn();
    const root = node('root'); app = renderer.createApp({ render: () => h(SystemPasswordDrawer, { visible: true, mode, submit, onSaved: saved, onDirtyChange: dirty }) }); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root);
    const inputs = all(root, n => n.tag === 'input'), current = crypto.randomUUID(), next = crypto.randomUUID();
    [current, next, next].forEach((value, i) => (inputs[i]!.props['onUpdate:modelValue'] as (v:string)=>void)(value)); await settle();
    expect(dirty).toHaveBeenLastCalledWith(true);
    await (find(root, n => n.tag === 'form')!.props.onSubmit as (e:unknown)=>Promise<void>)({ preventDefault() {} }); await settle();
    expect(submit).toHaveBeenCalledTimes(1); expect(submit).toHaveBeenCalledWith({ currentPassword: mode === 'SELF' ? current : '', operatorPassword: mode === 'ADMIN' ? current : '', newPassword: next });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ reauthenticationRequired: true })); expect(inputs.every(input => input.value === '')).toBe(true); expect(dirty).toHaveBeenLastCalledWith(false);
  });
  it('密码抽屉失败不显示异常中的秘密，并阻止重复提交', async () => {
    const secret = crypto.randomUUID(); let reject!: (reason:Error)=>void;
    const submit = vi.fn().mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    const root = node('root'); app = renderer.createApp({ render: () => h(SystemPasswordDrawer, { visible: true, mode: 'SELF', submit }) }); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root);
    const inputs = all(root, n => n.tag === 'input'); [secret, secret, secret].forEach((v, i) => (inputs[i]!.props['onUpdate:modelValue'] as (v:string)=>void)(v)); await settle();
    const form = find(root, n => n.tag === 'form')!, event = { preventDefault() {} };
    const first = (form.props.onSubmit as (e:unknown)=>Promise<void>)(event); await settle(); await (form.props.onSubmit as (e:unknown)=>Promise<void>)(event);
    expect(submit).toHaveBeenCalledTimes(1); reject(new Error(secret)); await first; await settle();
    expect(textOf(root)).not.toContain(secret); expect(textOf(root)).toContain('敏感输入已清空'); expect(inputs.every(input => input.value === '')).toBe(true);
  });
  it('真实Login模板无默认凭据，正式登录后必须完成首次改密', async () => {
    useAuthStore().accept(null); service.login.mockResolvedValue(identity());
    capabilityReader.mockResolvedValueOnce({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: false }).mockResolvedValueOnce({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: true });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/login', component: LoginView }, { path: '/system', component: { render: () => null } }] });
    await router.push('/login'); await router.isReady(); const root = node('root');
    app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
    const inputs = all(root, n => n.tag === 'input'); expect(inputs[0]!.value).toBe(''); expect(inputs[1]!.value).toBe('');
    const password = crypto.randomUUID(); (inputs[0]!.props['onUpdate:modelValue'] as (v:string)=>void)('operator'); (inputs[1]!.props['onUpdate:modelValue'] as (v:string)=>void)(password); await settle();
    await (find(root, n => n.tag === 'form')!.props.onSubmit as (e:unknown)=>Promise<void>)({ preventDefault() {} }); await settle();
    expect(service.login).toHaveBeenCalledWith({ username: 'operator', password }); expect(router.currentRoute.value.path).toBe('/login');
    expect(inputs[1]!.value).toBe(''); expect(all(root, n => n.tag === 'input').length).toBe(5); expect(service.getLoginCatalog).not.toHaveBeenCalled(); expect(textOf(root)).not.toContain('公开演示口令');
  });
  it('未初始化的真实Login模板禁用登录且不自动创建管理员', async () => {
    useAuthStore().accept(null); capabilityReader.mockResolvedValue({ authMode: 'LOCAL_PASSWORD', initialized: false, passwordChangeRequired: false });
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/login', component: LoginView }] }); await router.push('/login'); await router.isReady();
    const root = node('root'); app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
    expect(find(root, n => n.tag === 'button' && textOf(n).includes('登录工作区'))!.props.disabled).toBe(true);
    expect(textOf(root)).toContain('系统尚未显式初始化'); expect(service.login).not.toHaveBeenCalled(); expect(service.getLoginCatalog).not.toHaveBeenCalled();
  });
});
