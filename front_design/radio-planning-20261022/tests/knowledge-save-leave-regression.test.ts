import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import KnowledgeView from '../src/views/KnowledgeView.vue';
import KnowledgeChangeDrawer from '../src/components/KnowledgeChangeDrawer.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
import DecisionDialog from '../src/components/DecisionDialog.vue';
import RequestState from '../src/components/RequestState.vue';
import KnowledgeStateBadge from '../src/components/KnowledgeStateBadge.vue';
import KnowledgePrincipleEditor from '../src/components/KnowledgePrincipleEditor.vue';
import KnowledgePrincipleFlow from '../src/components/KnowledgePrincipleFlow.vue';
import KnowledgeNetworkRuleEditor from '../src/components/KnowledgeNetworkRuleEditor.vue';
import KnowledgeNetworkRulePanel from '../src/components/KnowledgeNetworkRulePanel.vue';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { useAuthStore } from '../src/stores/auth';
import { previewService } from '../src/services';
import { createKnowledgeHttp } from '../src/services/knowledge-http';
import { createAuthHttp } from '../src/services/auth-http';
import { initialKnowledgeWorkspace, knowledgeCatalog } from '../src/mocks/knowledge-presets';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { KNOWLEDGE_STORAGE_KEY } from '../src/config/demo';
import { DEMO_PASSWORD } from '../src/mocks/system-presets';
import { authFixture } from './helpers/auth';
import { all, clientTemplate, find, node, textOf, type HostNode } from './helpers/vue-client';
import type { KnowledgeChange, KnowledgeDraft, KnowledgeServices } from '../src/types/knowledge';

const configuration = vi.hoisted(() => ({ mode: 'mock', sampleData: true }));
vi.mock('../src/config/env', async importOriginal => ({
  ...await importOriginal<typeof import('../src/config/env')>(), env: configuration,
}));

// 仅替换 PrimeVue 的 DOM 外壳；关闭事件经过真实 AppDrawer、DecisionDialog 和业务模板。
vi.mock('primevue/drawer', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'header', 'closeButtonProps', 'closeOnEscape', 'dismissable'], emits: ['update:visible', 'after-show'],
    setup(props, { emit, slots }) { return () => props.visible ? h('drawer-shell', [
      h('button', { disabled: props.closeButtonProps?.disabled, onClick: () => emit('update:visible', false) }, '抽屉 X'),
      ...(slots.default?.() ?? []), ...(slots.footer?.() ?? []),
    ]) : null; },
  }) };
});
vi.mock('primevue/dialog', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'header'], emits: ['update:visible'],
    setup(props, { emit, slots }) { return () => props.visible ? h('dialog-shell', { header: props.header }, [
      h('button', { onClick: () => emit('update:visible', false) }, '弹窗 X'),
      ...(slots.default?.() ?? []), ...(slots.footer?.() ?? []),
    ]) : null; },
  }) };
});
vi.mock('../src/components/KnowledgeGraphPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/KnowledgeVersionDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppTable.vue', () => ({ default: { render: () => null } }));

beforeAll(async () => {
  for (const [component, filename] of [
    [KnowledgeView, 'views/KnowledgeView.vue'], [KnowledgeChangeDrawer, 'components/KnowledgeChangeDrawer.vue'],
    [AppDrawer, 'components/AppDrawer.vue'], [DecisionDialog, 'components/DecisionDialog.vue'],
    [RequestState, 'components/RequestState.vue'], [KnowledgeStateBadge, 'components/KnowledgeStateBadge.vue'],
    [KnowledgePrincipleEditor, 'components/KnowledgePrincipleEditor.vue'], [KnowledgePrincipleFlow, 'components/KnowledgePrincipleFlow.vue'],
    [KnowledgeNetworkRuleEditor, 'components/KnowledgeNetworkRuleEditor.vue'], [KnowledgeNetworkRulePanel, 'components/KnowledgeNetworkRulePanel.vue'],
  ] as const) await clientTemplate(component, 'src/' + filename, 'knowledge-save-leave-render.ts');
});

