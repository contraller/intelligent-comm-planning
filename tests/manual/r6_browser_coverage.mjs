// Imported by the shared harness only. No browser/server launch or direct API client.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'http://127.0.0.24:5324';
const API_ORIGIN = 'http://127.0.0.24:8124';
const ORIGINAL = Object.freeze({
  taskId: 'r4-network-89db2499fcf6', planId: 'PLAN-5273d94aa08345e4b047d62b915e2928',
  snapshotId: 'SNP-PL-0F4B502A', resourceRevision: 'resource-7c8bd11ec30d0ed4',
});
// One parameter tuple, not a sweep. Other engine defaults are observed, not supplied.
const PARAMETERS = Object.freeze({ radius_m: 60000, cell_m: 5000, az_step_deg: 10, hour: 12 });
const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = (scope, text) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${esc(text)}\\s*$`) });
const panel = c => c.page.locator('section[aria-label="冻结规划覆盖缓存"]');
const editor = c => panel(c).locator('section[aria-label="覆盖带宽选择"]');
// Implicit labels around selects include option text in the accessible name.
const field = (scope, text, tag) => scope.locator('label').filter({ hasText: new RegExp(`^\\s*${esc(text)}`) }).locator(`:scope > ${tag}`);
const sorted = rows => [...rows].sort((a, b) => a.device_id.localeCompare(b.device_id));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sleep = () => new Promise(resolve => setTimeout(resolve, 200));

function matches(response, endpoint, method = 'GET', query = {}) {
  const url = new URL(response.url());
  return [ORIGIN, API_ORIGIN].includes(url.origin) && url.pathname === '/api/v1' + endpoint
    && response.request().method() === method
    && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === String(value));
}

async function until(c, read, predicate, message, timeout = c.timeout) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    assert.equal(c.prohibited.length, 0, JSON.stringify(c.prohibited));
    value = await read();
    if (predicate(value)) return value;
    await sleep();
  } while (Date.now() < deadline);
  assert.fail(message + ': ' + JSON.stringify(value));
}
const enabled = (c, control) => until(c, () => control.isEnabled(), value => value, 'UI control remained disabled');

async function payload(c, response) {
  // Consume the real response body immediately, before another document can replace it.
  const raw = await response.json();
  c.sources.push({ path: new URL(response.url()).pathname + new URL(response.url()).search,
    method: response.request().method(), status: response.status() });
  assert(response.ok(), `HTTP ${response.status()}: ${JSON.stringify(raw)}`);
  assert.equal(raw.code, 0, JSON.stringify(raw));
  return raw.data;
}

const waitRead = (c, endpoint, query = {}, extra = () => true) => c.page.waitForResponse(
  response => matches(response, endpoint, 'GET', query) && extra(response), { timeout: c.timeout },
).then(response => payload(c, response));

async function environment(input, work) {
  for (const name of ['login', 'record', 'download', 'shot']) assert.equal(typeof input[name], 'function', `Missing harness ${name}`);
  assert(input.page && input.taskId === ORIGINAL.taskId && input.planId === ORIGINAL.planId, 'Only the approved original task/plan');
  const dir = typeof input.runtime === 'string' ? input.runtime : input.runtime?.dir;
  assert(dir && /^F:[\\/]/i.test(dir), 'Use the approved F: runtime');
  const manifest = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
  assert.equal(manifest.frontend, ORIGIN); assert.equal(manifest.api, API_ORIGIN);
  assert.equal(path.basename(dir), 'r4-f79ea5c1b6c54e38ae495d840c142013');
  assert.equal(manifest.database_url, 'sqlite:///F:/work/project2026-1/data/runtime/tmp/r4-f79ea5c1b6c54e38ae495d840c142013/workspace.sqlite');
  assert(input.page.url() === 'about:blank' || new URL(input.page.url()).origin === ORIGIN);
  const file = path.join(dir, 'r6-browser-coverage-state.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { schema: 'r6-coverage-ui-v1', original: ORIGINAL, parameters: PARAMETERS, operations: {}, cases: {} };
  assert.equal(state.schema, 'r6-coverage-ui-v1'); assert.deepEqual(state.original, ORIGINAL);
  assert.deepEqual(state.parameters, PARAMETERS);
  const c = { ...input, state, file, timeout: input.runtime?.timeoutMs ?? 120000,
    base: `/planning-coverages/${encodeURIComponent(input.planId)}`, sources: [], prohibited: [], writes: [], results: [] };
  let persistence = Promise.resolve(), persistenceError;
  c.save = () => {
    const content = JSON.stringify(c.state, null, 2) + '\n';
    const next = persistence.then(async () => {
      await writeFile(file + '.pending', content, { encoding: 'utf8' });
      await rename(file + '.pending', file);
    });
    // A failed write never truncates the last checkpoint or permits another mutation.
    persistence = next.catch(error => { persistenceError ??= error; });
    return next;
  };
  const writes = request => {
    const url = new URL(request.url());
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) || !url.pathname.startsWith('/api/v1/')) return;
    const expected = c.armed;
    const row = { method: request.method(), path: url.pathname, at: new Date().toISOString() };
    c.writes.push(row);
    if (c.readOnly || ![ORIGIN, API_ORIGIN].includes(url.origin) || !expected || request.method() !== 'POST'
      || url.pathname !== '/api/v1' + expected.endpoint || expected.sent) {
      c.prohibited.push(row); return;
    }
    expected.sent = true;
    const op = c.state.operations[expected.key];
    try {
      op.request = request.postDataJSON(); op.requestId = op.request?.request_id ?? null;
      op.phase = 'sent'; op.sentAt = row.at;
      void c.save().catch(() => {});
    } catch (error) { c.prohibited.push({ ...row, error: error.message }); }
  };
  await input.login('editor'); // Credentials and session setup belong solely to the harness.
  input.page.on('request', writes);
  c.test = async (id, action) => {
    const result = await input.record(id, async () => {
      if (persistenceError) throw persistenceError;
      const from = c.sources.length, writesFrom = c.writes.length;
      const detail = await action();
      assert.equal(c.prohibited.length, 0, JSON.stringify(c.prohibited));
      await persistence; if (persistenceError) throw persistenceError;
      c.state.cases[id] = { verifiedAt: new Date().toISOString(), detail };
      await c.save();
      return { ...detail, network: c.sources.slice(from), writes: c.writes.slice(writesFrom), checkpoint: file };
    });
    c.results.push({ id, detail: result }); return result;
  };
  try {
    await work(c);
    return { checkpoint: file, original: ORIGINAL, parameters: PARAMETERS, results: c.results,
      selectionId: state.operations.selection?.receipt?.selection_id ?? null,
      jobId: state.operations.compute?.receipt?.job_id ?? null };
  } finally {
    input.page.off('request', writes);
    await persistence;
    if (persistenceError) throw persistenceError;
  }
}

function sameAnchor(c, anchor) {
  assert(anchor, 'Missing frozen source anchor');
  assert.equal(anchor.plan_id, c.planId); assert.equal(anchor.task_id, c.taskId);
  assert.equal(anchor.snapshot_id, ORIGINAL.snapshotId); assert.equal(anchor.resource_revision, ORIGINAL.resourceRevision);
  for (const key of ['resource_content_hash', 'plan_input_sha256', 'raw_snapshot_sha256', 'frozen_tables_sha256', 'terrain_fingerprint'])
    assert.match(anchor[key], /^[a-f0-9]{64}$/, key);
  if (c.state.anchor) for (const key of Object.keys(c.state.anchor).filter(key => key !== 'engine_version'))
    assert.deepEqual(anchor[key], c.state.anchor[key], `Frozen source changed: ${key}`);
}

async function openOriginal(c, { historicalReadOnly = false } = {}) {
  if (historicalReadOnly) assert(c.readOnly && c.state.baseline && c.state.anchor, 'Historical entry requires the preserved original checkpoint');
  const marker = String(Date.now());
  const current = response => {
    const referer = response.request().headers().referer;
    return !!referer && new URL(referer).searchParams.get('r6coverage') === marker;
  };
  const reads = [
    waitRead(c, `/plans/${encodeURIComponent(c.planId)}`, {}, current),
    waitRead(c, `/task-inputs/${encodeURIComponent(c.taskId)}`, {}, current),
    waitRead(c, c.base + '/bandwidth-options', { task_id: c.taskId, snapshot_id: ORIGINAL.snapshotId, context: 'planning' }, current),
    waitRead(c, '/resource/context', { context: 'planning' }, current),
    waitRead(c, '/auth/session', {}, current),
  ];
  const [plan, task, options, resource, identity] = await Promise.all([...reads, c.page.goto(
    `${ORIGIN}/?r6coverage=${marker}#/planning?taskId=${encodeURIComponent(c.taskId)}&planId=${encodeURIComponent(c.planId)}`,
    { waitUntil: 'domcontentloaded', timeout: c.timeout },
  )]);
  assert.equal(plan.plan_id, c.planId); assert.equal(plan.task_id, c.taskId);
  assert.equal(plan.state, 'CONFIRMED');
  if (!historicalReadOnly) assert.equal(plan.current, true, 'Plan replaced: stop before writing');
  else assert.equal(typeof plan.current, 'boolean');
  assert.equal(plan.source_changed, false); assert.equal(plan.result.snapshot_id, ORIGINAL.snapshotId);
  assert.equal(task.task_id, c.taskId); assert.equal(resource.revision, ORIGINAL.resourceRevision);
  assert.equal(plan.resource_revision, resource.revision); assert.equal(task.resource_revision, resource.revision);
  assert.notEqual(identity.integration_mode, true); assert(identity.account_id);
  assert(identity.permissions.includes('planning.execute') && identity.permissions.includes('resources.view'));
  sameAnchor(c, options.anchor); assert.equal(options.anchor.engine_version, 'V01-4');
  let baseline;
  if (historicalReadOnly) {
    // current is a selection flag changed by E's confirmed V2, not frozen content.
    // Keep every other original plan field in the original canonical hash.
    assert.equal(digest({ ...plan, current: true }), c.state.baseline.planSha256, 'Historical plan content changed beyond current flag');
    assert.equal(plan.condition_version, c.state.anchor.condition_version);
    assert.equal(plan.input_version, c.state.anchor.input_version);
    assert.equal(task.condition_version, c.state.anchor.condition_version);
    assert.equal(identity.account_id, c.state.baseline.accountId);
    // task GET derives active_job_id from the latest job. A new completed job is
    // expected; freeze the remaining live task content across this read-only run.
    baseline = { planSha256: c.state.baseline.planSha256, taskContentSha256: digest({ ...task, active_job_id: null }),
      conditionVersion: task.condition_version, resourceRevision: resource.revision, accountId: identity.account_id };
    c.state.visual ??= {};
    if (c.state.visual.baseline) assert.deepEqual(baseline, c.state.visual.baseline, 'Historical source/live task content changed');
    c.state.visual.baseline ??= baseline;
  } else {
    baseline = { planSha256: digest(plan), taskSha256: digest(task), resourceRevision: resource.revision, accountId: identity.account_id };
    if (c.state.baseline) assert.deepEqual(baseline, c.state.baseline, 'Original plan/task/resource or owner changed');
    c.state.baseline ??= baseline;
  }
  c.state.anchor ??= options.anchor; c.catalog = options;
  await panel(c).waitFor({ state: 'visible', timeout: c.timeout });
  await until(c, () => c.page.locator('.steps button.active').innerText(), text => text.trim() === '2 · 规划计算与结果', 'Wrong planning step');
  await until(c, () => c.page.locator('.task-panel .panel-head .chip').innerText(), text => text.trim() === '已保存任务', 'Task input became dirty');
  await enabled(c, B(panel(c), '刷新带宽选项与选择'));
  if (c.state.operations.selection?.phase === 'accepted') validateSelection(c, options.current_selection);
  else if (!c.state.operations.selection) assert.equal(options.current_selection, null, 'Unowned existing FBS: stop, do not replace it');
  await c.save();
  return { baseline, current: plan.current, historicalReadOnly, activeJobIdObserved: task.active_job_id,
    source: options.anchor, currentSelectionId: options.current_selection?.selection_id ?? null };
}

