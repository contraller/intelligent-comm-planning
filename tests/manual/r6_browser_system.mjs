// 由主串行宿主导入；导入时不创建浏览器、服务、账号或口令。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://127.0.0.24:5324';
const ORIGINS = new Set([ORIGIN, 'http://127.0.0.24:8124']);
const API = '/api/v1';
const enc = encodeURIComponent;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, name) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escaped(name)}\\s*$`) });
const sleep = () => new Promise(resolve => setTimeout(resolve, 100));
const roleSelect = panel => panel.locator('label').filter({ hasText: /^\s*角色/ }).locator(':scope > select');
const SYSTEM_CASE_IDS = Object.freeze([
  'A-SYSTEM-01-role-create-readback', 'A-SYSTEM-02-account-create-readback',
  'A-SYSTEM-03-duplicate-account-rejected', 'A-SYSTEM-04-state-cancel-disable-enable',
  'A-SYSTEM-05-sacrificial-real-login', 'A-SYSTEM-06-self-password-7-reject-8-accept',
  'A-SYSTEM-07-new-password-login-restrictions',
]);
const ROLE_RECOVERY_CASE = 'A-SYSTEM-R01-created-role-readonly-recovery';
const ACCOUNT_RECOVERY_CASE = 'A-SYSTEM-R03-created-account-rejection-readonly-recovery';
const ACCOUNT_READONLY_CASE = 'A-SYSTEM-R03b-account-readonly-continuation';
const PASSWORD_RECOVERY_CASE = 'A-SYSTEM-R02-sacrificial-admin-password-recovery';
// 仅批准恢复这次已受理角色；任何其他失败或已创建账号均须另案核实。
const ROLE_RECOVERY = Object.freeze({
  run_id: 'bf0e888b-0c04-4c65-9dbd-479f60c89baa',
  runtime: 'r4-f79ea5c1b6c54e38ae495d840c142013',
  role_id: 'ROLE-7febd6c9940e444d9393c6e425e88006', role_name: 'R6-A-view-bf0e888b0c04',
  username: 'r6abf0e888b0c04', display_name: 'R6-A-bf0e888b0c04',
  request_id: 'd6c7f445-26e1-4bb3-be41-24577da96e49', operation_id: 'OP-8cdda1df7c61438685bc3d066199c81a',
  revision: 'SYS-10', admin_id: 'ACC-93989dce75d14a99ad82ed6eb9b200f5', admin_username: 'r4_admin',
  preexisting_role_ids: Object.freeze(['ROLE-55609d073cb14a73940f07df01097af4',
    'ROLE-50aa11292a45466ab38a3e7cc6f468d4', 'ROLE-c455c3c5917d41559f09fc68a187aef1']),
});
const ACCOUNT_RECOVERY = Object.freeze({
  account_id: 'ACC-48883ff3e2634b8bbb13dd54a43a3398',
  request_id: 'f50ffa38-362a-475b-9bca-8ff54bb80017', operation_id: 'OP-58da41917cd64fe8b83663dfd97224e8',
  revision: 'SYS-13', duplicate_request_id: '7243a997-7600-4d63-b883-7d626fab01d8',
  evidence_dir: 'r6-browser-1792877033509-f51038',
  dom_sha256: '1e67f0c11511cb901e7efc952c01abca5803d4477a362a08b87b7e0eb2adb8e0',
  results_sha256: '870fe5a1b66ab1af0da9d71bfc7c481ca7c3711bcf90ccbfb51395341a0355b4',
});
const READONLY_FAILURE = Object.freeze({
  evidence_dir: 'r6-browser-1792878513938-9b9eb3',
  dom_sha256: 'a5935e847698f98b4e9c7e6e81881f190d228ddae12c5b9efd388ae6e8c05481',
  results_sha256: 'a0c48d6a3c9f932b4e834c459576105fed61d1e603acdcc21ae19a6ad618eb57',
  error: 'page.waitForResponse: Timeout 60000ms exceeded while waiting for event "response"',
});

function matches(value, method, endpoint) {
  const url = new URL(value.url());
  return ORIGINS.has(url.origin) && value.request().method() === method && url.pathname === API + endpoint;
}
function identity(data) {
  assert(data && typeof data.account_id === 'string' && typeof data.role_id === 'string' && Array.isArray(data.permissions), 'The real login/session identity is incomplete.');
  return { account_id: data.account_id, username: data.username, role_id: data.role_id, permissions: [...data.permissions].sort() };
}
function operationResult(data) {
  return { object_id: typeof data?.objectId === 'string' ? data.objectId : undefined,
    operation_id: typeof data?.operationId === 'string' ? data.operationId : undefined,
    revision: typeof data?.revision === 'string' ? data.revision : undefined,
    changed: typeof data?.changed === 'boolean' ? data.changed : undefined,
    reauthentication_required: typeof data?.reauthenticationRequired === 'boolean' ? data.reauthenticationRequired : undefined };
}

function assertOperationIdentity(op) {
  assert.equal(typeof op.request_id, 'string'); assert(op.request_id.length > 0);
  assert.match(op.result?.operation_id ?? '', /^OP-[a-f0-9]{32}$/);
  // requestId 是幂等原号，operationId 是独立操作记录号，不能相等断言。
  assert.notEqual(op.result.operation_id, op.request_id);
}

function assertCreatedRoleResume(state, runId, runtime) {
  assert.equal(runId, ROLE_RECOVERY.run_id); assert.equal(state.run_id, ROLE_RECOVERY.run_id);
  assert.equal(path.resolve(runtime), path.join(ROOT, 'data/runtime/r2', ROLE_RECOVERY.runtime));
  for (const key of ['role_name', 'username', 'display_name']) assert.equal(state[key], ROLE_RECOVERY[key]);
  assert.deepEqual(Object.keys(state.cases), [SYSTEM_CASE_IDS[0]]);
  assert.equal(state.cases[SYSTEM_CASE_IDS[0]].phase, 'FAILED');
  assert.deepEqual(Object.keys(state.operations), ['role-create']);
  const op = state.operations['role-create'];
  assert.equal(op.phase, 'ACK_RECEIVED'); assert.equal(op.endpoint, '/system/roles');
  assert.equal(op.status, 200); assert.equal(op.code, 0); assert.equal(op.sent_count, 1); assert.equal(op.target_id, null);
  assert.equal(op.request_id, ROLE_RECOVERY.request_id); assertOperationIdentity(op);
  assert.equal(op.result.operation_id, ROLE_RECOVERY.operation_id); assert.equal(op.result.object_id, ROLE_RECOVERY.role_id);
  assert.equal(op.result.revision, ROLE_RECOVERY.revision); assert.equal(op.result.changed, true);
  for (const error of [op.error, state.cases[SYSTEM_CASE_IDS[0]].error]) {
    assert.equal(typeof error, 'string'); assert(error.includes(ROLE_RECOVERY.request_id) && error.includes(ROLE_RECOVERY.operation_id));
  }
  assert.equal(state.anchors.role_id, undefined); assert.equal(state.anchors.account_id, undefined);
  assert.equal(state.anchors.username_absent_before_create, undefined);
  assert.equal(state.anchors.admin_id, ROLE_RECOVERY.admin_id); assert.equal(state.anchors.admin_username, ROLE_RECOVERY.admin_username);
  assert.deepEqual(state.anchors.preexisting_role_ids, [...ROLE_RECOVERY.preexisting_role_ids]);
  assert.deepEqual(state.anchors.role_permissions, ['situation.view']);
  assert(!state.anchors.preexisting_role_ids.includes(ROLE_RECOVERY.role_id));
  assert.equal(state.admin_restored, true); assert.equal(state.success_cleanup.phase, 'SKIPPED_FAILED_OR_UNCERTAIN');
  assert.equal(state.secret_storage, 'MEMORY_ONLY'); assert.equal(state.created_role_resume, undefined);
  assert.equal(state.required_case_ids, undefined);
  const writes = state.http.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method) && !row.endpoint.startsWith('/auth/'));
  assert.equal(writes.length, 1); const accepted = writes[0];
  assert.equal(accepted.method, 'POST'); assert.equal(accepted.endpoint, '/system/roles');
  assert.equal(accepted.status, 200); assert.equal(accepted.code, 0);
  assert.equal(accepted.object_id, ROLE_RECOVERY.role_id); assert.equal(accepted.operation_id, ROLE_RECOVERY.operation_id);
  assert.equal(accepted.revision, ROLE_RECOVERY.revision); assert.equal(accepted.changed, true);
  assert(state.http.every(row => ['GET', 'HEAD', 'OPTIONS'].includes(row.method) || row.method === 'POST' &&
    ['/auth/login', '/system/roles'].includes(row.endpoint) && row.status === 200 && row.code === 0),
  'Any earlier non-role business write or unverified authentication prevents this recovery.');
}

function assertCreatedAccountResume(state, runId, runtime, resumeReadonly = false) {
  assert.equal(runId, ROLE_RECOVERY.run_id); assert.equal(state.run_id, runId);
  assert.equal(path.resolve(runtime), path.join(ROOT, 'data/runtime/r2', ROLE_RECOVERY.runtime));
  for (const key of ['role_name', 'username', 'display_name']) assert.equal(state[key], ROLE_RECOVERY[key]);
  assert.deepEqual(Object.keys(state.cases), [SYSTEM_CASE_IDS[0], ROLE_RECOVERY_CASE, SYSTEM_CASE_IDS[1], SYSTEM_CASE_IDS[2],
    ...(resumeReadonly ? [ACCOUNT_RECOVERY_CASE] : [])]);
  assert.equal(state.cases[SYSTEM_CASE_IDS[0]].phase, 'FAILED');
  assert.equal(state.cases[SYSTEM_CASE_IDS[2]].phase, 'FAILED');
  assert.equal(state.cases[SYSTEM_CASE_IDS[2]].error, 'Duplicate username has no visible rejection.');
  assert.equal(state.cases[ROLE_RECOVERY_CASE].phase, 'PASS'); assert.equal(state.cases[SYSTEM_CASE_IDS[1]].phase, 'PASS');
  assert.deepEqual(Object.keys(state.operations), ['role-create', 'account-create', 'duplicate-account']);
  for (const [key, target, request, operation, revision] of [
    ['role-create', ROLE_RECOVERY.role_id, ROLE_RECOVERY.request_id, ROLE_RECOVERY.operation_id, ROLE_RECOVERY.revision],
    ['account-create', ACCOUNT_RECOVERY.account_id, ACCOUNT_RECOVERY.request_id, ACCOUNT_RECOVERY.operation_id, ACCOUNT_RECOVERY.revision],
  ]) {
    const op = state.operations[key];
    assert.equal(op.phase, 'READBACK_CONFIRMED'); assert.equal(op.sent_count, 1);
    assert.equal(op.status, 200); assert.equal(op.code, 0); assert.equal(op.target_id, target);
    assert.equal(op.endpoint, key === 'role-create' ? '/system/roles' : '/system/accounts');
    assert.equal(op.request_id, request); assertOperationIdentity(op);
    assert.equal(op.result.operation_id, operation); assert.equal(op.result.object_id, target);
    assert.equal(op.result.changed, true); assert.equal(op.result.revision, revision);
  }
  const rejected = state.operations['duplicate-account'];
  assert.equal(rejected.phase, 'EXPLICIT_REJECTION'); assert.equal(rejected.endpoint, '/system/accounts');
  assert.equal(rejected.request_id, ACCOUNT_RECOVERY.duplicate_request_id); assert.equal(rejected.sent_count, 1);
  assert.equal(rejected.status, 409); assert.equal(rejected.code, 1203); assert.equal(rejected.target_id, null);
  assert.deepEqual(rejected.result, {});
  assert.equal(state.anchors.account_id, ACCOUNT_RECOVERY.account_id); assert.equal(state.anchors.role_id, ROLE_RECOVERY.role_id);
  assert.equal(state.anchors.admin_id, ROLE_RECOVERY.admin_id); assert.equal(state.anchors.admin_username, ROLE_RECOVERY.admin_username);
  assert.equal(state.anchors.username_absent_before_create, true);
  assert.deepEqual(state.anchors.preexisting_role_ids, [...ROLE_RECOVERY.preexisting_role_ids]);
  assert.deepEqual(state.anchors.role_permissions, ['situation.view']);
  assert.equal(state.created_role_resume.phase, 'READBACK_CONFIRMED');
  assert.deepEqual(state.created_role_resume.original_case, state.cases[SYSTEM_CASE_IDS[0]]);
  assert.deepEqual(state.created_role_resume.original_preexisting_role_ids, state.anchors.preexisting_role_ids);
  assert.equal(state.cases[ROLE_RECOVERY_CASE].detail.role_id, ROLE_RECOVERY.role_id);
  assert.equal(state.cases[ROLE_RECOVERY_CASE].detail.role_post_count, 0);
  assert.equal(state.cases[SYSTEM_CASE_IDS[1]].detail.must_change_password, true);
  if (resumeReadonly) {
    assert.deepEqual(state.cases[ACCOUNT_RECOVERY_CASE], { phase: 'FAILED', error: READONLY_FAILURE.error });
    const original = state.created_account_resume;
    assert.equal(original.phase, 'PREPARED');
    assert.deepEqual(original.password_maintenance, { phase: 'NOT_STARTED', target_id: ACCOUNT_RECOVERY.account_id });
    assert.match(original.source_checkpoint_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(original.original_cases), [SYSTEM_CASE_IDS[0], ROLE_RECOVERY_CASE, SYSTEM_CASE_IDS[1], SYSTEM_CASE_IDS[2]]);
    for (const [id, value] of Object.entries(original.original_cases)) assert.deepEqual(state.cases[id], value);
    assert.deepEqual(state.operations, original.original_operations);
    assert.deepEqual(state.anchors.preexisting_role_ids, original.original_preexisting_role_ids);
    assert.deepEqual(original.original_required_case_ids, [ROLE_RECOVERY_CASE, ...SYSTEM_CASE_IDS.slice(1)]);
    assert.equal(original.historical_evidence.dom_sha256, ACCOUNT_RECOVERY.dom_sha256);
    assert.equal(original.historical_evidence.results_sha256, ACCOUNT_RECOVERY.results_sha256);
    assert.deepEqual(state.required_case_ids, [ROLE_RECOVERY_CASE, SYSTEM_CASE_IDS[1], ACCOUNT_RECOVERY_CASE, ...SYSTEM_CASE_IDS.slice(3)]);
    assert.equal(state.account_readonly_resume, undefined);
  } else {
    assert.deepEqual(state.required_case_ids, [ROLE_RECOVERY_CASE, ...SYSTEM_CASE_IDS.slice(1)]);
    assert.equal(state.created_account_resume, undefined);
  }
  assert.equal(state.secret_storage, 'MEMORY_ONLY');
  assert.equal(state.admin_restored, true); assert.equal(state.success_cleanup.phase, 'SKIPPED_FAILED_OR_UNCERTAIN');
  assert.equal(state.success_cleanup.account_id, ACCOUNT_RECOVERY.account_id);
  assert(!state.unexpected_writes?.length);
  const business = state.http.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method) && !row.endpoint.startsWith('/auth/'));
  assert.deepEqual(business.map(row => [row.endpoint, row.method, row.status, row.code]), [
    ['/system/roles', 'POST', 200, 0], ['/system/accounts', 'POST', 200, 0], ['/system/accounts', 'POST', 409, 1203],
  ]);
  assert.equal(business[0].object_id, ROLE_RECOVERY.role_id); assert.equal(business[0].operation_id, ROLE_RECOVERY.operation_id);
  assert.equal(business[1].request_id, ACCOUNT_RECOVERY.request_id); assert.equal(business[1].object_id, ACCOUNT_RECOVERY.account_id);
  assert.equal(business[1].operation_id, ACCOUNT_RECOVERY.operation_id); assert.equal(business[2].request_id, ACCOUNT_RECOVERY.duplicate_request_id);
  assert(state.http.every(row => ['GET', 'HEAD', 'OPTIONS'].includes(row.method) || business.includes(row)
    || row.endpoint === '/auth/login' && row.method === 'POST' && row.status === 200 && row.code === 0),
  'Unknown writes or any earlier state/password operation prevent account recovery.');
}

async function readOriginalRejectionEvidence(runtime) {
  const dir = path.join(runtime, 'browser', ACCOUNT_RECOVERY.evidence_dir);
  const domFile = path.join(dir, SYSTEM_CASE_IDS[2] + '-dom.json'), resultFile = path.join(dir, 'results.json');
  const domBytes = await fs.readFile(domFile), resultBytes = await fs.readFile(resultFile);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(domBytes), ACCOUNT_RECOVERY.dom_sha256); assert.equal(hash(resultBytes), ACCOUNT_RECOVERY.results_sha256);
  const dom = JSON.parse(domBytes.toString('utf8')), results = JSON.parse(resultBytes.toString('utf8'));
  assert.equal(new URL(dom.url).origin, ORIGIN); assert.equal(new URL(dom.url).hash, '#/system');
  assert(dom.text.includes('唯一性或并发状态冲突') && dom.text.includes(ROLE_RECOVERY.username) && dom.text.includes(ROLE_RECOVERY.role_name));
  assert.equal(results.completed, false);
  assert(results.cases.some(row => row.id === SYSTEM_CASE_IDS[2] && row.state === 'FAIL'));
  assert(results.requests.some(row => row.method === 'POST' && row.path === API + '/system/accounts' && row.status === 409));
  assert(results.cases.some(row => row.id === 'A-SYSTEM-restore-admin' && row.state === 'PASS'));
  return { dom_file: domFile, dom_sha256: hash(domBytes), results_file: resultFile, results_sha256: hash(resultBytes),
    visible_rejection: '唯一性或并发状态冲突', request_id: ACCOUNT_RECOVERY.duplicate_request_id, status: 409, code: 1203 };
}

async function readReadonlyFailureEvidence(runtime) {
  const dir = path.join(runtime, 'browser', READONLY_FAILURE.evidence_dir);
  const domFile = path.join(dir, ACCOUNT_RECOVERY_CASE + '-dom.json'), resultFile = path.join(dir, 'results.json');
  const domBytes = await fs.readFile(domFile), resultBytes = await fs.readFile(resultFile);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(domBytes), READONLY_FAILURE.dom_sha256); assert.equal(hash(resultBytes), READONLY_FAILURE.results_sha256);
  const dom = JSON.parse(domBytes.toString('utf8')), results = JSON.parse(resultBytes.toString('utf8'));
  assert.equal(new URL(dom.url).origin, ORIGIN); assert(dom.text.includes('本地认证数据库不可用'));
  assert.equal(results.completed, false);
  assert.deepEqual(results.cases.map(row => [row.id, row.state]), [[ACCOUNT_RECOVERY_CASE, 'FAIL'], ['A-SYSTEM-restore-admin', 'PASS']]);
  assert(results.cases[0].error.startsWith(READONLY_FAILURE.error));
  const mutations = results.requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method));
  assert.equal(mutations.length, 2);
  assert(mutations.every(row => row.path === API + '/auth/login' && row.method === 'POST' && row.status === 200));
  assert(results.requests.some(row => row.path === API + '/auth/session' && row.status === 503));
  return { dom_file: domFile, dom_sha256: hash(domBytes), results_file: resultFile, results_sha256: hash(resultBytes),
    failed_case_id: ACCOUNT_RECOVERY_CASE, visible_error: '本地认证数据库不可用', business_mutation_count: 0,
    admin_restored: true };
}

async function environment(args, work, { resumeCreatedRole = false, resumeCreatedAccount = false, resumeReadonly = false, requiredCaseIds = SYSTEM_CASE_IDS } = {}) {
  const { page, runtime, login, record } = args;
  assert(page && runtime && typeof login === 'function' && typeof record === 'function');
  assert(args.systemWritesAuthorized === true || process.env.R6_SYSTEM_WRITES_ALLOWED === '1', 'Wait for main serial token; enable only sacrificial system writes.');
  assert(page.url() === 'about:blank' || new URL(page.url()).origin === ORIGIN);
  assert.equal(path.dirname(path.resolve(runtime)), path.join(ROOT, 'data/runtime/r2'));
  assert(/^r4-[a-f0-9]{32}$/.test(path.basename(runtime)));
  const runId = args.systemRunId ?? process.env.R6_SYSTEM_RUN_ID;
  assert(typeof runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId), 'Supply and retain one R6_SYSTEM_RUN_ID GUID.');
  if (resumeCreatedRole || resumeCreatedAccount) assert.equal(runId, ROLE_RECOVERY.run_id, 'This entry may resume only the explicitly approved original checkpoint.');
  if (resumeCreatedAccount) assert.equal(typeof args.fillSystemOperatorPassword, 'function', 'Main must supply the target-scoped private UI filler.');
  const output = path.join(ROOT, 'data/runtime/r6', runId), file = path.join(output, 'system-state.json');
  await fs.mkdir(output, { recursive: true });
  let state, checkpointBytes;
  try { checkpointBytes = await fs.readFile(file, 'utf8'); state = JSON.parse(checkpointBytes); }
  catch (error) {
    if (error.code !== 'ENOENT' || resumeCreatedRole || resumeCreatedAccount) throw error;
    const tag = runId.replaceAll('-', '').slice(0, 12);
    state = { schema: 'r6-system-sacrificial-v1', run_id: runId, runtime: path.resolve(runtime),
      role_name: 'R6-A-view-' + tag, username: 'r6a' + tag, display_name: 'R6-A-' + tag,
      cases: {}, operations: {}, http: [], anchors: {}, admin_restored: false,
      success_cleanup: { phase: 'NOT_STARTED' }, secret_storage: 'MEMORY_ONLY' };
  }
  assert.equal(state.schema, 'r6-system-sacrificial-v1'); assert.equal(state.runtime, path.resolve(runtime)); assert.equal(state.run_id, runId);
  if (resumeReadonly) {
    assert(resumeCreatedAccount); assertCreatedAccountResume(state, runId, runtime, true);
    const evidence = await readReadonlyFailureEvidence(runtime), historical = await readOriginalRejectionEvidence(runtime);
    state.account_readonly_resume = { phase: 'PREPARED',
      source_checkpoint_sha256: crypto.createHash('sha256').update(checkpointBytes).digest('hex'),
      original_created_account_resume: structuredClone(state.created_account_resume),
      original_cases: structuredClone(state.cases), original_operations: structuredClone(state.operations),
      original_required_case_ids: [...state.required_case_ids], original_preexisting_role_ids: [...state.anchors.preexisting_role_ids],
      readonly_failure_evidence: evidence, historical_evidence: historical,
      password_maintenance: { phase: 'NOT_STARTED', target_id: ACCOUNT_RECOVERY.account_id } };
  } else if (resumeCreatedAccount) {
    assertCreatedAccountResume(state, runId, runtime);
    const evidence = await readOriginalRejectionEvidence(runtime);
    state.created_account_resume = { phase: 'PREPARED', historical_evidence: evidence,
      source_checkpoint_sha256: crypto.createHash('sha256').update(checkpointBytes).digest('hex'),
      original_cases: structuredClone(state.cases), original_operations: structuredClone(state.operations),
      original_required_case_ids: [...state.required_case_ids], original_preexisting_role_ids: [...state.anchors.preexisting_role_ids],
      password_maintenance: { phase: 'NOT_STARTED', target_id: ACCOUNT_RECOVERY.account_id } };
  } else if (resumeCreatedRole) {
    assertCreatedRoleResume(state, runId, runtime);
    state.created_role_resume = { phase: 'PREPARED',
      source_checkpoint_sha256: crypto.createHash('sha256').update(checkpointBytes).digest('hex'),
      original_case_id: SYSTEM_CASE_IDS[0], original_case: structuredClone(state.cases[SYSTEM_CASE_IDS[0]]),
      original_role_operation: structuredClone(state.operations['role-create']),
      original_preexisting_role_ids: [...state.anchors.preexisting_role_ids],
      prior_account_create_absent: true, initial_password_regeneration_allowed: true };
  } else {
    assert.equal(Object.keys(state.cases).length, 0, 'Existing checkpoint requires main review/readback; never recreate an uncertain account or reset its password to resume.');
    assert.equal(Object.keys(state.operations).length, 0);
  }
  assert.equal(requiredCaseIds.length, 7); assert.equal(new Set(requiredCaseIds).size, 7);
  state.required_case_ids = [...requiredCaseIds];
  let diskFailure = null, scopeFailure = null, sequence = 0, checkpointTail = Promise.resolve();
  const failCheckpoint = error => {
    if (!diskFailure) {
      diskFailure = error;
      console.error(JSON.stringify({ checkpoint_write_failed: error.code ?? 'WRITE_FAILED', output, anchors: state.anchors,
        operations: Object.fromEntries(Object.entries(state.operations).map(([key, op]) => [key, { phase: op.phase, request_id: op.request_id, target_id: op.target_id }])) }));
    }
    return diskFailure;
  };
  const save = () => {
    if (diskFailure) return Promise.reject(diskFailure);
    let bytes;
    try { bytes = JSON.stringify(state, null, 2); }
    catch (error) { return Promise.reject(failCheckpoint(error)); }
    const temporary = file + '.' + process.pid + '.' + (++sequence) + '.' + crypto.randomUUID() + '.tmp';
    const pending = checkpointTail.then(async () => {
      if (diskFailure) throw diskFailure;
      try { await fs.writeFile(temporary, bytes, { flag: 'wx', flush: true }); await fs.rename(temporary, file); }
      catch (error) { throw failCheckpoint(error); }
    });
    checkpointTail = pending.catch(() => {});
    return pending;
  };
  const beforeUiAction = async (restoreOnly = false) => {
    let observed;
    do { observed = checkpointTail; await observed; } while (observed !== checkpointTail);
    if (diskFailure) throw diskFailure;
    if (scopeFailure && !restoreOnly) throw scopeFailure;
  };
  await save();
  // 口令不进入检查点、HTTP 证据、异常正文或文件。
  let initialPassword = 'Aa1!' + crypto.randomBytes(15).toString('base64url');
  let newPassword = 'Aa1!' + crypto.randomBytes(3).toString('base64url');
  let shortPassword = newPassword.slice(0, 7), duplicatePassword = 'Aa1!' + crypto.randomBytes(12).toString('base64url');
  const redact = error => {
    let text = error instanceof Error ? error.message : String(error);
    for (const secret of [initialPassword, newPassword, shortPassword, duplicatePassword].filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');
    return text;
  };
  const requests = [], unexpected = [];
  const capture = request => {
    const url = new URL(request.url());
    if (!ORIGINS.has(url.origin) || !url.pathname.startsWith(API + '/') || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const endpoint = url.pathname.slice(API.length), row = { endpoint, method: request.method() };
    requests.push(row);
    const armed = Object.values(state.operations).some(op => op.endpoint === endpoint && ['ARMED', 'SENT'].includes(op.phase));
    const allowed = request.method() === 'POST' && (
      ['/auth/login', '/auth/logout'].includes(endpoint) || armed && (
        endpoint === '/auth/password' || !resumeCreatedAccount && endpoint === '/system/accounts'
        || !resumeCreatedRole && !resumeCreatedAccount && endpoint === '/system/roles'
        || state.anchors.account_id && endpoint === '/system/accounts/' + enc(state.anchors.account_id) + '/state'
        || resumeCreatedAccount && endpoint === '/system/accounts/' + enc(ACCOUNT_RECOVERY.account_id) + '/password'
      ));
    if (!allowed) {
      try { const originalId = request.postDataJSON()?.requestId; if (typeof originalId === 'string') row.request_id = originalId; } catch { /* 不保留未知请求正文。 */ }
      unexpected.push(row); (state.unexpected_writes ??= []).push(row);
      scopeFailure ??= new Error('Unexpected write outside the approved target scope: ' + endpoint);
      save().catch(() => {});
    }
  };
  page.on('request', capture);
  const c = { ...args, state, output, save, requests, requiredCaseIds: [...requiredCaseIds],
    accountRecovery: resumeReadonly ? state.account_readonly_resume : state.created_account_resume,
    accountRecoveryCaseId: resumeReadonly ? ACCOUNT_READONLY_CASE : ACCOUNT_RECOVERY_CASE,
    historicalFailureIds: resumeCreatedAccount ? [SYSTEM_CASE_IDS[0], SYSTEM_CASE_IDS[2], ...(resumeReadonly ? [ACCOUNT_RECOVERY_CASE] : [])] : [],
    drawer: name => page.locator('.p-drawer:visible').filter({ has: page.locator('.p-drawer-title').filter({ hasText: new RegExp(`^${escaped(name)}$`) }) }),
    dialog: name => page.getByRole('dialog').filter({ has: page.getByText(name, { exact: true }) }),
    async until(check, label, timeout = 60000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (diskFailure || scopeFailure) throw diskFailure ?? scopeFailure; if (await check()) return; await sleep(); }
      throw new Error(label);
    },
  };
  c.http = async (method, endpoint, action, acceptFailure = false, received, restoreOnly = false) => {
    await beforeUiAction(restoreOnly);
    const pending = page.waitForResponse(value => matches(value, method, endpoint), { timeout: 60000 }); pending.catch(() => {});
    await action(); const response = await pending, body = await response.json();
    const trace = { endpoint, method, status: response.status(), code: body.code };
    // 认证响应及请求正文可能包含会话或口令，不保留原文。
    if (endpoint.startsWith('/system/') || endpoint === '/auth/password') Object.assign(trace, operationResult(body.data));
    if (endpoint.startsWith('/system/')) {
      if (typeof body.message === 'string') trace.message = body.message;
      if (typeof body.data?.reason === 'string') trace.reason = body.data.reason;
    }
    const requestId = method === 'POST' && (endpoint.startsWith('/system/') || endpoint === '/auth/password')
      ? response.request().postDataJSON()?.requestId : undefined;
    if (requestId !== undefined) trace.request_id = requestId;
    state.http.push(trace); if (received) received(body.data, trace); await save();
    if (!acceptFailure) assert([200, 201].includes(trace.status) && trace.code === 0, `HTTP ${trace.status}; code ${trace.code}; endpoint ${endpoint}`);
    return { data: body.data, status: trace.status, code: trace.code, request_id: requestId };
  };
  c.write = async (key, endpoint, action, { targetId, rejection = false } = {}) => {
    await beforeUiAction();
    assert(!(resumeCreatedRole || resumeCreatedAccount) || endpoint !== '/system/roles', 'The accepted original role must never be POSTed again.');
    assert(!resumeCreatedAccount || endpoint !== '/system/accounts', 'Account recovery must not create or duplicate-submit an account.');
    const ownPassword = endpoint === '/auth/password';
    const adminPassword = endpoint === '/system/accounts/' + enc(ACCOUNT_RECOVERY.account_id) + '/password';
    if (adminPassword) {
      assert(resumeCreatedAccount); assert.equal(key, 'account-password-recovery'); assert.equal(rejection, false);
      assert.equal(targetId, ACCOUNT_RECOVERY.account_id); assert.equal(c.authenticatedActor?.account_id, ROLE_RECOVERY.admin_id);
      assert.equal(state.cases[c.accountRecoveryCaseId]?.phase, 'PASS');
      assert.equal(c.accountRecovery.password_maintenance.phase, 'UI_READY');
      assert.equal(c.passwordRecoveryTarget?.id, targetId);
    }
    if (ownPassword) {
      assert.equal(key, 'self-password'); assert.equal(rejection, false);
      assert.equal(targetId, state.anchors.account_id); assert.notEqual(targetId, state.anchors.admin_id);
      assert.equal(c.authenticatedActor?.account_id, targetId); assert.equal(c.authenticatedActor?.role_id, state.anchors.role_id);
      assert.equal(c.authenticatedActor?.username, state.username);
    }
    assert(!state.operations[key], 'Existing original request must not be submitted again: ' + key);
    const op = state.operations[key] = { phase: 'ARMED', target_id: targetId ?? null, endpoint, sent_count: 0, sent_requests: [],
      ...(ownPassword ? { receipt_type: 'AUTH_PASSWORD', authenticated_account_id: c.authenticatedActor.account_id } : {}) }; await save();
    const onRequest = request => {
      if (!matches({ url: () => request.url(), request: () => request }, 'POST', endpoint)) return;
      const body = request.postDataJSON(); op.phase = 'SENT'; op.sent_count++;
      op.request_id ??= body.requestId;
      if (typeof body.baseRevision === 'string') op.base_revision = body.baseRevision;
      if (typeof body.enabled === 'boolean') op.enabled = body.enabled;
      op.password_lengths = Object.fromEntries(['initialPassword', 'currentPassword', 'newPassword'].filter(field => typeof body[field] === 'string').map(field => [field, [...body[field]].length]));
      if (adminPassword) op.operator_password_supplied = typeof body.operatorPassword === 'string' && body.operatorPassword.length > 0;
      op.sent_requests.push({ request_id: body.requestId, password_lengths: { ...op.password_lengths }, at: new Date().toISOString() });
      save().catch(() => {});
    };
    page.on('request', onRequest);
    try {
      const response = await c.http('POST', endpoint, action, rejection, (data, trace) => {
        // 脱敏回执随 HTTP 记录先排队落盘，再进行任何业务断言。
        op.phase = 'ACK_RECEIVED'; op.status = trace.status; op.code = trace.code;
        op.result = operationResult(data); op.response_request_id = trace.request_id;
        if (trace.message !== undefined) op.response_message = trace.message;
        if (trace.reason !== undefined) op.response_reason = trace.reason;
      });
      await beforeUiAction();
      assert.equal(op.sent_count, 1, 'One explicit UI operation produced multiple requests.'); assert(op.request_id, 'Actual UI request ID is missing.');
      assert.equal(response.request_id, op.request_id, 'Response must belong to this original UI request.');
      if (rejection) {
        assert(response.code !== 0 && [200, 400, 409, 422].includes(response.status), 'Expected an explicit duplicate-account rejection, not an authentication error.');
        op.phase = 'EXPLICIT_REJECTION';
      } else if (ownPassword) {
        // 本人改密按真实登录目标与原请求关联；System OP/对象/修订字段仅按有无记录。
        assert.equal(response.data.changed, true); assert.equal(response.data.reauthenticationRequired, true);
        assert.equal(op.authenticated_account_id, targetId);
        if (response.data.objectId != null && response.data.objectId !== '') assert.equal(response.data.objectId, targetId);
        if (response.data.requestId != null && response.data.requestId !== '') assert.equal(response.data.requestId, op.request_id);
        op.target_id = targetId; op.phase = 'ACK_VALIDATED'; c.authenticatedActor = null;
      } else {
        assertOperationIdentity(op); assert.equal(response.data.changed, true);
        if (targetId) assert.equal(response.data.objectId, targetId);
        if (adminPassword) {
          assert.equal(op.base_revision, c.passwordRecoveryTarget.revision); assert.equal(op.operator_password_supplied, true);
        }
        if (key === 'account-create') assert.notEqual(response.data.objectId, state.anchors.admin_id, 'New-account response must not target the existing administrator.');
        if (key === 'role-create') assert(!c.catalog.roles.some(role => role.id === response.data.objectId), 'New-role response reused an existing role ID.');
        op.target_id = response.data.objectId; op.phase = 'ACK_VALIDATED';
        if (key === 'role-create') state.anchors.role_id = response.data.objectId;
        if (key === 'account-create') state.anchors.account_id = response.data.objectId;
      }
      await save(); return response.data;
    } catch (error) {
      op.error = redact(error); if (['ARMED', 'SENT'].includes(op.phase)) op.phase = 'UNCERTAIN_NO_RETRY';
      if (!diskFailure) await save(); throw new Error(redact(error));
    } finally { page.off('request', onRequest); }
  };
  c.verified = async key => { await beforeUiAction(); state.operations[key].phase = 'READBACK_CONFIRMED'; await save(); };
  c.test = async (id, action) => {
    await beforeUiAction();
    assert(!state.cases[id]); state.cases[id] = { phase: 'RUNNING' }; await save();
    return record(id, async () => {
      try {
        const detail = await action(); assert.deepEqual(unexpected, [], 'Unexpected write endpoint outside the sacrificial-system scope.');
        state.cases[id] = { phase: 'PASS', detail }; await save();
        return { ...detail, output, role_id: state.anchors.role_id, account_id: state.anchors.account_id };
      } catch (error) {
        state.cases[id] = { phase: 'FAILED', error: redact(error) }; if (!diskFailure) await save();
        throw new Error(redact(error) + '\nSystem checkpoint: ' + JSON.stringify({ output, anchors: state.anchors,
          original_requests: Object.fromEntries(Object.entries(state.operations).map(([key, op]) => [key, { phase: op.phase, request_id: op.request_id, target_id: op.target_id }])) }));
      }
    });
  };
  c.forceAdmin = async () => {
    // 仅防止宿主 activeRole 缓存短路；私密口令与真实表单登录仍交 h.login。
    await beforeUiAction(true); await page.goto('about:blank#/login');
    const response = await c.http('POST', '/auth/login', () => login('admin'), false, undefined, true);
    const actor = identity(response.data);
    if (state.anchors.admin_id) assert.equal(actor.account_id, state.anchors.admin_id);
    else { state.anchors.admin_id = actor.account_id; state.anchors.admin_username = actor.username; }
    assert(actor.permissions.includes('system.accounts') && actor.permissions.includes('system.roles'));
    c.authenticatedActor = actor;
    state.admin_restored = true; if (!diskFailure) await save();
    return { admin_id: actor.account_id, restored_via_real_ui: true };
  };
  c.loginTarget = async password => {
    await page.getByLabel('账号', { exact: true }).waitFor({ state: 'visible', timeout: 60000 });
    await c.until(async () => await button(page, '登录工作区').isEnabled(), 'Real local-password login is not ready.');
    await page.getByLabel('账号', { exact: true }).fill(state.username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    const response = await c.http('POST', '/auth/login', () => button(page, '登录工作区').click());
    const actor = identity(response.data); assert.equal(actor.account_id, state.anchors.account_id); assert.equal(actor.role_id, state.anchors.role_id);
    assert.deepEqual(actor.permissions, [...state.anchors.role_permissions].sort());
    c.authenticatedActor = actor;
    state.admin_restored = false; await save(); return actor;
  };
  let failure = null, result;
  try { result = await work(c, { initial: () => initialPassword, next: () => newPassword, short: () => shortPassword, duplicate: () => duplicatePassword }); }
  catch (error) { failure = new Error(redact(error)); }
  finally {
    try {
      await record('A-SYSTEM-restore-admin', () => c.forceAdmin());
    } catch (error) {
      state.admin_restored = false;
      const message = 'Admin restoration is NOT confirmed: ' + redact(error);
      if (failure) failure.message += '\n' + message; else failure = new Error(message);
    }
    // 仅完整成功且原事务均已核实，才由恢复后的管理员停用本次新账号。
    const originalFailureRetained = (!resumeCreatedRole || (
      state.created_role_resume.phase === 'READBACK_CONFIRMED' &&
      JSON.stringify(state.cases[SYSTEM_CASE_IDS[0]]) === JSON.stringify(state.created_role_resume.original_case) &&
      JSON.stringify(state.anchors.preexisting_role_ids) === JSON.stringify(state.created_role_resume.original_preexisting_role_ids)
    )) && (!resumeCreatedAccount || (
      c.accountRecovery.phase === 'READONLY_CONFIRMED' &&
      c.accountRecovery.password_maintenance.phase === 'READBACK_CONFIRMED' &&
      state.cases[PASSWORD_RECOVERY_CASE]?.phase === 'PASS' &&
      state.operations['account-password-recovery']?.phase === 'READBACK_CONFIRMED' &&
      Object.entries(c.accountRecovery.original_cases).every(([id, value]) => JSON.stringify(state.cases[id]) === JSON.stringify(value)) &&
      JSON.stringify(state.anchors.preexisting_role_ids) === JSON.stringify(c.accountRecovery.original_preexisting_role_ids) &&
      (!resumeReadonly || JSON.stringify(state.created_account_resume) === JSON.stringify(c.accountRecovery.original_created_account_resume))
    ));
    const historicalIds = resumeCreatedAccount ? c.historicalFailureIds : resumeCreatedRole ? [SYSTEM_CASE_IDS[0]] : [];
    const complete = requiredCaseIds.every(id => state.cases[id]?.phase === 'PASS') && originalFailureRetained
      && Object.entries(state.cases).every(([id]) => requiredCaseIds.includes(id) || historicalIds.includes(id) || resumeCreatedAccount && id === PASSWORD_RECOVERY_CASE)
      && Object.values(state.operations).every(value => ['READBACK_CONFIRMED', 'EXPLICIT_REJECTION'].includes(value.phase))
      && !scopeFailure && unexpected.length === 0;
    if (!failure && !diskFailure && !complete) failure = new Error('Required logical cases or original operation readbacks are incomplete; no cleanup write is allowed.');
    if (!failure && !diskFailure && state.admin_restored && complete) {
      try {
        await record('A-SYSTEM-success-disable-sacrificial', async () => {
          state.success_cleanup = { phase: 'CHECKING_TARGET', account_id: state.anchors.account_id }; await save();
          const detail = await disableSacrificialOnSuccess(c);
          state.success_cleanup = { phase: 'READBACK_CONFIRMED', ...detail }; await save();
          return { ...detail, output };
        });
      } catch (error) {
        state.success_cleanup = { phase: 'FAILED_OR_UNCERTAIN_NO_RETRY', account_id: state.anchors.account_id, error: redact(error) };
        failure = new Error('Seven system cases passed, but final account disable is NOT confirmed: ' + redact(error)
          + '\nCleanup checkpoint: ' + JSON.stringify({ output, account_id: state.anchors.account_id,
            request_id: state.operations['success-disable']?.request_id, phase: state.operations['success-disable']?.phase }));
      }
    } else state.success_cleanup = { phase: 'SKIPPED_FAILED_OR_UNCERTAIN', account_id: state.anchors.account_id };
    page.off('request', capture);
    initialPassword = ''; newPassword = ''; shortPassword = ''; duplicatePassword = '';
    try { await beforeUiAction(true); await save(); }
    catch (error) { if (!failure) failure = new Error('Final checkpoint is NOT confirmed: ' + redact(error)); }
  }
  if (failure) throw failure;
  return { ...result, output, admin_restored: state.admin_restored,
    required_case_ids: [...requiredCaseIds], historical_failed_case_ids: resumeCreatedAccount ? c.historicalFailureIds : resumeCreatedRole ? [SYSTEM_CASE_IDS[0]] : [],
    success_account_disabled: state.success_cleanup?.phase === 'READBACK_CONFIRMED' };
}

async function openSystem(c) {
  const response = await c.http('GET', '/system/options', () => c.page.goto(`${ORIGIN}/?r6system=${c.state.run_id}-${Date.now()}#/system`, { waitUntil: 'domcontentloaded' }));
  await c.page.getByRole('heading', { name: '系统管理', exact: true, level: 1 }).waitFor({ timeout: 90000 });
  assert(response.data && Array.isArray(response.data.permissions) && Array.isArray(response.data.roles)); return response.data;
}
async function query(c, tab, endpoint, term) {
  const tabButton = button(c.page.locator('.side-list'), tab);
  if (!(await tabButton.getAttribute('class') ?? '').includes('active')) await c.http('GET', endpoint, () => tabButton.click());
  await c.page.getByLabel('搜索系统记录', { exact: true }).fill(term);
  const response = await c.http('GET', endpoint, () => button(c.page.locator('.filters'), '查询').click());
  assert(Array.isArray(response.data?.items)); return response.data;
}
async function roleReadback(c) {
  const catalog = await query(c, '角色权限', '/system/roles', c.state.role_name);
  const matches = catalog.items.filter(row => row.id === c.state.anchors.role_id && row.name === c.state.role_name); assert.equal(matches.length, 1);
  const row = c.page.locator('.roles-table tbody tr').filter({ has: c.page.getByText(c.state.role_name, { exact: true }) });
  const response = await c.http('GET', '/system/roles/' + enc(c.state.anchors.role_id), () => button(row, '权限矩阵 / 编辑').click());
  assert.equal(response.data.role.id, c.state.anchors.role_id);
  assert.deepEqual([...response.data.role.permissions].sort(), [...c.state.anchors.role_permissions].sort());
  const panel = c.drawer('编辑角色权限'); await panel.waitFor({ state: 'visible' });
  assert.equal(await panel.getByLabel('角色名称', { exact: true }).inputValue(), c.state.role_name);
  for (const code of c.state.anchors.role_permissions) assert(await panel.getByLabel(c.catalog.permissions.find(value => value.code === code).name, { exact: true }).isChecked());
  assert.equal(await panel.getByRole('checkbox', { checked: true }).count(), c.state.anchors.role_permissions.length);
  await button(panel, '关闭').click(); await panel.waitFor({ state: 'hidden' }); return response.data;
}
async function accountReadback(c, enabled) {
  const catalog = await query(c, '账号管理', '/system/accounts', c.state.username);
  const matches = catalog.items.filter(row => row.username === c.state.username); assert.equal(matches.length, 1);
  const account = matches[0]; assert.equal(account.id, c.state.anchors.account_id); assert.equal(account.roleId, c.state.anchors.role_id); assert.equal(account.enabled, enabled);
  const row = c.page.locator('.accounts-table tbody tr').filter({ has: c.page.getByText(c.state.username, { exact: true }) });
  const response = await c.http('GET', '/system/accounts/' + enc(account.id), () => button(row, '编辑').click());
  assert.equal(response.data.account.id, account.id); assert.equal(response.data.account.roleId, c.state.anchors.role_id); assert.equal(response.data.account.enabled, enabled);
  const panel = c.drawer('编辑账号'); await panel.waitFor({ state: 'visible' });
  assert.equal(await panel.getByLabel('登录名', { exact: true }).inputValue(), c.state.username);
  assert.equal(await roleSelect(panel).inputValue(), c.state.anchors.role_id);
  await button(panel, '关闭').click(); await panel.waitFor({ state: 'hidden' }); return { row, account: response.data.account };
}
async function fillAccount(c, panel, password) {
  await panel.getByLabel('登录名', { exact: true }).fill(c.state.username);
  await panel.getByLabel('显示名', { exact: true }).fill(c.state.display_name);
  await panel.getByLabel('部门', { exact: true }).fill('R6 constructed acceptance only');
  await roleSelect(panel).selectOption(c.state.anchors.role_id);
  await panel.getByLabel('初始密码', { exact: true }).fill(password);
}

