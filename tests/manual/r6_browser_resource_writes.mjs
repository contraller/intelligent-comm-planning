// 只使用主宿主的 Page；资源变更必须在性能及下游验收完成后显式放行。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://127.0.0.24:5324';
const ORIGINS = new Set([ORIGIN, 'http://127.0.0.24:8124']);
const API = '/api/v1';
const enc = encodeURIComponent;
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, text) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escaped(text)}\\s*$`) });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const changedPaths = new Set(['/resource/changes', '/resource/workspace/changes', '/resource/device-availability', '/resource/import/commit']);

function matches(response, method, endpoint) {
  const url = new URL(response.url());
  return ORIGINS.has(url.origin) && response.request().method() === method
    && (endpoint instanceof RegExp ? endpoint.test(url.pathname) : url.pathname === API + endpoint);
}
function mutation(request) {
  const url = new URL(request.url());
  return ORIGINS.has(url.origin) && (request.method() === 'POST' && changedPaths.has(url.pathname.slice(API.length))
    || request.method() === 'PUT' && /^\/api\/v1\/task-inputs\/[^/]+$/.test(url.pathname));
}
function requestBody(request) {
  if (!request.postData()) return null;
  const value = request.postDataJSON();
  if (value?.file?.base64) return { ...value, file: { name: value.file.name, base64_sha256: digest(value.file.base64) } };
  return value;
}
function receipt(value) {
  const r = value.receipt ?? value;
  return { ...r, revision: r.revision, changed: r.changed, readRevision: r.readRevision ?? r.read_revision };
}

const brief = (value, limit = 1024) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : text.slice(0, limit) + `…[另 ${text.length - limit} 字符见独立证据]`;
};
function failureSummary(state, output, error, { caseId, httpStart = 0, evidence = null } = {}) {
  const entries = Object.entries(state.operations), rows = state.http.slice(httpStart);
  const anchors = Object.fromEntries(['maintained_device_id', 'created_device_id', 'imported_device_id',
    'station_id', 'interference_id', 'candidate_id'].filter(key => state.anchors[key] !== undefined)
    .map(key => [key, brief(state.anchors[key], 160)]));
  if (state.anchors.device_source?.id) anchors.device_source_id = brief(state.anchors.device_source.id, 160);
  return { case_id: caseId, error_name: brief(error?.name ?? 'Error', 80), error: brief(error?.message ?? error),
    output, checkpoint: path.join(output, 'resource-writes-state.json'), anchors, failure_evidence: evidence,
    operation_count: entries.length, original_requests: entries.slice(-20).map(([key, op]) => ({
      key: brief(key, 80), phase: brief(op.phase, 48), request_id: brief(op.request?.request_id, 160),
      sent_count: op.sent_count ?? 0, revision: op.response ? brief(receipt(op.response).revision, 64) : undefined,
    })), operations_omitted: Math.max(0, entries.length - 20),
    endpoint_count: rows.length, endpoints: rows.slice(-20).map(row => ({ method: brief(row.method, 12),
      path: brief(row.path, 256), status: row.status, code: brief(row.response?.code, 40) })),
    endpoints_omitted: Math.max(0, rows.length - 20) };
}
function compactFailure(summary) {
  const error = new Error('R6-A resource-write failure: ' + JSON.stringify(summary));
  error.name = 'R6ResourceWriteFailure';
  return error;
}

async function environment(args, work) {
  const { page, runtime, taskId, planId, login, record, download, shot } = args;
  assert(page && runtime && taskId && planId, 'Use the real R6 host Page/runtime/task/plan.');
  for (const helper of [login, record, download, shot]) assert.equal(typeof helper, 'function');
  assert.equal(args.performanceComplete, true, 'Main must confirm performance AND downstream completion before enabling resource writes.');
  assert(page.url() === 'about:blank' || new URL(page.url()).origin === ORIGIN);
  assert.equal(path.dirname(path.resolve(runtime)), path.join(ROOT, 'data/runtime/r2'));
  assert(/^r4-[a-f0-9]{32}$/.test(path.basename(runtime)));
  const runId = args.resourceWritesRunId ?? process.env.R6_RESOURCE_WRITES_RUN_ID;
  assert(runId, 'Main must supply and retain R6_RESOURCE_WRITES_RUN_ID (one GUID) for checkpoint continuity.');
  assert(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId));
  const output = path.join(ROOT, 'data/runtime/r6', runId), file = path.join(output, 'resource-writes-state.json');
  await fs.mkdir(output, { recursive: true });
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { schema: 'r6-resource-writes-v1', run_id: runId, runtime: path.resolve(runtime), taskId, planId,
      tag: 'R6-A-' + runId.slice(0, 8), cases: {}, operations: {}, anchors: {}, http: [] };
  }
  assert.equal(state.schema, 'r6-resource-writes-v1');
  assert.equal(state.runtime, path.resolve(runtime)); assert.equal(state.taskId, taskId); assert.equal(state.planId, planId);
  assert(!Object.values(state.cases).some(value => ['RUNNING', 'FAILED'].includes(value.phase)),
    'Prior incomplete case requires main review before login/navigation; preserve the original Page and request checkpoint.');
  let diskFailure = null, checkpointSequence = 0, checkpointTail = Promise.resolve(), latestFailureEvidence = null;
  const failCheckpoint = error => {
    if (diskFailure) return diskFailure;
    diskFailure = error;
    // 保留最后有效检查点和临时文件；只输出已知原号，不重提或取消在途事务。
    console.error(JSON.stringify({ checkpoint_write_failed: brief(error.code ?? 'WRITE_FAILED', 64),
      ...failureSummary(state, output, error, { evidence: latestFailureEvidence }) }));
    return diskFailure;
  };
  const save = () => {
    if (diskFailure) return Promise.reject(diskFailure);
    // 入列时冻结完整快照，避免后来的 ACK 把尚未写完的 SENT 阶段覆盖。
    let bytes;
    try { bytes = JSON.stringify(state, null, 2); }
    catch (error) { return Promise.reject(failCheckpoint(error)); }
    const temporary = file + '.' + process.pid + '.' + (++checkpointSequence) + '.tmp';
    const pending = checkpointTail.then(async () => {
      if (diskFailure) throw diskFailure;
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', flush: true });
        await fs.rename(temporary, file);
      } catch (error) { throw failCheckpoint(error); }
    });
    // 事件回调不能 await；尾链吸收拒绝，原调用者和门禁仍通过 latch 得到失败。
    checkpointTail = pending.catch(() => {});
    return pending;
  };
  const beforeUiAction = async () => {
    let observed;
    do { observed = checkpointTail; await observed; } while (observed !== checkpointTail);
    if (diskFailure) throw diskFailure;
  };
  await save();
  const writes = [], capture = request => {
    if (mutation(request)) writes.push({ path: new URL(request.url()).pathname, method: request.method(), body: requestBody(request) });
  };
  page.on('request', capture);
  const c = { ...args, output, runId, state, save, writes, revision: null };
  c.drawer = title => page.locator('.p-drawer:visible').filter({ hasText: new RegExp(escaped(title)) })
    .filter({ has: page.locator('.p-drawer-title').filter({ hasText: new RegExp(`^${escaped(title)}$`) }) });
  c.dialog = title => page.getByRole('dialog').filter({ has: page.getByText(title, { exact: true }) });
  c.until = async (check, label, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (diskFailure) throw diskFailure; if (await check()) return; await pause(); }
    throw new Error(label);
  };
  c.data = async (response, received) => {
    const body = await response.json();
    const row = { path: new URL(response.url()).pathname + new URL(response.url()).search, method: response.request().method(),
      status: response.status(), request: requestBody(response.request()), response: body };
    state.http.push(row);
    if (received) received(body, row);
    await save();
    assert([200, 201].includes(row.status) && body?.code === 0 && body?.data, JSON.stringify(row));
    return body.data;
  };
  c.http = async (method, endpoint, action, predicate = () => true, received) => {
    await beforeUiAction();
    const pending = page.waitForResponse(value => matches(value, method, endpoint) && predicate(value), { timeout: 60000 });
    pending.catch(() => {});
    await action(); return c.data(await pending, received);
  };
  c.change = async (key, method, endpoint, action, context) => {
    await beforeUiAction();
    assert(!state.operations[key], `${key} already armed/accepted: keep the original checkpoint and request; do not resubmit automatically.`);
    const op = state.operations[key] = { phase: 'ARMED', before_revision: c.revision, endpoint: String(endpoint),
      at: new Date().toISOString(), sent_count: 0, sent_requests: [] };
    await save();
    const onRequest = request => {
      if (matches({ url: () => request.url(), request: () => request }, method, endpoint)) {
        const actual = requestBody(request);
        op.request ??= actual; op.sent_count++; op.phase = 'SENT';
        op.sent_requests.push({ request_id: actual?.request_id, request: actual, at: new Date().toISOString() });
        // 即刻入列每次真实原号；失败由全局 latch 阻断后续 UI，不抛未处理拒绝。
        save().catch(() => {});
      }
    };
    page.on('request', onRequest);
    try {
      const value = await c.http(method, endpoint, action, undefined, (body, row) => {
        // 原受理回执先与 HTTP 证据一并串行落盘，再做版本、对象或次数断言。
        op.phase = [200, 201].includes(row.status) && body?.code === 0 && body?.data ? 'ACK_RECEIVED' : 'REJECTED_RECEIVED';
        op.response = body?.data ?? null; op.http_status = row.status; op.business_code = body?.code;
        op.response_request_id = row.request?.request_id;
      });
      await beforeUiAction();
      assert.equal(op.sent_count, 1, 'A single explicit UI operation issued multiple writes.');
      assert.equal(typeof op.request?.request_id, 'string'); assert(op.request.request_id.length > 0, 'The actual UI request ID is missing.');
      assert.equal(op.response_request_id, op.request.request_id, 'The receipt must belong to this original UI request.');
      if (context) assert.equal(op.request?.context, context);
      if (op.request?.request_id && value.request_id !== undefined) assert.equal(value.request_id, op.request.request_id);
      if (context) {
        assert.equal(op.request?.base_revision, op.before_revision, 'The actual UI submitted a different base revision.');
        const r = receipt(value); assert.equal(r.changed, true); assert.match(r.revision, /^resource-[a-f0-9]{16}$/);
        assert.notEqual(r.revision, op.before_revision); assert.equal(r.readRevision, r.revision);
        c.revision = r.revision;
      }
      op.phase = 'ACK_VALIDATED'; await save(); return value;
    } catch (error) {
      op.error = error.message; if (op.phase === 'ARMED' || op.phase === 'SENT') op.phase = 'UNCERTAIN_NO_RETRY';
      if (!diskFailure) await save(); throw error;
    } finally { page.off('request', onRequest); }
  };
  c.verified = async key => { await beforeUiAction(); state.operations[key].phase = 'READBACK_CONFIRMED'; await save(); };
  const preserveFailure = async (id, error, start, previousOperations) => {
    const newOperations = Object.entries(state.operations).filter(([key]) => !previousOperations.has(key));
    const originalId = newOperations.at(-1)?.[1].request?.request_id;
    const marker = String(originalId ?? 'no-write-request').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    const evidenceFile = path.join(output, `failure-${id}-${marker}-${crypto.randomUUID()}.json`);
    latestFailureEvidence = { file: evidenceFile, status: 'NOT_WRITTEN' };
    const fullMessage = error instanceof Error ? error.message : String(error);
    state.cases[id] = { phase: 'FAILED', error: fullMessage, failure_evidence: evidenceFile };
    // 原错误及全部业务 HTTP/ops 只写独立文件；不把它们拼回宿主异常或 cause。
    await checkpointTail;
    if (diskFailure) {
      latestFailureEvidence = { file: evidenceFile, status: 'NOT_WRITTEN_DISK_FAILURE', code: brief(diskFailure.code ?? 'WRITE_FAILED', 64) };
    } else {
      try {
        const evidence = { schema: 'r6-resource-write-failure-v1', run_id: runId, case_id: id, verdict: 'FAILED',
          at: new Date().toISOString(), runtime: state.runtime, taskId, planId, checkpoint: file,
          primary_request_id: originalId ?? null, case_operation_keys: newOperations.map(([key]) => key), http_start_index: start,
          original_error: { name: error?.name ?? typeof error, message: fullMessage, stack: error?.stack ?? null,
            details: inspect(error, { depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false }) },
          anchors: state.anchors, cases: state.cases, operations: state.operations, http: state.http, writes };
        await fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2), { encoding: 'utf8', flag: 'wx', flush: true });
        latestFailureEvidence = { file: evidenceFile, status: 'WRITTEN' };
      } catch (failure) {
        latestFailureEvidence = { file: evidenceFile, status: 'WRITE_FAILED_PARTIAL_POSSIBLE', code: brief(failure.code ?? 'WRITE_FAILED', 64) };
        failCheckpoint(failure);
      }
    }
    state.cases[id].failure_evidence_status = latestFailureEvidence.status;
    if (!diskFailure) {
      try { await save(); }
      catch { /* 原始文件已独立保留；检查点失败由 latch 与下方摘要明确回报。 */ }
    }
    const summary = failureSummary(state, output, error, { caseId: id, httpStart: start, evidence: latestFailureEvidence });
    if (diskFailure) summary.checkpoint_write_failed = brief(diskFailure.code ?? 'WRITE_FAILED', 64);
    return compactFailure(summary);
  };
  c.test = async (id, action) => {
    await beforeUiAction();
    assert(!state.cases[id], `${id} already recorded. Main must inspect the original checkpoint, not restart writes with another tag.`);
    state.cases[id] = { phase: 'RUNNING' }; await save();
    return record(id, async () => {
      const start = state.http.length, previousOperations = new Set(Object.keys(state.operations));
      try {
        const detail = await action();
        const png = path.join(output, id + '.png'); await page.screenshot({ path: png, fullPage: true });
        state.cases[id] = { phase: 'PASS', detail, screenshot: png }; await save();
        return { ...detail, output, screenshot: png, anchors: state.anchors, http: state.http.slice(start) };
      } catch (error) {
        throw await preserveFailure(id, error, start, previousOperations);
      }
    });
  };
  let workFailure = null;
  try {
    await record('A-WRITES-environment', async () => ({ output, runId, taskId, planId,
      writes_authorized_by_host: true, warning: 'Changes resource revision; do not run during performance/downstream acceptance.',
      browser_owned_by_host: true, authentication_material_read_by_module: false }));
    await login('editor');
    return await work(c);
  } catch (error) {
    workFailure = error;
    throw error;
  } finally {
    page.off('request', capture);
    try { await beforeUiAction(); await save(); }
    catch (error) {
      const summary = failureSummary(state, output, error, { evidence: latestFailureEvidence });
      summary.checkpoint_finalization_failed = true;
      if (!workFailure) throw compactFailure(summary);
      console.error(JSON.stringify(summary));
    }
  }
}

async function route(c, name) {
  await c.page.goto(`${ORIGIN}/?r6aw=${c.runId}-${Date.now()}#/${name}`, { waitUntil: 'domcontentloaded' });
  await c.page.getByRole('heading', { name: name === 'resources' ? '资源管理' : 'GIS 态势', exact: true, level: 1 }).waitFor({ timeout: 90000 });
}
async function ledger(c) {
  const data = await c.http('GET', '/resource/devices', () => route(c, 'resources'));
  c.revision = data.revision;
  assert.match(c.revision, /^resource-[a-f0-9]{16}$/); assert(Array.isArray(data.items));
  const mode = c.page.getByLabel('状态显示来源', { exact: true });
  if (await mode.count() && await mode.inputValue() !== 'baseline') await mode.selectOption('baseline');
  return data;
}
async function refresh(c, context) {
  const value = await c.http('GET', '/resource/context', () => button(c.page, '刷新资源').click(), response => new URL(response.url()).searchParams.get('context') === context);
  assert.equal(value.revision, c.revision, 'Explicit UI refresh did not return the committed resource revision.');
  return value;
}
async function searchDevice(c, id) {
  const input = c.page.getByLabel('搜索设备', { exact: true });
  if (await input.inputValue() === id) {
    await c.http('GET', '/resource/devices', () => input.fill('R6-RESET-' + c.runId));
  }
  const data = await c.http('GET', '/resource/devices', () => input.fill(id), response => new URL(response.url()).searchParams.get('search') === id);
  assert.equal(data.revision, c.revision); assert(data.items.some(row => row.device_id === id));
  return c.page.locator('tbody tr').filter({ has: c.page.getByText(id, { exact: true }) });
}
async function detail(c, id) {
  const row = await searchDevice(c, id);
  const value = await c.http('GET', '/resource/devices/' + enc(id), () => button(row, '查看详情').click());
  const panel = c.drawer('设备实例详情'); await panel.waitFor({ state: 'visible' });
  await c.until(async () => (await panel.innerText()).includes(id), 'Detail identity missing.');
  assert.equal(value.revision, c.revision); assert.equal(value.item.device_id, id);
  return { panel, value };
}
async function closeRead(panel) {
  if (await panel.isVisible()) { await panel.locator('.p-drawer-close-button').click(); await panel.waitFor({ state: 'hidden' }); }
}
async function closeForm(c, panel) { await button(panel, '关闭').click(); await panel.waitFor({ state: 'hidden' }); }
async function formId(panel, term = '对象 ID（只读）') {
  return (await panel.locator('dt').filter({ hasText: new RegExp(`^${escaped(term)}$`) }).locator('xpath=following-sibling::dd[1]').innerText()).trim();
}
async function openMaintenance(c, id) {
  const d = await detail(c, id);
  const source = await c.http('GET', /^\/api\/v1\/resource\/(maintenance-context|edit-context)$/, () => button(d.panel, '编辑设备参数').click());
  const form = c.drawer('编辑设备参数'); await form.locator('#ledger-device-antennaHeightM').waitFor({ state: 'visible' });
  return { form, source, detail: d.panel };
}

