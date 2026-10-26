// 真实退出及同一文档重登录，不新建账号、不修改口令或业务资源。
import assert from 'node:assert/strict';

const button = (page, name) => page.getByRole('button').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });
export async function runSessionLifecycle(h) {
  assert(h.page.url() === 'about:blank' || new URL(h.page.url()).origin === 'http://127.0.0.24:5324');
  await h.record('R6-SESSION-logout-real-login-form', async () => {
    await h.login('admin');
    await h.page.getByRole('heading', { name: '系统管理', exact: true, level: 1 }).waitFor();
    const pending = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/logout'
      && response.request().method() === 'POST', { timeout: 60000 });
    pending.catch(() => {});
    await button(h.page, '退出').click();
    const response = await pending;
    assert.equal(response.status(), 200); assert.equal((await response.json()).code, 0);
    await h.page.waitForURL(url => url.hash.startsWith('#/login'));
    await h.page.getByLabel('账号', { exact: true }).waitFor({ state: 'visible' });
    // 等真实对话框退出动画结束，不把过渡帧当作仍被会话冻结。
    await h.page.getByText('当前工作区已冻结', { exact: true }).waitFor({ state: 'hidden', timeout: 5000 });
    return { productLogout: true, realLoginFormVisible: true, credentialsChanged: false };
  });
  await h.record('R6-SESSION-same-document-admin-relogin', async () => {
    await h.login('admin', { reuseLoginPage: true });
    await h.page.getByRole('heading', { name: '系统管理', exact: true, level: 1 }).waitFor();
    await h.page.getByText('当前工作区已冻结', { exact: true }).waitFor({ state: 'hidden', timeout: 5000 });
    return { sameDocumentRelogin: true, adminRestored: true, resourceWrites: 0 };
  });
  return { cases: 2, sameDocument: true };
}