async function disableSacrificialOnSuccess(c) {
  const state = c.state, id = state.anchors.account_id, created = state.operations['account-create'];
  assert(state.admin_restored && id && id !== state.anchors.admin_id);
  assert(!['admin', 'editor', 'reviewer'].includes(id.toLowerCase()));
  assert.equal(state.anchors.username_absent_before_create, true);
  assert.match(state.username, /^r6a[a-f0-9]{12}$/);
  assert(!['admin', 'editor', 'reviewer', state.anchors.admin_username].includes(state.username));
  assert.equal(created.phase, 'READBACK_CONFIRMED'); assert.equal(created.target_id, id);
  assert.equal(created.result.object_id, id); assertOperationIdentity(created);
  assert.equal(state.operations['role-create'].target_id, state.anchors.role_id);
  assert(!state.anchors.preexisting_role_ids.includes(state.anchors.role_id), 'Cleanup must not target an account with an existing administrator/editor/reviewer role.');
  await openSystem(c);
  const current = await accountReadback(c, true);
  assert.equal(current.account.id, id); assert.equal(current.account.username, state.username);
  assert.equal(current.account.roleId, state.anchors.role_id);
  await button(current.row, '停用').click(); const dialog = c.dialog('停用账号'); await dialog.waitFor({ state: 'visible' });
  await c.write('success-disable', '/system/accounts/' + enc(id) + '/state', () => button(dialog, '确认').click(), { targetId: id });
  assert.equal(state.operations['success-disable'].enabled, false);
  await dialog.waitFor({ state: 'hidden' }); const saved = await accountReadback(c, false);
  assert.equal(saved.account.id, id); await c.verified('success-disable');
  return { account_id: id, role_id: state.anchors.role_id, final_enabled: false, role_retained: true,
    request_id: state.operations['success-disable'].request_id, operation_id: state.operations['success-disable'].result.operation_id,
    revision: state.operations['success-disable'].result.revision };
}