async function maintenance(c) {
  await c.test('A-R03-maintenance-save-discard', async () => {
    const rows = await ledger(c);
    const device = rows.items.find(row => row.availability === 'ACTIVE');
    assert(device, 'No actual active device on the visible ledger page.');
    const id = device.device_id; c.state.anchors.maintained_device_id = id; await c.save();
    const opened = await openMaintenance(c, id), input = opened.form.locator('#ledger-device-antennaHeightM');
    const rawHeight = await input.inputValue(); assert(rawHeight.trim(), 'An unknown height must not be converted to zero.');
    const before = Number(rawHeight); assert(Number.isFinite(before) && before >= 0);
    const height = Number((before + 0.1).toFixed(4)); await input.fill(String(height));
    await c.change('R03-save', 'POST', /^\/api\/v1\/resource\/(changes|workspace\/changes)$/,
      () => button(opened.form, '保存当前设备').click(), 'ledger');
    await c.until(async () => (await opened.form.innerText()).includes('当前没有未保存修改'), 'Maintenance receipt not applied.');
    await closeForm(c, opened.form); await closeRead(opened.detail); await refresh(c, 'ledger');
    const saved = await detail(c, id); assert.equal(saved.value.item.antenna_height_m, height); await closeRead(saved.panel);
    await c.verified('R03-save');
    const edit = await openMaintenance(c, id); await edit.form.locator('#ledger-device-antennaHeightM').fill(String(height + 0.1));
    const start = c.writes.length;
    await button(edit.form, '关闭').click(); const decision = c.dialog('设备参数尚未保存'); await decision.waitFor({ state: 'visible' });
    await button(decision, '继续编辑').click(); await decision.waitFor({ state: 'hidden' });
    assert.equal(Number(await edit.form.locator('#ledger-device-antennaHeightM').inputValue()), height + 0.1);
    await button(edit.form, '关闭').click(); await button(c.dialog('设备参数尚未保存'), '放弃本次修改').click();
    await edit.form.waitFor({ state: 'hidden' }); await closeRead(edit.detail); await refresh(c, 'ledger');
    const unchanged = await detail(c, id); assert.equal(unchanged.value.item.antenna_height_m, height); await closeRead(unchanged.panel);
    assert.equal(c.writes.length, start, 'Discard unexpectedly issued a persistent write.');
    return { id, before_height_m: before, saved_height_m: height, revision: c.revision, discarded_input_not_saved: true };
  });
}

