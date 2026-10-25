// Main-harness imports only. Each named entry is separately authorized/run.
// No browser/server/dependency startup, direct HTTP client, evaluate or store calls.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'http://127.0.0.24:5324', API = '/api/v1';
const F = '/fault/workbench', K = '/kg/workbench';
const TASK = 'r4-network-89db2499fcf6', PLAN = 'PLAN-4d974f02b63b465ca03e030dcda8eff9';
const RESOURCE = 'resource-7c8bd11ec30d0ed4', VERSION = 'KGV-3';
const OLD_RUN = 'FR-3a67f1773487493aa949', OLD_CR = 'CR-DD078772EE0A4F8E';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = (scope, text) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escape(text)}\\s*$`) });
const select = (scope, text) => scope.locator('label').filter({ hasText: new RegExp(`^\\s*${escape(text)}`) }).locator(':scope > select');
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
const versionHash = value => hash({ entities: value.entities, relations: value.relations });
const versionContent = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'scenarioArchived'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function matches(value, endpoint, method = 'GET', query = {}) {
  const url = new URL(value.url());
  return url.origin === ORIGIN && url.pathname === API + endpoint && value.request().method() === method
    && Object.entries(query).every(([key, expected]) => url.searchParams.get(key) === String(expected));
}

async function data(response) {
  const raw = await response.json();
  assert(response.ok(), `HTTP ${response.status()}: ${JSON.stringify(raw)}`);
  assert.equal(raw.code, 0, JSON.stringify(raw));
  return raw.data;
}
const waitRead = (c, endpoint, query = {}, extra = () => true) => c.page.waitForResponse(
  value => matches(value, endpoint, 'GET', query) && extra(value), { timeout: c.timeout },
).then(response => data(response));

async function until(c, read, predicate, message, timeout = c.timeout) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    assert.equal(c.prohibited.length, 0, JSON.stringify(c.prohibited));
    if (c.storageError) throw c.storageError;
    value = await read(); if (predicate(value)) return value;
    await pause(100);
  } while (Date.now() < deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}
const enabled = (c, control) => until(c, () => control.isEnabled(), value => value, 'UI control remained disabled');
async function drawer(c, title) {
  const scope = c.page.locator('.p-drawer:visible').filter({ has: c.page.getByText(title, { exact: true }) });
  await scope.waitFor({ state: 'visible', timeout: c.timeout }); assert.equal(await scope.count(), 1); return scope;
}
async function decision(c, title, answer) {
  const modal = c.page.getByRole('dialog', { name: title, exact: true });
  await modal.waitFor({ state: 'visible', timeout: c.timeout }); await B(modal, answer).click();
}

function oldIdentity(state) {
  return { scenarioId: state.scenarioId, versionId: state.versionId, runId: state.runId, changeId: state.changeId,
    reportHash: state.reportHash, operations: state.operations, publishedVersionId: state.publishedVersionId,
    rolledBackVersionId: state.rolledBackVersionId };
}

async function environment(input, work) {
  for (const helper of ['login', 'record', 'download', 'shot']) assert.equal(typeof input[helper], 'function');
  assert.equal(input.taskId, TASK); assert.equal(input.planId, PLAN, 'Pass the frozen current parent V2, never the original V1');
  const dir = typeof input.runtime === 'string' ? input.runtime : input.runtime?.dir;
  assert(dir && /^F:[\\/]/i.test(dir));
  const manifest = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
  assert.equal(manifest.frontend, ORIGIN); assert.equal(manifest.api, 'http://127.0.0.24:8124');
  assert.equal(path.basename(dir), 'r4-f79ea5c1b6c54e38ae495d840c142013');
  assert.equal(manifest.database_url, 'sqlite:///F:/work/project2026-1/data/runtime/tmp/r4-f79ea5c1b6c54e38ae495d840c142013/workspace.sqlite');
  assert(input.page.url() === 'about:blank' || new URL(input.page.url()).origin === ORIGIN);
  const originalFile = path.join(dir, 'r6-browser-sr56-state.json');
  const original = JSON.parse(await readFile(originalFile, 'utf8'));
  assert.equal(original.runId, OLD_RUN); assert.equal(original.changeId, OLD_CR); assert.equal(original.rolledBackVersionId, VERSION);
  const originalHash = hash(oldIdentity(original)), file = path.join(dir, 'r6-browser-sr56-remaining-state.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state ??= { schema: 1, origin: ORIGIN, taskId: TASK, planId: PLAN, resourceRevision: RESOURCE, publishedVersionId: VERSION,
    tag: `R6-REM-${randomUUID()}`, originalHash, operations: {}, scenarios: {}, checks: {} };
  assert.deepEqual([state.schema, state.origin, state.taskId, state.planId, state.resourceRevision, state.publishedVersionId, state.originalHash],
    [1, ORIGIN, TASK, PLAN, RESOURCE, VERSION, originalHash]);
  const c = { ...input, dir, file, state, timeout: input.runtime?.timeoutMs ?? 120000,
    prohibited: [], writes: [], responses: [], pendingResponses: new Set(), results: [] };
  let chain = Promise.resolve();
  c.save = () => {
    const bytes = JSON.stringify(state, null, 2) + '\n';
    const writing = chain.then(async () => { await writeFile(file + '.pending', bytes, 'utf8'); await rename(file + '.pending', file); });
    chain = writing.catch(error => { c.storageError ??= error; }); return writing;
  };
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.origin !== ORIGIN || !url.pathname.startsWith(API + '/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
      || url.pathname.startsWith(API + '/auth/')) return;
    const row = { method: request.method(), path: url.pathname, at: new Date().toISOString() };
    // Preflight/validate are observed real business reads, not scenario commits.
    if ([API + F + '/import-preview', API + F + '/validate'].includes(url.pathname)) { c.writes.push({ ...row, preflightOnly: true }); return; }
    const payload = request.postDataJSON(); c.writes.push({ ...row, requestId: payload?.requestId });
    let key = c.armed?.endpoint === url.pathname.slice(API.length) && !c.armed.sent ? c.armed.key : null;
    if (!key && url.pathname === API + F + '/actions/impact' && payload.runId) {
      const owner = [['cancel', 'q04'], ['cancel-immediate', 'q04-immediate']].find(([scene, prefix]) =>
        payload.runId === (state.scenarios[scene]?.runId ?? state.operations[`${prefix}-submit`]?.receipt?.objectId)
        && !state.operations[`${prefix}-auto-impact`]);
      if (owner) { key = `${owner[1]}-auto-impact`; state.operations[key] = { endpoint: F + '/actions/impact', phase: 'armed', automaticUi: true }; }
    }
    if (!key || request.method() !== 'POST') { c.prohibited.push(row); return; }
    if (key === c.armed?.key) c.armed.sent = true;
    const op = state.operations[key]; op.phase = 'sent'; op.request = payload; op.requestId = payload.requestId;
    op.sentAt = row.at; void c.save().catch(() => {});
  };
  const onResponse = response => {
    const url = new URL(response.url());
    if (url.origin !== ORIGIN || ![API + F, API + K].some(prefix => url.pathname.startsWith(prefix))) return;
    const promise = (async () => {
      const raw = await response.json().catch(() => null);
      const entry = { path: url.pathname.slice(API.length), query: Object.fromEntries(url.searchParams),
        method: response.request().method(), status: response.status(), raw, data: raw?.data, at: Date.now(),
        document: response.request().headers().referer ?? '' };
      c.responses.push(entry);
      if (entry.method !== 'POST') return;
      const body = response.request().postDataJSON();
      const op = Object.values(state.operations).find(value => value.endpoint === entry.path && value.requestId === body?.requestId);
      if (op) { op.phase = response.ok() && raw?.code === 0 ? 'accepted' : 'response-rejected'; op.receipt = raw?.data;
        op.response = { http: entry.status, code: raw?.code, message: raw?.message }; await c.save(); }
    })();
    c.pendingResponses.add(promise); void promise.catch(error => { c.storageError ??= error; }).finally(() => c.pendingResponses.delete(promise));
  };
  await input.login('editor'); input.page.on('request', onRequest); input.page.on('response', onResponse);
  c.test = async (id, action) => {
    const detail = await input.record(id, async () => {
      if (c.storageError) throw c.storageError;
      const writeIndex = c.writes.length;
      let value;
      try { value = await action(); }
      catch (error) {
        await Promise.all([...c.pendingResponses]);
        if (typeof c.evidence === 'string') await writeFile(path.join(c.evidence, id + '-catalog-http.json'), JSON.stringify({
          documentMarker: c.documentMarker, scenarios: c.responses.filter(row => row.path === F + '/catalog/scenarios'),
          archiveOperations: Object.fromEntries(Object.entries(state.operations).filter(([key]) => key.startsWith('q03-'))),
          knowledge: c.responses.filter(row => row.path.startsWith(K + '/browse/') || row.path.startsWith(K + '/history/')),
          immediate: { outcome: state.cancelImmediateCoverage, scenario: state.scenarios['cancel-immediate'],
            operations: Object.fromEntries(Object.entries(state.operations).filter(([key]) => key.startsWith('q04-immediate'))),
            responses: c.responses.filter(row => state.scenarios['cancel-immediate']?.runId
              && row.path.startsWith(`${F}/runs/${state.scenarios['cancel-immediate'].runId}/`)) },
        }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        throw error;
      }
      await Promise.all([...c.pendingResponses]); await chain;
      assert.equal(c.prohibited.length, 0, JSON.stringify(c.prohibited)); if (c.storageError) throw c.storageError;
      state.checks[id] = value; await c.save();
      return { ...value, writes: c.writes.slice(writeIndex), checkpoint: file };
    }); c.results.push({ id, detail }); return detail;
  };
  try {
    await c.save(); await work(c);
    assert.equal(hash(oldIdentity(JSON.parse(await readFile(originalFile, 'utf8')))), originalHash, 'Original FR/CR checkpoint changed');
    return { checkpoint: file, results: c.results, operations: state.operations, scenarios: state.scenarios,
      cancelCoverage: state.cancelCoverage ?? 'NOT_RUN', cancelImmediateCoverage: state.cancelImmediateCoverage ?? 'NOT_RUN',
      originalRunUntouched: OLD_RUN, originalChangeUntouched: OLD_CR };
  } finally {
    input.page.off('request', onRequest); input.page.off('response', onResponse);
    await Promise.all([...c.pendingResponses]); await chain; if (c.storageError) throw c.storageError;
  }
}

async function route(c, kind, role = 'editor') {
  await c.login(role);
  const endpoint = kind === 'diagnosis' ? F : K, marker = randomUUID();
  c.documentMarker = marker;
  const own = response => {
    const referer = response.request().headers().referer;
    return !!referer && new URL(referer).searchParams.get('r6remaining') === marker;
  };
  const [metadata, identity] = await Promise.all([waitRead(c, endpoint, {}, own), waitRead(c, '/auth/session', {}, own),
    c.page.goto(`${ORIGIN}/?r6remaining=${marker}#/${kind}`, { waitUntil: 'domcontentloaded', timeout: c.timeout })]);
  assert(identity.account_id && !identity.integration_mode); c.actor = identity.account_id;
  await enabled(c, B(c.page, '重新加载'));
  if (kind === 'diagnosis') {
    const source = metadata.sources.plans.find(value => value.id === PLAN);
    assert(source?.canCreate, 'Frozen parent V2 must still be a legal current diagnosis source');
    assert.equal(source.taskId, TASK);
  } else {
    assert.equal(metadata.workspace.currentVersionId, VERSION, 'Never move the published KGV-3 pointer');
    c.metadata = metadata;
  }
  return metadata;
}