async function recoverCreatedRoleReadOnly(c) {
  const state = c.state, original = state.created_role_resume;
  assert.deepEqual(state.operations['role-create'], original.original_role_operation);
  await c.forceAdmin(); c.catalog = await openSystem(c);
  assert.deepEqual(state.anchors.preexisting_role_ids, [...ROLE_RECOVERY.preexisting_role_ids]);
  for (const id of state.anchors.preexisting_role_ids) assert(c.catalog.roles.some(role => role.id === id), 'An original role is missing from the real catalog.');
  const role = c.catalog.roles.find(row => row.id === ROLE_RECOVERY.role_id);
  assert(role); assert.equal(role.name, state.role_name);
  state.anchors.role_id = ROLE_RECOVERY.role_id; await c.save();
  const detail = await roleReadback(c);
  assert.equal(detail.role.id, ROLE_RECOVERY.role_id); assert.equal(detail.role.name, ROLE_RECOVERY.role_name);
  assert.deepEqual([...detail.role.permissions].sort(), ['situation.view']);
  assert.deepEqual(state.anchors.preexisting_role_ids, original.original_preexisting_role_ids);
  assert(!c.requests.some(row => row.endpoint === '/system/roles'), 'Role recovery must use only real UI reads, never another role POST.');
  assert(!c.requests.some(row => row.endpoint === '/system/accounts' || row.endpoint === '/auth/password'));
  assert.deepEqual(state.cases[SYSTEM_CASE_IDS[0]], original.original_case);
  const op = state.operations['role-create'];
  assertOperationIdentity(op); op.target_id = ROLE_RECOVERY.role_id;
  op.readonly_recovery = { case_id: ROLE_RECOVERY_CASE, original_phase: original.original_role_operation.phase,
    request_id: op.request_id, operation_id: op.result.operation_id, role_id: ROLE_RECOVERY.role_id };
  original.phase = 'READBACK_CONFIRMED'; await c.verified('role-create');
  return { role_id: ROLE_RECOVERY.role_id, role_name: state.role_name, permissions: detail.role.permissions,
    request_id: op.request_id, operation_id: op.result.operation_id, role_post_count: 0,
    original_failed_case_id: SYSTEM_CASE_IDS[0], original_failed_case_preserved: true,
    preexisting_role_ids: [...state.anchors.preexisting_role_ids], initial_password_previously_unused: true };
}