let pinia: ReturnType<typeof createPinia> | undefined;
let app: App | undefined;
const scrolled: HostNode[] = [], focused: HostNode[] = [];
// 内存宿主只记录 DOM 定位请求；不把它当作浏览器视口或视觉验证。
function remove(child: HostNode) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove,
  createElement: tag => Object.assign(node(tag), {
    scrollIntoView(this: HostNode) { scrolled.push(this); },
    focus(this: HostNode) { focused.push(this); },
  }),
  createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => {
    const el = node('#static', text); insert(el, parent, anchor); return [el, el];
  },
});
afterEach(() => {
  app?.unmount(); app = undefined;
  if (pinia) disposePinia(pinia);
  pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function settle() { for (let i = 0; i < 100; i++) await nextTick(); }
function button(root: HostNode, label: string) {
  const found = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(found, label).toBeDefined();
  return found!;
}
function press(root: HostNode, label: string): Promise<unknown> {
  const target = button(root, label);
  expect(target.props.disabled, label + ' 应可操作').not.toBe(true);
  return Promise.resolve((target.props.onClick as () => unknown)());
}
const dialog = (root: HostNode) => find(root, n => n.tag === 'dialog-shell');
function summaryInput(root: HostNode) {
  const input = find(root, n => n.tag === 'input' && n.props.placeholder === '说明本次修改目的');
  expect(input).toBeDefined(); return input!;
}
async function enterSummary(root: HostNode, value: string) {
  const input = summaryInput(root);
  expect(input.props.readonly).not.toBe(true);
  (input.props.onInput as (event: unknown) => void)({ target: { value } });
  await settle();
}
function unloadBlocked() {
  const event = new Event('beforeunload', { cancelable: true });
  Object.defineProperty(event, 'returnValue', { value: undefined, writable: true });
  window.dispatchEvent(event); return event.defaultPrevented;
}

// HTTP 使用独立、严格的数值版本 DTO 与可控传输响应；绝不将 Mock 的 KGM/SEED 回执改名冒充 HTTP。
// 这些是传输桩测试，不宣称真实服务器或浏览器端到端通过。
function httpFixture() {
  const seed = initialKnowledgeWorkspace();
  const version = { ...knowledgeClone(seed.versions.at(-1)!), id: 'KGV-2', number: 2,
    parentId: 'KGV-1', changeId: null };
  const change: KnowledgeChange = { ...knowledgeClone(seed.changes.find(c => c.state === 'DRAFT')!),
    id: 'KGC-http-exit', content: { ...knowledgeClone(seed.changes.find(c => c.state === 'DRAFT')!.content), baseVersionId: 'KGV-2' } };
  const identity = { session_id: 'SID-http-exit', account_id: change.authorId, username: 'kg_editor',
    display_name: '知识编辑人', role_id: 'ROLE-KG-EDITOR', role_name: '知识编辑人',
    identity_revision: '1', session_generation: '1', permissions: ['knowledge.view', 'knowledge.edit'] };
  let detail = knowledgeClone(change), revision = 'KG-1', loggedOut = false;
  let nextDetail: KnowledgeChange | undefined;
  const failures = { save: false, submit: false, detail: false, logout: false, noChange: false };
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const response = (data: unknown, message = '', code = 0) => new Response(JSON.stringify({ code, message, data }),
    { status: code ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input), 'http://kg.test').pathname.replace('/api/v1', '');
    if (path === '/auth/session') return response(loggedOut ? null : identity);
    if (path === '/auth/csrf') return response({ csrf_token: 'csrf-exit', session_id: loggedOut ? null : identity.session_id });
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      expect(new Headers(init.headers).get('X-Session-Id')).toBe(identity.session_id);
      expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-exit');
      if (path === '/auth/logout') {
        if (failures.logout) return response(null, '退出暂不可用', 5001);
        loggedOut = true; return response(null);
      }
      if (path === '/kg/workbench/actions/save' || path === '/kg/workbench/actions/submit') {
        const action = path.endsWith('/save') ? 'save' : 'submit';
        if (action === 'save' && failures.noChange) return new Response(JSON.stringify({
          code: 1001, message: '没有可保存的知识变更', data: null,
        }), { status: 422, headers: { 'Content-Type': 'application/json' } });
        if (failures[action]) return response(null, action === 'save' ? '保存暂不可用' : '送审暂不可用', 5001);
        expect(nextDetail, '测试必须显式安排受理后的服务端快照').toBeDefined();
        detail = knowledgeClone(nextDetail!); revision = action === 'save' ? 'KG-2' : 'KG-3';
        return response({ objectId: detail.id, entityId: detail.id, changed: true, revision, currentVersionId: 'KGV-2' });
      }
    }
    if (path === '/kg/workbench') return response({ ...knowledgeCatalog(), error: null, dataOrigin: 'SAMPLE',
      workspace: { revision, currentVersionId: 'KGV-2', current: version, identitySnapshots: [],
        counts: { '设备知识': 1, '网络态势知识': 0, '故障运维知识': 0 } } });
    if (path === '/kg/workbench/detail/version/KGV-2') return response(version);
    if (path === '/kg/workbench/detail/change/' + detail.id) {
      if (failures.detail) return response(null, '详情暂不可读', 5001);
      return response(detail);
    }
    if (path === '/kg/workbench/history/changes') return response({ items: [{ ...detail,
      summary: detail.content.summary, baseVersionId: detail.content.baseVersionId }], total: 1, pageNum: 1, pageSize: 20 });
    throw new Error('未安排的 HTTP 请求：' + path);
  });
  const auth = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => 'http://kg.test', fetcher });
  const service = createKnowledgeHttp(auth.authenticatedRequest);
  return { service, auth, failures, posts, changeId: change.id,
    arrangeSave(draft: KnowledgeDraft) { nextDetail = { ...knowledgeClone(change), revision: 2, content: knowledgeClone(draft) }; },
    arrangeSubmit(draft: KnowledgeDraft) { nextDetail = { ...knowledgeClone(change), revision: 2,
      content: knowledgeClone(draft), state: 'PENDING', submissions: [{ number: 1, revision: 2,
        actorId: change.authorId, time: change.updatedAt, content: knowledgeClone(draft), outcome: 'PENDING', review: null }] }; },
    read: async () => knowledgeClone(detail),
  };
}