async function oneWrite(c, key, endpoint, action, verify, expectedRejection = false, { waitForReads = true } = {}) {
  const previous = c.state.operations[key];
  if (previous) {
    assert.equal(previous.phase, expectedRejection ? 'expected-rejected' : 'accepted',
      `Keep original ${key}/${previous.requestId}; do not retry an uncertain/rejected write`);
    return previous.receipt;
  }
  const op = c.state.operations[key] = { endpoint, phase: 'armed', at: new Date().toISOString() };
  await c.save(); c.armed = { key, endpoint, sent: false };
  const response = c.page.waitForResponse(value => matches(value, endpoint, 'POST'), { timeout: c.timeout }).then(async value => {
    const raw = await value.json();
    await until(c, async () => op.requestId, Boolean, 'Original requestId not observed');
    verify(op.request);
    if (waitForReads) await Promise.all([...c.pendingResponses]);
    if (expectedRejection) {
      assert.equal(value.status(), 422); assert.equal(raw.code, 1001); assert.match(raw.message, /意见/);
      op.phase = 'expected-rejected'; op.receipt = raw.data ?? null; op.response = { http: 422, code: raw.code, message: raw.message };
    } else { assert(value.ok(), JSON.stringify(raw)); assert.equal(raw.code, 0, JSON.stringify(raw)); op.phase = 'accepted'; op.receipt = raw.data; }
    await c.save(); return op.receipt;
  });
  try { const [receipt] = await Promise.all([response, action()]); assert(c.armed.sent); return receipt; }
  finally { c.armed = null; }
}

// Read a real downloaded template, preserving actual headers and legal sample fields.
function csvRows(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [], row = []; let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\n' && !quoted) { row.push(cell.replace(/\r$/, '')); rows.push(row.splice(0)); cell = ''; }
    else cell += char;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  assert(!quoted, 'Malformed downloaded CSV'); return rows.filter(value => value.some(Boolean));
}
const csv = rows => rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';

