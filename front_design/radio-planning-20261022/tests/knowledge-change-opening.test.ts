import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { authorizeStore } from './helpers/auth';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { previewService } from '../src/services';
import { useKnowledgeStore } from '../src/stores/knowledge';
import type { KnowledgeChange, KnowledgeVersion } from '../src/types/knowledge';
import KnowledgeView from '../src/views/KnowledgeView.vue';
import { clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }));
vi.mock('../src/composables/useKnowledgeLeaveGuard', () => ({ useKnowledgeLeaveGuard() {} }));
vi.mock('../src/components/KnowledgeChangeDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/KnowledgeVersionDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/KnowledgeGraphPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows'], setup: (props, { slots }) => () =>
    h('table-shell', (props.rows ?? []).map((row: { id: string }) => slots.actions?.({ row }))) }) };
});
beforeAll(() => clientTemplate(KnowledgeView, 'src/views/KnowledgeView.vue', 'knowledge-opening-render.ts'));

let pinia: ReturnType<typeof createPinia> | undefined;
let app: App | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 6; i++) await nextTick(); }
function setup() {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore('kg_reviewer');
  const store = useKnowledgeStore(), seed = initialKnowledgeWorkspace();
  const change = knowledgeClone(seed.changes.find(c => c.state === 'PENDING')!);
  const base = knowledgeClone(seed.versions.find(v => v.id === change.content.baseVersionId)!);
  store.workspace = seed;
  const detail = deferred<KnowledgeChange>(), version = deferred<KnowledgeVersion>();
  const readChange = vi.spyOn(previewService, 'getKnowledgeChange').mockReturnValue(detail.promise);
  const readVersion = vi.spyOn(previewService, 'getKnowledgeVersion').mockReturnValue(version.promise);
  return { store, change, base, detail, version, readChange, readVersion };
}

// 可控传输延迟验证读取生命周期；不将这些夹具结果当作浏览器性能数据。
describe('知识维护打开变更的读取反馈与并发保护', () => {
  it('显示两步读取状态，完成后恢复操作，保留原审核内容', async () => {
    const s = setup(); s.store.error = '上次读取失败';
    const opening = s.store.openChange(s.change); await settle();
    expect(s.store.openingChangeId).toBe(s.change.id);
    expect(s.store.openingChangeStage).toBe('detail');
    expect(s.store.locked).toBe(true); expect(s.store.error).toBe('');
    expect(s.store.drawerOpen).toBe(false);
    s.detail.resolve(s.change); await settle();
    expect(s.store.openingChangeStage).toBe('base');
    expect(s.readVersion).toHaveBeenCalledWith(expect.objectContaining({ id: s.change.content.baseVersionId }));
    s.version.resolve(s.base); await opening;
    expect(s.store.drawerOpen).toBe(true); expect(s.store.draft).toEqual(s.change.content);
    expect(s.store.change).toEqual(s.change); expect(s.store.canEdit).toBe(false);
    expect(s.store.locked).toBe(false); expect(s.store.openingChangeId).toBe('');
    expect(s.store.openingChangeStage).toBe('');
  });

  it('同一事件循环及读取中的重复点击都不重发请求，也不伪报失败', async () => {
    const s = setup();
    const first = s.store.openChange(s.change), second = s.store.openChange(s.change);
    await settle(); await second;
    await s.store.openChange({ id: 'another-change' });
    expect(s.readChange).toHaveBeenCalledTimes(1); expect(s.store.error).toBe('');
    s.detail.resolve(s.change); await settle();
    await s.store.openChange(s.change);
    expect(s.readVersion).toHaveBeenCalledTimes(1); expect(s.store.error).toBe('');
    s.version.resolve(s.base); await first;
    expect(s.store.changeId).toBe(s.change.id);
  });

  it.each(['detail', 'base'] as const)('%s 读取失败释放忙态，重试可正常打开', async stage => {
    const s = setup(), opening = s.store.openChange(s.change); await settle();
    if (stage === 'base') { s.detail.resolve(s.change); await settle(); }
    s[stage === 'base' ? 'version' : 'detail'].reject(new Error('读取暂不可用'));
    await opening;
    expect(s.store.error).toBe('读取暂不可用'); expect(s.store.locked).toBe(false);
    expect(s.store.openingChangeId).toBe(''); expect(s.store.drawerOpen).toBe(false);
    s.readChange.mockResolvedValue(s.change); s.readVersion.mockResolvedValue(s.base);
    await s.store.openChange(s.change);
    expect(s.store.drawerOpen).toBe(true); expect(s.store.error).toBe('');
  });

  it('退出页面后丢弃迟到详情，不继续获取整张对照版本', async () => {
    const s = setup(), opening = s.store.openChange(s.change); await settle();
    s.store.stopQueries(); s.detail.resolve(s.change); await opening;
    expect(s.readVersion).not.toHaveBeenCalled(); expect(s.store.drawerOpen).toBe(false);
    expect(s.store.openingChangeId).toBe(''); expect(s.store.locked).toBe(false);
  });

  it('清理会话后旧版本响应不能覆盖新会话的读取状态', async () => {
    const s = setup(), oldOpening = s.store.openChange(s.change); await settle();
    s.detail.resolve(s.change); await settle();
    s.store.clearForSession();
    const next = deferred<KnowledgeChange>(); s.readChange.mockReturnValue(next.promise);
    const newOpening = s.store.openChange({ id: 'next-change' }); await settle();
    s.version.resolve(s.base); await oldOpening;
    expect(s.store.openingChangeId).toBe('next-change'); expect(s.store.loading).toBe(true);
    s.store.stopQueries(); next.resolve(s.change); await newOpening;
    expect(s.store.openingChangeId).toBe(''); expect(s.store.drawerOpen).toBe(false);
  });

  it('已有未保存内容仍先确认，取消后不发送读取请求', async () => {
    const s = setup(); s.store.draft = knowledgeClone(s.change.content);
    s.store.baseline = knowledgeClone(s.change.content); s.store.draft.summary += '尚未保存';
    const opening = s.store.openChange(s.change); await settle();
    expect(s.store.decision?.title).toBe('未保存的知识草稿');
    expect(s.store.openingChangeId).toBe(''); expect(s.readChange).not.toHaveBeenCalled();
    s.store.answer('cancel'); await opening;
    expect(s.store.dirtyDraft).toBe(true); expect(s.readChange).not.toHaveBeenCalled();
  });

  it('实际列表模板在两个读取阶段显示反馈、禁用按钮，失败后恢复重试', async () => {
    const s = setup(); s.store.activeTab = 'changes';
    s.store.workspace!.changes = [s.change];
    const root = node('root'); app = renderer.createApp({ render: () => h(KnowledgeView) });
    app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); await settle();
    const button = find(root, n => n.tag === 'button' && textOf(n) === '查看 / 处理')!;
    expect(button).toBeDefined();
    const opening = Promise.resolve((button.props.onClick as (event: unknown) => unknown)({ stopPropagation() {} }));
    await settle();
    expect(textOf(root)).toContain('正在读取变更内容…');
    expect(textOf(button)).toBe('正在打开…'); expect(button.props.disabled).toBe(true);
    s.detail.resolve(s.change); await settle();
    expect(textOf(root)).toContain('正在读取对照版本…');
    s.version.reject(new Error('对照版本暂不可用')); await opening; await settle();
    expect(textOf(root)).toContain('对照版本暂不可用');
    expect(textOf(button)).toBe('查看 / 处理'); expect(button.props.disabled).toBe(false);
    expect(textOf(root)).not.toContain('正在读取');
  });
});
