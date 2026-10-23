import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { allPermissions } from '../src/config/permissions';
import { ApiError } from '../src/services/types';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';

const service = vi.hoisted(() => ({ loadSystemOptions: vi.fn(), queryAccountSummaries: vi.fn(), queryRoleSummaries: vi.fn(), queryParameterSummaries: vi.fn(), queryOperationSummaries: vi.fn(), getOperationEvent: vi.fn(), getSystemAccount: vi.fn(), getSystemRole: vi.fn(), getSystemParameter: vi.fn(), saveSystemAccount: vi.fn(), saveSystemRole: vi.fn(), saveSystemParameter: vi.fn(), setSystemAccountState: vi.fn(), getSession: vi.fn(), getSystemOperation: vi.fn(), changeOwnPassword: vi.fn(), maintainSystemAccountPassword: vi.fn(), resetSystemParameters: vi.fn(), archiveSystemLogs: vi.fn(), login: vi.fn(), getLoginCatalog: vi.fn() }));
const capabilityReader = vi.hoisted(() => vi.fn());
vi.mock('../src/services/local-identity-http', () => ({ readLocalIdentityCapabilities: capabilityReader }));
vi.mock('../src/services', () => ({ previewService: service, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/config/env', () => ({ env: { mode: 'http', apiBaseUrl: '/api/v1', sampleData: true } }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { h } = await import('vue');
  return { default: { props: ['visible', 'title'], emits: ['update:visible'], setup(props: {visible:boolean;title?:string}, context: {slots:Record<string,()=>import('vue').VNode[]>;emit:(event:'update:visible',value:boolean)=>void}) { return () => props.visible ? h('section', [h('button', { 'aria-label': '关闭' + props.title, onClick: () => context.emit('update:visible', false) }, '关闭'), context.slots.default?.(), context.slots.footer?.()]) : null; } } };
});
vi.mock('../src/components/AppTable.vue', async () => {
  const { h } = await import('vue');
  return { default: { props: ['rows'], emits: ['select'], setup(props: {rows:{id:string}[]}, context:{emit:(event:'select',row:{id:string})=>void}) { return () => h('div', props.rows.map(row => h('button', { onClick: () => context.emit('select', row) }, row.id))); } } };
});
vi.mock('../src/components/SystemAccountDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SystemRoleDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/RequestState.vue', () => ({ default: { render: () => null } }));
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { useRuntimeParametersStore } from '../src/stores/runtime-parameters';
import type { RuntimeParametersSnapshot } from '../src/types/runtime-parameters';
import SystemParameterDrawer from '../src/components/SystemParameterDrawer.vue';
import SystemPasswordDrawer from '../src/components/SystemPasswordDrawer.vue';
import LoginView from '../src/views/LoginView.vue';
import SystemView from '../src/views/SystemView.vue';
import { all, clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';
let pinia: ReturnType<typeof createPinia>;
let app: App | undefined;
beforeAll(async () => {
  await clientTemplate(SystemParameterDrawer, 'src/components/SystemParameterDrawer.vue', 'r2-p05-parameter-render.ts');
  await clientTemplate(SystemPasswordDrawer, 'src/components/SystemPasswordDrawer.vue', 'r2-p05-password-render.ts');
  await clientTemplate(LoginView, 'src/views/LoginView.vue', 'r2-p05-login-render.ts');
  await clientTemplate(SystemView, 'src/views/SystemView.vue', 'r2-p05-system-render.ts');
});
const identity = () => ({ id: 'ACC-one', sessionId: 'SID-one', username: 'operator', name: '维护', roleId: 'ROLE-one', roleName: '维护角色', epoch: 'session-generation', revision: '1', permissions: [...allPermissions] });
const row = () => ({ id: 'ACC-two', username: 'viewer', name: '查看人员', department: '测试', roleId: 'ROLE-one', enabled: true, roleName: '角色', lastLogin: null });
const result = () => ({ revision: 'SYS-2', objectId: 'ACC-two', changed: true, operationId: 'OP-one' });
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {}); vi.stubGlobal('window', new EventTarget());
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
function mountParameter(id = 'PAR-02') {
  useSystemStore().parameterForm = { id, name: '测试参数', value: id === 'PAR-01' ? 30 : 15, unit: 's', description: '当前服务端参数', readonly: false,
    min: 1, max: id === 'PAR-01' ? 3600 : 120, applicationState: 'STORED_ONLY', appliesTo: '明确消费者' };
  const root = node('root'); app = renderer.createApp(SystemParameterDrawer); app.use(pinia); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root);
  return root;
}
function bindRuntime() {
  const snapshot: RuntimeParametersSnapshot = { version: 'runtime-parameters-v1', epoch: 'runtime-one', revision: 'SYS-2', values: { 'PAR-01': 30, 'PAR-02': 15 } };
  const client = { getRuntimeParameters: vi.fn().mockResolvedValue(snapshot) }, runtime = useRuntimeParametersStore();
  runtime.bind(client, () => useAuthStore().identity?.sessionId ?? null);
  return { runtime, client, snapshot };
}
describe('本地系统页面状态闭环', () => {
  it('参数存储不冒称运行生效，无快照不补默认或承诺其他标签', async () => {
    const root = mountParameter(); await settle();
    expect(textOf(root)).toContain('服务端参数已存储'); expect(textOf(root)).toContain('本标签未应用');
    expect(textOf(root)).toContain('当前无可核实的运行参数快照'); expect(textOf(root)).toContain('不代表其他标签');
    expect(textOf(root)).not.toContain('尚未接入运行消费者'); expect(textOf(root)).not.toContain('实际值');
  });
  it.each([['PAR-01', 'gis.device-status-directory', 'http.request-timeout'], ['PAR-02', 'http.request-timeout', 'http.timeout']])(
    '%s只认准确consumer及同快照版本的本标签反馈', async (id, consumer, wrongConsumer) => {
      const { runtime, snapshot } = bindRuntime(); await runtime.refresh(); const root = mountParameter(id);
      expect(runtime.reportApplied(wrongConsumer, snapshot.epoch, snapshot.revision)).toBe(true); await settle();
      expect(textOf(root)).toContain('本标签未应用');
      expect(runtime.reportApplied(consumer, 'old-epoch', snapshot.revision)).toBe(false);
      expect(runtime.reportApplied(consumer, snapshot.epoch, 'SYS-1')).toBe(false); await settle();
      expect(textOf(root)).toContain('本标签未应用');
      expect(runtime.reportApplied(consumer, snapshot.epoch, snapshot.revision)).toBe(true); await settle();
      expect(textOf(root)).toContain('本标签已应用'); expect(textOf(root)).toContain(snapshot.epoch); expect(textOf(root)).toContain(snapshot.revision);
    });
  it('新版本未报告应用前清除旧标记，草稿值不充当实际运行值', async () => {
    const { runtime, snapshot, client } = bindRuntime(); await runtime.refresh(); runtime.reportApplied('http.request-timeout', snapshot.epoch, snapshot.revision);
    const root = mountParameter(); useSystemStore().parameterForm!.value = 20; await settle();
    expect(textOf(root)).toContain('实际值 15 s'); expect(textOf(root)).not.toContain('实际值 20');
    client.getRuntimeParameters.mockResolvedValue({ ...snapshot, revision: 'SYS-3', values: { 'PAR-01': 30, 'PAR-02': 18 } });
    await runtime.refresh(); await settle(); expect(textOf(root)).toContain('本标签未应用'); expect(textOf(root)).toContain('SYS-3'); expect(textOf(root)).toContain('实际值 18 s');
  });
  it('刷新失败没有可核实快照，不回显异常或旧应用状态', async () => {
    const { runtime, snapshot, client } = bindRuntime(); await runtime.refresh(); runtime.reportApplied('http.request-timeout', snapshot.epoch, snapshot.revision);
    const root = mountParameter(); client.getRuntimeParameters.mockRejectedValueOnce(new Error('private-runtime-error'));
    await expect(runtime.refresh()).rejects.toThrow(); await settle();
    expect(textOf(root)).toContain('本标签未应用'); expect(textOf(root)).toContain('当前无可核实的运行参数快照');
    expect(textOf(root)).not.toContain('private-runtime-error'); expect(textOf(root)).not.toContain('SYS-2');
  });
  it('换会话同步移除旧快照和本标签应用状态', async () => {
    const { runtime, snapshot } = bindRuntime(); await runtime.refresh(); runtime.reportApplied('http.request-timeout', snapshot.epoch, snapshot.revision);
    const root = mountParameter(); await settle(); expect(textOf(root)).toContain('本标签已应用');
    useAuthStore().accept({ ...identity(), sessionId: 'SID-new' }); await settle();
    expect(textOf(root)).toContain('本标签未应用'); expect(textOf(root)).toContain('当前无可核实的运行参数快照'); expect(textOf(root)).not.toContain('SYS-2');
  });
  it('固定WGS84维持只读，不套用运行参数consumer标记', async () => {
    const root = mountParameter('PAR-03'); useSystemStore().parameterForm = { ...useSystemStore().parameterForm!, readonly: true, value: 'EPSG:4326', unit: '', applicationState: 'APPLIED' }; await settle();
    expect(textOf(root)).toContain('WGS84 / EPSG:4326 保持只读'); expect(textOf(root)).not.toContain('本标签状态');
    expect(find(root, n => n.tag === 'input')!.props.readonly).toBeDefined();
    expect(find(root, n => n.tag === 'button' && textOf(n) === '保存参数')!.props.disabled).toBe(true);
  });
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
  it('同身份参数FOUND对三个参数对象独立刷新runtime，核实成功不重复提交', async () => {
    const { runtime, client, snapshot } = bindRuntime(), refreshing = vi.spyOn(runtime, 'refresh'), store = useSystemStore();
    const objects = ['PAR-01', 'PAR-02', 'parameters'];
    for (const [index, objectId] of objects.entries()) {
      const requestId = 'uncertain-parameter-' + objectId;
      store.pendingMutation = { requestId, action: 'parameter.save', actorId: identity().id };
      service.getSystemOperation.mockResolvedValueOnce({ status: 'FOUND', ...result(), objectId });
      expect(await store.reconcilePending()).toBe(true); await settle();
      expect(service.getSystemOperation).toHaveBeenLastCalledWith({ requestId });
      expect(refreshing).toHaveBeenCalledTimes(index + 1); expect(client.getRuntimeParameters).toHaveBeenCalledTimes(index + 1);
      expect(runtime.snapshot).toEqual(snapshot); expect(runtime.error).toBeNull(); expect(store.pendingMutation).toBeNull();
      expect(store.notice).toBe('已核实操作提交成功');
    }
    expect(service.saveSystemParameter).not.toHaveBeenCalled(); expect(service.resetSystemParameters).not.toHaveBeenCalled();
  });
  it('参数回执NOT_FOUND不刷新runtime，不把未找到当失败或自动重提', async () => {
    const { runtime, client } = bindRuntime(), refreshing = vi.spyOn(runtime, 'refresh'), store = useSystemStore();
    const pending = { requestId: 'uncertain-parameter-not-found', action: 'parameter.save', actorId: identity().id };
    store.pendingMutation = pending; service.getSystemOperation.mockResolvedValueOnce({ status: 'NOT_FOUND' });
    expect(await store.reconcilePending()).toBe(false); await settle();
    expect(service.getSystemOperation).toHaveBeenCalledWith({ requestId: pending.requestId });
    expect(refreshing).not.toHaveBeenCalled(); expect(client.getRuntimeParameters).not.toHaveBeenCalled();
    expect(store.pendingMutation).toEqual(pending); expect(store.error).toContain('不能判定失败'); expect(runtime.snapshot).toBeNull();
    expect(service.saveSystemParameter).not.toHaveBeenCalled();
  });
  it('参数回执迟到FOUND遇同账号换会话不刷新runtime，保留原核实号', async () => {
    const { runtime, client } = bindRuntime(), refreshing = vi.spyOn(runtime, 'refresh'), store = useSystemStore();
    const pending = { requestId: 'uncertain-parameter-late', action: 'parameter.save', actorId: identity().id };
    store.pendingMutation = pending;
    let resolve!: (value: unknown) => void;
    service.getSystemOperation.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const reading = store.reconcilePending(); await settle();
    expect(service.getSystemOperation).toHaveBeenCalledWith({ requestId: pending.requestId });
    useAuthStore().accept({ ...identity(), sessionId: 'SID-new' });
    resolve({ status: 'FOUND', ...result(), objectId: 'PAR-02' });
    expect(await reading).toBe(false); await settle();
    expect(refreshing).not.toHaveBeenCalled(); expect(client.getRuntimeParameters).not.toHaveBeenCalled();
    expect(store.pendingMutation).toEqual(pending); expect(store.error).toContain('身份已变化'); expect(runtime.snapshot).toBeNull();
    expect(service.saveSystemParameter).not.toHaveBeenCalled();
  });
  it('确定的版本拒绝保留普通输入，不挂结果未知状态', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '输入';
    service.saveSystemAccount.mockRejectedValueOnce(new ApiError('版本变化', 1203)); expect(await store.save()).toBe(false); expect(store.pendingMutation).toBeNull(); expect(store.accountForm!.name).toBe('输入');
  });
  it('核实回执期间换会话保留原请求编号和现场', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '保留现场';
    service.saveSystemAccount.mockRejectedValueOnce(new ApiError('超时', 'REQUEST_TIMEOUT')); await store.save(); const requestId = store.pendingMutation!.requestId;
    let resolve!: (value:unknown)=>void; service.getSystemOperation.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const reading = store.reconcilePending(); await settle(); useAuthStore().accept({ ...identity(), sessionId: 'SID-new' }); resolve({ status: 'FOUND', ...result() });
    expect(await reading).toBe(false); expect(store.pendingMutation!.requestId).toBe(requestId); expect(store.accountForm!.name).toBe('保留现场');
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
  it('同权限新会话不能提交旧账号表单或旧密码目标', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '旧会话输入';
    useAuthStore().accept({ ...identity(), sessionId: 'SID-new' });
    expect(store.canSave).toBe(false); expect(await store.save()).toBe(false); expect(service.saveSystemAccount).not.toHaveBeenCalled();
    const opening = store.openPassword({ id: 'ACC-two' }); await settle(); store.answer('discard'); await opening;
    useAuthStore().accept({ ...identity(), sessionId: 'SID-third' });
    await expect(store.submitPassword({ currentPassword: '', operatorPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() })).rejects.toThrow();
    expect(service.maintainSystemAccountPassword).not.toHaveBeenCalled();
  });
  it('权限影响确认框期间切号不提交原表单', async () => {
    const store = useSystemStore(); await store.load(); service.getSystemAccount.mockResolvedValueOnce({ revision: 'SYS-1', account: { ...row(), id: 'ACC-one' } });
    await store.openAccount({ id: 'ACC-one' }); store.accountForm!.roleId = 'ROLE-other';
    const saving = store.save(); await settle(); expect(store.decision).not.toBeNull();
    useAuthStore().accept({ ...identity(), id: 'ACC-new', sessionId: 'SID-new' }); store.answer('save');
    expect(await saving).toBe(false); expect(service.saveSystemAccount).not.toHaveBeenCalled(); expect(store.accountForm!.roleId).toBe('ROLE-other');
  });
  it('停启确认冻结选择时的版本，确认换身份则取消', async () => {
    const store = useSystemStore(); await store.load(); service.setSystemAccountState.mockResolvedValue(result());
    const first = store.setEnabled(row()); await settle(); store.accounts!.revision = 'SYS-9'; store.answer('save'); await first;
    expect(service.setSystemAccountState).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 'SYS-1', accountId: 'ACC-two', enabled: false }));
    service.setSystemAccountState.mockClear(); const second = store.setEnabled(row()); await settle();
    useAuthStore().accept({ ...identity(), sessionId: 'SID-new' }); store.answer('save'); await second;
    expect(service.setSystemAccountState).not.toHaveBeenCalled();
  });
  it('恢复参数先保护脏表单，取消保留输入', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '未保存输入';
    const resetting = store.reset('system'); await settle(); expect(store.decision!.title).toBe('系统表单尚未保存'); store.answer('cancel'); await resetting;
    expect(store.accountForm!.name).toBe('未保存输入'); expect(service.resetSystemParameters).not.toHaveBeenCalled();
  });
  it('归档确认冻结日志边界，确认换身份不发请求', async () => {
    const store = useSystemStore(); await store.load(); await store.changeTab('logs'); service.archiveSystemLogs.mockResolvedValue(result());
    const archiving = store.reset('logs'); await settle(); store.logs!.revision = 'AUD-9'; store.logs!.snapshotSequence = 9; store.answer('save'); await archiving;
    expect(service.archiveSystemLogs).toHaveBeenCalledWith(expect.objectContaining({ baseAuditRevision: 'AUD-3', throughSequence: 3 }));
    service.archiveSystemLogs.mockClear(); const second = store.reset('logs'); await settle(); useAuthStore().accept({ ...identity(), sessionId: 'SID-new' }); store.answer('save'); await second;
    expect(service.archiveSystemLogs).not.toHaveBeenCalled();
  });
  it('已确定提交成功后身份刷新不会留下可再提交的旧表单', async () => {
    const store = useSystemStore(); await store.load(); await store.openAccount({ id: 'ACC-two' }); store.accountForm!.name = '已提交';
    service.saveSystemAccount.mockImplementationOnce(async () => { useAuthStore().accept(null); return { ...result(), reauthenticationRequired: true }; });
    expect(await store.save()).toBe(true); expect(store.accountForm).toBeNull(); expect(store.dirty).toBe(false); expect(store.notice).toContain('已提交');
  });
  it('真实System模板关闭日志详情会取消在途读取且迟到响应不重开', async () => {
    useAuthStore().accept({ ...identity(), permissions: ['system.view', 'system.logs'] });
    service.queryOperationSummaries.mockResolvedValue({ items: [{ id: 'LOG-one' }, { id: 'LOG-two' }], total: 2, pageNum: 1, pageSize: 20, revision: 'AUD-3', snapshotSequence: 3 });
    service.getOperationEvent.mockResolvedValueOnce({ id: 'LOG-one', time: new Date().toISOString(), actor: null, attemptedUsername: 'operator', module: 'system', action: 'parameter.save', outcome: 'SUCCESS', summary: '历史快照', changes: { before: { value: 30 }, after: { value: 45 } } });
    let resolve!: (value:unknown)=>void; service.getOperationEvent.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/system', component: SystemView }] }); await router.push('/system'); await router.isReady();
    const root = node('root'); app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
    await (find(root, n => n.tag === 'button' && textOf(n) === 'LOG-one')!.props.onClick as ()=>Promise<void>)(); await settle(); expect(textOf(root)).toContain('历史快照');
    const second = (find(root, n => n.tag === 'button' && textOf(n) === 'LOG-two')!.props.onClick as ()=>Promise<void>)(); await settle();
    (find(root, n => n.tag === 'button' && n.props['aria-label'] === '关闭操作日志详情')!.props.onClick as ()=>void)(); await settle();
    expect(service.getOperationEvent.mock.calls[1]![0].signal.aborted).toBe(true);
    resolve({ id: 'LOG-two', summary: '迟到日志' }); await second; await settle(); expect(textOf(root)).not.toContain('迟到日志'); expect(textOf(root)).not.toContain('历史快照');
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
  it('Login迟到能力响应不能打开新身份的旧改密表单', async () => {
    let resolve!: (value:unknown)=>void; capabilityReader.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/login', component: LoginView }] }); await router.push('/login'); await router.isReady();
    const root = node('root'); app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
    const signal = capabilityReader.mock.calls[0]![0].signal; useAuthStore().accept({ ...identity(), sessionId: 'SID-new' }); await settle();
    resolve({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: true }); await settle();
    expect(signal.aborted).toBe(true); expect(all(root, n => n.tag === 'input')).toHaveLength(2);
    expect(find(root, n => n.tag === 'button' && textOf(n).includes('登录工作区'))!.props.disabled).toBe(true);
  });
  it('重新读取登录状态不会绕过改密未知结果核实', async () => {
    useAuthStore().accept(null); service.login.mockResolvedValue(identity()); service.getSystemOperation.mockResolvedValue({ status: 'NOT_FOUND' });
    capabilityReader.mockResolvedValueOnce({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: false }).mockResolvedValueOnce({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: true });
    service.changeOwnPassword.mockRejectedValue(new ApiError('超时', 'REQUEST_TIMEOUT'));
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/login', component: LoginView }, { path: '/system', component: { render: () => null } }] }); await router.push('/login'); await router.isReady();
    const root = node('root'); app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
    const inputs = all(root, n => n.tag === 'input'); (inputs[0]!.props['onUpdate:modelValue'] as (v:string)=>void)('operator'); (inputs[1]!.props['onUpdate:modelValue'] as (v:string)=>void)(crypto.randomUUID());
    await (find(root, n => n.tag === 'form')!.props.onSubmit as (e:unknown)=>Promise<void>)({ preventDefault() {} }); await settle();
    const changedPassword = crypto.randomUUID(); all(root, n => n.tag === 'input').slice(2).forEach(input => (input.props['onUpdate:modelValue'] as (v:string)=>void)(changedPassword)); await settle();
    await (all(root, n => n.tag === 'form')[1]!.props.onSubmit as (e:unknown)=>Promise<void>)({ preventDefault() {} }); await settle();
    expect(service.changeOwnPassword).toHaveBeenCalledTimes(1);
    await (find(root, n => n.tag === 'button' && textOf(n) === '重新读取登录状态')!.props.onClick as ()=>Promise<void>)(); await settle();
    expect(service.getSystemOperation).toHaveBeenCalledTimes(1); expect(router.currentRoute.value.path).toBe('/login'); expect(textOf(root)).toContain('尚未查到回执');
  });
});