async function importDrawer(c) {
  await enabled(c, B(c.page, '导入场景')); await B(c.page, '导入场景').click();
  const scope = await drawer(c, '导入故障场景'); await select(scope, '绑定当前有效方案').selectOption(PLAN); return scope;
}
async function template(c, scope) {
  if (!c.state.template) {
    const file = await c.download(() => B(scope, 'CSV 模板').click(), 'R6-REM-Q03-template-csv');
    const rows = csvRows(await readFile(file.file, 'utf8'));
    assert.deepEqual(rows[0], ['scenario_key', 'scenario_name', 'description', 'object_type', 'object_id', 'fault_type', 'symptom_ids', 'occur_time', 'interference_id']);
    assert(rows[1]?.[4] && rows[1][3] === 'DEVICE' && rows[1][5] === 'HW_FAILURE');
    c.state.template = { file, headers: rows[0], sample: rows[1] }; await c.save();
  }
  return c.state.template;
}
async function preflight(c, scope, name, rows) {
  const waiting = c.page.waitForResponse(value => matches(value, F + '/import-preview', 'POST'), { timeout: c.timeout }).then(value => data(value));
  const [preview] = await Promise.all([waiting, scope.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv(rows), 'utf8') })]);
  await until(c, () => scope.innerText(), text => !text.includes('正在读取与预检'), 'Import preview not settled'); return preview;
}
async function imported(c, key, invalid = false) {
  const known = c.state.scenarios[key];
  if (known?.scenarioId) return known;
  const previous = c.state.operations[`${key}-import`];
  if (previous) {
    assert.equal(previous.phase, 'accepted', 'Keep the original import request; do not repeat it');
    assert.equal(previous.receipt.entityIds.length, 2); assert.equal(previous.request.drafts.length, 1);
    const draft = previous.request.drafts[0];
    c.state.scenarios[key] = { name: draft.name, scenarioId: previous.receipt.entityIds[0], versionId: previous.receipt.entityIds[1], draft };
    await c.save(); return c.state.scenarios[key];
  }
  const scope = await importDrawer(c), source = await template(c, scope);
  const legal = [...source.sample]; legal[0] = key; legal[1] = `${c.state.tag}-${key}`; legal[2] = '本轮构造浏览器验收，非实测；不改变资源或规划';
  if (invalid && !c.state.checks.invalidImport) {
    const bad = [...legal]; bad[4] = `R6-NO-SUCH-DEVICE-${c.state.tag}`;
    const preview = await preflight(c, scope, 'r6-invalid.csv', [source.headers, bad]);
    assert(preview.issues.length > 0); assert.equal(await B(scope, '整批导入').isEnabled(), false);
    c.state.checks.invalidImport = { issues: preview.issues, commitEnabled: false, commitPosts: 0 }; await c.save();
  }
  const preview = await preflight(c, scope, `r6-${key}-valid.csv`, [source.headers, legal]);
  assert.deepEqual(preview.issues, []); assert.equal(preview.drafts.length, 1); assert.equal(preview.drafts[0].planId, PLAN);
  assert.equal(preview.drafts[0].faults[0].objectId, source.sample[4]);
  await enabled(c, B(scope, '整批导入'));
  const receipt = await oneWrite(c, `${key}-import`, F + '/actions/import', () => B(scope, '整批导入').click(), request => {
    assert.deepEqual(request.drafts, preview.drafts); assert(request.drafts.every(draft => draft.planId === PLAN));
  });
  assert.equal(receipt.entityIds.length, 2);
  c.state.scenarios[key] = { name: legal[1], scenarioId: receipt.entityIds[0], versionId: receipt.entityIds[1], draft: preview.drafts[0] };
  await c.save(); await scope.waitFor({ state: 'hidden', timeout: c.timeout }); return c.state.scenarios[key];
}
async function openVersion(c, own) {
  const marker = randomUUID(), query = { scenarioId: own.scenarioId, versionId: own.versionId };
  c.documentMarker = marker;
  const response = waitRead(c, F + '/version', query, value => (value.request().headers().referer ?? '').includes(marker));
  const [value] = await Promise.all([response, c.page.goto(`${ORIGIN}/?r6remaining=${marker}#/diagnosis?${new URLSearchParams(query)}`, { waitUntil: 'domcontentloaded', timeout: c.timeout })]);
  await enabled(c, B(c.page, '重新加载'));
  assert.equal(value.scenarioId, own.scenarioId); assert.equal(value.id, own.versionId); assert.equal(value.planId, PLAN);
  assert.equal(value.network.id, PLAN); assert.equal(value.network.taskId, TASK); assert.equal(value.network.state, 'CONFIRMED'); assert.equal(value.network.sourceChanged, false);
  assert.deepEqual(value.faults, own.draft.faults);
  const frozenHash = hash(versionContent(value));
  if (own.versionHash) assert.equal(frozenHash, own.versionHash, 'Imported original version changed');
  own.versionHash ??= frozenHash; await c.save(); return value;
}
async function scenarioCard(c, own, archived) {
  const list = c.page.locator('.scenario-list'), toggle = list.getByLabel('归档', { exact: true });
  // A write receipt precedes the component's auth checks/list refresh/finally.
  // Do not start another catalog read while that write still owns the page lock.
  await enabled(c, B(c.page, '重新加载'));
  if (await toggle.isChecked() !== archived) {
    await Promise.all([waitRead(c, F + '/catalog/scenarios', { archived }), toggle.setChecked(archived)]);
  }
  const card = list.locator('.scene-card').filter({ has: c.page.getByText(own.name, { exact: true }) });
  for (let i = 0; i < 50; i++) {
    const ready = await until(c, async () => {
      const response = c.responses.filter(row => row.path === F + '/catalog/scenarios' && row.method === 'GET'
        && row.query.archived === String(archived) && row.document.includes(c.documentMarker)).at(-1);
      const error = list.locator('.list-error').filter({ hasText: '场景目录读取失败' });
      const errorText = await error.count() ? await error.innerText() : '';
      const dto = response?.status === 200 && response.raw?.code === 0 ? response.data : null;
      let applied = false;
      if (dto && Array.isArray(dto.items) && await list.locator('.scene-card').count() === dto.items.length) {
        applied = true;
        for (const item of dto.items) if (await list.locator('.scene-card').filter({
          has: c.page.getByText(item.versions.at(-1).name, { exact: true }),
        }).count() !== 1) { applied = false; break; }
      }
      return { applied, errorText, dto, cardCount: await card.count() };
    }, value => !!value.errorText || value.applied, 'Current catalog response was not applied to the DOM');
    assert.equal(ready.errorText, '', 'Scenario catalog UI rejected its response');
    assert(ready.dto, 'A current-document real catalog DTO is required');
    c.state.checks.lastScenarioCatalog = { archived, pageNum: ready.dto.pageNum, total: ready.dto.total,
      expectedScenarioId: own.scenarioId, items: ready.dto.items, domApplied: true };
    await c.save();
    if (await card.count()) {
      assert.equal(await card.count(), 1);
      assert(ready.dto.items.some(item => item.id === own.scenarioId && item.archived === archived));
      assert.equal(await card.getByLabel('查看场景版本', { exact: true }).inputValue(), own.versionId);
      return card;
    }
    assert(ready.dto.pageNum * ready.dto.pageSize < ready.dto.total, 'Original scenario absent from the completed real catalog; do not import again');
    const next = B(list, '下页'); assert(await next.count() && await next.isEnabled(), 'Original scenario is absent; do not import again');
    await Promise.all([waitRead(c, F + '/catalog/scenarios', { archived }), next.click()]);
  }
  assert.fail('Scenario catalog exceeded bounded paging');
}

