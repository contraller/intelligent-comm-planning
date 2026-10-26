// 真实页面验收宿主；独立浏览器、显式新库、原始失败和截图均保留在本轮目录。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(key);
  return index < 0 ? fallback : args[index + 1];
};
const runtime = path.resolve(option('--runtime-root', ''));
const group = option('--group', 'inspect');
assert(['inspect', 'core', 'planning', 'sr56', 'sr56Remaining', 'operations', 'performance', 'leave', 'resourceWrites', 'responsive', 'system', 'session', 'accountAccess', 'coverage'].includes(group));
assert.equal(path.dirname(runtime), path.join(root, 'data/runtime/r2'));
assert.match(path.basename(runtime), /^r4-[a-f0-9]{32}$/);
const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'workspace.json'), 'utf8'));
assert.equal(manifest.frontend, 'http://127.0.0.24:5324');
assert.equal(manifest.api, 'http://127.0.0.24:8124');
assert.equal(path.resolve(manifest.key_file), path.join(runtime, 'private.json'));
assert.equal(manifest.database_url, `sqlite:///${path.join(root, 'data/runtime/tmp', path.basename(runtime), 'workspace.sqlite').replaceAll('\\', '/')}`);
const privateConfig = JSON.parse(await fs.readFile(manifest.key_file, 'utf8'));
if (option('--png-package', '')) process.env.R6_PNG_PACKAGE = path.resolve(option('--png-package'));
const runId = `r6-browser-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const evidence = path.join(runtime, 'browser', runId);
await fs.mkdir(evidence, { recursive: false });
// 每组串行复用专属测试上下文，证据仍按次新增；不复制依赖或动用户标签。
const profile = path.join(runtime, 'browser-contexts', group);
await fs.mkdir(profile, { recursive: true });
process.env.TEMP = path.join(runtime, 'tmp');
process.env.TMP = process.env.TEMP;
const require = createRequire(option('--playwright-package', path.join(root, 'front_design/radio-planning-20261022/package.json')));
const { chromium } = require('playwright');
// 本轮所有分组共用回环互斥锁；进程退出自动释放，不残留锁文件。
const lease = net.createServer(socket => socket.destroy());
await new Promise((resolve, reject) => {
  lease.once('error', error => reject(new Error(`本轮已有浏览器验收运行或互斥端口不可用：${error.code}`)));
  lease.listen({ host: '127.0.0.24', port: 55324, exclusive: true }, resolve);
});
lease.unref();
const memoryBefore = { freeBytes: os.freemem(), totalBytes: os.totalmem(), at: new Date().toISOString() };
assert(memoryBefore.freeBytes >= 1024 ** 3, '可用物理内存不足1GiB，暂不启动浏览器；不终止用户其他程序。');
const context = await chromium.launchPersistentContext(profile, {
  executablePath: option('--edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
  headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
  downloadsPath: path.join(evidence, 'downloads'), tracesDir: evidence,
});
const page = await context.newPage();
// 复用的是本组专属测试目录；关闭恢复的旧页，避免后台轮询干扰本次验收。
for (const previous of context.pages()) if (previous !== page) await previous.close();
page.setDefaultTimeout(30000);
const cases = [], requests = [], pageErrors = [];
let activeRole = '', completed = false, failure = null;
const origin = manifest.frontend;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('response', response => {
  const url = new URL(response.url());
  if (url.origin === origin && /^\/(api|maps|fonts|health)\//.test(url.pathname)) requests.push({
    path: url.pathname + url.search, method: response.request().method(), status: response.status(), at: Date.now(),
  });
});
const shot = async label => {
  assert.match(label, /^[A-Za-z0-9_-]+$/);
  const file = path.join(evidence, label + '.png');
  await page.screenshot({ path: file, fullPage: false });
  return file;
};
let evidenceSaveSequence = 0;
let evidenceSaveTail = Promise.resolve();
const save = () => {
  // 入列时冻结证据，串行写独立临时文件，不截断上一次有效结果。
  const pending = path.join(evidence, `results.pending-${process.pid}-${++evidenceSaveSequence}.json`);
  const bytes = JSON.stringify({
    method: 'REAL_BROWSER_EDGE_LOCAL_PASSWORD', group, runId, source: 'LATEST_FRONTEND_DEV_SOURCE',
    frontend: origin, taskId, planId, cases, pageErrors, requests, completed, failure,
    execution: { serialBrowserLease: '127.0.0.24:55324', memoryBefore, freeMemoryBytes: os.freemem() },
  }, null, 2);
  const operation = evidenceSaveTail.then(async () => {
    await fs.writeFile(pending, bytes, { flag: 'wx', flush: true });
    // Windows短暂读句柄会阻止原子替换；只重试落盘，不重放任何业务请求。
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(pending, path.join(evidence, 'results.json')); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(50 * 2 ** attempt, 1000)));
      }
    }
  });
  evidenceSaveTail = operation.catch(() => {});
  return operation;
};
const record = async (id, action) => {
  assert.match(id, /^[A-Za-z0-9_-]+$/);
  const started = Date.now(), requestIndex = requests.length, errorIndex = pageErrors.length;
  try {
    const detail = await action();
    assert.equal(pageErrors.length, errorIndex, '本操作出现未处理页面异常');
    cases.push({ id, state: 'PASS', elapsed_ms: Date.now() - started, detail: detail ?? null,
      requests: requests.slice(requestIndex), screenshot: await shot(id) });
    await save();
    console.log(JSON.stringify({ case: id, state: 'PASS', elapsed_ms: Date.now() - started }));
    return detail;
  } catch (error) {
    await fs.writeFile(path.join(evidence, id + '-dom.json'), JSON.stringify(await page.evaluate(() => ({
      url: location.href, text: document.body.innerText,
      buttons: [...document.querySelectorAll('button')].map(value => ({ text: value.innerText, disabled: value.disabled, type: value.type })),
      // 只记录输入有效性和长度，绝不记录账号口令内容。
      inputs: [...document.querySelectorAll('input')].map(value => ({ label: value.getAttribute('aria-label'), type: value.type,
        length: value.value.length, valid: value.validity.valid, message: value.validationMessage })),
    })).catch(() => ({ unavailable: true })), null, 2));
    cases.push({ id, state: 'FAIL', elapsed_ms: Date.now() - started, error: String(error.message),
      requests: requests.slice(requestIndex), screenshot: await shot(id + '-failed').catch(() => null) });
    await save();
    throw error;
  }
};
const login = async (role, { reuseLoginPage = false } = {}) => {
  if (activeRole === role && !page.url().includes('/login')) return;
  assert(['admin', 'editor', 'reviewer'].includes(role));
  if (reuseLoginPage) {
    assert.equal(group, 'session');
    assert.equal(new URL(page.url()).origin, origin);
    assert(new URL(page.url()).hash.startsWith('#/login'));
  } else {
    await context.clearCookies();
    // 切换测试身份只清理独立上下文；不注销其他浏览器或替代产品退出用例。
    await page.goto(`${origin}/?acceptance=${runId}-${Date.now()}#/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  }
  await page.getByLabel('账号', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('.login-enter');
    return button && !button.disabled;
  }, { timeout: 60000 });
  await page.getByLabel('账号', { exact: true }).fill(privateConfig.accounts[role].username);
  await page.getByLabel('密码', { exact: true }).fill(privateConfig.accounts[role].password);
  const [response] = await Promise.all([
    page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/auth/login' && value.request().method() === 'POST', { timeout: 60000 }),
    page.getByRole('button', { name: '登录工作区' }).click({ timeout: 60000 }),
  ]);
  assert.equal(response.status(), 200, '真实登录未成功');
  await page.waitForURL(url => url.hash !== '#/login' && !url.hash.startsWith('#/login?'), { timeout: 60000 });
  activeRole = role;
};
const fillSystemOperatorPassword = async ({ targetId }) => {
  // 仅恢复本轮已创建的可牺牲账号；凭据只填真实表单，不返回或写证据。
  assert(group === 'system' && ['runSystemResumeCreatedAccount', 'runSystemResumeAccountReadonly'].includes(option('--entry', ''))
    || group === 'accountAccess' && ['runAccountAccess', 'runAccountAccessResume'].includes(option('--entry', '')));
  assert.equal(process.env.R6_SYSTEM_RUN_ID, 'bf0e888b-0c04-4c65-9dbd-479f60c89baa');
  assert.equal(targetId, 'ACC-48883ff3e2634b8bbb13dd54a43a3398');
  assert.equal(activeRole, 'admin');
  await page.route('**/api/v1/system/accounts/*/password', async route => {
    const url = new URL(route.request().url());
    if (!['http://127.0.0.24:5324', 'http://127.0.0.24:8124'].includes(url.origin)
        || url.pathname !== `/api/v1/system/accounts/${targetId}/password`) {
      pageErrors.push('验收拒绝向非本轮测试账号维护密码');
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const drawer = page.locator('.p-drawer:visible').filter({
    has: page.locator('.p-drawer-title').filter({ hasText: /^维护账号密码$/ }),
  });
  assert.equal(await drawer.count(), 1);
  await drawer.getByLabel('操作人当前密码', { exact: true }).fill(privateConfig.accounts.admin.password);
};
const accountTestSecrets = {
  async create() { return accountSecrets(false); },
  async read() { return accountSecrets(true); },
};
async function accountSecrets(readExisting) {
  // 仅为已创建的本轮可牺牲账号保管密文，避免验收中断后反复维护密码。
  assert.equal(group, 'accountAccess');
  const purpose = 'r6-account-access-v1', targetId = 'ACC-48883ff3e2634b8bbb13dd54a43a3398';
  const systemRun = 'bf0e888b-0c04-4c65-9dbd-479f60c89baa';
  assert.equal(process.env.R6_SYSTEM_RUN_ID, systemRun);
  const folder = path.join(runtime, 'browser-private');
  const file = path.join(folder, 'r6-account-access.enc.json');
  const aad = Buffer.from(JSON.stringify({ purpose, targetId, systemRun }));
  const key = crypto.hkdfSync('sha256', Buffer.from(privateConfig.identity_request_key, 'base64'),
    Buffer.from(systemRun), Buffer.from(purpose + ':' + targetId), 32);
  if (readExisting) {
    const sealed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(sealed.purpose, purpose); assert.equal(sealed.targetId, targetId); assert.equal(sealed.systemRun, systemRun);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const secret = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    assert.equal(typeof secret.initial, 'string'); assert.equal(secret.initial.length, 32);
    assert.equal(typeof secret.next, 'string'); assert.equal(secret.next.length, 8);
    return secret;
  }
  await fs.mkdir(folder, { recursive: true });
  try { await fs.access(file); throw new Error('原测试密文已存在，只能原号恢复，不生成新口令'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const secret = { initial: crypto.randomBytes(24).toString('base64url'),
    next: [...crypto.randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join('') };
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  const sealed = { purpose, targetId, systemRun, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  const pending = file + '.' + crypto.randomUUID() + '.pending';
  await fs.writeFile(pending, JSON.stringify(sealed), { flag: 'wx', flush: true, mode: 0o600 });
  await fs.rename(pending, file);
  return secret;
}
const download = async (action, label) => {
  assert.match(label, /^[A-Za-z0-9_-]+$/);
  const [item] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), action()]);
  assert.equal(await item.failure(), null);
  const name = item.suggestedFilename();
  const target = path.join(evidence, label + path.extname(name));
  await item.saveAs(target);
  const bytes = await fs.readFile(target);
  assert(bytes.length > 0, '下载为空');
  return { file: target, suggested_name: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
};
let taskId = option('--task-id', ''), planId = option('--plan-id', '');
if (!taskId || !planId) {
  const candidates = (await fs.readdir(runtime)).filter(name => /^r6-plan-http-.*\.json$/.test(name));
  for (const name of candidates.reverse()) {
    const value = JSON.parse(await fs.readFile(path.join(runtime, name), 'utf8'));
    if (value.completed && value.result?.state === 'CONFIRMED') {
      taskId = value.result.task_id; planId = value.result.plan_id; break;
    }
  }
}
try {
  if (group === 'inspect') {
    await record('LOGIN-EDITOR', async () => {
      await login('editor');
      await page.getByRole('heading', { name: 'GIS 态势', exact: true }).waitFor({ timeout: 60000 });
      const text = await page.locator('body').innerText();
      await fs.writeFile(path.join(evidence, 'visible-page.txt'), text);
      return { url: page.url(), text_tail: text.slice(-2500) };
    });
  } else {
    assert(taskId && planId, '须先真实计算并保存本轮方案');
    const modules = { core: './r6_browser_core.mjs', planning: './r6_browser_planning.mjs',
      sr56: './r6_browser_sr56.mjs', operations: './r6_browser_operations.mjs', performance: './r6_browser_performance.mjs',
      leave: './r6_browser_leave.mjs', resourceWrites: './r6_browser_resource_writes.mjs', responsive: './r6_browser_responsive.mjs',
      system: './r6_browser_system.mjs', session: './r6_browser_session.mjs', accountAccess: './r6_browser_account_access.mjs',
      coverage: './r6_browser_coverage.mjs', sr56Remaining: './r6_browser_sr56_remaining.mjs' };
    assert(Object.hasOwn(modules, group), '未知验收分组');
    const module = await import(modules[group]);
    const entry = option('--entry', '');
    if (entry) assert(/^[A-Za-z][A-Za-z0-9]+$/.test(entry) && Object.hasOwn(module, entry), '未知分段验收函数');
    const run = entry ? module[entry] : module.default ?? module.runCore ?? module.runPlanning ?? module.runSr56 ?? module.runOperations ?? module.runPerformance;
    assert.equal(typeof run, 'function');
    const caseNames = option('--cases', '').split(',').map(value => value.trim()).filter(Boolean);
    const result = await run({ page, runtime, evidence, taskId, planId, login, record, download, shot,
      ...((group === 'system' && ['runSystemResumeCreatedAccount', 'runSystemResumeAccountReadonly'].includes(entry)) || group === 'accountAccess'
        ? { fillSystemOperatorPassword } : {}),
      ...(group === 'accountAccess' ? { accountTestSecrets } : {}),
      ...(caseNames.length ? { caseNames } : {}), performanceComplete: option('--performance-complete', '') === '1' });
    await fs.writeFile(path.join(evidence, 'group-result.json'), JSON.stringify(result ?? null, null, 2));
  }
  completed = true;
} catch (error) {
  failure = { name: error.name, message: error.message };
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  try {
    await save();
    console.log(JSON.stringify({ evidence, completed, cases: cases.length, failed: cases.filter(value => value.state === 'FAIL').length, page_errors: pageErrors.length }));
  } finally {
    // 证据落盘失败也必须关闭本轮独立浏览器，不遗留进程占用。
    try { await context.close(); }
    finally { await new Promise(resolve => lease.close(resolve)); }
  }
}