async function parameters(c) {
  const controls = [
    [field(panel(c), '半径（km）', 'input'), '60'], [field(panel(c), '网格（m）', 'input'), '5000'],
    [field(panel(c), '方位步长（度）', 'select'), '10'], [field(panel(c), '时刻（时）', 'input'), '12'],
  ];
  // On resuming a running job the component defaults already equal this tuple.
  for (let index = 0; index < controls.length; index++) {
    const [control, value] = controls[index];
    if (await control.isEnabled() || await control.inputValue() !== value) {
      await enabled(c, control);
      if (index === 2) await control.selectOption(value); else await control.fill(value);
    }
    assert.equal(await control.inputValue(), value);
  }
  return PARAMETERS;
}

async function uiOptions(control) {
  const values = [];
  for (const option of await control.locator('option').all()) {
    const value = await option.getAttribute('value');
    if (value !== null && value !== '' && !(await option.isDisabled())) values.push(value);
  }
  return values;
}

async function chooseAll(c) {
  const required = c.catalog.devices.filter(row => row.state === 'SELECTION_REQUIRED');
  assert(required.length > 0, 'No active multi-value bandwidths to explicitly select');
  assert(c.catalog.devices.some(row => row.state === 'NO_ASSIGNED_FREQUENCY'), 'SKIPPED fixture is required');
  const groups = [...new Set(required.map(row => row.model_id))].sort();
  const choices = [], batches = [];
  const model = editor(c).getByLabel('筛选带宽型号', { exact: true });
  const batch = editor(c).getByLabel('批量带宽', { exact: true });
  await editor(c).getByLabel('仅未选设备', { exact: true }).check();
  for (const modelId of groups) {
    assert((await uiOptions(model)).includes(modelId), `Missing real UI model ${modelId}`);
    await model.selectOption(modelId);
    const rows = required.filter(row => row.model_id === modelId);
    const check = B(editor(c), `勾选该型号（${rows.length}）`);
    await enabled(c, check); await check.click(); await enabled(c, batch);
    const legal = await uiOptions(batch);
    assert(legal.length > 0, `No common legal UI bandwidth for ${modelId}; do not manufacture an option`);
    assert(legal.every(value => rows.every(row => row.options_khz?.includes(Number(value)))), 'UI option/catalog mismatch');
    const allHf = rows.every(row => /^(HF|短波)$/i.test(row.band ?? ''));
    const allVuhf = rows.every(row => /^(VHF|UHF|VUHF|V\/UHF|超短波)$/i.test(row.band ?? ''));
    const preferred = allHf ? '3' : allVuhf ? '25' : null;
    // Fallback is still an explicitly selected, rendered option, never a fake model parameter.
    const value = preferred && legal.includes(preferred) ? preferred : legal[0];
    await batch.selectOption(value); assert.equal(await batch.inputValue(), value);
    await B(editor(c), `应用到勾选项（${rows.length}）`).click();
    choices.push(...rows.map(row => ({ device_id: row.device_id, rx_bandwidth_khz: Number(value) })));
    batches.push({ modelId, band: [...new Set(rows.map(row => row.band))], count: rows.length, legalUiOptions: legal,
      selectedKhz: Number(value), preferredAvailable: preferred ? legal.includes(preferred) : null });
  }
  await until(c, () => editor(c).locator('.feedback').innerText(), text => text.trim() === `待确认 ${required.length} 台；未确认内容尚未保存`, 'Missing local choices');
  await B(editor(c), '预览选择').click();
  const preview = await editor(c).locator('[aria-label="带宽选择待确认清单"] p').allTextContents();
  assert.equal(preview.length, required.length);
  for (const choice of choices) assert(preview.some(text => text.trim() === `${choice.device_id}：未选 → ${choice.rx_bandwidth_khz} kHz`), 'Preview missing explicit choice');
  c.state.choices = sorted(choices); c.state.batches = batches; await c.save();
  return { selectedDevices: choices.length, batches,
    fixedSingleValueDevices: c.catalog.devices.filter(row => row.state === 'SINGLE_VALUE').length,
    skippedDevices: c.catalog.devices.filter(row => row.state === 'NO_ASSIGNED_FREQUENCY').length,
    syntheticAssumptions: c.catalog.devices.filter(row => row.bandwidth_provenance).map(row => ({ deviceId: row.device_id, source: row.bandwidth_provenance })) };
}