export async function runSr5ScenarioLifecycle(input) {
  return environment(input, async c => {
    await c.test('R6-REM-Q03-import-preflight-commit', async () => {
      await route(c, 'diagnosis'); const own = await imported(c, 'lifecycle', true); const version = await openVersion(c, own);
      return { ...own, version: version.version, invalidPreflight: c.state.checks.invalidImport, template: c.state.template.file };
    });
    for (const archived of [true, false]) await c.test(`R6-REM-Q03-${archived ? 'archive' : 'restore'}-original`, async () => {
      const own = c.state.scenarios.lifecycle, key = archived ? 'q03-archive' : 'q03-restore';
      if (archived && c.state.operations['q03-restore']?.phase === 'accepted') {
        const version = await openVersion(c, own); assert.equal(version.scenarioArchived, false);
        return { scenarioId: own.scenarioId, versionId: own.versionId, archiveAlreadyVerified: true, restored: true, replayed: false };
      }
      if (!c.state.operations[key]) {
        const card = await scenarioCard(c, own, !archived);
        await oneWrite(c, key, F + '/actions/archive', async () => {
          await B(card, archived ? '归档' : '恢复').click(); await decision(c, archived ? '归档场景' : '恢复场景', archived ? '归档' : '恢复');
        }, request => { assert.equal(request.scenarioId, own.scenarioId); assert.equal(request.archived, archived); });
      } else assert.equal(c.state.operations[key].phase, 'accepted');
      await scenarioCard(c, own, archived); const version = await openVersion(c, own);
      assert.equal(version.scenarioArchived, archived); return { scenarioId: own.scenarioId, versionId: own.versionId, archived, versionHash: own.versionHash };
    });
  });
}

// Exact accepted Q03 continuation: read original archive, then first restore only.
// No calls to template/import or archive(true); never recreate the original IDs.
export async function resumeSr5ScenarioLifecycle(input) {
  return environment(input, async c => {
    const own = c.state.scenarios.lifecycle;
    assert.equal(own?.scenarioId, 'FS-919E180360824499'); assert.equal(own.versionId, 'FSV-7D252EEBEA1D45A3');
    assert.equal(c.state.operations['lifecycle-import']?.phase, 'accepted');
    assert.equal(c.state.operations['lifecycle-import'].requestId, '8bf4b917-3a31-4e01-b819-cc0baef234bc');
    assert.equal(c.state.operations['q03-archive']?.phase, 'accepted');
    assert.equal(c.state.operations['q03-archive'].requestId, '557792a7-ba80-4ec6-b22f-fdaecad61c9d');
    const protectedOperations = hash({ imported: c.state.operations['lifecycle-import'], archived: c.state.operations['q03-archive'] });
    await c.test('R6-REM-Q03-resume-original-archive-readback', async () => {
      await route(c, 'diagnosis');
      const restored = c.state.operations['q03-restore']?.phase === 'accepted';
      await scenarioCard(c, own, !restored);
      const version = await openVersion(c, own); assert.equal(version.scenarioArchived, !restored);
      return { scenarioId: own.scenarioId, versionId: own.versionId, archived: version.scenarioArchived,
        versionHash: own.versionHash, readOnly: true, alreadyRestored: restored };
    });
    await c.test('R6-REM-Q03-resume-first-restore-only', async () => {
      if (!c.state.operations['q03-restore']) {
        const card = await scenarioCard(c, own, true);
        await oneWrite(c, 'q03-restore', F + '/actions/archive', async () => {
          await B(card, '恢复').click(); await decision(c, '恢复场景', '恢复');
        }, request => { assert.equal(request.scenarioId, own.scenarioId); assert.equal(request.archived, false); });
      } else assert.equal(c.state.operations['q03-restore'].phase, 'accepted', 'Inspect original restore request; do not retry it');
      await scenarioCard(c, own, false); const version = await openVersion(c, own); assert.equal(version.scenarioArchived, false);
      assert.equal(hash({ imported: c.state.operations['lifecycle-import'], archived: c.state.operations['q03-archive'] }), protectedOperations);
      return { scenarioId: own.scenarioId, versionId: own.versionId, archived: false, versionHash: own.versionHash,
        restoreRequestId: c.state.operations['q03-restore'].requestId, importReplayed: false, archiveReplayed: false };
    });
  });
}

function latest(c, endpoint) { return c.responses.filter(row => row.path === endpoint && row.status === 200 && row.raw?.code === 0).at(-1)?.data; }
async function openOwnedRun(c, own) {
  await route(c, 'diagnosis');
  const history = c.page.locator('button.history-card').filter({ has: c.page.getByText(own.name, { exact: true }) });
  await history.waitFor({ state: 'visible', timeout: c.timeout }); assert.equal(await history.count(), 1);
  const [detail] = await Promise.all([waitRead(c, `${F}/runs/${own.runId}/detail`), history.click()]);
  assert.equal(detail.run.id, own.runId); assert.equal(detail.run.scenario.id, own.versionId); return detail;
}
export async function runSr5CancelWindow(input) {
  return environment(input, async c => {
    await c.test('R6-REM-Q04-independent-scenario', async () => {
      await route(c, 'diagnosis'); const own = await imported(c, 'cancel'); await openVersion(c, own); return own;
    });
    await c.test('R6-REM-Q04-single-natural-window', async () => {
      const own = c.state.scenarios.cancel;
      const resuming = !!c.state.operations['q04-submit'];
      const receipt = await oneWrite(c, 'q04-submit', F + '/actions/submit', () => B(c.page, '开始诊断').click(), request => assert.equal(request.scenarioVersionId, own.versionId));
      own.runId ??= receipt.objectId; assert.notEqual(own.runId, OLD_RUN); await c.save();
      if (resuming) await openOwnedRun(c, own);
      const progressPath = `${F}/runs/${own.runId}/progress`, detailPath = `${F}/runs/${own.runId}/detail`;
      if (!c.state.operations['q04-cancel']) {
        await until(c, async () => ({ progress: latest(c, progressPath), cancel: await B(c.page.locator('.progress-panel'), '取消任务').isVisible() }),
          value => value.progress && (value.cancel || ['SUCCESS', 'FAILED', 'CANCELLED'].includes(value.progress.state)), 'No actual original-run progress');
        const progress = latest(c, progressPath); assert.notEqual(progress.state, 'FAILED');
        if (progress.state === 'SUCCESS') {
          c.state.cancelCoverage = 'NOT_EXECUTED_NATURAL_SUCCESS'; await c.save();
          return { runId: own.runId, cancelVerified: false, outcome: c.state.cancelCoverage, state: progress.state, noSecondSubmission: true };
        }
        const cancel = B(c.page.locator('.progress-panel'), '取消任务'); await enabled(c, cancel); await cancel.click();
        await decision(c, '取消诊断', '取消');
        assert.equal(c.writes.filter(row => row.path === API + F + '/actions/cancel').length, 0, 'Dialog cancellation must not POST');
        if (!await cancel.isVisible() || latest(c, progressPath)?.state === 'SUCCESS') {
          c.state.cancelCoverage = 'NOT_CONFIRMED_NATURAL_COMPLETION'; await c.save();
          return { runId: own.runId, cancelVerified: false, outcome: c.state.cancelCoverage, dialogCancelVerified: true, noSecondSubmission: true };
        }
        await oneWrite(c, 'q04-cancel', F + '/actions/cancel', async () => { await cancel.click(); await decision(c, '取消诊断', '确认取消'); }, request => assert.equal(request.runId, own.runId));
      } else assert.equal(c.state.operations['q04-cancel'].phase, 'accepted');
      const detail = await until(c, async () => latest(c, detailPath), value => value?.state === 'CANCELLED', 'Accepted cancel needs original detail readback');
      assert.equal(detail.run.id, own.runId); assert(detail.run.diagnoseTaskId); assert.equal(detail.run.scenario.id, own.versionId);
      assert.equal(hash(versionContent(detail.run.scenario)), own.versionHash, 'Cancellation changed the frozen input');
      await until(c, () => c.page.locator('.progress-panel').innerText(), text => text.includes('已取消'), 'CANCELLED not rendered');
      c.state.cancelCoverage = 'CANCELLED_CONFIRMED'; await c.save();
      return { runId: own.runId, diagnosisTaskId: detail.run.diagnoseTaskId, impactTaskId: detail.run.impactTaskId,
        state: detail.state, frozenVersionHash: own.versionHash, cancelVerified: true, automaticImpact: c.state.operations['q04-auto-impact'] ?? null };
    });
  });
}