function validDevice(resources) {
  return resources.devices.find(row => row.availability === 'ACTIVE' && Number.isFinite(row.antennaHeightM) && row.antennaHeightM >= 0
    && Number.isFinite(row.txPowerDbm) && resources.models.some(model => model.id === row.modelId && row.txPowerDbm <= model.txPowerMaxDbm
      && (row.workFreqKhz == null || row.workFreqKhz >= model.freqMinKhz && row.workFreqKhz <= model.freqMaxKhz))
    && resources.antennas.some(antenna => antenna.id === row.antennaId)
    && resources.stations.some(node => node.id === row.stationId && node.classes.includes(resources.models.find(model => model.id === row.modelId)?.deviceClass)));
}
async function createDevice(c) {
  await c.test('A-R04-create-device', async () => {
    await ledger(c);
    const source = await c.http('GET', '/resource/edit-context', () => button(c.page, '新增设备').click());
    assert.equal(source.revision, c.revision); assert(source.resources);
    const sample = validDevice(source.resources); assert(sample, 'No actual valid device/model/antenna association to reuse.');
    const panel = c.drawer('新增设备'); await panel.locator('#ledger-device-stationId').waitFor({ state: 'visible' });
    const id = await formId(panel, '设备编号'); assert(!source.resources.devices.some(row => row.id === id));
    await panel.locator('#ledger-device-stationId').selectOption(sample.stationId);
    await panel.locator('#ledger-device-modelId').selectOption(sample.modelId);
    await panel.locator('#ledger-device-antennaId').selectOption(sample.antennaId);
    for (const [field, value] of Object.entries({ antennaHeightM: sample.antennaHeightM, txPowerDbm: sample.txPowerDbm,
      workFreqKhz: sample.workFreqKhz, tiltDeg: sample.tiltDeg, azimuthDeg: sample.azimuthDeg, installedAt: sample.installedAt })) {
      await panel.locator('#ledger-device-' + field).fill(value == null ? '' : String(value));
    }
    c.state.anchors.created_device_id = id; c.state.anchors.device_source = sample; await c.save();
    await c.change('R04-save', 'POST', '/resource/workspace/changes', () => button(panel, '保存当前设备').click(), 'ledger');
    await c.until(async () => (await panel.innerText()).includes('当前没有未保存修改'), 'New device save did not settle.');
    await closeForm(c, panel); await refresh(c, 'ledger');
    const saved = await detail(c, id);
    for (const [field, value] of Object.entries({ node_id: sample.stationId, model_id: sample.modelId, antenna_id: sample.antennaId,
      antenna_height_m: sample.antennaHeightM, tx_power_dbm: sample.txPowerDbm })) assert.equal(saved.value.item[field], value);
    assert.equal(saved.value.item.status, null); assert.equal(saved.value.item.alert, null);
    await closeRead(saved.panel); await c.verified('R04-save');
    return { id, existing_source_id: sample.id, station_id: sample.stationId, model_id: sample.modelId, antenna_id: sample.antennaId, revision: c.revision };
  });
}