function validateSelection(c, receipt) {
  assert(receipt, 'Saved FBS is absent from real UI readback');
  assert.match(receipt.selection_id, /^FBS-[a-f0-9]{32}$/); assert.match(receipt.selection_hash, /^[a-f0-9]{64}$/);
  sameAnchor(c, receipt.source_anchor); assert.deepEqual(sorted(receipt.choices), c.state.choices);
  const known = c.state.operations.selection?.receipt;
  if (known) {
    assert.equal(receipt.selection_id, known.selection_id, 'Do not replace the original FBS');
    assert.equal(receipt.selection_hash, known.selection_hash); assert.equal(receipt.version_no, known.version_no);
  }
}

async function oneWrite(c, key, endpoint, action) {
  assert(!c.readOnly, 'This entry cannot save or compute');
  const previous = c.state.operations[key];
  if (previous) {
    assert.equal(previous.phase, 'accepted', `Original ${key} is ${previous.phase}, request=${previous.requestId}; inspect original, never blindly resubmit`);
    return previous.receipt;
  }
  const op = c.state.operations[key] = { phase: 'armed', armedAt: new Date().toISOString(), endpoint };
  await c.save(); // Persist intent before the UI action, even if the process then crashes.
  c.armed = { key, endpoint, sent: false };
  const response = c.page.waitForResponse(value => matches(value, endpoint, 'POST'), { timeout: c.timeout }).then(async value => {
    const raw = await value.json();
    op.phase = value.ok() && raw.code === 0 ? 'accepted' : 'rejected';
    op.http = value.status(); op.code = raw.code; op.message = raw.message;
    op.receipt = raw.data ?? null; op.responseAt = new Date().toISOString();
    await c.save(); // Keep original FBS/FCJ before any later assertion can fail.
    c.sources.push({ path: '/api/v1' + endpoint, method: 'POST', status: value.status() });
    assert(value.ok() && raw.code === 0, JSON.stringify(raw));
    return raw.data;
  });
  try {
    const [receipt] = await Promise.all([response, action()]);
    assert(c.armed.sent && op.requestId, 'No real UI business request was observed');
    assert.equal(op.request.task_id, c.taskId); assert.equal(op.request.snapshot_id, ORIGINAL.snapshotId);
    return receipt;
  } finally { c.armed = null; }
}