async function start(mode: 'http' | 'mock') {
  configuration.mode = mode; configuration.sampleData = mode === 'mock';
  scrolled.length = 0; focused.length = 0;
  const root = node('root');
  class TestDocument extends EventTarget {
    activeElement = null;
    getElementById(id: string) { return find(root, n => n.props.id === id); }
  }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {}); vi.stubGlobal('window', new EventTarget());
  pinia = createPinia(); setActivePinia(pinia);
  const auth = useAuthStore(), store = useKnowledgeStore();
  const http = mode === 'http' ? httpFixture() : undefined;
  const mock = mode === 'mock' ? authFixture() : undefined;
  if (http) {
    for (const key of Object.keys(http.service) as (keyof KnowledgeServices)[])
      vi.spyOn(previewService, key).mockImplementation(http.service[key] as never);
    vi.spyOn(previewService, 'getSession').mockImplementation(http.auth.getSession);
    vi.spyOn(previewService, 'logout').mockImplementation(http.auth.logout);
    auth.accept(await previewService.getSession());
  } else {
    mock!.bind();
    auth.accept(await previewService.login({ username: 'kg_editor', password: DEMO_PASSWORD }));
  }
  auth.currentPath = '/knowledge';
  // 应用级清理约定；退出守卫的注册由真实 KnowledgeView 执行。
  auth.registerCleaner(store.clearForSession);
  store.activeTab = 'changes';
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/knowledge', component: KnowledgeView }, { path: '/away', component: { render: () => h('p', '已离开知识页') } },
  ] });
  await router.push('/knowledge'); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) });
  app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root);
  await settle();
  expect(store.loadError).toBe(''); expect(store.workspace).not.toBeNull();
  const changeId = http?.changeId ?? 'KGC-SEED-DRAFT';
  await store.openChange({ id: changeId }); await settle();
  const save = vi.spyOn(previewService, 'saveKnowledgeReceipt');
  const submit = vi.spyOn(previewService, 'submitKnowledgeReceipt');
  const logout = vi.spyOn(previewService, 'logout');
  return { root, store, auth, router, save, submit, logout, http, mock,
    read: () => http ? http.read() : mock!.raw.getKnowledgeChange({ id: changeId }),
    arrangeSave: () => http?.arrangeSave(store.draft!),
    arrangeSubmit: () => http?.arrangeSubmit(store.draft!),
    fail(action: 'save' | 'submit' | 'detail' | 'logout') {
      if (http) http.failures[action] = true;
      else if (action === 'save' || action === 'submit') mock!.storage.failWriteKeys.add(KNOWLEDGE_STORAGE_KEY);
      else vi.mocked(previewService[action === 'detail' ? 'getKnowledgeChange' : 'logout'])
        .mockRejectedValue(new Error(action === 'detail' ? '详情暂不可读' : '退出暂不可用'));
    },
  };
}
type Scenario = Awaited<ReturnType<typeof start>>;
async function edited(mode: 'http' | 'mock') {
  const s = await start(mode);
  await enterSummary(s.root, '保存退出回归输入');
  expect(s.store.dirtyDraft).toBe(true); expect(unloadBlocked()).toBe(true);
  return s;
}
async function noPrompt(s: Scenario, action: () => Promise<unknown>) {
  const task = action(); await settle();
  expect(s.store.decision, '已处理输入不应再次确认').toBeNull();
  expect(dialog(s.root)).toBeUndefined(); await task;
}
async function confirmSubmit(s: Scenario) {
  const task = press(s.root, '提交审核');
  await expect.poll(() => s.store.decision?.title).toBe('提交审核');
  s.arrangeSubmit(); await press(s.root, '确认送审'); await task; await settle();
}