async function availability(c) {
  await c.test('A-R05-availability-cancel-restore', async () => {
    await ledger(c);
    const id = c.state.anchors.created_device_id;
    assert(id, 'Run R04 in this checkpoint first; do not change availability of an unrelated device.');
    const row = await searchDevice(c, id); await row.getByRole('checkbox', { name: '勾选 ' + id, exact: true }).check();
    await button(c.page, '批量下架').click();
    const confirm = c.dialog('下架设备');
    await confirm.waitFor({ state: 'visible' }); const before = c.writes.length;
    await button(confirm, '取消').click(); await confirm.waitFor({ state: 'hidden' });
    assert.equal(c.writes.length, before); await refresh(c, 'ledger');
    const initial = await detail(c, id); assert.equal(initial.value.item.availability, 'ACTIVE'); await closeRead(initial.panel);
    for (const [label, desired, key] of [['批量下架', 'OFF_SHELF', 'R05-off'], ['批量启用', 'ACTIVE', 'R05-on']]) {
      const target = await searchDevice(c, id); await target.getByRole('checkbox', { name: '勾选 ' + id, exact: true }).check();
      await button(c.page, label).click(); const dialog = c.dialog(desired === 'ACTIVE' ? '启用设备' : '下架设备'); await dialog.waitFor({ state: 'visible' });
      await c.change(key, 'POST', '/resource/device-availability', () => button(dialog, '确认操作').click(), 'ledger');
      await dialog.waitFor({ state: 'hidden' }); await refresh(c, 'ledger');
      const saved = await detail(c, id); assert.equal(saved.value.item.availability, desired); await closeRead(saved.panel); await c.verified(key);
    }
    return { id, cancellation_did_not_write: true, final_availability: 'ACTIVE', revision: c.revision };
  });
}