// One additional natural cancellation window. Never replay the completed Q04
// run, wait for a progress response, or dismiss/reopen the confirmation dialog.
export async function runSr5CancelImmediate(input) {
  return environment(input, async c => {
    assert(!c.state.operations['q04-immediate-submit'], 'Immediate attempt already owns an original request; inspect it read-only, never resubmit');
    assert(!c.state.operations['q04-immediate-cancel'], 'Never repeat the immediate cancellation request');
    await c.test('R6-REM-Q04-immediate-independent-scenario', async () => {
      assert(c.state.template?.sample?.[4], 'Reuse the original downloaded real template sample');
      await route(c, 'diagnosis');
      const own = await imported(c, 'cancel-immediate');
      assert.notEqual(own.scenarioId, c.state.scenarios.cancel?.scenarioId);
      assert.equal(own.draft.faults.length, 1); assert.equal(own.draft.faults[0].objectId, c.state.template.sample[4]);
      await openVersion(c, own); return { ...own, constructed: true, template: c.state.template.file, noArtificialDelay: true };
    });
    await c.test('R6-REM-Q04-immediate-single-confirm', async () => {
      const own = c.state.scenarios['cancel-immediate'];
      const receipt = await oneWrite(c, 'q04-immediate-submit', F + '/actions/submit', () => B(c.page, '开始诊断').click(),
        request => assert.equal(request.scenarioVersionId, own.versionId), false, { waitForReads: false });
      own.runId = receipt.objectId; assert(own.runId && own.runId !== OLD_RUN && own.runId !== c.state.scenarios.cancel?.runId);
      c.state.cancelImmediateCoverage = 'SUBMITTED_UNVERIFIED';
      await c.save(); // Preserve the original FR before the sole cancel; no screenshot/GET wait here.
      const panel = c.page.locator('.progress-panel'), cancel = B(panel, '取消任务');
      const ready = await until(c, async () => ({
        ready: await cancel.count() === 1 && await cancel.isVisible() && await cancel.isEnabled(),
        title: await panel.count() ? await panel.locator('.title strong').innerText() : '',
      }), value => value.ready || /^(已完成|执行失败|已取消)\s*·/.test(value.title), 'No actual enabled cancel control or terminal UI');
      if (!ready.ready) {
        c.state.cancelImmediateCoverage = ready.title.startsWith('已完成') ? 'NOT_CANCELLED_NATURAL_SUCCESS' : 'NOT_CANCELLED_TERMINAL_UI';
        c.state.cancelImmediateEvidence = { runId: own.runId, cancelVerified: false, title: ready.title,
          progress: latest(c, `${F}/runs/${own.runId}/progress`) ?? null, cancelPosts: 0, noFurtherScenario: true };
        await c.save(); assert.fail(`Immediate cancellation not covered: ${c.state.cancelImmediateCoverage}; retain ${own.runId}, no third scenario`);
      }
      try {
        await oneWrite(c, 'q04-immediate-cancel', F + '/actions/cancel', async () => {
          await cancel.click(); await decision(c, '取消诊断', '确认取消');
        }, request => assert.equal(request.runId, own.runId), false, { waitForReads: false });
      } catch (error) {
        await Promise.all([...c.pendingResponses]);
        const original = c.state.operations['q04-immediate-cancel'];
        if (original?.response?.http === 409 && original.response.code === 1203 && /已完成的完整分析不能取消/.test(original.response.message)) {
          c.state.cancelImmediateCoverage = 'NOT_CANCELLED_NATURAL_409';
          c.state.cancelImmediateEvidence = { runId: own.runId, requestId: original.requestId,
            response: original.response, cancelVerified: false, noFurtherScenario: true };
          await c.save();
        }
        throw error; // A natural 409 remains a failed cancellation proof, never a PASS/retry.
      }
      const detail = await until(c, async () => latest(c, `${F}/runs/${own.runId}/detail`),
        value => value?.state === 'CANCELLED', 'Accepted immediate cancel needs original real detail readback');
      assert.equal(detail.run.id, own.runId); assert.equal(detail.run.scenario.id, own.versionId); assert(detail.run.diagnoseTaskId);
      assert.equal(hash(versionContent(detail.run.scenario)), own.versionHash, 'Cancellation changed the frozen input');
      await until(c, () => panel.locator('.title strong').innerText(), text => /^已取消\s*·/.test(text), 'Original CANCELLED not rendered');
      assert.equal(c.writes.filter(row => row.path === API + F + '/actions/submit').length, 1);
      assert.equal(c.writes.filter(row => row.path === API + F + '/actions/cancel').length, 1);
      c.state.cancelImmediateCoverage = 'CANCELLED_CONFIRMED';
      c.state.cancelImmediateEvidence = { scenarioId: own.scenarioId, versionId: own.versionId, runId: own.runId,
        diagnosisTaskId: detail.run.diagnoseTaskId, impactTaskId: detail.run.impactTaskId, state: detail.state,
        frozenVersionHash: own.versionHash, cancelVerified: true, submitRequestId: c.state.operations['q04-immediate-submit'].requestId,
        cancelRequestId: c.state.operations['q04-immediate-cancel'].requestId,
        automaticImpact: c.state.operations['q04-immediate-auto-impact'] ?? null };
      await c.save(); return c.state.cancelImmediateEvidence;
    });
  });
}

