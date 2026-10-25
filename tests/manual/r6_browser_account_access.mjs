// 仅由主 accountAccess 宿主导入；旧 system 脚本、检查点及既有账号均不可写。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://127.0.0.24:5324', API = '/api/v1';
const ORIGINS = new Set([ORIGIN, 'http://127.0.0.24:8124']);
const RUN = 'bf0e888b-0c04-4c65-9dbd-479f60c89baa';
const RUNTIME = path.join(ROOT, 'data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013');
const ACCOUNT = 'ACC-48883ff3e2634b8bbb13dd54a43a3398', USERNAME = 'r6abf0e888b0c04';
const ROLE = 'ROLE-7febd6c9940e444d9393c6e425e88006', ROLE_NAME = 'R6-A-view-bf0e888b0c04';
const ADMIN = 'ACC-93989dce75d14a99ad82ed6eb9b200f5';
const ORIGINAL_ROLES = ['ROLE-55609d073cb14a73940f07df01097af4', 'ROLE-50aa11292a45466ab38a3e7cc6f468d4', 'ROLE-c455c3c5917d41559f09fc68a187aef1'];
const OLD05 = 'A-SYSTEM-05-sacrificial-real-login';
const IDS = ['A-ACCOUNT-ACCESS-05-login', 'A-ACCOUNT-ACCESS-06-self-password', 'A-ACCOUNT-ACCESS-07-relogin-restrictions'];
const SYS_HASH = '616767cc7e0cf814a1c51be4c3f95aa1fa3748fc84c5d5128733bf1abec9ef63';
const DOM_HASH = '36ef16091b2a723bc895c334ce9d972724e1751e3b35bd152611eb29f0188933';
const RESULT_HASH = '837af81daa874c6b649a6cb9147475c47a86ae8a4c119c7812dff50033b8afe8';
const TARGET = '/system/accounts/' + ACCOUNT;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, text) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escape(text)}\\s*$`) });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const limited = value => String(value ?? '').slice(0, 1024);
const identity = value => {
  assert(value && typeof value.account_id === 'string' && typeof value.role_id === 'string' && Array.isArray(value.permissions), 'Incomplete actual identity.');
  return { account_id: value.account_id, username: value.username, role_id: value.role_id, permissions: [...value.permissions].sort() };
};
function result(value) {
  return { object_id: typeof value?.objectId === 'string' ? value.objectId : undefined,
    operation_id: typeof value?.operationId === 'string' ? value.operationId : undefined,
    revision: typeof value?.revision === 'string' ? value.revision : undefined,
    changed: value?.changed === true, reauthentication_required: value?.reauthenticationRequired === true };
}
function matches(response, method, endpoint) {
  const url = new URL(response.url());
  return ORIGINS.has(url.origin) && url.pathname === API + endpoint && response.request().method() === method;
}
function accepted(op) {
  return op && ['ACK_RECEIVED', 'ACK_VALIDATED', 'READBACK_CONFIRMED'].includes(op.phase)
    && [200, 201].includes(op.status) && op.code === 0 && op.result?.changed === true;
}

async function sourceProof() {
  const sourceFile = path.join(ROOT, 'data/runtime/r6', RUN, 'system-state.json');
  const bytes = await fs.readFile(sourceFile); assert.equal(hash(bytes), SYS_HASH, 'Frozen system checkpoint changed; stop.');
  const source = JSON.parse(bytes.toString('utf8'));
  assert.equal(source.run_id, RUN); assert.equal(source.runtime, RUNTIME);
  assert.equal(source.anchors.account_id, ACCOUNT); assert.equal(source.anchors.role_id, ROLE);
  assert.equal(source.anchors.admin_id, ADMIN); assert.equal(source.username, USERNAME);
  assert.deepEqual(source.anchors.preexisting_role_ids, ORIGINAL_ROLES);
  assert.deepEqual(source.anchors.role_permissions, ['situation.view']);
  assert.equal(source.admin_restored, true); assert(!source.unexpected_writes?.length);
  assert.equal(source.cases[OLD05].phase, 'FAILED'); assert(!source.cases['A-SYSTEM-06-self-password-7-reject-8-accept']);
  assert(!source.cases['A-SYSTEM-07-new-password-login-restrictions']);
  assert.deepEqual(Object.keys(source.operations), ['role-create', 'account-create', 'duplicate-account', 'account-password-recovery', 'account-disable', 'account-enable']);
  const originals = [
    ['role-create', 'd6c7f445-26e1-4bb3-be41-24577da96e49', ROLE],
    ['account-create', 'f50ffa38-362a-475b-9bca-8ff54bb80017', ACCOUNT],
    ['account-password-recovery', '0d1ed2d8-9cf5-4f7d-979c-e7acfa8b2ef8', ACCOUNT],
    ['account-disable', 'a8007b41-c44d-47bc-8509-4de50bedf7bb', ACCOUNT],
    ['account-enable', 'dd659619-0b02-4a3f-85e0-4f61a1f04c39', ACCOUNT],
  ];
  for (const [key, requestId, target] of originals) {
    const op = source.operations[key]; assert.equal(op.phase, 'READBACK_CONFIRMED');
    assert.equal(op.request_id, requestId); assert.equal(op.target_id, target); assert.equal(op.result.object_id, target);
    assert.equal(op.status, 200); assert.equal(op.code, 0); assert.equal(op.sent_count, 1); assert.equal(op.result.changed, true);
  }
  assert.equal(source.operations['duplicate-account'].request_id, '7243a997-7600-4d63-b883-7d626fab01d8');
  assert.equal(source.operations['duplicate-account'].phase, 'EXPLICIT_REJECTION');
  assert.equal(source.operations['duplicate-account'].status, 409); assert.equal(source.operations['duplicate-account'].code, 1203);
  assert.equal(source.operations['account-disable'].enabled, false); assert.equal(source.operations['account-enable'].enabled, true);
  assert(!source.http.some(row => row.endpoint === '/auth/password'));
  const dir = path.join(RUNTIME, 'browser/r6-browser-1792880363346-714b72');
  const domFile = path.join(dir, OLD05 + '-dom.json'), resultsFile = path.join(dir, 'results.json');
  const domBytes = await fs.readFile(domFile), resultBytes = await fs.readFile(resultsFile);
  assert.equal(hash(domBytes), DOM_HASH); assert.equal(hash(resultBytes), RESULT_HASH);
  const dom = JSON.parse(domBytes.toString('utf8')), report = JSON.parse(resultBytes.toString('utf8'));
  assert(dom.text.includes('当前工作区已冻结')); assert.equal(report.completed, false);
  assert.deepEqual(report.pageErrors, ['运行参数实例已经绑定', "Cannot set properties of null (setting '__vnode')"]);
  assert.deepEqual(report.cases.map(row => [row.id, row.state]), [
    ['A-SYSTEM-R03b-account-readonly-continuation', 'PASS'], ['A-SYSTEM-R02-sacrificial-admin-password-recovery', 'PASS'],
    ['A-SYSTEM-04-state-cancel-disable-enable', 'PASS'], [OLD05, 'FAIL'], ['A-SYSTEM-restore-admin', 'PASS'],
  ]);
  const fifth = report.cases.find(row => row.id === OLD05);
  assert(fifth.requests.some(row => row.path === API + '/auth/logout' && row.method === 'POST' && row.status === 200));
  assert(!fifth.requests.some(row => row.path === API + '/auth/login' && row.method === 'POST'));
  assert(!report.requests.some(row => row.path === API + '/auth/password'));
  return { system_checkpoint: sourceFile, system_sha256: SYS_HASH, dom_file: domFile, dom_sha256: DOM_HASH,
    results_file: resultsFile, results_sha256: RESULT_HASH, original_operations: structuredClone(source.operations),
    original_cases: Object.fromEntries(Object.entries(source.cases).map(([id, value]) => [id, value.phase])),
    no_prior_target_login_or_self_password: true, original_admin_id: ADMIN, preexisting_role_ids: [...ORIGINAL_ROLES] };
}

function validateSecrets(value) {
  // 断言仅输出布尔结论，不把秘密作为 assert 的 actual/expected。
  assert(value && typeof value.initial === 'string' && [...value.initial].length === 32, 'Encrypted initial credential must have length 32.');
  assert(typeof value.next === 'string' && /^[a-z0-9]{8}$/.test(value.next), 'Encrypted next credential must be eight lowercase/digit characters.');
  assert(value.initial !== value.next, 'The two encrypted credentials must differ.');
  return value;
}

async function context(h, resume) {
  assert(h.page && path.resolve(h.runtime) === RUNTIME, 'Only the original .24 runtime is allowed.');
  for (const key of ['login', 'record', 'fillSystemOperatorPassword']) assert.equal(typeof h[key], 'function');
  assert.equal(typeof h.accountTestSecrets?.create, 'function'); assert.equal(typeof h.accountTestSecrets?.read, 'function');
  assert.equal(h.accountAccessRunId ?? process.env.R6_SYSTEM_RUN_ID ?? RUN, RUN);
  assert(h.page.url() === 'about:blank' || new URL(h.page.url()).origin === ORIGIN);
  const proof = await sourceProof(), output = path.join(ROOT, 'data/runtime/r6', RUN);
  const file = path.join(output, 'account-access-state.json');
  let state;
  if (resume) {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(state.schema, 'r6-account-access-v1'); assert.equal(state.run_id, RUN);
    assert.equal(state.runtime, RUNTIME); assert.equal(state.account_id, ACCOUNT); assert.equal(state.role_id, ROLE); assert.equal(state.username, USERNAME);
    assert.deepEqual(state.source_proof, proof); assert(!state.unexpected_writes?.length);
    assert.equal(state.secrets.phase, 'SEALED_VERIFIED');
    assert(accepted(state.operations['final-admin-maintenance']), 'Resume requires the already accepted original maintenance receipt; never submit again.');
    for (const [key, op] of Object.entries(state.operations)) {
      assert(['final-admin-maintenance', 'self-password', 'final-disable'].includes(key));
      assert(accepted(op), 'Unknown ARMED/SENT/rejected operation requires main original-number review, never resubmission.');
      assert.equal(op.target_id, ACCOUNT); assert.equal(op.sent_count, 1); assert(op.request_id);
      assert.equal(op.response_request_id, op.request_id);
      assert.equal(op.endpoint, key === 'final-admin-maintenance' ? TARGET + '/password' : key === 'self-password' ? '/auth/password' : TARGET + '/state');
      assert.equal(op.actor_id, key === 'self-password' ? ACCOUNT : ADMIN);
      if (op.result.object_id != null) assert.equal(op.result.object_id, ACCOUNT);
      if (key === 'self-password') assert.equal(op.result.reauthentication_required, true);
      if (key === 'final-disable') assert.equal(op.enabled, false);
    }
    if (accepted(state.operations['self-password'])) {
      assert(state.checks.initial_login_verified && state.checks.forced_change_visible && state.checks.short_rejected,
        'Original initial-login/short-password proof is required before receipt recovery.');
      assert(state.attempts.some(attempt => attempt.cases.some(row => row.id === IDS[0] && row.phase === 'PASS')));
    }
    if (accepted(state.operations['final-disable'])) {
      assert(state.checks.new_password_verified && state.checks.same_spa_relogin_verified);
      assert(IDS.every(id => state.attempts.some(attempt => attempt.cases.some(row => row.id === id && row.phase === 'PASS'))));
    }
  } else {
    try { await fs.access(file); throw new Error('Account-access checkpoint already exists; only the explicit receipt resume entry may inspect it.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    state = { schema: 'r6-account-access-v1', run_id: RUN, runtime: RUNTIME, account_id: ACCOUNT, role_id: ROLE,
      username: USERNAME, source_proof: proof, secrets: { phase: 'NOT_CREATED', storage: 'HOST_AES_GCM_ONLY' },
      operations: {}, checks: {}, attempts: [], http: [], unexpected_writes: [], admin_restored: false };
    await fs.writeFile(file, JSON.stringify(state, null, 2), { flag: 'wx', flush: true });
  }
  let credentials = null, diskFailure = null, scopeFailure = null, tail = Promise.resolve(), sequence = 0;
  const redact = error => {
    let text = error instanceof Error ? error.message : String(error);
    for (const secret of [credentials?.initial, credentials?.next, credentials?.next?.slice(0, 7)].filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');
    return limited(text);
  };
  const failDisk = error => {
    if (!diskFailure) {
      diskFailure = error;
      console.error(JSON.stringify({ account_access_checkpoint_failed: error.code ?? 'WRITE_FAILED', file,
        originals: Object.fromEntries(Object.entries(state.operations).map(([key, op]) => [key, { request_id: op.request_id, phase: op.phase }])) }));
    }
    return diskFailure;
  };
  const save = () => {
    if (diskFailure) return Promise.reject(diskFailure);
    let bytes; try { bytes = JSON.stringify(state, null, 2); } catch (error) { return Promise.reject(failDisk(error)); }
    const temp = file + '.' + process.pid + '.' + (++sequence) + '.' + crypto.randomUUID() + '.tmp';
    const pending = tail.then(async () => {
      if (diskFailure) throw diskFailure;
      try { await fs.writeFile(temp, bytes, { flag: 'wx', flush: true }); await fs.rename(temp, file); }
      catch (error) { throw failDisk(error); }
    });
    tail = pending.catch(() => {}); return pending;
  };
  const errors = [], requests = [];
  const guard = async (restoring = false) => {
    let last; do { last = tail; await last; } while (last !== tail);
    if (diskFailure) throw diskFailure;
    if (!restoring) { if (scopeFailure) throw scopeFailure; assert.equal(errors.length, 0, 'Page error observed; keep accepted originals and stop.'); }
  };
  const c = { h, state, file, output, resume, save, guard, redact, actor: null, errors, requests,
    selfAcceptedOnEntry: resume && accepted(state.operations['self-password']),
    drawer: title => h.page.locator('.p-drawer:visible').filter({ has: h.page.locator('.p-drawer-title').filter({ hasText: new RegExp(`^${escape(title)}$`) }) }),
    async until(check, message) {
      const end = Date.now() + 60000;
      while (Date.now() < end) { await guard(); if (await check()) return; await pause(); } throw new Error(message);
    },
    timeOrigin: () => h.page.evaluate(() => performance.timeOrigin),
    passed: id => state.attempts.some(attempt => attempt.cases.some(row => row.id === id && row.phase === 'PASS')),
  };
  const onError = error => { errors.push(redact(error)); };
  const onRequest = request => {
    const url = new URL(request.url());
    if (!ORIGINS.has(url.origin) || !url.pathname.startsWith(API + '/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const endpoint = url.pathname.slice(API.length), row = { endpoint, method: request.method() }; requests.push(row);
    const op = Object.values(state.operations).find(value => value.endpoint === endpoint && ['ARMED', 'SENT'].includes(value.phase));
    const auth = ['/auth/login', '/auth/logout'].includes(endpoint);
    const allowed = request.method() === 'POST' && (auth || op && (
      endpoint === '/auth/password' || endpoint === TARGET + '/state' || !resume && endpoint === TARGET + '/password'));
    if (!allowed) {
      try { const id = request.postDataJSON()?.requestId; if (typeof id === 'string') row.request_id = id; } catch { /* 不记录未知正文。 */ }
      state.unexpected_writes.push(row); scopeFailure ??= new Error('Unexpected mutation endpoint: ' + endpoint); save().catch(() => {});
    }
  };
  h.page.on('pageerror', onError); h.page.on('request', onRequest);
  c.http = async (method, endpoint, action, received, restoring = false) => {
    await guard(restoring);
    const waiting = h.page.waitForResponse(value => matches(value, method, endpoint), { timeout: 60000 }); waiting.catch(() => {});
    await action(); const response = await waiting, body = await response.json();
    const trace = { endpoint, method, status: response.status(), code: body.code };
    if (endpoint.startsWith('/system/') || endpoint === '/auth/password') Object.assign(trace, result(body.data));
    if (method === 'POST' && !['/auth/login', '/auth/logout'].includes(endpoint)) trace.request_id = response.request().postDataJSON()?.requestId;
    state.http.push(trace); if (received) received(body.data, trace); await save();
    assert([200, 201].includes(trace.status) && trace.code === 0, `Request not confirmed: ${method} ${endpoint}; status ${trace.status}; code ${trace.code}`);
    return body.data;
  };
  c.write = async (key, endpoint, action) => {
    await guard(); assert(!state.operations[key], 'Original operation exists; never resubmit: ' + key);
    assert.equal(endpoint, key === 'final-admin-maintenance' ? TARGET + '/password' : key === 'self-password' ? '/auth/password' : TARGET + '/state');
    if (key === 'final-admin-maintenance') {
      assert(!resume); assert.equal(state.secrets.phase, 'SEALED_VERIFIED'); assert.equal(c.actor?.account_id, ADMIN);
      assert.equal(state.checks.target_readonly, true); assert.equal(state.checks.operator_filled_by_main, true);
    } else if (key === 'self-password') {
      assert.equal(c.actor?.account_id, ACCOUNT); assert(c.passed(IDS[0])); assert.equal(state.checks.short_rejected, true);
    } else { assert.equal(key, 'final-disable'); assert.equal(c.actor?.account_id, ADMIN); assert(IDS.every(c.passed)); }
    const op = state.operations[key] = { endpoint, target_id: ACCOUNT, actor_id: c.actor.account_id, phase: 'ARMED', sent_count: 0, sent_requests: [] }; await save();
    const capture = request => {
      if (!matches({ url: () => request.url(), request: () => request }, 'POST', endpoint)) return;
      const body = request.postDataJSON(); op.phase = 'SENT'; op.sent_count++; op.request_id ??= body.requestId;
      if (typeof body.baseRevision === 'string') op.base_revision = body.baseRevision;
      if (typeof body.enabled === 'boolean') op.enabled = body.enabled;
      const lengths = Object.fromEntries(['currentPassword', 'newPassword'].filter(field => typeof body[field] === 'string').map(field => [field, [...body[field]].length]));
      op.sent_requests.push({ request_id: body.requestId, password_lengths: lengths });
      if (key === 'final-admin-maintenance') op.operator_password_supplied = typeof body.operatorPassword === 'string' && body.operatorPassword.length > 0;
      save().catch(() => {});
    };
    h.page.on('request', capture);
    try {
      const data = await c.http('POST', endpoint, action, (value, trace) => {
        op.phase = 'ACK_RECEIVED'; op.status = trace.status; op.code = trace.code; op.result = result(value);
        op.response_request_id = trace.request_id;
      });
      await guard(); assert.equal(op.sent_count, 1); assert.equal(typeof op.request_id, 'string');
      assert.equal(op.response_request_id, op.request_id); assert.equal(data.changed, true);
      if (data.objectId != null && data.objectId !== '') assert.equal(data.objectId, ACCOUNT);
      if (key === 'self-password') assert.equal(data.reauthenticationRequired, true);
      else { assert.equal(data.objectId, ACCOUNT); assert.match(data.operationId, /^OP-[a-f0-9]{32}$/); }
      if (key === 'final-admin-maintenance') assert.equal(op.base_revision, c.maintenanceRevision);
      if (key === 'final-disable') assert.equal(op.enabled, false);
      op.phase = 'ACK_VALIDATED'; await save(); return data;
    } catch (error) {
      op.error = redact(error); if (['ARMED', 'SENT'].includes(op.phase)) op.phase = 'UNCERTAIN_NO_RETRY';
      if (!diskFailure) await save(); throw new Error(redact(error));
    } finally { h.page.off('request', capture); }
  };
  c.confirm = async key => { await guard(); assert(accepted(state.operations[key])); state.operations[key].phase = 'READBACK_CONFIRMED'; await save(); };
  c.forceAdmin = async () => {
    await guard(true); await h.page.goto('about:blank#/login');
    const data = await c.http('POST', '/auth/login', async () => {
      try { await h.login('admin'); } catch { throw new Error('Private administrator UI login was not confirmed.'); }
    }, undefined, true);
    c.actor = identity(data); assert.equal(c.actor.account_id, ADMIN);
    assert(c.actor.permissions.includes('system.accounts') && c.actor.permissions.includes('system.roles'));
    state.admin_restored = true; await save();
    return { account_id: ADMIN, actual_ui_login: true };
  };
  c.logout = async () => {
    await c.http('POST', '/auth/logout', () => button(h.page, '退出').click()); c.actor = null;
    await h.page.waitForURL(url => url.hash.startsWith('#/login')); await h.page.getByLabel('账号', { exact: true }).waitFor({ state: 'visible' });
  };
  c.loginTarget = async password => {
    await h.page.getByLabel('账号', { exact: true }).waitFor({ state: 'visible' });
    await h.page.getByLabel('账号', { exact: true }).fill(USERNAME); await h.page.getByLabel('密码', { exact: true }).fill(password);
    const data = await c.http('POST', '/auth/login', () => button(h.page, '登录工作区').click());
    c.actor = identity(data); assert.equal(c.actor.account_id, ACCOUNT); assert.equal(c.actor.role_id, ROLE);
    assert.equal(c.actor.username, USERNAME); assert.deepEqual(c.actor.permissions, ['situation.view']);
    state.admin_restored = false; await save(); return c.actor;
  };
  const attempt = { index: state.attempts.length + 1, entry: resume ? 'runAccountAccessResume' : 'runAccountAccess', cases: [], phase: 'RUNNING' };
  state.attempts.push(attempt); await save();
  c.test = async (id, action) => {
    await guard(); const row = { id, phase: 'RUNNING' }; attempt.cases.push(row); await save();
    try {
      return await h.record(id, async () => {
        const detail = await action(); await guard(); row.phase = 'PASS'; row.detail = detail; await save(); return detail;
      });
    } catch (error) { row.phase = 'FAILED'; row.error = redact(error); if (!diskFailure) await save(); throw new Error(redact(error) + '\nAccount-access checkpoint: ' + file); }
  };
  c.loadSecrets = async () => {
    try {
      if (!resume) {
        const created = validateSecrets(await h.accountTestSecrets.create());
        credentials = validateSecrets(await h.accountTestSecrets.read());
        assert(created.initial === credentials.initial && created.next === credentials.next, 'Encrypted credentials did not read back identically.');
      } else credentials = validateSecrets(await h.accountTestSecrets.read());
    } catch { throw new Error('Encrypted test credential creation/readback not confirmed; do not generate credentials or repeat maintenance.'); }
    state.secrets = { phase: 'SEALED_VERIFIED', storage: 'HOST_AES_GCM_ONLY', initial_length: 32, next_length: 8 }; await save();
    return { initial: () => credentials.initial, next: () => credentials.next, short: () => credentials.next.slice(0, 7) };
  };
  c.finish = async (failure = null) => {
    try { await h.record('A-ACCOUNT-ACCESS-restore-admin', () => c.forceAdmin()); }
    catch { state.admin_restored = false; failure ??= new Error('Actual administrator restoration is not confirmed.'); }
    if (!failure) {
      try { await openSystem(c); await originalAccounts(c); state.checks.original_accounts_unchanged = true; }
      catch { failure = new Error('Original three account profiles are not confirmed unchanged.'); }
    }
    try { assert.equal(hash(await fs.readFile(proof.system_checkpoint)), SYS_HASH); }
    catch { failure ??= new Error('Frozen original system evidence is no longer unchanged; stop.'); }
    attempt.phase = failure ? 'FAILED' : 'PASS'; if (failure) attempt.error = redact(failure);
    attempt.page_errors = [...errors]; credentials = null;
    h.page.off('request', onRequest); h.page.off('pageerror', onError);
    try { await guard(true); await save(); } catch { failure ??= new Error('Final checkpoint persistence is not confirmed.'); }
    if (failure) throw new Error(redact(failure) + '\nAccount-access checkpoint: ' + file);
    return { checkpoint: file, account_id: ACCOUNT, role_id: ROLE, required_cases: IDS,
      account_disabled: state.checks.target_disabled === true, admin_restored: state.admin_restored,
      original_accounts_unchanged: state.checks.original_accounts_unchanged === true,
      encrypted_test_credentials_retained: true, frozen_system_checkpoint_unchanged: true };
  };
  return c;
}

async function query(c, tab, endpoint, search) {
  const page = c.h.page, target = button(page.locator('.side-list'), tab);
  if (!(await target.getAttribute('class') ?? '').includes('active')) await c.http('GET', endpoint, () => target.click());
  await page.getByLabel('搜索系统记录', { exact: true }).fill(search);
  return c.http('GET', endpoint, () => button(page.locator('.filters'), '查询').click());
}
async function openSystem(c) {
  const data = await c.http('GET', '/system/options', () => c.h.page.goto(`${ORIGIN}/?accountAccess=${RUN}-${Date.now()}#/system`, { waitUntil: 'domcontentloaded' }));
  for (const id of ORIGINAL_ROLES) assert(data.roles.some(role => role.id === id));
  assert(data.roles.some(role => role.id === ROLE && role.name === ROLE_NAME)); return data;
}
async function targetReadback(c, enabled) {
  const catalog = await query(c, '账号管理', '/system/accounts', USERNAME), rows = catalog.items.filter(row => row.username === USERNAME);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, ACCOUNT); assert.equal(rows[0].roleId, ROLE); assert.equal(rows[0].enabled, enabled);
  const row = c.h.page.locator('.accounts-table tbody tr').filter({ has: c.h.page.getByText(USERNAME, { exact: true }) });
  const detail = await c.http('GET', TARGET, () => button(row, '编辑').click());
  assert.equal(detail.account.id, ACCOUNT); assert.equal(detail.account.username, USERNAME); assert.equal(detail.account.roleId, ROLE);
  assert.equal(detail.account.enabled, enabled);
  const panel = c.drawer('编辑账号'); await panel.waitFor({ state: 'visible' });
  assert.equal(await panel.getByLabel('登录名', { exact: true }).inputValue(), USERNAME);
  const select = panel.locator('label').filter({ hasText: /^\s*角色/ }).locator(':scope > select'); assert.equal(await select.inputValue(), ROLE);
  await button(panel, '关闭').click(); await panel.waitFor({ state: 'hidden' }); return { row, account: detail.account, revision: detail.revision };
}
async function originalAccounts(c) {
  const data = await query(c, '账号管理', '/system/accounts', '');
  assert.equal(data.total, 4); assert.equal(data.items.length, 4);
  const original = data.items.filter(row => row.id !== ACCOUNT).map(row => ({ id: row.id, username: row.username,
    role_id: row.roleId, enabled: row.enabled, must_change_password: row.mustChangePassword ?? null })).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(original.length, 3); assert(original.some(row => row.id === ADMIN));
  assert.deepEqual(original.map(row => row.role_id).sort(), [...ORIGINAL_ROLES].sort());
  if (c.state.original_accounts) assert.deepEqual(original, c.state.original_accounts);
  else { c.state.original_accounts = original; await c.save(); }
}
async function readonly(c) {
  await c.forceAdmin(); const options = await openSystem(c);
  await originalAccounts(c);
  await query(c, '角色权限', '/system/roles', ROLE_NAME);
  const row = c.h.page.locator('.roles-table tbody tr').filter({ has: c.h.page.getByText(ROLE_NAME, { exact: true }) });
  const data = await c.http('GET', '/system/roles/' + ROLE, () => button(row, '权限矩阵 / 编辑').click());
  assert.equal(data.role.id, ROLE); assert.deepEqual(data.role.permissions, ['situation.view']);
  const panel = c.drawer('编辑角色权限'); await panel.waitFor({ state: 'visible' });
  assert.equal(await panel.getByRole('checkbox', { checked: true }).count(), 1);
  await panel.getByLabel(options.permissions.find(value => value.code === 'situation.view').name, { exact: true }).isChecked().then(value => assert(value));
  await button(panel, '关闭').click(); await panel.waitFor({ state: 'hidden' });
  const disabled = accepted(c.state.operations['final-disable']);
  const account = await targetReadback(c, !disabled);
  assert.equal(account.account.mustChangePassword, !accepted(c.state.operations['self-password']));
  c.state.checks.target_readonly = true; await c.save();
  return { account_id: ACCOUNT, role_id: ROLE, enabled: account.account.enabled,
    must_change_password: account.account.mustChangePassword, source_operations_unchanged: true };
}
async function maintain(c, secret, account) {
  if (c.resume) { await c.confirm('final-admin-maintenance'); return { original_request_id: c.state.operations['final-admin-maintenance'].request_id, resubmitted: false }; }
  const detail = await c.http('GET', TARGET, () => button(account.row, '维护密码').click());
  assert.equal(detail.account.id, ACCOUNT); assert.equal(detail.account.roleId, ROLE);
  const panel = c.drawer('维护账号密码'); await panel.waitFor({ state: 'visible' });
  c.maintenanceRevision = detail.revision;
  try { await c.h.fillSystemOperatorPassword({ targetId: ACCOUNT }); }
  catch { throw new Error('Private target-scoped operator input was not confirmed; no automatic retry.'); }
  c.state.checks.operator_filled_by_main = true; await c.save();
  await panel.getByLabel('新密码', { exact: true }).fill(secret.initial());
  await panel.getByLabel('确认新密码', { exact: true }).fill(secret.initial());
  await c.until(async () => await button(panel, '提交密码').isEnabled(), 'Final maintenance form is not actionable.');
  await c.write('final-admin-maintenance', TARGET + '/password', () => button(panel, '提交密码').click());
  await panel.waitFor({ state: 'hidden' }); const saved = await targetReadback(c, true);
  assert.equal(saved.account.mustChangePassword, true); await c.confirm('final-admin-maintenance');
  return { target_id: ACCOUNT, initial_length: 32, ciphertext_precommitted: true, request_id: c.state.operations['final-admin-maintenance'].request_id };
}
async function fifth(c, secret) {
  if (accepted(c.state.operations['self-password'])) {
    assert(c.passed(IDS[0]) && c.state.checks.initial_login_verified && c.state.checks.forced_change_visible, 'Accepted self-password needs original initial-login proof.');
    return { original_initial_login_preserved: true, old_initial_login_repeated: false };
  }
  await c.logout(); const actor = await c.loginTarget(secret.initial());
  await c.drawer('修改本人密码').waitFor({ state: 'visible' });
  c.state.checks.initial_login_verified = true; c.state.checks.forced_change_visible = true; await c.save();
  return { account_id: actor.account_id, role_id: actor.role_id, initial_length: 32, forced_change_visible: true };
}
async function sixth(c, secret) {
  if (accepted(c.state.operations['self-password'])) {
    assert.equal(c.state.checks.short_rejected, true); return { original_request_id: c.state.operations['self-password'].request_id, resubmitted: false, short_length: 7, next_length: 8 };
  }
  const panel = c.drawer('修改本人密码'); await panel.waitFor({ state: 'visible' });
  await panel.getByLabel('当前密码', { exact: true }).fill(secret.initial());
  await panel.getByLabel('新密码', { exact: true }).fill(secret.short()); await panel.getByLabel('确认新密码', { exact: true }).fill(secret.short());
  const before = c.requests.filter(row => row.endpoint === '/auth/password').length;
  await c.until(async () => !await button(panel, '提交密码').isEnabled(), 'Seven-character frontend gate is not disabled.');
  assert.equal(c.requests.filter(row => row.endpoint === '/auth/password').length, before);
  c.state.checks.short_rejected = true; await c.save();
  await panel.getByLabel('新密码', { exact: true }).fill(secret.next()); await panel.getByLabel('确认新密码', { exact: true }).fill(secret.next());
  await c.until(async () => await button(panel, '提交密码').isEnabled(), 'Eight-character frontend gate is not enabled.');
  c.state.checks.password_write_time_origin = await c.timeOrigin(); await c.save();
  await c.write('self-password', '/auth/password', () => button(panel, '提交密码').click());
  c.actor = null; await panel.waitFor({ state: 'hidden' });
  return { short_length: 7, short_submitted: false, next_length: 8, accepted_original_request: c.state.operations['self-password'].request_id };
}
async function seventh(c, secret) {
  if (c.selfAcceptedOnEntry) {
    // 跨 CLI 只回读原受理；本次 SPA 另以新口令退出/重登证明，不再改密。
    await c.logout(); await c.loginTarget(secret.next()); await c.h.page.getByRole('heading', { name: 'GIS 态势', exact: true, level: 1 }).waitFor();
    c.state.checks.current_relogin_time_origin = await c.timeOrigin(); await c.logout();
  }
  const actor = await c.loginTarget(secret.next()); await c.h.page.getByRole('heading', { name: 'GIS 态势', exact: true, level: 1 }).waitFor();
  assert.equal(await c.drawer('修改本人密码').count(), 0);
  assert.equal(await c.timeOrigin(), c.selfAcceptedOnEntry ? c.state.checks.current_relogin_time_origin : c.state.checks.password_write_time_origin);
  for (const name of ['系统管理', '网络规划', '知识图谱']) assert.equal(await c.h.page.getByRole('link').filter({ hasText: new RegExp(`^\\s*${escape(name)}\\s*$`) }).count(), 0);
  const session = await c.http('GET', '/auth/session', () => c.h.page.reload({ waitUntil: 'domcontentloaded' }));
  assert.deepEqual(identity(session), actor); await c.confirm('self-password');
  await c.h.page.goto(`${ORIGIN}/?accountAccess=restricted-${Date.now()}#/system`, { waitUntil: 'domcontentloaded' });
  await c.h.page.waitForURL(url => url.hash.startsWith('#/situation'));
  assert.equal(await c.h.page.getByRole('heading', { name: '系统管理', exact: true, level: 1 }).count(), 0);
  c.state.checks.new_password_verified = true; c.state.checks.same_spa_relogin_verified = true; await c.save();
  return { account_id: ACCOUNT, next_length: 8, same_spa_relogin: true, permission_route_fallback: true,
    password_write_document_continuity: c.selfAcceptedOnEntry ? 'original write preserved; relogin verified in current SPA' : 'same document as self-password submission' };
}
async function disable(c) {
  assert(IDS.every(c.passed) && c.state.checks.new_password_verified && c.state.checks.same_spa_relogin_verified);
  assert.equal(c.state.operations['self-password'].phase, 'READBACK_CONFIRMED');
  await c.forceAdmin(); await openSystem(c); await originalAccounts(c);
  if (!c.state.operations['final-disable']) {
    const current = await targetReadback(c, true); await button(current.row, '停用').click();
    const dialog = c.h.page.getByRole('dialog').filter({ has: c.h.page.getByText('停用账号', { exact: true }) }); await dialog.waitFor({ state: 'visible' });
    await c.write('final-disable', TARGET + '/state', () => button(dialog, '确认').click()); await dialog.waitFor({ state: 'hidden' });
  }
  const saved = await targetReadback(c, false); assert.equal(saved.account.mustChangePassword, false);
  await c.confirm('final-disable'); c.state.checks.target_disabled = true; await c.save();
  return { account_id: ACCOUNT, enabled: false, role_retained: true, original_request_id: c.state.operations['final-disable'].request_id };
}
async function run(h, resume) {
  const c = await context(h, resume); let failure = null;
  try {
    const secret = await c.loadSecrets();
    await c.test('A-ACCOUNT-ACCESS-readonly-source', () => readonly(c));
    // 真实行 locator 只留在当前函数，不能落进检查点或宿主结果。
    const current = await targetReadback(c, !accepted(c.state.operations['final-disable']));
    if (accepted(c.state.operations['final-disable'])) {
      assert(IDS.every(c.passed)); await c.test('A-ACCOUNT-ACCESS-disable-readback', () => disable(c));
    } else {
      await c.test('A-ACCOUNT-ACCESS-final-maintenance', () => maintain(c, secret, current));
      await c.test(IDS[0], () => fifth(c, secret)); await c.test(IDS[1], () => sixth(c, secret)); await c.test(IDS[2], () => seventh(c, secret));
      await c.test('A-ACCOUNT-ACCESS-success-disable', () => disable(c));
    }
  } catch (error) { failure = new Error(c.redact(error)); }
  return c.finish(failure);
}

export async function runAccountAccess(h) { return run(h, false); }
export async function runAccountAccessResume(h) { return run(h, true); }
export default runAccountAccess;