async function importDevice(c) {
  await c.test('A-R06-valid-file-preview-commit-readback', async () => {
    await ledger(c); await button(c.page, '导入').click(); const panel = c.drawer('导入资源'); await panel.waitFor({ state: 'visible' });
    await panel.getByLabel('导入资源类型', { exact: true }).selectOption('devices');
    const downloaded = await c.download(() => button(panel, 'CSV 模板').click(), 'A-R06-device-template');
    const bytes = await fs.readFile(downloaded.file), text = bytes.toString('utf8');
    const templateFile = path.join(c.output, 'downloaded-device-template.csv'); await fs.writeFile(templateFile, bytes, { flag: 'wx' });
    const papa = createRequire(path.join(ROOT, 'front_design/radio-planning-20261022/package.json'))('papaparse');
    const parsed = papa.parse(text, { header: true, skipEmptyLines: true }); assert.equal(parsed.errors.length, 0);
    const fields = parsed.meta.fields; assert(fields?.[0] === 'device_id');
    const source = c.state.anchors.device_source; assert(source, 'R04 real catalog anchor is required.');
    const id = 'R6-IMPORT-' + c.runId.slice(0, 8), values = { device_id: id, node_id: source.stationId, model_id: source.modelId,
      antenna_id: source.antennaId, antenna_height_m: source.antennaHeightM, tilt_deg: source.tiltDeg ?? '', azimuth_deg: source.azimuthDeg ?? '',
      tx_power_dbm: source.txPowerDbm, work_freq_khz: source.workFreqKhz ?? '', status: '', install_time: source.installedAt ?? '', availability: 'ACTIVE' };
    assert(fields.every(field => Object.hasOwn(values, field)), 'The actual template has unknown fields; do not invent mappings.');
    const file = path.join(c.output, 'valid-device.csv');
    await fs.writeFile(file, papa.unparse({ fields, data: [fields.map(field => values[field])] }), { flag: 'wx' });
    const before = c.writes.length, revision = c.revision;
    const preview = await c.http('POST', '/resource/import/preview', () => panel.getByLabel('选择资源文件', { exact: true }).setInputFiles(file));
    assert.equal(preview.base_revision, revision); assert.equal(preview.valid, true); assert.equal(preview.issues.length, 0);
    assert.deepEqual(preview.rows.map(row => [row.id, row.action]), [[id, 'NEW']]);
    await panel.getByText('正在读取并预检…', { exact: true }).waitFor({ state: 'hidden' });
    await c.until(async () => (await panel.innerText()).includes('错误 0') && await button(panel, '确认整批保存').isEnabled(), 'Valid preview is not actionable.');
    assert.equal(c.writes.length, before, 'Preflight must not commit resources.');
    await button(panel, '关闭').click(); const decision = c.dialog('导入尚未确认'); await decision.waitFor({ state: 'visible' });
    await button(decision, '继续查看').click(); await decision.waitFor({ state: 'hidden' });
    assert((await panel.innerText()).includes(id)); assert(await button(panel, '确认整批保存').isEnabled());
    await button(panel, '关闭').click(); await button(c.dialog('导入尚未确认'), '放弃本次导入').click();
    await panel.waitFor({ state: 'hidden' }); await refresh(c, 'ledger'); assert.equal(c.writes.length, before);
    await button(c.page, '导入').click(); await panel.waitFor({ state: 'visible' });
    await panel.getByLabel('导入资源类型', { exact: true }).selectOption('devices');
    const retryPreview = await c.http('POST', '/resource/import/preview', () => panel.getByLabel('选择资源文件', { exact: true }).setInputFiles(file));
    assert.equal(retryPreview.base_revision, revision); assert.equal(retryPreview.valid, true);
    assert.match(retryPreview.signature, /^[a-f0-9]{64}$/); assert.equal(retryPreview.issues.length, 0);
    assert.deepEqual(retryPreview.rows.map(row => [row.id, row.action]), [[id, 'NEW']]);
    await panel.getByText('正在读取并预检…', { exact: true }).waitFor({ state: 'hidden' });
    await c.until(async () => await button(panel, '确认整批保存').isEnabled(), 'Explicitly reselected file is not ready to commit.');
    assert.equal(c.writes.length, before, 'Closing/reselecting a file must not write resources.');
    c.state.anchors.imported_device_id = id; await c.save();
    await c.change('R06-commit', 'POST', '/resource/import/commit', () => button(panel, '确认整批保存').click(), 'ledger');
    await panel.waitFor({ state: 'hidden' }); await refresh(c, 'ledger'); const saved = await detail(c, id);
    assert.equal(saved.value.item.node_id, source.stationId); assert.equal(saved.value.item.model_id, source.modelId);
    assert.equal(saved.value.item.antenna_id, source.antennaId); assert.equal(saved.value.item.origin, 'IMPORT');
    await closeRead(saved.panel); await c.verified('R06-commit');
    return { id, file, template: downloaded, retained_template_file: templateFile, template_bytes_sha256: digest(bytes), preflight_revision: revision,
      continue_retained_preview: true, discard_did_not_write: true, revision: c.revision };
  });
}

export async function runResourceLedgerWrites(args) {
  return environment(args, async c => {
    await maintenance(c); await createDevice(c); await availability(c); await importDevice(c);
    return { output: c.output, anchors: c.state.anchors, revision: c.revision };
  });
}