async function historyItem(c, tab, endpoint, id) {
  await enabled(c, B(c.page, '重新加载'));
  let [page] = await Promise.all([waitRead(c, endpoint), B(c.page, tab).click()]);
  for (let number = 1; number <= Math.max(1, Math.ceil(page.total / page.pageSize)); number++) {
    assert.equal(page.pageNum, number);
    const panel = c.page.locator('.knowledge-panel'), versions = tab === '版本记录';
    const rows = panel.getByRole('row').filter({ has: B(c.page, versions ? '快照与差异' : '查看 / 处理') });
    // 版本页同时展示日志分页，只核对当前历史表的分页条。
    const pager = panel.locator('.panel-body.toolbar').filter({ has: c.page.getByText(
      versions ? `共 ${page.total} 个版本` : `共 ${page.total} 条`, { exact: true }) });
    // PrimeVue table rows mount after the real history DTO is delivered. Match
    // that DTO's page, count and stable raw cells before absence/paging decisions.
    await until(c, async () => {
      if (await pager.count() !== 1 || !await pager.getByText(`第 ${page.pageNum} 页`, { exact: true }).isVisible()
        || await rows.count() !== page.items.length) return false;
      for (const item of page.items) {
        const row = versions ? rows.filter({ has: c.page.getByText(`v${item.number}`, { exact: true }) })
          : rows.filter({ has: c.page.getByRole('cell', { name: item.updatedAt, exact: true }) })
            .filter({ has: c.page.getByRole('cell', { name: String(item.revision), exact: true }) })
            .filter({ has: c.page.getByRole('cell', { name: item.baseVersionId, exact: true }) });
        if (!await row.count()) return false;
      }
      return true;
    }, Boolean, 'Real knowledge history page has not mounted in the table');
    const found = page.items.find(item => item.id === id); if (found) return found;
    assert(number * page.pageSize < page.total, `Original ${id} absent; never recreate it`);
    [page] = await Promise.all([waitRead(c, endpoint), B(pager, '下页').click()]);
  }
}
async function published(c) {
  const summary = await historyItem(c, '版本记录', K + '/history/versions', VERSION);
  const row = c.page.getByRole('row').filter({ has: c.page.getByText(`v${summary.number}`, { exact: true }) });
  await row.waitFor({ state: 'visible', timeout: c.timeout }); assert.equal(await row.count(), 1);
  const [snapshot] = await Promise.all([waitRead(c, K + '/detail/version/' + VERSION), B(row, '快照与差异').click()]);
  assert.equal(snapshot.id, VERSION);
  const snapshotHash = versionHash(snapshot);
  if (c.state.kgSnapshotHash) assert.equal(snapshotHash, c.state.kgSnapshotHash, 'Published KGV-3 content changed');
  c.state.kgSnapshotHash ??= snapshotHash; await c.save();
  const scope = await drawer(c, `知识版本 v${snapshot.number}`);
  await scope.getByText(snapshot.id, { exact: true }).waitFor({ state: 'visible', timeout: c.timeout });
  await enabled(c, B(c.page, '重新加载'));
  // This read-only version drawer has no footer close text. Use its unique
  // PrimeVue header icon's explicit aria label; business draft footers differ.
  const close = scope.locator('.p-drawer-header').getByRole('button', { name: /^(Close|关闭)$/i });
  assert.equal(await close.count(), 1, 'Expected one visible version-drawer header close control');
  assert.match(await close.getAttribute('aria-label') ?? '', /^(Close|关闭)$/i);
  await close.click();
  await scope.waitFor({ state: 'hidden', timeout: c.timeout }); return snapshot;
}
async function browseReady(c) {
  const result = await until(c, async () => ({
    pending: await c.page.locator('.kg-progress').isVisible(),
    enabled: await B(c.page.locator('.kg-search'), '检索').isEnabled(),
    error: await c.page.locator('.kg-stage .kg-error').count() ? await c.page.locator('.kg-stage .kg-error').innerText() : '',
  }), value => !!value.error || (!value.pending && value.enabled), 'Published browse query has not settled in the DOM');
  assert.equal(result.error, '', 'Published browse UI rejected its real response');
}
async function graphApplied(c, graph) {
  await browseReady(c);
  const expected = `显示 ${graph.entities.length} / ${graph.totalNodes} 个节点 · ${graph.relations.length} / ${graph.totalEdges} 条关系`;
  await until(c, () => c.page.locator('.knowledge-canvas .graph-foot').innerText(),
    text => text.replace(/\s+/g, ' ').includes(expected), 'Actual graph DTO counts not rendered');
  await c.page.locator('.knowledge-canvas .canvas').waitFor({ state: 'visible', timeout: c.timeout });
}
async function search(c, query) {
  await browseReady(c);
  await c.page.getByLabel('检索已发布知识', { exact: true }).fill(query);
  const [result] = await Promise.all([waitRead(c, K + '/browse/search', { versionId: VERSION, search: query }), B(c.page.locator('.kg-search'), '检索').click()]);
  assert.equal(result.versionId, VERSION);
  await browseReady(c);
  await until(c, () => c.page.locator('.kg-list-heading').innerText(), text => text.includes(`匹配 ${result.total} 个实体`), 'Actual search total not rendered');
  const count = result.total ? result.items.length : result.similar.length;
  await until(c, () => c.page.locator('.kg-filters button.kg-entity').count(), value => value === count, 'Actual search/recommendation rows not mounted');
  return result;
}

function explorationSeed(snapshot) {
  const neighbors = id => new Set(snapshot.relations.filter(row => row.head === id || row.tail === id).map(row => row.head === id ? row.tail : row.head));
  for (const root of snapshot.entities.filter(entity => /[\u3400-\u9fff]{4}/.test(entity.name) && entity.name.length <= 100)) {
    const firstHop = neighbors(root.id); firstHop.add(root.id);
    const neighborId = [...firstHop].find(id => id !== root.id && [...neighbors(id)].some(next => !firstHop.has(next)));
    if (neighborId) return { rootId: root.id, name: root.name, neighborId };
  }
  assert.fail('No real published Chinese-name entity with an expandable second hop; do not invent graph data');
}

// Read-only geometry derived from actual GET graph entities and the current DOM box.
// Mirrors the current public renderer's ring layout / ECharts centered 80% view.
// Performs one real canvas click, never chart.dispatchAction/evaluate/store access.
async function clickGraphNeighbor(c, graph, rootId, neighborId) {
  await graphApplied(c, graph);
  const host = c.page.locator('.knowledge-canvas .canvas'); await host.scrollIntoViewIfNeeded();
  // Finish the existing graph entry animation only; never delay diagnosis/cancel.
  await pause(1100);
  const box = await host.boundingBox(); assert(box && box.width > 0 && box.height > 0);
  const others = graph.entities.filter(entity => entity.id !== rootId);
  const points = graph.entities.map(entity => {
    if (entity.id === rootId) return { id: entity.id, x: 450, y: 300 };
    const index = others.findIndex(value => value.id === entity.id), ring = Math.floor(index / 12);
    const count = Math.min(12, others.length - ring * 12), angle = (index % 12) / count * Math.PI * 2;
    return { id: entity.id, x: 450 + Math.cos(angle) * (180 + ring * 105), y: 300 + Math.sin(angle) * (160 + ring * 85) };
  });
  const spanX = Math.max(...points.map(point => point.x)) - Math.min(...points.map(point => point.x)) || 2;
  const spanY = Math.max(...points.map(point => point.y)) - Math.min(...points.map(point => point.y)) || 2;
  const scale = 0.8 * Math.min(box.width / spanX, box.height / spanY) * (points.length === 2 ? 0.5 : 0.8);
  const target = points.find(point => point.id === neighborId); assert(target);
  const position = { x: box.width / 2 + (target.x - 450) * scale, y: box.height / 2 + (target.y - 300) * scale };
  assert(position.x > 0 && position.x < box.width && position.y > 0 && position.y < box.height);
  await c.shot('R6-REM-K01-before-neighbor-click');
  const [detail] = await Promise.all([waitRead(c, K + '/browse/entity', { versionId: VERSION, entityId: neighborId }), host.click({ position })]);
  assert.equal(detail.entity.id, neighborId); await browseReady(c);
  await c.page.locator('.kg-detail').getByText(neighborId, { exact: true }).waitFor({ state: 'visible', timeout: c.timeout });
  return { position, detail };
}