for (const mode of ['http', 'mock'] as const) describe.sequential(`${mode}：知识保存、送审及退出回归`, () => {
  it('保存处理期间右上X与底部关闭同步禁用，完成后均可正常关闭', async () => {
    const s = await edited(mode); s.arrangeSave();
    const save = s.save.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.save.mockImplementationOnce(async input => { await gate; return save(input); });
    const saving = press(s.root, '保存草稿'); await settle();
    expect(s.store.locked).toBe(true);
    expect(button(s.root, '抽屉 X').props.disabled).toBe(true);
    expect(button(s.root, '关闭').props.disabled).toBe(true);
    release(); await saving; await settle();
    expect(s.store.locked).toBe(false);
    expect(button(s.root, '抽屉 X').props.disabled).not.toBe(true);
    expect(textOf(s.root)).toContain('当前内容已保存，可直接关闭。');
    await noPrompt(s, () => press(s.root, '抽屉 X'));
  });
  it.each(['保存草稿', '提交审核'] as const)('%s 成功后，关闭、路由离开与退出均不再提示', async action => {
    const s = await edited(mode); s.arrangeSave();
    if (action === '保存草稿') await press(s.root, action); else await confirmSubmit(s);
    await settle();
    expect((await s.read()).content.summary).toBe('保存退出回归输入');
    expect((await s.read()).state).toBe(action === '保存草稿' ? 'DRAFT' : 'PENDING');
    expect(s.store.dirty).toBe(false); expect(s.store.receiptPending).toBe(false);
    expect(unloadBlocked()).toBe(false); expect(s.save).toHaveBeenCalledTimes(1);
    expect(s.submit).toHaveBeenCalledTimes(action === '保存草稿' ? 0 : 1);
    await noPrompt(s, () => press(s.root, '关闭'));
    await noPrompt(s, () => s.router.push('/away'));
    expect(s.router.currentRoute.value.path).toBe('/away');
    expect(await s.auth.leaveSession()).toBe(true); expect(s.logout).toHaveBeenCalledTimes(1);
  });

  it.each(['保存草稿', '提交审核'] as const)('%s 成功后保持抽屉打开直接退出，只执行一次退出', async action => {
    const s = await edited(mode); s.arrangeSave();
    if (action === '保存草稿') await press(s.root, action); else await confirmSubmit(s);
    await noPrompt(s, () => s.auth.leaveSession());
    expect(s.auth.identity).toBeNull(); expect(s.store.draft).toBeNull();
    expect(s.logout).toHaveBeenCalledTimes(1); expect(s.save).toHaveBeenCalledTimes(1);
  });

  it.each(['关闭', '路由', '退出'] as const)('未保存输入在%s时保存后继续，不二次弹窗', async target => {
    const s = await edited(mode); s.arrangeSave();
    const leaving = target === '关闭' ? press(s.root, '关闭') : target === '路由' ? s.router.push('/away') : s.auth.leaveSession();
    await settle(); expect(s.store.decision?.title).toBe('未保存的知识草稿');
    await press(s.root, '保存草稿后继续'); await leaving; await settle();
    expect(s.store.decision).toBeNull(); expect(dialog(s.root)).toBeUndefined();
    expect((await s.read()).content.summary).toBe('保存退出回归输入'); expect(s.save).toHaveBeenCalledTimes(1);
    if (target === '路由') expect(s.router.currentRoute.value.path).toBe('/away');
    if (target === '退出') expect(s.auth.identity).toBeNull();
    else expect(s.store.dirty).toBe(false);
  });

  it.each(['继续编辑', '弹窗 X'] as const)('退出确认选择%s保留完整输入，再次退出仍受保护', async answer => {
    const s = await edited(mode), draft = knowledgeClone(s.store.draft);
    const leaving = s.auth.leaveSession(); await settle();
    await press(s.root, answer); expect(await leaving).toBe(false);
    expect(s.store.draft).toEqual(draft); expect(summaryInput(s.root).props.value).toBe(draft!.summary);
    expect(s.auth.identity?.username).toBe('kg_editor'); expect(s.auth.hasUnsaved()).toBe(true);
    expect(s.save).not.toHaveBeenCalled(); expect(s.logout).not.toHaveBeenCalled();
    const retry = s.auth.leaveSession(); await settle(); expect(dialog(s.root)).toBeDefined();
    await press(s.root, '继续编辑'); expect(await retry).toBe(false);
  });

  it.each(['关闭', '抽屉 X', '路由', '退出'] as const)('%s 确认放弃后不重复确认、不写入', async target => {
    const s = await edited(mode), original = (await s.read()).content;
    const leaving = target === '路由' ? s.router.push('/away') : target === '退出' ? s.auth.leaveSession() : press(s.root, target);
    await settle(); expect(s.store.decision?.title).toBe('未保存的知识草稿');
    await press(s.root, '放弃输入'); await leaving; await settle();
    expect(dialog(s.root)).toBeUndefined(); expect(s.store.dirty).toBe(false);
    expect(s.store.error).toBe('');
    expect((await s.read()).content).toEqual(original); expect(s.save).not.toHaveBeenCalled();
    if (target === '路由') expect(s.router.currentRoute.value.path).toBe('/away');
    if (target === '退出') expect(s.logout).toHaveBeenCalledTimes(1);
    else await noPrompt(s, () => s.auth.leaveSession());
  });

  it.each(['保存草稿', '提交审核', '离页保存'] as const)('%s 写入失败，错误可见且保留输入和离页保护', async action => {
    const s = await edited(mode), draft = knowledgeClone(s.store.draft), original = await s.read(); s.fail('save');
    if (action === '离页保存') {
      const leaving = s.auth.leaveSession(); await settle(); await press(s.root, '保存草稿后继续');
      expect(await leaving).toBe(false); expect(s.logout).not.toHaveBeenCalled();
    } else await press(s.root, action);
    await settle();
    expect(s.store.error).not.toBe('');
    expect(all(s.root, n => n.props.role === 'alert').some(n => textOf(n).includes(s.store.error))).toBe(true);
    expect(s.store.draft).toEqual(draft); expect(summaryInput(s.root).props.value).toBe(draft!.summary);
    expect(await s.read()).toEqual(original); expect(s.store.dirtyDraft).toBe(true); expect(unloadBlocked()).toBe(true);
    expect(s.submit).not.toHaveBeenCalled(); expect(s.store.locked).toBe(false);
    const closing = press(s.root, '关闭'); await settle(); expect(dialog(s.root)).toBeDefined();
    await press(s.root, '继续编辑'); await closing; expect(s.store.drawerOpen).toBe(true);
  });

  it('送审失败保留已保存内容和可见错误，不伪报送审成功', async () => {
    const s = await edited(mode); s.arrangeSave(); await press(s.root, '保存草稿'); s.fail('submit');
    await confirmSubmit(s);
    expect(s.store.change?.state).toBe('DRAFT'); expect((await s.read()).state).toBe('DRAFT');
    expect(s.store.draft?.summary).toBe('保存退出回归输入'); expect(s.store.error).not.toBe('');
    expect(all(s.root, n => n.props.role === 'alert').some(n => textOf(n).includes(s.store.error))).toBe(true);
    expect(s.save).toHaveBeenCalledTimes(1); expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['取消', '弹窗 X'] as const)('送审确认%s不提交；自动保存内容仍保留且可关闭', async answer => {
    const s = await edited(mode); s.arrangeSave(); const submitting = press(s.root, '提交审核'); await settle();
    await expect.poll(() => s.store.decision?.title).toBe('提交审核'); await press(s.root, answer); await submitting;
    expect(s.submit).not.toHaveBeenCalled(); expect((await s.read()).state).toBe('DRAFT');
    expect(s.store.draft?.summary).toBe('保存退出回归输入'); await noPrompt(s, () => press(s.root, '关闭'));
  });

  it.each(['保存草稿', '提交审核'] as const)('%s 已受理但详情读取失败，关闭和退出不重复写入', async action => {
    const s = await edited(mode); s.arrangeSave();
    if (action === '保存草稿') { s.fail('detail'); await press(s.root, action); }
    else {
      await press(s.root, '保存草稿'); s.fail('detail'); await confirmSubmit(s);
    }
    await settle(); expect(s.store.receiptPending).toBe(true); expect(s.store.dirtyDraft).toBe(false);
    expect(s.store.notice).toContain('无需重复提交'); expect(s.store.error).toContain('详情暂不可读');
    expect(unloadBlocked()).toBe(false); expect(await s.store.saveDraft()).toBe(false); await s.store.submit();
    expect(s.store.decision).toBeNull(); expect(s.save).toHaveBeenCalledTimes(1);
    expect(s.submit).toHaveBeenCalledTimes(action === '保存草稿' ? 0 : 1);
    await noPrompt(s, () => press(s.root, '关闭')); await noPrompt(s, () => s.auth.leaveSession());
    expect(s.logout).toHaveBeenCalledTimes(1); expect((await s.read()).content.summary).toBe('保存退出回归输入');
  });

  it('退出失败不能执行延迟放弃，输入仍可见且可取消重试', async () => {
    const s = await edited(mode), draft = knowledgeClone(s.store.draft); s.fail('logout');
    const leaving = s.auth.leaveSession(); await settle(); await press(s.root, '放弃输入');
    expect(await leaving).toBe(false); expect(s.auth.notice).toContain('退出暂不可用');
    expect(s.store.draft).toEqual(draft); expect(s.store.dirty).toBe(true); expect(unloadBlocked()).toBe(true);
    expect(s.auth.bypassLeave).toBe(false); expect(summaryInput(s.root).props.value).toBe(draft!.summary);
    const retry = s.auth.leaveSession(); await settle(); await press(s.root, '继续编辑'); expect(await retry).toBe(false);
    expect(s.logout).toHaveBeenCalledTimes(1);
  });

  it.each(['实体', '关系'] as const)('仅加入原样已有%s后保存退出，被拒绝且定位可见错误', async kind => {
    const s = await start(mode), original = await s.read();
    await s.store.newChange(); await settle(); await enterSummary(s.root, '仅选择已有知识，尚未修改');
    const label = kind === '实体' ? '选择已有实体加入编辑' : '选择已有关系加入编辑';
    const select = find(s.root, n => n.props['aria-label'] === label)!;
    expect(select).toBeDefined();
    const row = kind === '实体' ? s.store.base!.entities[0] : s.store.base!.relations[0];
    (select.props['onUpdate:modelValue'] as (id: string) => void)(row.id);
    (select.props.onChange as () => void)(); await settle();
    expect(kind === '实体' ? s.store.draft!.entities : s.store.draft!.relations).toEqual([row]);
    const draft = knowledgeClone(s.store.draft);
    if (s.http) s.http.failures.noChange = true;
    const leaving = s.auth.leaveSession(); await settle();
    expect(dialog(s.root)).toBeDefined(); await press(s.root, '保存草稿后继续');
    expect(await leaving).toBe(false); await settle();
    expect(dialog(s.root)).toBeUndefined(); expect(s.store.drawerOpen).toBe(true);
    expect(s.store.draft).toEqual(draft); expect(s.store.dirtyDraft).toBe(true);
    expect(s.store.error).toMatch(mode === 'http' ? /没有可保存的知识变更/ : /没有相对已发布基线的实际修改/);
    expect(all(s.root, n => n.props.role === 'alert').some(n => textOf(n).includes(s.store.error))).toBe(true);
    expect(s.logout).not.toHaveBeenCalled(); expect(s.save).toHaveBeenCalledTimes(1);
    expect(await s.read()).toEqual(original); expect(unloadBlocked()).toBe(true);
    // 在长抽屉中仅存在顶部 error 文本不够，必须主动将错误汇总带入用户关注位置。
    expect.soft(scrolled.some(n => textOf(n).includes(s.store.error)), '保存失败后滚动到错误汇总').toBe(true);
    expect.soft(focused.some(n => textOf(n).includes(s.store.error)), '保存失败后聚焦错误汇总').toBe(true);
  });

  it('撤销编辑权限后不能保存或送审，未保存保护仍然有效', async () => {
    const s = await edited(mode), draft = knowledgeClone(s.store.draft);
    s.auth.accept({ ...s.auth.identity!, permissions: ['knowledge.view'] }); await settle();
    expect(find(s.root, n => n.tag === 'button' && textOf(n).trim() === '保存草稿')).toBeUndefined();
    expect(summaryInput(s.root).props.readonly).toBe(true); expect(await s.store.saveDraft()).toBe(false);
    await s.store.submit(); expect(s.save).not.toHaveBeenCalled(); expect(s.submit).not.toHaveBeenCalled();
    const leaving = s.router.push('/away'); await settle(); expect(dialog(s.root)).toBeDefined();
    await press(s.root, '继续编辑'); await leaving;
    expect(s.router.currentRoute.value.path).toBe('/knowledge'); expect(s.store.draft).toEqual(draft);
    expect(s.store.dirtyDraft).toBe(true);
  });
});

describe.sequential('Mock 结构化字段校验：真实校验器与定位回调', () => {
  it('保存退出因来源为空失败，错误项可定位到原行并聚焦来源字段', async () => {
    const s = await edited('mock'), entityId = s.store.draft!.entities[0].id;
    const row = find(s.root, n => n.props.id === 'knowledge-row-' + entityId)!;
    const label = find(row, n => n.tag === 'label' && textOf(n).startsWith('来源说明'))!;
    const source = find(label, n => n.tag === 'input')!;
    (source.props.onInput as (event: unknown) => void)({ target: { value: '' } }); await settle();
    const draft = knowledgeClone(s.store.draft), original = await s.read();
    const leaving = s.auth.leaveSession(); await settle(); await press(s.root, '保存草稿后继续');
    expect(await leaving).toBe(false); await settle();
    expect(s.store.issues).toContainEqual({ objectId: entityId, field: 'source', message: '来源说明须为 1–200 字符' });
    expect(dialog(s.root)).toBeUndefined(); expect(s.store.draft).toEqual(draft); expect(await s.read()).toEqual(original);
    expect(s.logout).not.toHaveBeenCalled();
    const issue = find(s.root, n => n.tag === 'button' && textOf(n).includes(entityId) && textOf(n).includes('来源说明须为'));
    expect(issue, '实际错误项定位按钮').toBeDefined();
    await (issue!.props.onClick as () => unknown)(); await settle();
    expect(scrolled).toContain(row);
    expect(focused, '错误项应聚焦来源字段，不能只滚动到整行').toContain(source);
  });
});