async function beginGis(c, navigate = true) {
  if (navigate) {
    const current = await c.http('GET', '/resource/context', () => route(c, 'situation'), response => new URL(response.url()).searchParams.get('context') === 'gis');
    c.revision = current.revision;
  }
  const value = await c.http('GET', '/resource/edit-context', () => button(c.page, '编辑资源').click(),
    response => new URL(response.url()).searchParams.get('context') === 'gis');
  assert.equal(value.revision, c.revision); assert(value.resources && value.validationSource);
  await button(c.page, '退出编辑').waitFor({ state: 'visible' });
  return value;
}
async function endGis(c, panel) {
  if (panel && await panel.isVisible()) await closeForm(c, panel);
  await button(c.page, '退出编辑').click(); await button(c.page, '编辑资源').waitFor({ state: 'visible' });
  await refresh(c, 'gis');
}
async function selectGisDevice(c, id) {
  const tree = c.page.locator('.gis-resource-tree');
  await button(tree, '全部类型').click();
  await tree.getByLabel('搜索资源', { exact: true }).fill(id);
  await tree.getByRole('button', { name: '选择设备 ' + id, exact: true }).click();
  await button(c.page, '编辑设备参数').click();
  const panel = c.drawer('编辑设备参数'); await panel.locator('#resource-antennaHeightM').waitFor({ state: 'visible' });
  return panel;
}
async function saveGis(c, key, panel) {
  const result = await c.change(key, 'POST', '/resource/workspace/changes',
    () => button(panel, '保存全部草稿').click(), 'gis');
  await c.until(async () => !await panel.isVisible() || await button(panel, '关闭').isEnabled(), 'GIS save/refresh did not settle.');
  await endGis(c, panel);
  const readback = await beginGis(c, false);
  assert.equal(readback.revision, receipt(result).revision);
  return readback;
}
function insideCoordinate(source) {
  const bounds = source.validationSource.planningBounds;
  assert(Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite), 'Actual DEM bounds are required.');
  const station = source.resources.stations.find(row => row.coordinate?.length === 2 && row.coordinate.every(Number.isFinite)
    && row.coordinate[0] >= bounds[0] && row.coordinate[0] <= bounds[2] && row.coordinate[1] >= bounds[1] && row.coordinate[1] <= bounds[3]);
  assert(station, 'No actual node coordinate within the current DEM. Do not invent coordinates.');
  return station;
}
async function applyDraft(c, panel, label = '应用到草稿') {
  const writes = c.writes.length;
  await button(panel, label).click();
  await c.until(async () => (await panel.innerText()).includes('已应用到 GIS 草稿，尚未保存'), 'The actual form did not apply a valid draft.');
  assert.equal(c.writes.length, writes, 'Applying a draft unexpectedly persisted it.');
}

async function gisEdit(c) {
  await c.test('A-G02-edit-undo-redo-save-readback', async () => {
    const source = await beginGis(c), original = validDevice(source.resources); assert(original);
    const panel = await selectGisDevice(c, original.id), input = panel.locator('#resource-antennaHeightM');
    assert.equal(Number(await input.inputValue()), original.antennaHeightM);
    const height = Number((original.antennaHeightM + 0.2).toFixed(4)); await input.fill(String(height));
    await applyDraft(c, panel); const writes = c.writes.length;
    await button(c.page, '撤销').click();
    await c.until(async () => Number(await input.inputValue()) === original.antennaHeightM, 'Undo did not restore the actual device form.');
    await button(c.page, '重做').click();
    await c.until(async () => Number(await input.inputValue()) === height, 'Redo did not restore the same draft value.');
    assert.equal(c.writes.length, writes);
    const saved = await saveGis(c, 'G02-save', panel);
    assert.equal(saved.resources.devices.find(row => row.id === original.id)?.antennaHeightM, height);
    const reopened = await selectGisDevice(c, original.id); assert.equal(Number(await reopened.locator('#resource-antennaHeightM').inputValue()), height);
    await c.verified('G02-save'); await endGis(c, reopened);
    return { id: original.id, before_height_m: original.antennaHeightM, saved_height_m: height, revision: c.revision, undo_redo_without_write: true };
  });
}

async function stationWrite(c) {
  await c.test('A-G03-one-fixed-station-pick-cancel', async () => {
    const source = await beginGis(c), reference = insideCoordinate(source);
    await button(c.page, '新建固定站').click(); const panel = c.drawer('新增固定站'); await panel.waitFor({ state: 'visible' });
    const id = await formId(panel), name = c.state.tag + '-station';
    await panel.locator('#resource-name').fill(name);
    await panel.locator('#resource-longitude').fill(String(reference.coordinate[0]));
    await panel.locator('#resource-latitude').fill(String(reference.coordinate[1]));
    await panel.locator('#resource-remark').fill('R6 constructed browser acceptance, not a surveyed station.');
    const before = [await panel.locator('#resource-longitude').inputValue(), await panel.locator('#resource-latitude').inputValue()];
    await button(panel, '在地图上重新取点').click();
    await button(c.page, '取消取点并返回表单（Esc）').click(); await panel.waitFor({ state: 'visible' });
    assert.deepEqual([await panel.locator('#resource-longitude').inputValue(), await panel.locator('#resource-latitude').inputValue()], before);
    c.state.anchors.station_id = id; await c.save(); await applyDraft(c, panel);
    const saved = await saveGis(c, 'G03-station-save', panel), station = saved.resources.stations.find(row => row.id === id);
    assert(station); assert.equal(station.name, name); assert.deepEqual(station.coordinate, reference.coordinate); assert.equal(station.origin, 'MANUAL');
    const tree = c.page.locator('.gis-resource-tree'); await button(tree, '按站点浏览').click(); await tree.getByLabel('搜索资源', { exact: true }).fill(id);
    const selected = tree.getByRole('button').filter({ hasText: name }); assert.equal(await selected.count(), 1); await selected.click();
    await button(c.page, '编辑节点').click(); const reopened = c.drawer('编辑固定站'); await reopened.waitFor({ state: 'visible' });
    assert.equal(await reopened.locator('#resource-name').inputValue(), name);
    assert.equal(Number(await reopened.locator('#resource-longitude').inputValue()), reference.coordinate[0]);
    await c.verified('G03-station-save'); await endGis(c, reopened);
    return { id, name, coordinate: station.coordinate, coordinate_reference_node: reference.id, revision: c.revision, pick_cancel_retained_input: true };
  });
}