export async function runKgPublishedExplore(input) {
  return environment(input, async c => {
    let snapshot, seed;
    await c.test('R6-REM-K01-published-search-relation', async () => {
      await route(c, 'knowledge'); snapshot = await published(c);
      seed = c.state.explorationSeed ?? explorationSeed(snapshot); c.state.explorationSeed ??= seed; await c.save();
      await B(c.page, '图谱浏览').click(); const result = await search(c, seed.name);
      assert(result.total > 0 && result.items.some(entity => entity.id === seed.rootId));
      if (!(await c.page.locator('.kg-detail').innerText()).includes(seed.rootId)) {
        const item = c.page.locator('.kg-filters button.kg-entity').filter({ hasText: seed.rootId }); assert.equal(await item.count(), 1);
        await Promise.all([waitRead(c, K + '/browse/entity', { entityId: seed.rootId }), item.click()]);
      }
      await browseReady(c);
      await c.page.locator('.kg-detail').getByText(seed.rootId, { exact: true }).waitFor({ state: 'visible', timeout: c.timeout });
      await until(c, async () => latest(c, K + '/browse/entity'), value => value?.entity.id === seed.rootId, 'Selected entity response missing');
      const detail = latest(c, K + '/browse/entity'); assert(detail.relations.length > 0);
      const relations = c.page.locator('.kg-detail .kg-related');
      await until(c, () => relations.count(), count => count === detail.relations.length, 'Real entity relation rows not mounted');
      await relations.first().waitFor({ state: 'visible', timeout: c.timeout });
      assert(await relations.count() > 0);
      await relations.first().getByRole('button').first().click();
      await until(c, () => c.page.locator('.kg-detail').innerText(), text => text.includes('关系编号')
        && text.includes(detail.relations[0].id), 'Selected actual relation detail not displayed');
      await c.page.locator('.kg-detail').getByText(detail.relations[0].id, { exact: true }).waitFor({ state: 'visible', timeout: c.timeout });
      return { versionId: VERSION, snapshotHash: c.state.kgSnapshotHash, seed, searchTotal: result.total, relationReadback: true };
    });
    await c.test('R6-REM-K01-canvas-expand-collapse', async () => {
      const before = await until(c, async () => c.responses.filter(row => row.path === K + '/browse/graph'
        && row.query.focusId === seed.rootId && row.data?.entities.some(entity => entity.id === seed.neighborId)).at(-1), Boolean, 'Actual initial one-hop graph missing');
      const clicked = await clickGraphNeighbor(c, before.data, seed.rootId, seed.neighborId);
      await enabled(c, B(c.page, '展开选中实体一跳'));
      const [expanded] = await Promise.all([waitRead(c, K + '/browse/graph', { versionId: VERSION, focusId: seed.rootId }, response =>
        JSON.parse(new URL(response.url()).searchParams.get('expandedIds')).includes(seed.neighborId)), B(c.page, '展开选中实体一跳').click()]);
      assert(expanded.entities.some(entity => !before.data.entities.some(previous => previous.id === entity.id)), 'Actual second-hop expansion must add a real node');
      await graphApplied(c, expanded); await enabled(c, B(c.page, '收起上次展开'));
      const [collapsed] = await Promise.all([waitRead(c, K + '/browse/graph', { versionId: VERSION, focusId: seed.rootId }, response =>
        !JSON.parse(new URL(response.url()).searchParams.get('expandedIds')).includes(seed.neighborId)), B(c.page, '收起上次展开').click()]);
      assert.deepEqual(collapsed.entities.map(entity => entity.id).sort(), before.data.entities.map(entity => entity.id).sort());
      await graphApplied(c, collapsed);
      return { seed, physicalCanvasClick: clicked.position, beforeNodes: before.data.entities.length, expandedNodes: expanded.entities.length,
        collapsedNodes: collapsed.entities.length, relations: expanded.relations.map(relation => relation.id) };
    });
    await c.test('R6-REM-K01-similar-and-empty', async () => {
      // Identifier/frequency-like terms are deliberately excluded by the real
      // similarity service. Select one informative Chinese fixture from this
      // actual published snapshot, independently of the expansion root.
      if (!c.state.similaritySeed) {
        const serialized = JSON.stringify(snapshot.entities);
        const entity = snapshot.entities.find(value => ['Symptom', 'Fault', 'Cause', 'Solution', 'DiagnosisStep'].includes(value.type)
          && /^[\u3400-\u9fff]{4,40}$/.test(value.name) && !serialized.includes(value.name + '验'));
        assert(entity, 'Need one real informative Chinese similarity fixture; never sweep queries');
        c.state.similaritySeed = { entityId: entity.id, name: entity.name, query: entity.name + '验' }; await c.save();
      }
      const fixture = c.state.similaritySeed;
      assert(snapshot.entities.some(entity => entity.id === fixture.entityId && entity.name === fixture.name));
      const query = fixture.query, similar = await search(c, query);
      assert.equal(similar.total, 0, 'Representative typo must be a no-exact-match search'); assert(similar.similar.length > 0, 'Actual published data must produce recommendations');
      await until(c, () => c.page.locator('.kg-filters').innerText(), text => text.includes('相似知识推荐'), 'Similar results not rendered');
      const emptyQuery = `R6-no-match-${c.state.tag}`, empty = await search(c, emptyQuery);
      assert.equal(empty.total, 0); assert.deepEqual(empty.items, []); assert.deepEqual(empty.similar, []);
      await until(c, () => c.page.locator('.kg-filters').innerText(), text => text.includes('暂无相似推荐') && text.includes('匹配 0 个实体'), 'Empty results not rendered');
      assert.equal(c.writes.length, 0);
      await route(c, 'knowledge'); assert.equal(versionHash(await published(c)), c.state.kgSnapshotHash);
      return { fixture, query, recommendationIds: similar.similar.map(entity => entity.id), emptyQuery, emptyCode: empty.code, businessWrites: 0 };
    });
  });
}

async function openOwnChange(c, expectedState) {
  const own = c.state.rejection; assert(own?.changeId && own.changeId !== OLD_CR);
  const summary = await historyItem(c, '知识维护', K + '/history/changes', own.changeId);
  const row = c.page.getByRole('row').filter({ has: c.page.getByText(summary.summary, { exact: true }) });
  await row.waitFor({ state: 'visible', timeout: c.timeout }); assert.equal(await row.count(), 1);
  const [value] = await Promise.all([waitRead(c, K + '/detail/change/' + own.changeId), B(row, '查看 / 处理').click()]);
  assert.equal(value.id, own.changeId); assert.equal(value.content.baseVersionId, VERSION);
  if (expectedState) assert.equal(value.state, expectedState);
  if (own.authorId) assert.equal(value.authorId, own.authorId);
  const scope = await drawer(c, `知识变更 · ${own.changeId}`); await enabled(c, B(scope, '关闭'));
  await until(c, () => scope.getByLabel('变更摘要', { exact: true }).inputValue(), text => text === value.content.summary,
    'Original change content not applied to the visible drawer');
  return { value, scope };
}
async function closeChange(c, scope) { await enabled(c, B(scope, '关闭')); await B(scope, '关闭').click(); await scope.waitFor({ state: 'hidden', timeout: c.timeout }); }
async function submitOwn(c, key, scope) {
  const own = c.state.rejection;
  return oneWrite(c, key, K + '/actions/submit', async () => {
    await enabled(c, B(scope, '提交审核')); await B(scope, '提交审核').click(); await decision(c, '提交审核', '确认送审');
  }, request => assert.equal(request.changeId, own.changeId));
}

