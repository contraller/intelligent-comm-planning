import { afterEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { previewService } from '../src/services';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { buildKnowledgeCases } from '../src/services/knowledge-case-builder';

afterEach(() => vi.restoreAllMocks());
async function setup() {
  setActivePinia(createPinia());
  const auth = authorizeStore('kg_editor'),
    storage = new TestStorage(),
    service = createKnowledgeMock(() => storage);
  for (const [name, method] of Object.entries(service))
    vi.spyOn(previewService as any, name).mockImplementation(method as never);
  const store = useKnowledgeStore();
  await store.load();
  const context = await store.readCaseBase(),
    built = buildKnowledgeCases(
      [
        {
          caseId: 'FC-ENTRY-01',
          title: '',
          faultType: 'HW_FAILURE',
          objectType: 'DEVICE',
          deviceClass: '',
          cause: '接头松动',
          component: '接头',
          solution: '按核准规程处理并复测',
          source: '本地受控测试资料',
          symptoms: ['供电告警'],
          steps: [{ order: 1, text: '按规程检查连接状态' }],
        },
      ],
      context.base,
      context.catalog,
    );
  return { auth, storage, service, store, context, draft: built.draft! };
}
it('生成的是受离开保护的未保存草稿，保存后复用原有审核流程', async () => {
  const s = await setup(),
    before = JSON.stringify((await s.service.loadKnowledgeWorkspace()).workspace!.versions);
  await s.store.applyCaseDraft(s.draft, s.context);
  expect(s.store.drawerOpen).toBe(true);
  expect(s.store.dirtyDraft).toBe(true);
  expect(s.storage.writes).toBe(0);
  expect(await s.store.saveDraft()).toBe(true);
  expect(s.store.dirtyDraft).toBe(false);
  expect(s.storage.writes).toBe(1);
  expect(JSON.stringify((await s.service.loadKnowledgeWorkspace()).workspace!.versions)).toBe(
    before,
  );
  expect(s.store.change!.state).toBe('DRAFT');
  const submitting = s.store.submit();
  await vi.waitFor(() => expect(s.store.decision?.title).toBe('提交审核'));
  s.store.answer('save');
  await submitting;
  expect(s.store.change!.state).toBe('PENDING');
  expect((await s.service.loadKnowledgeWorkspace()).workspace!.currentVersionId).toBe(
    s.context.base.id,
  );
});
it('应用前版本变化拒绝旧预检，不替换原未保存输入', async () => {
  const s = await setup();
  await s.store.newChange();
  s.store.draft!.summary = '必须保留的原草稿';
  const before = JSON.stringify(s.store.draft);
  const current = await s.service.loadKnowledgeMetadata();
  vi.mocked(previewService.loadKnowledgeMetadata).mockResolvedValue({
    ...current,
    workspace: { ...current.workspace!, currentVersionId: 'changed-version' },
  });
  const applying = s.store.applyCaseDraft(s.draft, s.context);
  s.store.answer('discard');
  await expect(applying).rejects.toThrow('知识版本已变化');
  expect(JSON.stringify(s.store.draft)).toBe(before);
  expect(s.storage.writes).toBe(0);
});
it('预检期间身份变化，不应用迟到的旧身份内容', async () => {
  const s = await setup();
  let finish!: (value: Awaited<ReturnType<typeof previewService.getKnowledgeVersion>>) => void;
  vi.mocked(previewService.getKnowledgeVersion).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const reading = s.store.readCaseBase();
  await Promise.resolve();
  await Promise.resolve();
  s.auth.accept({ ...s.auth.identity!, sessionId: 'other-session' });
  finish(s.context.base);
  await expect(reading).rejects.toThrow('身份已变化');
  expect(s.store.draft).toBeNull();
});