async function recoverCreatedAccountReadOnly(c) {
  const state = c.state, original = c.accountRecovery;
  await c.forceAdmin(); c.catalog = await openSystem(c);
  await roleReadback(c);
  const current = await accountReadback(c, true);
  assert.equal(current.account.id, ACCOUNT_RECOVERY.account_id); assert.equal(current.account.username, ROLE_RECOVERY.username);
  assert.equal(current.account.roleId, ROLE_RECOVERY.role_id); assert.equal(current.account.mustChangePassword, true);
  assert.deepEqual(state.operations, original.original_operations);
  assert.deepEqual(state.anchors.preexisting_role_ids, original.original_preexisting_role_ids);
  assert(c.requests.every(row => ['/auth/login', '/auth/logout'].includes(row.endpoint)), 'Read-only recovery must not send any business mutation.');
  original.phase = 'READONLY_CONFIRMED'; await c.save();
  return { account_id: current.account.id, role_id: current.account.roleId, enabled: true, must_change_password: true,
    create_request_id: ACCOUNT_RECOVERY.request_id, duplicate_request_id: ACCOUNT_RECOVERY.duplicate_request_id,
    historical_evidence: original.historical_evidence, unique_account_confirmed_via_ui: true,
    readonly_failure_evidence: original.readonly_failure_evidence,
    duplicate_resubmitted: false, original_failures_preserved: [...c.historicalFailureIds] };
}