export async function runKgRejectRevise(input) {
  return environment(input, async c => {
    await c.test('R6-REM-K03-new-independent-draft', async () => {
      await route(c, 'knowledge'); const snapshot = await published(c);
      const knownSave = c.state.operations['k03-save-first'];
      if (knownSave) {
        assert.equal(knownSave.phase, 'accepted', 'Retain the original create request');
        if (c.state.rejection) assert.equal(c.state.rejection.changeId, knownSave.receipt.entityId, 'Resume the original accepted CR only');
      }
      if (!c.state.rejection && knownSave) {
        assert.equal(knownSave.phase, 'accepted', 'Retain original create request; never recreate a draft');
        c.state.rejection = { changeId: knownSave.receipt.entityId, summary: knownSave.request.draft.summary,
          entityId: knownSave.request.draft.entities[0].id, authorId: knownSave.request.actorId }; await c.save();
      }
      if (!c.state.rejection) {
        const source = snapshot.entities.find(entity => entity.description.length <= 1600); assert(source, 'Need a real editable entity');
        await B(c.page, '新增知识变更').click(); const scope = await drawer(c, '新建知识变更');
        await scope.getByLabel('选择已有实体加入编辑', { exact: true }).selectOption(source.id);
        const summary = `${c.state.tag} 独立驳回修订`;
        await scope.getByLabel('变更摘要', { exact: true }).fill(summary);
        await scope.getByLabel('描述', { exact: true }).fill(source.description + '\n本轮独立构造审核测试，非已发布知识。');
        const receipt = await oneWrite(c, 'k03-save-first', K + '/actions/save', () => B(scope, '保存草稿').click(), request => {
          assert.equal(request.changeId, null); assert.equal(request.draft.baseVersionId, VERSION); assert.equal(request.draft.entities.length, 1);
          assert.equal(request.draft.entities[0].id, source.id); assert.equal(request.draft.summary, summary);
        });
        assert.notEqual(receipt.entityId, OLD_CR); assert.equal(receipt.currentVersionId, VERSION);
        c.state.rejection = { changeId: receipt.entityId, summary, entityId: source.id, authorId: c.actor }; await c.save();
        await closeChange(c, await drawer(c, `知识变更 · ${receipt.entityId}`));
      }
      const current = await openOwnChange(c); assert.equal(current.value.authorId, c.actor);
      await closeChange(c, current.scope); return { ...c.state.rejection, publishedSnapshotHash: c.state.kgSnapshotHash };
    });
    await c.test('R6-REM-K03-submit-first-once', async () => {
      const current = await openOwnChange(c);
      if (!c.state.operations['k03-submit-first']) { assert.equal(current.value.state, 'DRAFT'); await submitOwn(c, 'k03-submit-first', current.scope); }
      else assert.equal(c.state.operations['k03-submit-first'].phase, 'accepted');
      await closeChange(c, current.scope); return { changeId: c.state.rejection.changeId, originalRequestId: c.state.operations['k03-submit-first'].requestId };
    });
    await c.test('R6-REM-K03-review-empty-reject-once', async () => {
      await route(c, 'knowledge', 'reviewer'); let current = await openOwnChange(c);
      assert.notEqual(c.actor, current.value.authorId, 'Use an independent reviewer, never mixed permissions');
      if (!c.state.operations['k03-reject']) {
        assert.equal(current.value.state, 'PENDING'); const before = hash(current.value);
        await current.scope.getByLabel('审核意见（驳回必填）', { exact: true }).fill('');
        await oneWrite(c, 'k03-empty-opinion', K + '/actions/review', () => B(current.scope, '驳回').click(), request => {
          assert.equal(request.changeId, c.state.rejection.changeId); assert.equal(request.approved, false); assert.equal(request.opinion, '');
        }, true);
        await until(c, () => current.scope.innerText(), text => text.includes('驳回须填写意见'), 'Empty-opinion rejection not displayed');
        await closeChange(c, current.scope); current = await openOwnChange(c, 'PENDING'); assert.equal(hash(current.value), before, 'Invalid review changed the draft/submission');
        const opinion = `${c.state.tag} 需补充构造说明后重提`;
        await current.scope.getByLabel('审核意见（驳回必填）', { exact: true }).fill(opinion);
        await oneWrite(c, 'k03-reject', K + '/actions/review', () => B(current.scope, '驳回').click(), request => {
          assert.equal(request.changeId, c.state.rejection.changeId); assert.equal(request.approved, false); assert.equal(request.opinion, opinion);
        });
        await closeChange(c, current.scope); current = await openOwnChange(c, 'REJECTED');
      }
      assert(current.value.submissions.some(item => item.outcome === 'REJECTED' && item.review?.actorId === c.actor && item.review.opinion.includes(c.state.tag)));
      const value = current.value; await closeChange(c, current.scope); return { changeId: value.id, state: value.state, submissions: value.submissions };
    });
    await c.test('R6-REM-K03-author-revise-resubmit-no-publish', async () => {
      await route(c, 'knowledge', 'editor'); let current = await openOwnChange(c);
      assert.equal(c.actor, current.value.authorId);
      if (!c.state.operations['k03-save-revision']) {
        assert.equal(current.value.state, 'REJECTED');
        await current.scope.getByLabel('变更摘要', { exact: true }).fill(c.state.rejection.summary + ' · 已补充');
        const description = current.scope.getByLabel('描述', { exact: true });
        await description.fill((await description.inputValue()) + '\n已按本次独立驳回意见补充，仍未发布。');
        await oneWrite(c, 'k03-save-revision', K + '/actions/save', () => B(current.scope, '保存草稿').click(), request => {
          assert.equal(request.changeId, c.state.rejection.changeId); assert.equal(request.draft.baseVersionId, VERSION);
          assert.equal(request.draft.entities[0].id, c.state.rejection.entityId);
        });
      } else assert.equal(c.state.operations['k03-save-revision'].phase, 'accepted');
      await submitOwn(c, 'k03-submit-second', current.scope);
      await closeChange(c, current.scope); current = await openOwnChange(c, 'PENDING');
      assert.equal(current.value.submissions.at(-1).number, 2); assert.equal(current.value.submissions.at(-1).outcome, 'PENDING');
      assert(current.value.submissions.some(item => item.outcome === 'REJECTED'));
      const final = current.value; await closeChange(c, current.scope);
      await route(c, 'knowledge'); assert.equal(versionHash(await published(c)), c.state.kgSnapshotHash);
      assert.equal(c.writes.filter(row => /\/(publish|rollback)$/.test(row.path)).length, 0);
      return { changeId: final.id, finalState: final.state, submissions: final.submissions,
        currentVersionId: VERSION, publishedSnapshotUnchanged: true, publishCalls: 0, originalChangeUntouched: OLD_CR };
    });
  });
}
