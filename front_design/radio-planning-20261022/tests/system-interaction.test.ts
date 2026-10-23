import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { previewService } from '../src/services';
import { readSystem } from '../src/services/system-storage';

let pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => {
  if (pinia) { useSystemStore(pinia).clearForSession(); disposePinia(pinia); }
  pinia = undefined; vi.restoreAllMocks();
});
async function setup() {
  const fixture = authFixture(); await fixture.login();
  pinia = createPinia(); setActivePinia(pinia);
  useAuthStore().accept(await fixture.service.getSession()); fixture.bind();
  const store = useSystemStore(); await store.load();
  return { ...fixture, store };
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }

describe('系统表单与查询交互', () => {
  // 延迟返回即使忽略 AbortSignal，也不能覆盖后打开的新建表单。
  it.each(['account', 'role'] as const)('迟到的 %s 详情不能覆盖新建输入', async kind => {
    const s = await setup();
    const detail = kind === 'account'
      ? await s.service.getSystemAccount({ id: 'SYS-RESOURCE' })
      : await s.service.getSystemRole({ id: 'ROLE-RESOURCE' });
    let resolve!: (value: any) => void;
    const pending = new Promise<any>(done => { resolve = done; });
    if (kind === 'account') vi.mocked(previewService.getSystemAccount).mockReturnValueOnce(pending);
    else vi.mocked(previewService.getSystemRole).mockReturnValueOnce(pending);
    const reading = kind === 'account'
      ? s.store.openAccount({ id: 'SYS-RESOURCE' }) : s.store.openRole({ id: 'ROLE-RESOURCE' });
    await settle(); expect(s.store.loading).toBe(true);
    if (kind === 'account') { await s.store.openAccount(); s.store.accountForm!.name = '新账号输入'; }
    else { await s.store.openRole(); s.store.roleForm!.name = '新角色输入'; }
    resolve(detail); await reading;
    const form = kind === 'account' ? s.store.accountForm : s.store.roleForm;
    expect(form?.id).toBeNull(); expect(form?.name).toBe(kind === 'account' ? '新账号输入' : '新角色输入');
    expect(s.store.loading).toBe(false);
  });

  it('目录尚未就绪时不能建立缺少基线的新表单', async () => {
    const s = await setup(); s.store.catalog = null;
    await s.store.openAccount(); await s.store.openRole();
    expect(s.store.accountForm).toBeNull(); expect(s.store.roleForm).toBeNull();
  });

  it('首次目录读取期间切页签会补齐目录，旧目录响应不能覆盖', async () => {
    const s = await setup(); s.store.catalog = null;
    const options = await s.service.loadSystemOptions();
    let resolve!: (value: typeof options) => void;
    vi.mocked(previewService.loadSystemOptions).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const reading = s.store.load(); await settle();
    await s.store.changeTab('roles'); expect(s.store.catalog).toEqual(options); expect(s.store.roles).not.toBeNull();
    resolve({ ...options, revision: '迟到的目录' }); await reading;
    expect(s.store.catalog).toMatchObject({ revision: options.revision }); expect(s.store.loading).toBe(false);
  });

  it('修改本人资料和角色说明直接保存，新建角色也不额外确认', async () => {
    const s = await setup();
    await s.store.openAccount({ id: 'SYS-ADMIN' }); s.store.accountForm!.name = '测试管理员';
    expect(await s.store.save()).toBe(true); expect(s.store.decision).toBeNull();
    expect(readSystem(s.storage).accounts[0].name).toBe('测试管理员');
    await s.store.changeTab('roles'); await s.store.openRole({ id: 'ROLE-RESOURCE' });
    s.store.roleForm!.description = '调整角色说明';
    expect(await s.store.save()).toBe(true); expect(s.store.decision).toBeNull();
    await s.store.openRole(); s.store.roleForm!.name = '新角色';
    expect(await s.store.save()).toBe(true); expect(s.store.decision).toBeNull();
  });

  it('关联角色权限改变只确认一次，取消保留输入且不提交', async () => {
    const s = await setup(); await s.store.changeTab('roles'); await s.store.openRole({ id: 'ROLE-RESOURCE' });
    s.store.toggle('resources.edit', false);
    const cancelled = s.store.save(); await settle();
    expect(s.store.decision?.title).toBe('确认账号与权限影响'); s.store.answer('cancel');
    expect(await cancelled).toBe(false); expect(s.store.dirty).toBe(true);
    expect(previewService.saveSystemRole).not.toHaveBeenCalled();
    const saved = s.store.save(); await settle(); s.store.answer('save');
    expect(await saved).toBe(true); expect(previewService.saveSystemRole).toHaveBeenCalledTimes(1);
    expect(readSystem(s.storage).roles.find(r => r.id === 'ROLE-RESOURCE')!.permissions).not.toContain('resources.edit');
  });

  it('保存并离开合并权限影响提示，不连续弹窗', async () => {
    const s = await setup(); await s.store.changeTab('roles'); await s.store.openRole({ id: 'ROLE-RESOURCE' });
    s.store.toggle('resources.edit', false);
    const leaving = s.store.allowLeave(); await settle();
    expect(s.store.decision?.title).toBe('系统表单尚未保存');
    expect(s.store.decision?.message).toContain('所有使用此角色');
    s.store.answer('save'); await settle(); expect(s.store.decision).toBeNull();
    expect(await leaving).toBe(true); expect(previewService.saveSystemRole).toHaveBeenCalledTimes(1);
  });

  it('无变化保存不发请求，保存失败保留输入，重试后清理旧错误', async () => {
    const s = await setup(); await s.store.openAccount({ id: 'SYS-RESOURCE' });
    expect(s.store.canSave).toBe(true); expect(await s.store.save()).toBe(true);
    expect(previewService.saveSystemAccount).not.toHaveBeenCalled();
    await s.store.openAccount({ id: 'SYS-RESOURCE' }); s.store.accountForm!.name = '保留的输入';
    vi.mocked(previewService.saveSystemAccount).mockRejectedValueOnce(new Error('保存暂不可用'));
    expect(await s.store.save()).toBe(false); expect(s.store.accountForm?.name).toBe('保留的输入');
    expect(s.store.error).toBe('保存暂不可用'); expect(s.store.notice).toBe('');
    expect(await s.store.save()).toBe(true); expect(s.store.error).toBe(''); expect(s.store.notice).toBe('修改已保存');
  });

  it('查询失败保留成功条件，后续翻页不带入失败或未提交输入', async () => {
    const s = await setup(); s.store.query.search = '资源'; await s.store.search();
    s.store.query.search = '新条件';
    vi.mocked(previewService.queryAccountSummaries).mockRejectedValueOnce(new Error('查询失败'));
    await s.store.search(); expect(s.store.loadError).toBe('查询失败'); expect(s.store.appliedQuery.search).toBe('资源');
    await s.store.changePage(1);
    expect(previewService.queryAccountSummaries).toHaveBeenLastCalledWith(expect.objectContaining({ search: '资源', pageNum: 2 }));
    expect(s.store.query.search).toBe('新条件'); expect(s.store.loadError).toBe('');
  });
});