async function recoverSacrificialPassword(c, secret) {
  const id = ACCOUNT_RECOVERY.account_id, state = c.state;
  assert.equal(state.anchors.account_id, id); assert.equal(state.anchors.role_id, ROLE_RECOVERY.role_id);
  assert.equal(c.authenticatedActor?.account_id, ROLE_RECOVERY.admin_id);
  assert(state.admin_restored && c.authenticatedActor.permissions.includes('system.accounts'));
  assert.equal(c.accountRecovery.password_maintenance.phase, 'NOT_STARTED');
  const current = await accountReadback(c, true);
  assert.equal(current.account.id, id); assert.equal(current.account.username, ROLE_RECOVERY.username);
  const detail = await c.http('GET', '/system/accounts/' + enc(id), () => button(current.row, '维护密码').click());
  assert.equal(detail.data.account.id, id); assert.equal(detail.data.account.roleId, ROLE_RECOVERY.role_id);
  assert.equal(detail.data.account.username, ROLE_RECOVERY.username);
  const panel = c.drawer('维护账号密码'); await panel.waitFor({ state: 'visible' });
  c.passwordRecoveryTarget = { id, revision: detail.data.revision };
  // helper 只负责私密输入和目标路由限制，不向本模块返回管理员口令。
  try { await c.fillSystemOperatorPassword({ targetId: id }); }
  catch { throw new Error('Target-scoped operator-password UI filler was not confirmed; inspect original requests before any retry.'); }
  c.accountRecovery.password_maintenance = { phase: 'UI_READY', target_id: id,
    operation_key: 'account-password-recovery', operator_filled_by_main: true };
  await c.save();
  await panel.getByLabel('新密码', { exact: true }).fill(secret.initial());
  await panel.getByLabel('确认新密码', { exact: true }).fill(secret.initial());
  await c.until(async () => await button(panel, '提交密码').isEnabled(), 'Target password maintenance is not actionable.');
  await c.write('account-password-recovery', '/system/accounts/' + enc(id) + '/password',
    () => button(panel, '提交密码').click(), { targetId: id });
  await panel.waitFor({ state: 'hidden' });
  const saved = await accountReadback(c, true);
  assert.equal(saved.account.id, id); assert.equal(saved.account.username, ROLE_RECOVERY.username);
  assert.equal(saved.account.roleId, ROLE_RECOVERY.role_id); assert.equal(saved.account.mustChangePassword, true);
  c.accountRecovery.password_maintenance.phase = 'READBACK_CONFIRMED';
  c.accountRecovery.password_maintenance.request_id = state.operations['account-password-recovery'].request_id;
  c.accountRecovery.password_maintenance.operation_id = state.operations['account-password-recovery'].result.operation_id;
  await c.verified('account-password-recovery');
  return { account_id: id, role_id: ROLE_RECOVERY.role_id, initial_password_length: [...secret.initial()].length,
    request_id: state.operations['account-password-recovery'].request_id,
    operation_id: state.operations['account-password-recovery'].result.operation_id,
    changed: true, must_change_password: true, operator_secret_returned: false };
}