async function interferenceWrite(c) {
  await c.test('A-G03-one-interference-resource', async () => {
    const source = await beginGis(c), node = insideCoordinate(source);
    const reference = source.resources.interferences?.find(row => row.interferenceType && Number.isFinite(row.antennaHeightM)
      && row.antennaHeightM >= 0 && Number.isFinite(row.centerFreqKhz) && row.centerFreqKhz > 0
      && Number.isFinite(row.bandwidthKhz) && row.bandwidthKhz > 0 && Number.isFinite(row.txPowerDbm));
    assert(reference, 'No actual interference source to supply representative valid parameters.');
    await button(c.page, '新建干扰源').click(); const panel = c.drawer('新增干扰源'); await panel.waitFor({ state: 'visible' });
    const identity = await panel.getByText(/^稳定 ID：/).innerText(), id = identity.replace(/^稳定 ID：\s*/, '').trim(), name = c.state.tag + '-interference';
    assert(id && !source.resources.interferences.some(row => row.id === id));
    const values = { name, longitude: node.coordinate[0], latitude: node.coordinate[1], elevationM: reference.elevationM,
      antennaHeightM: reference.antennaHeightM, centerFreqKhz: reference.centerFreqKhz, bandwidthKhz: reference.bandwidthKhz,
      txPowerDbm: reference.txPowerDbm, antennaGainDbi: reference.antennaGainDbi, interferenceType: reference.interferenceType,
      patternType: reference.patternType, azimuthDeg: reference.azimuthDeg, dutyCycle: reference.dutyCycle, active: 'false' };
    for (const [field, value] of Object.entries(values)) {
      const input = panel.locator('#interference-' + field);
      if (['interferenceType', 'patternType', 'active'].includes(field)) await input.selectOption(value == null ? '' : String(value));
      else await input.fill(value == null ? '' : String(value));
    }
    c.state.anchors.interference_id = id; await c.save(); await applyDraft(c, panel, '应用到 GIS 草稿');
    const saved = await saveGis(c, 'G03-interference-save', panel), item = saved.resources.interferences.find(row => row.id === id);
    assert(item); assert.equal(item.name, name); assert.equal(item.active, false); assert.deepEqual(item.coordinate, node.coordinate);
    for (const field of ['antennaHeightM', 'centerFreqKhz', 'bandwidthKhz', 'txPowerDbm', 'interferenceType', 'patternType']) assert.equal(item[field], reference[field]);
    const tree = c.page.locator('.gis-resource-tree'); await button(tree, '全部类型').click(); await button(tree, '按站点浏览').click();
    await tree.getByLabel('搜索资源', { exact: true }).fill(id);
    const directoryItem = tree.locator('[data-group="interferences"] button').filter({ hasText: name });
    await directoryItem.waitFor({ state: 'visible' }); assert((await directoryItem.innerText()).includes(id));
    assert((await directoryItem.innerText()).includes('未生效')); await directoryItem.click();
    await c.page.getByTestId('gis-resource-interference-parameters').click();
    const detail = c.drawer('干扰源详情'); await detail.waitFor({ state: 'visible' });
    assert((await detail.innerText()).includes(id)); assert((await detail.innerText()).includes(name));
    await button(detail, '编辑参数').click();
    const reopened = c.drawer('编辑干扰源'); await reopened.waitFor({ state: 'visible' });
    assert((await reopened.getByText(/^稳定 ID：/).innerText()).includes(id));
    assert.equal(await reopened.locator('#interference-name').inputValue(), name);
    assert.equal(await reopened.locator('#interference-active').inputValue(), 'false');
    for (const field of ['antennaHeightM', 'centerFreqKhz', 'bandwidthKhz', 'txPowerDbm']) {
      assert.equal(Number(await reopened.locator('#interference-' + field).inputValue()), reference[field]);
    }
    await c.verified('G03-interference-save'); await endGis(c, reopened);
    return { id, name, active: false, parameter_reference_source: reference.id, revision: c.revision, resource_configuration_only: true,
      readback: '同一新源保存回执、刷新目录及原参数抽屉复开回读；复开未修改参数或提交新写入' };
  });
}

function endpointPair(resources) {
  const devices = resources.devices.filter(row => row.availability === 'ACTIVE');
  for (const a of devices) {
    const modelA = resources.models.find(row => row.id === a.modelId); if (!modelA) continue;
    const b = devices.find(row => row.stationId !== a.stationId && resources.models.some(model => model.id === row.modelId
      && model.deviceClass === modelA.deviceClass && Math.max(model.freqMinKhz, modelA.freqMinKhz) <= Math.min(model.freqMaxKhz, modelA.freqMaxKhz)));
    if (b) return { a, b, deviceClass: modelA.deviceClass };
  }
  throw new Error('No actual same-class, distinct-node active device pair with a shared supported band.');
}
async function candidateWrite(c) {
  await c.test('A-G03-one-pending-candidate-link', async () => {
    const source = await beginGis(c), pair = endpointPair(source.resources);
    await button(c.page, '新建候选链路').click(); const panel = c.drawer('新增候选链路'); await panel.waitFor({ state: 'visible' }); const id = await formId(panel);
    for (const [field, value] of Object.entries({ nodeAId: pair.a.stationId, nodeBId: pair.b.stationId,
      deviceAId: pair.a.id, deviceBId: pair.b.id, deviceClass: pair.deviceClass })) await panel.locator('#resource-' + field).selectOption(value);
    // 可选物理评估输入保持未提供，不由浏览器脚本编造。
    await panel.locator('#resource-freqKhz').fill(''); await panel.locator('#resource-bandwidthKhz').fill('');
    c.state.anchors.candidate_id = id; await c.save(); await applyDraft(c, panel);
    const saved = await saveGis(c, 'G03-candidate-save', panel), item = saved.resources.candidateLinks.find(row => row.id === id);
    assert(item); assert.equal(item.assessmentState, 'PENDING'); assert.equal(item.source.kind, 'MANUAL');
    for (const field of ['distanceM', 'pathLossDb', 'rxPowerDbm', 'linkMarginDb', 'isAvailable', 'linkState']) assert.equal(item[field], null);
    assert.equal(item.nodeAId, pair.a.stationId); assert.equal(item.nodeBId, pair.b.stationId);
    assert.equal(item.deviceAId, pair.a.id); assert.equal(item.deviceBId, pair.b.id);
    const tree = c.page.locator('.gis-resource-tree'); await button(tree, '全部类型').click(); await button(tree, '按站点浏览').click();
    await tree.getByLabel('搜索资源', { exact: true }).fill(id);
    await tree.getByRole('button', { name: '选择候选链路 ' + id, exact: true }).click();
    await c.until(async () => (await c.page.locator('.candidate-detail').innerText()).includes('待评估'), 'Saved candidate lacks its visible pending-assessment provenance.');
    await c.verified('G03-candidate-save'); await endGis(c);
    return { id, node_a: pair.a.stationId, node_b: pair.b.stationId, device_a: pair.a.id, device_b: pair.b.id,
      assessment: 'PENDING', assessment_fields: 'not provided; no link-feasibility claim', revision: c.revision };
  });
}