async function selection(c) {
  if (c.state.operations.selection) {
    assert.equal(c.state.operations.selection.phase, 'accepted', 'Original selection needs inspection; no retry POST');
    validateSelection(c, c.catalog.current_selection);
    return { resumed: true, selection: c.catalog.current_selection, batches: c.state.batches };
  }
  const detail = await chooseAll(c);
  const receipt = await oneWrite(c, 'selection', c.base + '/bandwidth-selections', () => B(editor(c), '确认并提交选择').click());
  validateSelection(c, receipt);
  assert.deepEqual(sorted(c.state.operations.selection.request.choices), c.state.choices);
  // The component performs a GET after save; explicitly refresh once settled to prove current FBS.
  await enabled(c, B(panel(c), '刷新带宽选项与选择'));
  const [options] = await Promise.all([waitRead(c, c.base + '/bandwidth-options', { task_id: c.taskId, snapshot_id: ORIGINAL.snapshotId, context: 'planning' }),
    B(panel(c), '刷新带宽选项与选择').click()]);
  sameAnchor(c, options.anchor); validateSelection(c, options.current_selection); c.catalog = options;
  await until(c, () => panel(c).innerText(), text => text.includes(`已回读服务端选择 v${receipt.version_no} · ${receipt.selection_id}`), 'FBS not rendered');
  return { ...detail, selection: receipt, requestId: c.state.operations.selection.requestId };
}