async function runSystemFlow(args, resumeCreatedRole, resumeCreatedAccount = false, resumeReadonly = false) {
  const requiredCaseIds = resumeCreatedAccount
    ? [ROLE_RECOVERY_CASE, SYSTEM_CASE_IDS[1], resumeReadonly ? ACCOUNT_READONLY_CASE : ACCOUNT_RECOVERY_CASE, ...SYSTEM_CASE_IDS.slice(3)]
    : resumeCreatedRole ? [ROLE_RECOVERY_CASE, ...SYSTEM_CASE_IDS.slice(1)] : [...SYSTEM_CASE_IDS];
  return environment(args, async (c, secret) => {
    if (resumeCreatedAccount) {
      await c.test(resumeReadonly ? ACCOUNT_READONLY_CASE : ACCOUNT_RECOVERY_CASE, () => recoverCreatedAccountReadOnly(c));
      await c.test(PASSWORD_RECOVERY_CASE, () => recoverSacrificialPassword(c, secret));
    } else {
    if (resumeCreatedRole) await c.test(ROLE_RECOVERY_CASE, () => recoverCreatedRoleReadOnly(c));
    else await c.test('A-SYSTEM-01-role-create-readback', async () => {
      await c.forceAdmin(); c.catalog = await openSystem(c);
      c.state.anchors.preexisting_role_ids = c.catalog.roles.map(role => role.id);
      const registry = new Map(c.catalog.permissions.map(row => [row.code, row])), chosen = new Set();
      const add = code => { assert(registry.has(code), 'Required permission is absent from the real catalog.'); if (chosen.has(code)) return; chosen.add(code); registry.get(code).requires.forEach(add); };
      add('situation.view');
      assert(![...chosen].some(code => /^(system\.|knowledge\.|planning\.|resources\..*(edit|import|create|reset))/.test(code)), 'The real catalog would expand this minimal role outside the approved scope.');
      c.state.anchors.role_permissions = [...chosen].sort(); await c.save();
      await query(c, '角色权限', '/system/roles', c.state.role_name);
      await button(c.page, '新增角色').click(); const panel = c.drawer('新增角色'); await panel.waitFor({ state: 'visible' });
      await panel.getByLabel('角色名称', { exact: true }).fill(c.state.role_name);
      await panel.getByLabel('说明', { exact: true }).fill('R6 sacrificial GIS viewer; not a production authorization change.');
      assert.equal(await panel.getByRole('checkbox', { checked: true }).count(), 0);
      for (const code of chosen) await panel.getByLabel(registry.get(code).name, { exact: true }).check();
      await c.write('role-create', '/system/roles', () => button(panel, '保存角色').click());
      await panel.waitFor({ state: 'hidden' }); await roleReadback(c); await c.verified('role-create');
      return { permissions: c.state.anchors.role_permissions, built_in_roles_untouched: true };
    });
    await c.test('A-SYSTEM-02-account-create-readback', async () => {
      const existing = await query(c, '账号管理', '/system/accounts', c.state.username);
      assert.equal(existing.items.filter(account => account.username === c.state.username).length, 0);
      c.state.anchors.username_absent_before_create = true; await c.save();
      await button(c.page, '新增账号').click(); const panel = c.drawer('新增账号'); await panel.waitFor({ state: 'visible' }); await fillAccount(c, panel, secret.initial());
      await c.write('account-create', '/system/accounts', () => button(panel, '保存账号').click());
      await panel.waitFor({ state: 'hidden' }); const saved = await accountReadback(c, true);
      assert.equal(saved.account.mustChangePassword, true); await c.verified('account-create');
      return { initial_password_length: [...secret.initial()].length, must_change_password: true, existing_accounts_untouched: true };
    });
    await c.test('A-SYSTEM-03-duplicate-account-rejected', async () => {
      await button(c.page, '新增账号').click(); const panel = c.drawer('新增账号'); await panel.waitFor({ state: 'visible' }); await fillAccount(c, panel, secret.duplicate());
      await c.write('duplicate-account', '/system/accounts', () => button(panel, '保存账号').click(), { rejection: true });
      const rejected = c.state.operations['duplicate-account'];
      assert.equal(rejected.status, 409); assert.equal(rejected.code, 1203);
      assert.equal(rejected.response_reason, 'UNIQUENESS_CONFLICT');
      assert.equal(typeof rejected.response_message, 'string'); assert(rejected.response_message.length > 0);
      await c.until(async () => (await panel.getByRole('alert').innerText()).includes(rejected.response_message), 'Actual duplicate rejection is not visible.');
      await button(panel, '关闭').click();
      await button(c.dialog('系统表单尚未保存'), '放弃修改').click(); await panel.waitFor({ state: 'hidden' });
      await accountReadback(c, true);
      return { duplicate_rejected: true, original_account_id_retained: true, password_material_recorded: false };
    });
    }
    await c.test('A-SYSTEM-04-state-cancel-disable-enable', async () => {
      for (const [enabled, label] of [[false, '停用'], [true, '启用']]) {
        const original = await accountReadback(c, !enabled); const start = c.requests.filter(row => row.endpoint.endsWith('/state')).length;
        await button(original.row, label).click(); const dialog = c.dialog(label + '账号'); await dialog.waitFor({ state: 'visible' });
        await button(dialog, '取消').click(); await dialog.waitFor({ state: 'hidden' });
        assert.equal(c.requests.filter(row => row.endpoint.endsWith('/state')).length, start);
        const retained = await accountReadback(c, !enabled); await button(retained.row, label).click(); await dialog.waitFor({ state: 'visible' });
        const key = enabled ? 'account-enable' : 'account-disable';
        await c.write(key, '/system/accounts/' + enc(c.state.anchors.account_id) + '/state', () => button(dialog, '确认').click(), { targetId: c.state.anchors.account_id });
        await dialog.waitFor({ state: 'hidden' }); await accountReadback(c, enabled); await c.verified(key);
      }
      return { cancel_did_not_write: true, final_enabled: true, only_target_account_changed: true };
    });
    await c.test('A-SYSTEM-05-sacrificial-real-login', async () => {
      await c.http('POST', '/auth/logout', () => button(c.page, '退出').click());
      await c.page.waitForURL(url => url.hash.startsWith('#/login'));
      const actor = await c.loginTarget(secret.initial());
      const panel = c.drawer('修改本人密码'); await panel.waitFor({ state: 'visible' });
      return { account_id: actor.account_id, role_id: actor.role_id, forced_self_password_change: true, login_password_length: [...secret.initial()].length };
    });
    await c.test('A-SYSTEM-06-self-password-7-reject-8-accept', async () => {
      const panel = c.drawer('修改本人密码'); await panel.waitFor({ state: 'visible' });
      await panel.getByLabel('当前密码', { exact: true }).fill(secret.initial());
      await panel.getByLabel('新密码', { exact: true }).fill(secret.short()); await panel.getByLabel('确认新密码', { exact: true }).fill(secret.short());
      const before = c.requests.filter(row => row.endpoint === '/auth/password').length;
      await c.until(async () => !await button(panel, '提交密码').isEnabled(), 'Seven-scalar input was not refused by the actual frontend.');
      assert.equal(c.requests.filter(row => row.endpoint === '/auth/password').length, before);
      assert.equal([...secret.short()].length, 7); assert.equal([...secret.next()].length, 8);
      await panel.getByLabel('新密码', { exact: true }).fill(secret.next()); await panel.getByLabel('确认新密码', { exact: true }).fill(secret.next());
      await c.until(async () => await button(panel, '提交密码').isEnabled(), 'Eight-scalar input is not enabled in the actual form.');
      const result = await c.write('self-password', '/auth/password', () => button(panel, '提交密码').click(), { targetId: c.state.anchors.account_id });
      assert.equal(result.reauthenticationRequired, true); await panel.waitFor({ state: 'hidden' });
      return { short_length: 7, short_submitted: false, accepted_length: 8, reauthentication_required: true };
    });
    await c.test('A-SYSTEM-07-new-password-login-restrictions', async () => {
      const actor = await c.loginTarget(secret.next()); await c.page.getByRole('heading', { name: 'GIS 态势', exact: true, level: 1 }).waitFor({ timeout: 90000 });
      assert.equal(await c.drawer('修改本人密码').count(), 0);
      for (const name of ['网络规划', '系统管理', '知识图谱']) assert.equal(await c.page.getByRole('link').filter({ hasText: new RegExp(`^\\s*${escaped(name)}\\s*$`) }).count(), 0);
      const reload = await c.http('GET', '/auth/session', () => c.page.reload({ waitUntil: 'domcontentloaded' }));
      assert.deepEqual(identity(reload.data), actor); await c.verified('self-password');
      await c.page.goto(`${ORIGIN}/?r6system=restricted-${Date.now()}#/system`, { waitUntil: 'domcontentloaded' });
      await c.page.waitForURL(url => url.hash.startsWith('#/situation'));
      assert.equal(await c.page.getByRole('heading', { name: '系统管理', exact: true, level: 1 }).count(), 0);
      return { account_id: actor.account_id, permissions: actor.permissions, new_password_relogin: true,
        restricted_system_navigation: 'real route guard fallback; not a server-403 claim', resource_writes: false };
    });
    return { role_id: c.state.anchors.role_id, account_id: c.state.anchors.account_id,
      required_steps: requiredCaseIds.length, recorded_cases: Object.keys(c.state.cases).length,
      resource_revision_modified: false, password_storage: 'memory only; not recoverable after process exit', objects_deleted: false };
  }, { resumeCreatedRole, resumeCreatedAccount, resumeReadonly, requiredCaseIds });
}

export async function runSystem(args) { return runSystemFlow(args, false); }
export async function runSystemResumeCreatedRole(args) { return runSystemFlow(args, true); }
export async function runSystemResumeCreatedAccount(args) { return runSystemFlow(args, false, true); }
export async function runSystemResumeAccountReadonly(args) { return runSystemFlow(args, false, true, true); }
export const runSystemAccounts = runSystem;
export default runSystem;