async function taskBridge(c) {
  await c.test('A-G04-saved-task-edit-save-return', async () => {
    const current = await c.http('GET', '/resource/context', () => route(c, 'situation'), response => new URL(response.url()).searchParams.get('context') === 'gis');
    c.revision = current.revision; await button(c.page, '任务查看').click(); const panel = c.page.locator('.gis-task-panel');
    await panel.getByLabel('搜索已保存任务', { exact: true }).fill(c.taskId);
    await c.http('GET', '/task-inputs', () => button(panel, '查询').click());
    const selected = await c.http('GET', '/task-inputs/' + enc(c.taskId), () => panel.getByLabel('选择已保存任务', { exact: true }).selectOption(c.taskId));
    assert.equal(selected.task_id, c.taskId); assert.equal(selected.resource_revision, c.revision, 'The original task is historical: do not invent replacement references.');
    assert(selected.input.stationIds.length >= 2 && selected.input.demands.length > 0);
    const nodeId = selected.input.stationIds[0], demandId = selected.input.demands[0].id;
    await panel.locator('.task-row').filter({ hasText: new RegExp(escaped(nodeId) + '(?:\\s|$)') }).getByRole('button').filter({ hasText: /^\s*定位节点\s*$/ }).click();
    const demand = panel.locator('.task-row').filter({ has: c.page.getByText(demandId, { exact: true }) }); await button(demand, '定位通联').click();
    await c.until(async () => (await demand.getAttribute('class')).includes('selected'), 'Task demand did not become selected in the real UI.');
    const beforeWrites = c.writes.length; await button(panel, '编辑任务').click();
    await c.page.waitForURL(url => url.hash.includes('/planning') && url.hash.includes('editTask=1') && url.hash.includes(enc(c.taskId)));
    const name = c.page.locator('.task-form input[data-validation-field="name"]'); await name.waitFor({ state: 'visible' });
    assert.equal(await name.inputValue(), selected.input.name);
    // 先验证仅返回 GIS 不会静默保存。
    await button(c.page, '返回 GIS 任务').click(); await c.page.waitForURL(url => url.hash.startsWith('#/situation'));
    await c.until(async () => await c.page.locator('.gis-task-panel').getByLabel('选择已保存任务', { exact: true }).inputValue() === c.taskId, 'Return lost the original task.');
    assert.equal(c.writes.length, beforeWrites);
    await button(c.page.locator('.gis-task-panel'), '编辑任务').click(); await name.waitFor({ state: 'visible' });
    const nextName = c.state.tag + '-task-bridge'; await name.fill(nextName);
    const saved = await c.change('G04-task-save', 'PUT', '/task-inputs/' + enc(c.taskId), () => button(c.page, '保存任务并返回 GIS').click());
    assert.equal(saved.task_id, c.taskId); assert.equal(saved.input.name, nextName);
    const oldInput = { ...selected.input, name: nextName }; assert.deepEqual(saved.input, oldInput, 'The bridge changed conditions beyond the explicit task name.');
    await c.page.waitForURL(url => url.hash.startsWith('#/situation') && url.hash.includes(enc(c.taskId)));
    const returned = c.page.locator('.gis-task-panel');
    assert(saved.input_version && saved.revision); assert.notEqual(saved.input_version, selected.input_version);
    await c.until(async () => (await returned.innerText()).includes(saved.input_version), 'Returned GIS task version is not visible.');
    // 用实际文档导航重新读取持久化任务，不只检查本地标签。
    const readback = await c.http('GET', '/task-inputs/' + enc(c.taskId), () => routeTask(c));
    assert.equal(readback.task_id, c.taskId); assert.equal(readback.input_version, saved.input_version); assert.equal(readback.revision, saved.revision);
    assert.equal(readback.input.name, nextName); assert.equal(readback.resource_revision, c.revision);
    await c.verified('G04-task-save');
    return { task_id: c.taskId, old_input_version: selected.input_version, saved_input_version: saved.input_version, saved_revision: saved.revision, node_id: nodeId, demand_id: demandId,
      returned_without_save_wrote_nothing: true, resource_revision: c.revision, saved_task_resource_revision: saved.resource_revision };
  });
}
async function routeTask(c) {
  await c.page.goto(`${ORIGIN}/?r6aw=${c.runId}-${Date.now()}#/situation?taskId=${enc(c.taskId)}`, { waitUntil: 'domcontentloaded' });
  await c.page.getByRole('heading', { name: 'GIS 态势', exact: true, level: 1 }).waitFor({ timeout: 90000 });
}

export async function runResourceGisWrites(args) {
  return environment(args, async c => {
    await gisEdit(c); await stationWrite(c); await interferenceWrite(c); await candidateWrite(c);
    return { output: c.output, anchors: c.state.anchors, revision: c.revision };
  });
}
export async function runResourceTaskBridge(args) {
  return environment(args, async c => { await taskBridge(c); return { output: c.output, taskId: c.taskId }; });
}
export async function runResourceWrites(args) {
  return environment(args, async c => {
    // 原任务桥先于资源变更，不通过重写方案掩盖来源过期。
    await taskBridge(c); await maintenance(c); await createDevice(c); await availability(c); await importDevice(c);
    await gisEdit(c); await stationWrite(c); await interferenceWrite(c); await candidateWrite(c);
    return { output: c.output, anchors: c.state.anchors, revision: c.revision, warning: 'Original plan may now be historical; not a performance result.' };
  });
}
export default runResourceWrites;