function validateJob(c, job) {
  assert.match(job.job_id, /^FCJ-[a-f0-9]{32}$/); sameAnchor(c, job.anchor);
  assert.equal(job.request_id, c.state.operations.compute.requestId);
  const known = c.state.operations.compute.receipt;
  assert.equal(job.job_id, known.job_id, 'Do not switch original FCJ');
  assert.equal(job.bandwidth_selection_id, c.state.operations.selection.receipt.selection_id);
  assert.equal(job.bandwidth_selection_hash, c.state.operations.selection.receipt.selection_hash);
  for (const [key, value] of Object.entries(PARAMETERS)) assert.equal(job.parameters[key], value);
  assert(!['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(job.state), `Original job terminated: ${JSON.stringify(job)}`);
}

async function readCache(c) {
  await enabled(c, B(panel(c), '读取覆盖缓存'));
  const [cache] = await Promise.all([waitRead(c, c.base + '/cache', {
    task_id: c.taskId, snapshot_id: ORIGINAL.snapshotId, context: 'planning',
    bandwidth_selection_id: c.state.operations.selection.receipt.selection_id,
  }), B(panel(c), '读取覆盖缓存').click()]);
  sameAnchor(c, cache.anchor);
  for (const [key, value] of Object.entries(PARAMETERS)) assert.equal(cache.parameters[key], value);
  assert.equal(cache.bandwidth_selection_id, c.state.operations.selection.receipt.selection_id);
  assert.equal(cache.bandwidth_selection_hash, c.state.operations.selection.receipt.selection_hash);
  return cache;
}

async function rememberHit(c, cache, cacheKey) {
  assert.equal(cache.state, 'HIT'); assert.equal(cache.cache_key, cacheKey);
  await until(c, () => panel(c).innerText(), text => text.includes('已命中冻结缓存'), 'HIT not rendered');
  if (c.state.cacheKey) assert.equal(cache.cache_key, c.state.cacheKey);
  if (c.state.resultSha256) assert.equal(digest(cache.result), c.state.resultSha256, 'Original result changed');
  c.cache = cache; c.state.cacheKey = cache.cache_key; c.state.resultSha256 = digest(cache.result); await c.save();
}

async function finishJob(c) {
  const op = c.state.operations.compute;
  assert.equal(op?.phase, 'accepted', 'Original FCJ receipt required; no automatic compute retry');
  validateJob(c, op.receipt);
  await B(panel(c), '刷新作业').waitFor({ state: 'visible', timeout: c.timeout });
  const deadline = Date.now() + 20 * 60 * 1000, transitions = [];
  let job;
  do {
    // Genuine UI refresh; the component may also poll the same original job every 2 s.
    await enabled(c, B(panel(c), '刷新作业'));
    [job] = await Promise.all([waitRead(c, `/planning-coverages/jobs/${op.receipt.job_id}`, {
      task_id: c.taskId, snapshot_id: ORIGINAL.snapshotId, plan_id: c.planId, context: 'planning',
    }), B(panel(c), '刷新作业').click()]);
    validateJob(c, job);
    if (transitions.at(-1)?.state !== job.state) transitions.push({ state: job.state, progress: job.progress, stage: job.stage });
    c.state.lastJob = { job_id: job.job_id, state: job.state, progress: job.progress, stage: job.stage };
    await c.save();
    if (job.state === 'SUCCESS') break;
    // Bound UI traffic while letting the real component poll. Never call fetch/request.
    await c.page.waitForTimeout(2000);
  } while (Date.now() < deadline);
  assert.equal(job.state, 'SUCCESS', 'Original job still running: keep FCJ; do not create another');
  await until(c, () => panel(c).innerText(), text => text.includes('完成 · 100%'), 'SUCCESS not rendered');
  const cache = await readCache(c);
  await rememberHit(c, cache, job.cache_key);
  return { jobId: job.job_id, requestId: op.requestId, state: job.state, fromCache: job.from_cache,
    transitions, cacheKey: cache.cache_key, resultSha256: c.state.resultSha256 };
}

async function compute(c) {
  assert.equal(c.state.operations.selection?.phase, 'accepted', 'Save/read original FBS before compute');
  validateSelection(c, c.catalog.current_selection); await parameters(c);
  if (!c.state.operations.compute) {
    const before = await readCache(c);
    assert.equal(before.state, 'MISS', 'Expected fresh tuple/FBS MISS; do not claim a new calculation on an existing HIT');
    await enabled(c, B(panel(c), '计算冻结覆盖'));
    const job = await oneWrite(c, 'compute', c.base + '/compute', () => B(panel(c), '计算冻结覆盖').click());
    validateJob(c, job);
    const request = c.state.operations.compute.request;
    assert.deepEqual(request.parameters, PARAMETERS);
    assert.equal(request.bandwidth_selection_id, c.state.operations.selection.receipt.selection_id);
  }
  return finishJob(c);
}

async function layers(c) {
  const cache = c.cache ?? await readCache(c);
  assert.equal(cache.state, 'HIT'); assert.equal(cache.cache_key, c.state.cacheKey);
  assert.equal(digest(cache.result), c.state.resultSha256, 'Cached result changed');
  const result = cache.result;
  assert.equal(result.schema_version, 2); assert.equal(result.status, 'COMPLETE');
  const { total, eligible, complete, unavailable, skipped } = result.summary;
  assert(eligible > 0 && skipped > 0, 'Both active and no-active-link devices are required');
  assert.equal(complete, eligible); assert.equal(unavailable, 0);
  assert.equal(total, eligible + skipped); assert.equal(total, result.devices.length);
  assert.deepEqual(sorted(result.provenance.bandwidth_choices), c.state.choices);
  const byId = new Map(c.catalog.devices.map(row => [row.device_id, row]));
  for (const device of result.devices) {
    const original = byId.get(device.device_id); assert(original, 'Unexpected device');
    if (original.state === 'NO_ASSIGNED_FREQUENCY') {
      assert.equal(device.status, 'SKIPPED'); assert.equal(device.reason_code, 'NO_ASSIGNED_FREQUENCY');
      assert.deepEqual(device.computations, []);
    } else {
      assert.equal(device.status, 'COMPLETE'); assert(device.computations.length > 0);
      const choice = c.state.choices.find(row => row.device_id === device.device_id);
      if (choice) { assert.equal(device.rx_bandwidth.value_khz, choice.rx_bandwidth_khz); assert.equal(device.rx_bandwidth.source, 'EXPLICIT_COMPUTE_PARAMETER'); }
    }
  }
  const select = field(panel(c), '覆盖设备', 'select');
  await select.waitFor({ state: 'visible', timeout: c.timeout });
  assert.equal((await uiOptions(select)).length, total);
  const toggle = panel(c).getByLabel('覆盖图层', { exact: true });
  const map = c.page.locator('.map-panel .map-host');
  await map.waitFor({ state: 'visible', timeout: c.timeout });
  await map.locator('canvas').first().waitFor({ state: 'visible', timeout: c.timeout });
  const sampled = [], pictures = [];
  // One completed device per actual band, plus one SKIPPED; no device x parameter sweep.
  const active = [...new Map(result.devices.filter(row => row.status === 'COMPLETE').map(row => [row.band, row])).values()];
  const noLink = result.devices.find(row => row.status === 'SKIPPED');
  for (const device of [...active, noLink]) {
    await select.selectOption(device.device_id); assert.equal(await select.inputValue(), device.device_id);
    const option = select.locator(`option[value="${device.device_id}"]`);
    assert((await option.innerText()).includes(device.status === 'SKIPPED' ? '本次无活动链路' : '已计算'));
    await until(c, () => panel(c).innerText(), text => device.status === 'SKIPPED' ? text.includes('本次无活动链路')
      && device.reasons.every(reason => text.includes(reason))
      : text.includes(device.computations.map(part => `${part.freq_khz} kHz`).join(' / ')), 'Selected device detail not rendered');
    const stem = `R6-COV-${device.device_id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    await toggle.check(); assert.equal(await toggle.isChecked(), true);
    await map.scrollIntoViewIfNeeded(); await c.page.waitForTimeout(300);
    pictures.push(await c.shot(stem + '-layer-on'));
    await toggle.uncheck(); assert.equal(await toggle.isChecked(), false);
    await map.scrollIntoViewIfNeeded(); await c.page.waitForTimeout(300);
    pictures.push(await c.shot(stem + '-layer-off'));
    sampled.push({ deviceId: device.device_id, band: device.band, status: device.status, reasonCode: device.reason_code,
      frequencies: device.computations.map(part => part.freq_khz),
      coverageFeatures: device.computations.reduce((sum, part) => sum + part.geojson.features.filter(feature => feature.geometry && feature.properties.is_coverage).length, 0),
      syntheticAssumption: device.bandwidth_provenance ?? null });
  }
  await toggle.check();
  return { summary: result.summary, sampled, pictures,
    layerEvidence: 'Real UI selector/checkbox/canvas and paired screenshots; canvas feature visibility requires screenshot review, no private map/store inspection.' };
}

async function sourceReadback(c) {
  const result = await openOriginal(c);
  await parameters(c); validateSelection(c, c.catalog.current_selection);
  const cache = await readCache(c);
  assert.equal(cache.state, 'HIT'); assert.equal(cache.cache_key, c.state.cacheKey);
  assert.equal(digest(cache.result), c.state.resultSha256);
  return { ...result, selectionId: cache.bandwidth_selection_id, cacheKey: cache.cache_key, resultSha256: c.state.resultSha256,
    originalRequestIds: Object.fromEntries(Object.entries(c.state.operations).map(([key, op]) => [key, op.requestId])) };
}

export async function runCoverage(input) {
  return environment(input, async c => {
    await c.test('R6-COV-01-original-source', () => openOriginal(c));
    await c.test('R6-COV-02-explicit-bandwidth-save-once', () => selection(c));
    await c.test('R6-COV-03-compute-once-success-hit', () => compute(c));
    await c.test('R6-COV-04-active-skipped-layer-readback', () => layers(c));
    await c.test('R6-COV-05-original-source-unchanged', () => sourceReadback(c));
  });
}

// V5只读视觉复核：计算由独立HTTP原号完成，本入口不提交选择或计算。
export async function caseFieldSurfaceVisual(input) {
  await input.login('editor');
  const expected=JSON.parse(await readFile(path.resolve(input.runtime,'..','coverage-field-live-20261026','result.json'),'utf8'));
  const observedWrites=[];
  const guard=request=>{const url=new URL(request.url());if(url.origin===ORIGIN&&url.pathname.startsWith('/api/v1/')&&request.method()==='POST')observedWrites.push(url.pathname);};
  input.page.on('request',guard);
  try {
    return await input.record('V5-FIELD-READONLY-VISUAL',async()=>{
      const page=input.page;
      await page.goto(`${ORIGIN}/#/planning?taskId=${ORIGINAL.taskId}&planId=${ORIGINAL.planId}`,{waitUntil:'domcontentloaded',timeout:90000});
      const scope=panel({page});await scope.waitFor({state:'visible',timeout:60000});
      await field(scope,'超短波半径','input').fill('60');await field(scope,'网格','input').fill('5000');
      await field(scope,'历史缓存方位步长','select').selectOption('10');await field(scope,'时刻','input').fill('12');
      await field(scope,'短波最远预测','input').fill('900');
      await B(scope,'读取覆盖缓存').waitFor({state:'visible'});
      const deadline=Date.now()+60000;while(!await B(scope,'读取覆盖缓存').isEnabled()){assert(Date.now()<deadline,'读取入口未就绪');await new Promise(r=>setTimeout(r,100));}
      const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/planning-coverages/${ORIGINAL.planId}/cache`&&r.request().method()==='GET'),B(scope,'读取覆盖缓存').click()]);
      // 大响应可能超出CDP inspector缓存；实际页面仍正常解码。
      // 通过真实点击读取，再在页面来源明细核对独立HTTP记录的缓存键，
      // 不重发计算或用evaluate读取隐藏store。
      assert.equal(response.status(),200);
      const cache=expected;
      await page.getByLabel('预测覆盖显示方式',{exact:true}).waitFor({state:'visible'});
      await scope.locator('summary').filter({hasText:'来源与算法限制'}).click();
      await scope.getByText(expected.cache_key,{exact:true}).waitFor({state:'visible'});
      const select=field(scope,'覆盖设备','select'),toggle=scope.getByLabel('覆盖图层',{exact:true});
      const map=page.locator('.map-panel'),fit=B(map,'全域');
      const screenshots=[];
      for(const band of ['HF','VUHF']){
        const device=cache.result.devices.find(row=>row.band===band&&row.status==='COMPLETE'&&row.computations.some(part=>part.geojson.features.some(f=>f.geometry&&f.properties.is_coverage&&(band!=='HF'||f.properties.surface_kind==='SKYWAVE'))
          &&(band!=='HF'||part.geojson.features.some(f=>f.properties.surface_kind==='SKIP_ZONE'&&!f.properties.is_coverage))));
        assert(device,'缺少可显示的'+band+'覆盖');
        await select.selectOption(device.device_id);await toggle.check();await fit.click();await page.waitForTimeout(400);
        await map.scrollIntoViewIfNeeded();
        const on=path.join(input.evidence,`v5-${band.toLowerCase()}-on.png`);await map.screenshot({path:on});
        await toggle.uncheck();await map.scrollIntoViewIfNeeded();
        const off=path.join(input.evidence,`v5-${band.toLowerCase()}-off.png`);await map.screenshot({path:off});
        assert.notEqual((await readFile(on)).toString('base64'),(await readFile(off)).toString('base64'),'图层开关像素未变化');
        screenshots.push({band,deviceId:device.device_id,on,off});
      }
      await toggle.check();await page.getByLabel('预测覆盖显示方式',{exact:true}).selectOption('boundary');
      await fit.click();await page.waitForTimeout(300);await map.scrollIntoViewIfNeeded();
      await map.screenshot({path:path.join(input.evidence,'v5-vuhf-boundary.png')});
      await page.getByLabel('预测覆盖显示方式',{exact:true}).selectOption('field');
      await fit.click();await page.waitForTimeout(300);await map.scrollIntoViewIfNeeded();
      await map.screenshot({path:path.join(input.evidence,'v5-vuhf-field.png')});
      await scope.getByText('预测场强热力图',{exact:true}).count();
      await input.shot('v5-field-controls');
      assert.deepEqual(observedWrites,[],'只读复核不得发业务POST');
      return {cacheKey:cache.cache_key,engine:'V01-5',screenshots,businessPosts:observedWrites};
    });
  } finally {input.page.off('request',guard);}
}

// Segments always reopen the same source and consume the same independent checkpoint.
export async function caseCoverageSelection(input) {
  return environment(input, async c => {
    await c.test('R6-COV-01-original-source', () => openOriginal(c));
    await c.test('R6-COV-02-explicit-bandwidth-save-once', () => selection(c));
  });
}
export async function caseCoverageCompute(input) {
  return environment(input, async c => {
    await c.test('R6-COV-01-original-source', () => openOriginal(c));
    await c.test('R6-COV-03-compute-once-success-hit', () => compute(c));
  });
}
export async function runCoverageReadback(input) {
  return environment(input, async c => {
    assert.equal(c.state.operations.compute?.phase, 'accepted', 'Readback needs the original accepted FCJ');
    await c.test('R6-COV-01-original-source', () => openOriginal(c));
    await parameters(c);
    if (await B(panel(c), '刷新作业').isVisible()) {
      await c.test('R6-COV-03-compute-once-success-hit', () => finishJob(c));
    } else {
      // The product's original-job shortcut is session-bound. A fresh harness login
      // cannot restore it with store injection or a fabricated job URL. Read only
      // a SUCCESS already proved and persisted in the original UI invocation.
      assert.equal(c.state.lastJob?.state, 'SUCCESS', 'New session has no original-job UI entry; retain FCJ and ask main to inspect, never compute again');
      assert(c.state.cacheKey && c.state.resultSha256, 'Original SUCCESS/HIT evidence is required');
    }
    await c.test('R6-COV-04-active-skipped-layer-readback', () => layers(c));
    await c.test('R6-COV-05-original-source-unchanged', () => sourceReadback(c));
  });
}

// Explicit main-authorized recovery only. This is a real browser document GET,
// not the product's session-bound job shortcut and not an automatic fallback.
export async function runCoverageResumeReadback(input) {
  return environment(input, async c => {
    const op = c.state.operations.compute;
    assert.equal(op?.phase, 'accepted', 'Keep the accepted original FCJ');
    assert.equal(c.state.operations.selection?.phase, 'accepted', 'Keep the accepted original FBS');
    validateJob(c, op.receipt);
    assert.deepEqual(op.request.parameters, PARAMETERS);
    assert.equal(op.request.bandwidth_selection_id, c.state.operations.selection.receipt.selection_id);
    const query = { task_id: c.taskId, snapshot_id: ORIGINAL.snapshotId, plan_id: c.planId, context: 'planning' };
    const endpoint = `/planning-coverages/jobs/${op.receipt.job_id}`;
    const url = `${ORIGIN}/api/v1${endpoint}?${new URLSearchParams(query)}`;
    let job;
    await c.test('R6-COV-03a-original-job-browser-get', async () => {
      [job] = await Promise.all([waitRead(c, endpoint, query), c.page.goto(url, { waitUntil: 'domcontentloaded', timeout: c.timeout })]);
      assert.equal(c.page.url(), url); validateJob(c, job);
      assert.equal(job.state, 'SUCCESS'); assert.equal(job.progress, 1);
      assert.equal(job.cache_key, op.receipt.cache_key);
      c.state.recovery = { method: 'REAL_BROWSER_DOCUMENT_GET', productJobShortcut: false,
        url, verifiedAt: new Date().toISOString(), job, jobSha256: digest(job) };
      await c.save();
      return { method: c.state.recovery.method, productJobShortcut: false, url, job,
        jobSha256: c.state.recovery.jobSha256, originalRequestId: op.requestId };
    });
    await c.test('R6-COV-01-original-source', () => openOriginal(c));
    await c.test('R6-COV-03b-original-hit-ui-recovery', async () => {
      await parameters(c); validateSelection(c, c.catalog.current_selection);
      const cache = await readCache(c); await rememberHit(c, cache, job.cache_key);
      c.state.recovery.cacheKey = cache.cache_key; c.state.recovery.resultSha256 = c.state.resultSha256;
      await c.save();
      return { method: 'ORIGINAL_JOB_GET_PLUS_REAL_PLANNING_UI_CACHE', newExecution: false,
        jobId: job.job_id, originalRequestId: op.requestId, jobState: job.state,
        selectionId: cache.bandwidth_selection_id, cacheKey: cache.cache_key,
        resultSha256: c.state.resultSha256, summary: cache.result.summary };
    });
    await c.test('R6-COV-04-active-skipped-layer-readback', () => layers(c));
    await c.test('R6-COV-05-original-source-unchanged', () => sourceReadback(c));
  });
}

function coverageFeatures(device) {
  return device.computations.flatMap(part => part.geojson.features.filter(feature => feature.geometry && feature.properties.is_coverage));
}

async function hideCandidatePoints(c) {
  await B(c.page, '部署点位').click();
  const details = c.page.locator('details.support-details').filter({
    has: c.page.locator('summary').filter({ hasText: /^候选筛选与依据$/ }),
  });
  assert.equal(await details.count(), 1, 'Expected the actual candidate disclosure');
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  const control = details.getByLabel('显示已返回候选点', { exact: true });
  await enabled(c, control);
  const wasChecked = await control.isChecked();
  if (wasChecked) await control.uncheck();
  assert.equal(await control.isChecked(), false);
  await until(c, () => c.page.locator('.candidate-map-legend').isVisible(), value => !value, 'Candidate legend remained visible');
  return { wasChecked, action: wasChecked ? 'UI_UNCHECK' : 'UI_DEFAULT_OFF_VERIFIED', checked: false, candidateLegendVisible: false };
}

async function visualMapPairs(c) {
  const cache = c.cache, result = cache.result;
  assert.equal(cache.state, 'HIT'); assert.equal(digest(result), c.state.resultSha256);
  assert.equal(result.status, 'COMPLETE'); assert.equal(result.schema_version, 2);
  assert.equal(result.summary.complete, result.summary.eligible); assert.equal(result.summary.unavailable, 0);
  const chosen = ['HF', 'VUHF'].map(band => {
    const candidates = result.devices.filter(device => device.band === band && device.status === 'COMPLETE' && coverageFeatures(device).length);
    candidates.sort((a, b) => coverageFeatures(b).length - coverageFeatures(a).length || a.device_id.localeCompare(b.device_id));
    assert(candidates.length, `No actual ${band} coverage geometry; never manufacture it`);
    return candidates[0];
  });
  const skipped = result.devices.find(device => device.status === 'SKIPPED');
  assert(skipped); assert.equal(skipped.reason_code, 'NO_ASSIGNED_FREQUENCY'); assert.deepEqual(skipped.computations, []);
  chosen.push(skipped);
  const select = field(panel(c), '覆盖设备', 'select'), toggle = panel(c).getByLabel('覆盖图层', { exact: true });
  const map = c.page.locator('.map-panel .map-host'), pairs = [];
  await map.waitFor({ state: 'visible', timeout: c.timeout });
  const boundsBefore = await map.boundingBox();
  assert(boundsBefore && boundsBefore.width > 0 && boundsBefore.height > 0);
  for (const device of chosen) {
    await select.selectOption(device.device_id); assert.equal(await select.inputValue(), device.device_id);
    await until(c, () => panel(c).innerText(), text => device.status === 'SKIPPED'
      ? device.reasons.every(reason => text.includes(reason)) && text.includes('本次无活动链路')
      : text.includes(device.computations.map(part => `${part.freq_khz} kHz`).join(' / ')), 'Device detail not settled');
    const captures = [];
    for (const visible of [true, false]) {
      await toggle.setChecked(visible); assert.equal(await toggle.isChecked(), visible);
      assert.equal(await c.page.locator('.candidate-map-legend').isVisible(), false);
      await map.scrollIntoViewIfNeeded(); await c.page.waitForTimeout(400);
      const label = `R6-COV-VIS-${device.device_id.replace(/[^A-Za-z0-9_-]/g, '_')}-${visible ? 'on' : 'off'}`;
      const full = await c.shot(label);
      const mapFile = path.join(path.dirname(full), label + '-map.png');
      const bytes = await map.screenshot({ path: mapFile, animations: 'disabled' });
      captures.push({ visible, full, map: mapFile, bytes: bytes.length,
        mapPngSha256: createHash('sha256').update(bytes).digest('hex'), box: await map.boundingBox() });
    }
    assert.deepEqual(captures[0].box, captures[1].box, 'Map viewport layout changed within on/off pair');
    pairs.push({ deviceId: device.device_id, band: device.band, status: device.status,
      frequencies: device.computations.map(part => part.freq_khz), coverageFeatures: coverageFeatures(device).length,
      syntheticAssumption: device.bandwidth_provenance ?? null, captures,
      mapPngBytesEqual: captures[0].mapPngSha256 === captures[1].mapPngSha256 });
  }
  await toggle.uncheck();
  return { pairs, summary: result.summary, viewportManipulation: 'NONE',
    pixelVerdict: 'PENDING_HUMAN_REVIEW',
    note: 'Map-host screenshots preserve the existing viewport. PNG byte differences alone are not a coverage-pixel verdict.' };
}

// Explicit history-only visual entry after E confirmed V2. Never calls oneWrite.
export async function runCoverageVisualReadback(input) {
  return environment(input, async c => {
    c.readOnly = true;
    assert.equal(c.state.operations.selection?.phase, 'accepted');
    assert.equal(c.state.operations.compute?.phase, 'accepted');
    assert(c.state.cacheKey && c.state.resultSha256 && c.state.recovery?.job?.state === 'SUCCESS');
    const operationsSha256 = digest(c.state.operations);
    await c.test('R6-COV-V01-historical-source-readonly', () => openOriginal(c, { historicalReadOnly: true }));
    await c.test('R6-COV-V02-candidates-hidden-original-hit', async () => {
      const candidates = await hideCandidatePoints(c);
      await parameters(c); validateSelection(c, c.catalog.current_selection);
      const cache = await readCache(c); await rememberHit(c, cache, c.state.operations.compute.receipt.cache_key);
      return { candidates, selectionId: cache.bandwidth_selection_id, cacheKey: cache.cache_key,
        resultSha256: c.state.resultSha256, parameters: PARAMETERS, newExecution: false };
    });
    await c.test('R6-COV-V03-unmasked-map-pairs-captured', async () => {
      const detail = await visualMapPairs(c); c.state.visual.pairs = detail; return detail;
    });
    await c.test('R6-COV-V04-history-source-cache-unchanged', async () => {
      const source = await openOriginal(c, { historicalReadOnly: true });
      await parameters(c); validateSelection(c, c.catalog.current_selection);
      const cache = await readCache(c); await rememberHit(c, cache, c.state.cacheKey);
      assert.equal(digest(c.state.operations), operationsSha256); assert.equal(c.writes.length, 0);
      return { ...source, cacheKey: cache.cache_key, resultSha256: c.state.resultSha256, businessWrites: 0, operationsSha256 };
    });
  });
}
export default runCoverage;
