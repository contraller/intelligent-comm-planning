import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Browser/service ownership and evidence persistence belong to the main harness.
export const FRONTEND = 'http://127.0.0.24:5324';
export const API = 'http://127.0.0.24:8124';
const PREFIX = '/api/v1';
const TIMEOUT = 60000;
const FREQ = '/resource/frequency-resources';
const OBS = '/observations/spectrum';
let navigationSerial = 0;

function contract(h) {
  assert(h?.page && typeof h.page.waitForResponse === 'function', 'A real Playwright Page is required');
  for (const key of ['login', 'record', 'download', 'shot']) assert.equal(typeof h[key], 'function', `${key} closure required`);
  assert(h.runtime, 'Main-owned runtime required; only explicit late entries access their own public checkpoints');
  assert.equal(typeof h.taskId, 'string', 'This R6 taskId is required');
  assert.equal(typeof h.planId, 'string', 'This R6 confirmed planId is required');
  assert(h.taskId && h.planId, 'Empty taskId/planId');
}

function identities(h) {
  const suffix = createHash('sha256').update(`${h.taskId}:${h.planId}`).digest('hex').slice(0, 12);
  return { frequencyId: h.frequencyId ?? `FQ-R6-D-${suffix}`, sourceId: h.sourceId ?? `SRC-R6-D-${suffix}` };
}

function urlOf(value) { return new URL(typeof value === 'string' ? value : value.url()); }
function apiPath(value) {
  const u = urlOf(value);
  return [FRONTEND, API].includes(u.origin) && u.pathname.startsWith(`${PREFIX}/`) ? u.pathname.slice(PREFIX.length) : null;
}
function matches(response, spec) {
  const request = response.request(), u = urlOf(response), actual = apiPath(response);
  return request.method() === (spec.method ?? 'GET') && actual !== null
    && (typeof spec.path === 'string' ? actual === spec.path : spec.path.test(actual))
    && Object.entries(spec.query ?? {}).every(([key, value]) => u.searchParams.get(key) === String(value));
}

// Cancel our listeners on every exit, including an action failing before it sends HTTP.
async function http(page, specs, action) {
  const responses = new Array(specs.length), seen = new Set();
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  pending.catch(() => {});
  const listener = response => {
    for (let i = 0; i < specs.length; i++) {
      if (!seen.has(i) && matches(response, specs[i])) { responses[i] = response; seen.add(i); }
    }
    if (seen.size === specs.length) resolve(responses);
  };
  const timer = setTimeout(() => reject(new Error(`Missing real HTTP: ${specs.filter((_, i) => !seen.has(i)).map(s => `${s.method ?? 'GET'} ${s.path}`).join(', ')}`)), TIMEOUT);
  page.on('response', listener);
  try {
    await action();
    await pending;
    const results = [];
    for (let i = 0; i < specs.length; i++) {
      const response = responses[i], spec = specs[i], request = response.request();
      assert.equal(response.fromServiceWorker(), false, 'Service-worker responses are not HTTP evidence');
      assert(['fetch', 'xhr'].includes(request.resourceType()), 'Expected a browser fetch/XHR response');
      assert.equal(response.status(), spec.status ?? 200, `${request.method()} ${spec.path} status`);
      const raw = await response.json();
      let data;
      if (spec.file) {
        assert.match(response.headers()['content-type'] ?? '', /application\/json/i);
        assert.match(response.headers()['content-disposition'] ?? '', /^attachment/i);
        assert.equal(Object.hasOwn(raw, 'code'), false, 'An API error envelope is not an export');
        data = raw;
      } else {
        assert.equal(raw.code, spec.code ?? 0, `${spec.path} business code`);
        assert.equal(typeof raw.message, 'string', 'Missing API message');
        assert(Object.hasOwn(raw, 'data'), 'Missing API data envelope');
        data = raw.data;
      }
      const body = request.postData() ? request.postDataJSON() : null;
      if (spec.checkRequest) spec.checkRequest(body, urlOf(response));
      const bytes = spec.file ? await response.body() : null;
      results.push({ data, body, status: response.status(), code: raw.code,
        path: apiPath(response), query: Object.fromEntries(urlOf(response).searchParams),
        ...(bytes ? { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } : {}) });
    }
    return results;
  } finally { clearTimeout(timer); page.off('response', listener); }
}

async function unique(locator) {
  await locator.waitFor({ state: 'visible', timeout: TIMEOUT });
  assert.equal(await locator.count(), 1, 'Control selector must resolve uniquely');
  return locator;
}
async function click(locator) { await (await unique(locator)).click({ timeout: TIMEOUT }); }
async function fill(locator, value) { await (await unique(locator)).fill(String(value), { timeout: TIMEOUT }); }
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactText = text => new RegExp(`^${escapePattern(text)}$`);
// PrimeIcons ::before can enter accessibleName; textContent excludes CSS glyphs.
const button = (scope, text) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escapePattern(text)}\\s*$`) });
const iconButton = (scope, label) => scope.getByRole('button', { name: label, exact: true });
// The installed PrimeVue Drawer has no aria-labelledby; use its actual title node.
const drawer = (page, name) => page.locator('.p-drawer, .p-dialog').filter({
  has: page.locator('.p-drawer-title, .p-dialog-title').filter({ hasText: exactText(name) }),
});
const region = (page, name) => page.getByRole('region', { name, exact: true });

async function until(check, message) {
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  assert.fail(message);
}
async function contains(locator, expected) {
  await unique(locator);
  await until(async () => (await locator.textContent() ?? '').includes(expected), `Expected visible text: ${expected}`);
}
async function enabled(locator, expected = true) {
  await unique(locator);
  await until(async () => await locator.isEnabled() === expected, `Unexpected enabled state: ${expected}`);
}
async function closeDrawer(page, name) {
  const panel = await unique(drawer(page, name));
  // PrimeVue Drawer header close, scoped separately from any footer "关闭" command.
  await click(panel.locator('button.p-drawer-close-button'));
  await panel.waitFor({ state: 'hidden', timeout: TIMEOUT });
}
async function expand(scope, summary) {
  const details = scope.locator('details').filter({ has: scope.page().locator('summary').filter({ hasText: exactText(summary) }) });
  await unique(details);
  if (await details.getAttribute('open') === null) await click(details.locator('summary'));
}

async function enter(h, route, specs) {
  await h.login(route === 'system' ? 'admin' : 'editor');
  assert.equal(urlOf(h.page.url()).origin, FRONTEND, 'login must use only the R6 .24 frontend');
  const result = await http(h.page, specs, () => h.page.goto(`${FRONTEND}/?r6d=${Date.now()}-${++navigationSerial}#/${route}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT }));
  assert.equal(urlOf(h.page.url()).origin, FRONTEND);
  await unique(h.page.getByRole('heading', { name: route === 'system' ? '系统管理' : '资源管理', exact: true, level: 1 }));
  return result;
}

async function caseRecord(h, id, writes, operation) {
  contract(h);
  let result;
  await h.record(`R6-D-${id}`, async () => {
    const forbidden = [], errors = [];
    const onRequest = request => {
      const u = urlOf(request), path = apiPath(request);
      if (u.hostname.startsWith('127.0.0.') && ![FRONTEND, API].includes(u.origin)) forbidden.push(`${request.method()} ${u.origin}${u.pathname}`);
      if (u.pathname === '/r6-declaration-only') forbidden.push('Unexpected collector connection attempt');
      // login is the only authentication mutation permitted, and belongs to the supplied closure.
      if (path && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path !== '/auth/login'
        && !writes.some(([method, allowed]) => request.method() === method && (typeof allowed === 'string' ? path === allowed : allowed.test(path)))) {
        forbidden.push(`${request.method()} ${path}`);
      }
    };
    const onError = error => errors.push(error.message);
    h.page.on('request', onRequest); h.page.on('pageerror', onError);
    try {
      result = await operation();
      assert.deepEqual(forbidden, [], 'Out-of-scope request observed');
      assert.deepEqual(errors, [], 'Uncaught page error');
      await h.shot(`r6-d-${id}`);
      return { ...result, taskId: h.taskId, planId: h.planId, origin: FRONTEND, evidence: 'REAL_UI_HTTP' };
    } finally { h.page.off('request', onRequest); h.page.off('pageerror', onError); }
  });
  return result;
}

async function ledger(h, extra = []) {
  const [context, devices, ...other] = await enter(h, 'resources', [
    { path: '/resource/context', query: { context: 'ledger' } },
    { path: '/resource/devices', query: { context: 'ledger' } }, ...extra,
  ]);
  assert.match(context.data.revision, /^resource-[a-f0-9]{16}$/);
  assert.equal(devices.data.revision, context.data.revision);
  return { context: context.data, devices: devices.data, other };
}
async function openDevice(h, baseline) {
  const id = h.deviceId ?? 'DV-0001';
  assert(baseline.devices.items.some(item => item.device_id === id), `${id} must be in the first ledger page; supply a visible deviceId`);
  const row = h.page.getByRole('row').filter({ has: h.page.getByRole('checkbox', { name: `勾选 ${id}`, exact: true }) });
  const [detail] = await http(h.page, [{ path: `/resource/devices/${encodeURIComponent(id)}`, query: { context: 'ledger', revision: baseline.context.revision } }], () => click(button(row, '查看详情')));
  assert.equal(detail.data.item.device_id, id);
  const panel = await unique(drawer(h.page, '设备实例详情'));
  await expand(panel, '参数信息');
  return { id, panel, item: detail.data.item };
}

export async function runDeviceConfiguration(h) {
  return caseRecord(h, 'device-configuration', [['POST', '/device-configurations/validate'], ['POST', '/device-configurations']], async () => {
    const baseline = await ledger(h), device = await openDevice(h, baseline);
    const [context] = await http(h.page, [{ path: '/device-configurations/context', query: { device_id: device.id, revision: baseline.context.revision } }], () => click(button(device.panel, '配置请求')));
    const panel = await unique(drawer(h.page, '设备配置请求')), c = context.data;
    assert.equal(c.device.device_id, device.id);
    assert.equal(c.resource_revision, baseline.context.revision);
    const power = c.device.source_values.tx_power_dbm === null ? c.model.tx_power_max_dbm : Math.min(c.device.source_values.tx_power_dbm, c.model.tx_power_max_dbm);
    const frequency = c.model.freq_min_khz;
    assert(Number.isFinite(power) && Number.isFinite(frequency));
    await fill(panel.getByRole('spinbutton', { name: '请求功率', exact: true }), power);
    await fill(panel.getByRole('spinbutton', { name: '请求频率', exact: true }), frequency);
    await enabled(button(panel, '提交系统受理'), false);
    const [validated] = await http(h.page, [{ method: 'POST', path: '/device-configurations/validate', checkRequest: body => {
      assert.equal(body.device_id, device.id); assert.equal(body.base_revision, c.resource_revision);
      assert.deepEqual(body.values, { tx_power_dbm: power, work_freq_khz: frequency });
    } }], () => click(button(panel, '校验')));
    assert.equal(validated.data.valid, true);
    const [accepted] = await http(h.page, [{ method: 'POST', path: '/device-configurations' }], () => click(button(panel, '提交系统受理')));
    const receipt = accepted.data;
    assert.equal(receipt.request_id, accepted.body.request_id);
    assert.equal(receipt.device_id, device.id);
    assert.equal(receipt.base_revision, baseline.context.revision);
    assert.deepEqual(receipt.requested_values, validated.data.requested_values);
    for (const [key, value] of Object.entries({ status: 'ACCEPTED', receipt_scope: 'SYSTEM_ACCEPTANCE', dispatch_status: 'NOT_DISPATCHED', device_execution_status: 'UNKNOWN', applied_values: null, online: null, effective: null, device_reported_at: null })) assert.equal(receipt[key], value, key);
    await contains(region(h.page, '系统受理回执'), '系统已受理 · 未下发');
    await contains(region(h.page, '系统受理回执'), '未知／未知／未知');
    const [history] = await http(h.page, [{ path: '/device-configurations/history', query: { device_id: device.id } }], () => click(button(panel, '读取历史')));
    assert(history.data.items.some(item => item.request_id === receipt.request_id && item.dispatch_status === 'NOT_DISPATCHED'));
    const [readback] = await http(h.page, [{ path: `/device-configurations/${encodeURIComponent(receipt.request_id)}` }], () => click(button(region(h.page, '配置受理历史'), receipt.request_id)));
    assert.deepEqual(readback.data, receipt);
    const [again] = await http(h.page, [{ path: '/device-configurations/context', query: { device_id: device.id } }], () => click(button(panel, '重新读取来源')));
    assert.equal(again.data.resource_revision, c.resource_revision);
    assert.equal(again.data.resource_content_hash, c.resource_content_hash);
    assert.deepEqual(again.data.device.source_values, c.device.source_values, 'System acceptance must not change ledger values');
    await closeDrawer(h.page, '设备配置请求');
    return { requestId: receipt.request_id, deviceId: device.id, revision: c.resource_revision, status: receipt.status, dispatchStatus: receipt.dispatch_status };
  });
}

export async function runStatusEntry(h) {
  return caseRecord(h, 'status-entry-local-rejection', [], async () => {
    const baseline = await ledger(h, [{ path: '/device-status/snapshots', query: { context: 'ledger' } }]);
    const listing = baseline.other[0].data, panel = await unique(region(h.page, '设备状态快照'));
    assert(listing.items.every(item => item.resource_revision === baseline.context.revision));
    assert.equal(await panel.getByRole('combobox', { name: '状态显示来源', exact: true }).inputValue(), 'baseline');
    await contains(panel, '固定批次');
    await expand(panel, '显式导入构造状态');
    const input = panel.getByRole('textbox', { name: '状态导入 JSON', exact: true });
    await fill(input, '{"broken":');
    await click(button(panel, '校验并导入'));
    await until(async () => await panel.getByRole('alert').count() === 1 && !!(await panel.getByRole('alert').textContent())?.trim(), 'Malformed JSON must show a local error');
    await fill(input, '{}');
    await click(button(panel, '校验并导入'));
    await contains(panel.getByRole('alert'), '状态快照请求无效');
    await click(button(panel, '放弃未提交导入输入'));
    assert.equal(await input.inputValue(), '');
    assert.equal(await panel.getByRole('combobox', { name: '状态显示来源', exact: true }).inputValue(), 'baseline');
    const [after] = await http(h.page, [{ path: '/device-status/snapshots' }], () => click(button(panel, '读取批次')));
    assert.deepEqual(after.data, listing, 'Local validation must not create snapshots');
    return { revision: baseline.context.revision, existingSnapshots: listing.total, rejectedLocally: ['malformed-json', 'invalid-schema'], statusWrites: 0, followTested: false };
  });
}

export async function runDeviceTrace(h) {
  return caseRecord(h, 'trace-preview-only', [['POST', /^\/device-traces\/[^/]+\/restore-preview$/]], async () => {
    const baseline = await ledger(h), device = await openDevice(h, baseline);
    const path = `/device-traces/${encodeURIComponent(device.id)}`;
    const [history] = await http(h.page, [{ path: `${path}/history` }], () => click(button(device.panel, '变更追溯与历史版本')));
    const panel = await unique(drawer(h.page, '设备资源追溯'));
    assert(history.data.items.length, 'At least a retained baseline is required');
    const source = history.data.items.find(item => item.kind === 'RESOURCE_CHANGE') ?? history.data.items.find(item => item.kind === 'RETAINED_BASELINE');
    assert(source, 'No supported trace entry');
    let detailTested = false;
    if (source.request_id !== null) {
      const [detail] = await http(h.page, [{ path: `${path}/operations/${encodeURIComponent(source.request_id)}` }], () => click(button(panel, source.request_id)));
      assert.equal(detail.data.request_id, source.request_id);
      assert.equal(detail.data.device_id, device.id);
      assert(Array.isArray(detail.data.diffs)); detailTested = true;
    } else await click(button(panel, '留存基线（不是修改）'));
    const [preview] = await http(h.page, [{ method: 'POST', path: `${path}/restore-preview`, checkRequest: body => {
      assert.equal(body.base_revision, baseline.context.revision);
      assert.equal(body.source_revision, source.revision);
      assert.equal(body.source_request_id, source.request_id);
    } }], () => click(button(panel, '生成三参数恢复候选')));
    assert.equal(preview.data.device_id, device.id);
    assert.equal(preview.data.base_revision, baseline.context.revision);
    assert.equal(preview.data.source_revision, source.revision);
    assert(Object.keys(preview.data.patch).every(key => ['tx_power_dbm', 'work_freq_khz', 'antenna_height_m'].includes(key)));
    await contains(region(h.page, '参数恢复候选'), '尚未保存');
    await h.shot('r6-d-trace-candidate-unsaved');
    await closeDrawer(h.page, '设备资源追溯');
    await closeDrawer(h.page, '设备实例详情');
    const [readback] = await http(h.page, [{ path: '/resource/context', query: { context: 'ledger' } }], () => click(button(h.page, '刷新资源')));
    assert.equal(readback.data.revision, baseline.context.revision, 'Restore preview must not save resources');
    return { deviceId: device.id, revision: baseline.context.revision, sourceRevision: source.revision, compatible: preview.data.compatible, saved: false,
      operationDetail: detailTested ? 'CHECKED' : 'NOT_RUN_NO_RESOURCE_CHANGE_HISTORY' };
  });
}

async function frequencyPage(h) {
  await ledger(h);
  const [result] = await http(h.page, [{ path: `${FREQ}/query` }], () => click(button(h.page, '规划频点')));
  const panel = await unique(region(h.page, '规划频点管理'));
  assert.equal(result.data.data_origin, 'SYNTHETIC_INTEGRATION');
  const id = identities(h).frequencyId;
  await fill(panel.getByRole('textbox', { name: '频点编号或备注', exact: true }), id);
  const [filtered] = await http(h.page, [{ path: `${FREQ}/query`, query: { search: id } }], () => click(button(panel, '筛选')));
  return { panel, id, listing: filtered.data };
}
function frequencyRow(page, id) {
  return region(page, '规划频点管理').getByRole('row').filter({ has: page.getByRole('checkbox', { name: `选择频点 ${id}`, exact: true }) });
}
async function frequencyForm(h, id) {
  await click(button(region(h.page, '规划频点管理'), '新增构造频点'));
  const panel = await unique(drawer(h.page, '新增构造频点'));
  await fill(panel.getByRole('textbox', { name: '构造频点编号', exact: true }), id);
  await fill(panel.getByRole('spinbutton', { name: '中心频率 / kHz', exact: true }), 7105);
  await fill(panel.getByRole('spinbutton', { name: '带宽 / kHz', exact: true }), 3);
  await fill(panel.getByRole('textbox', { name: '构造频点备注', exact: true }), 'R6-D 浏览器构造验收，非正式频率授权');
  return panel;
}
async function maintainFrequency(h, id, kind, action) {
  const [preview] = await http(h.page, [{ method: 'POST', path: `${FREQ}/changes/validate`, checkRequest: body => {
    assert.equal(body.changes.length, 1); assert.equal(body.changes[0].kind, kind); assert.equal(body.changes[0].freq_id, id);
  } }], action);
  assert.deepEqual(preview.data.selected_ids, [id]);
  assert.equal(preview.data.items[0].kind, kind);
  const confirmation = await unique(drawer(h.page, '确认构造频点维护'));
  const [receipt] = await http(h.page, [{ method: 'POST', path: `${FREQ}/changes`, checkRequest: body => {
    assert.equal(body.base_revision, preview.data.revision);
    assert.deepEqual(body.changes, preview.body.changes);
  } }], () => click(button(confirmation, '确认保存')));
  assert.equal(receipt.data.request_id, receipt.body.request_id);
  assert.equal(receipt.data.base_revision, preview.data.revision);
  assert.deepEqual(receipt.data.updated, [id]);
  assert.equal(receipt.data.changed, true);
  assert.notEqual(receipt.data.revision, receipt.data.base_revision);
  await contains(region(h.page, '本次停用回执'), receipt.data.request_id);
  await contains(region(h.page, '本次停用回执'), receipt.data.revision);
  await unique(frequencyRow(h.page, id));
  return receipt.data;
}

export async function runFrequencyAdd(h) {
  return caseRecord(h, 'frequency-add', [['POST', `${FREQ}/changes/validate`], ['POST', `${FREQ}/changes`]], async () => {
    const { id, listing } = await frequencyPage(h);
    assert.equal(listing.total, 0, 'ADD already exists; resume PATCH/ENABLE instead of resubmitting ADD');
    const form = await frequencyForm(h, id);
    const receipt = await maintainFrequency(h, id, 'ADD', () => click(button(form, '预检变更')));
    const item = receipt.items[0];
    assert.equal(item.freq_id, id); assert.equal(item.is_available, false); assert.equal(item.occupied_by, null);
    assert.equal(item.center_freq_khz, 7105); assert.equal(item.bandwidth_khz, 3);
    await contains(frequencyRow(h.page, id), '已停用');
    return { frequencyId: id, requestId: receipt.request_id, revision: receipt.revision, available: false };
  });
}
export async function runFrequencyPatch(h) {
  return caseRecord(h, 'frequency-patch', [['POST', `${FREQ}/changes/validate`], ['POST', `${FREQ}/changes`]], async () => {
    const { id, listing } = await frequencyPage(h);
    assert.equal(listing.total, 1, 'Run ADD first');
    const before = listing.items[0];
    assert.equal(before.freq_id, id);
    assert.notEqual(before.channel_no, 0, 'PATCH already applied; resume ENABLE');
    await click(button(frequencyRow(h.page, id), '编辑'));
    const form = await unique(drawer(h.page, '编辑构造频点'));
    await enabled(form.getByRole('textbox', { name: '构造频点编号', exact: true }), false);
    await fill(form.getByRole('spinbutton', { name: '信道号', exact: true }), 0);
    const receipt = await maintainFrequency(h, id, 'PATCH', () => click(button(form, '预检变更')));
    assert.equal(receipt.items[0].channel_no, 0, 'Zero channel must survive UI and HTTP');
    assert.equal(receipt.items[0].center_freq_khz, before.center_freq_khz);
    assert.equal(receipt.items[0].is_available, before.is_available);
    return { frequencyId: id, requestId: receipt.request_id, revision: receipt.revision, channel: 0 };
  });
}
export async function runFrequencyEnable(h) {
  return caseRecord(h, 'frequency-enable', [['POST', `${FREQ}/changes/validate`], ['POST', `${FREQ}/changes`]], async () => {
    const { id, panel, listing } = await frequencyPage(h);
    assert.equal(listing.total, 1, 'Run ADD first');
    assert.equal(listing.items[0].is_available, false, 'ENABLE already applied; do not disable just to repeat it');
    await (await unique(panel.getByRole('checkbox', { name: `选择频点 ${id}`, exact: true }))).check();
    const receipt = await maintainFrequency(h, id, 'ENABLE', () => click(button(panel, '启用所选')));
    assert.equal(receipt.items[0].is_available, true);
    await contains(frequencyRow(h.page, id), '可用');
    return { frequencyId: id, requestId: receipt.request_id, revision: receipt.revision, available: true };
  });
}
export async function runFrequencyDuplicate(h) {
  return caseRecord(h, 'frequency-duplicate-rejection', [['POST', `${FREQ}/changes/validate`]], async () => {
    const { id, listing } = await frequencyPage(h);
    assert.equal(listing.total, 1, 'An existing R6-D frequency is required');
    const form = await frequencyForm(h, id);
    const [rejected] = await http(h.page, [{ method: 'POST', path: `${FREQ}/changes/validate`, status: 422, code: 1001,
      checkRequest: body => { assert.equal(body.changes[0].kind, 'ADD'); assert.equal(body.changes[0].freq_id, id); } }], () => click(button(form, '预检变更')));
    await unique(form.getByRole('alert'));
    assert((await form.getByRole('alert').textContent())?.trim(), 'Duplicate rejection must be visible');
    assert.equal(await drawer(h.page, '确认构造频点维护').count(), 0, 'Rejected preview must not offer commit');
    await click(button(form, '取消'));
    await click(button(await unique(drawer(h.page, '关闭构造草稿')), '放弃草稿'));
    await form.waitFor({ state: 'hidden', timeout: TIMEOUT });
    const [again] = await http(h.page, [{ path: `${FREQ}/query`, query: { search: id } }], () => click(button(region(h.page, '规划频点管理'), '刷新')));
    assert.equal(again.data.revision, listing.revision, 'Duplicate failure must not advance resource version');
    assert.deepEqual(again.data.items, listing.items);
    return { frequencyId: id, httpStatus: rejected.status, businessCode: rejected.code, unchangedRevision: listing.revision };
  });
}

async function exportJson(h, spec, action, label) {
  let saved;
  const [response] = await http(h.page, [{ ...spec, file: true }], async () => { saved = await h.download(action, label); });
  assert(saved && typeof saved === 'object', 'download must return the main-owned saved-file summary');
  assert(response.bytes > 0 && response.bytes <= 2 * 1024 * 1024, 'Export must be nonempty and bounded');
  assert.match(saved.file, /^F:[\\/]/i, 'Download evidence must be saved on F:');
  assert.equal(saved.bytes, response.bytes, 'Saved download length differs from the HTTP attachment');
  assert.equal(saved.sha256, response.sha256, 'Saved download differs from the HTTP attachment');
  return { file: response.data, saved, bytes: response.bytes, sha256: response.sha256 };
}

async function openSpectrumSources(h) {
  // Returning to a visited v-show tab need not issue another mount-time GET.
  await click(button(h.page, '频谱接口配置'));
  const panel = await unique(h.page.locator('section.source-panel'));
  const refresh = iconButton(panel, '刷新');
  await enabled(refresh);
  const [listing] = await http(h.page, [{ path: '/spectrum/sources', query: { page: 1, page_size: 10 } }],
    () => click(refresh));
  await enabled(refresh);
  assert.equal(listing.data.page, 1, 'Source preparation must read the first page after document reload');
  assert.equal(listing.data.pageSize, 10);
  assert.equal(await panel.getByRole('alert').count(), 0, 'Fresh source list must be accepted by the visible page');
  return panel;
}

export async function runSpectrumSource(h) {
  return caseRecord(h, 'spectrum-source', [['POST', '/spectrum/sources'], ['POST', /^\/spectrum\/sources\/[^/]+\/checks$/]], async () => {
    await ledger(h);
    const panel = await openSpectrumSources(h), id = identities(h).sourceId;
    await fill(panel.getByRole('textbox', { name: '搜索采集源', exact: true }), id);
    const [existing] = await http(h.page, [{ path: '/spectrum/sources', query: { search: id } }], () => click(iconButton(panel, '搜索')));
    if (existing.data.total === 1) {
      const source = existing.data.items[0];
      assert.equal(source.sourceId, id, 'Reuse only the exact deterministic source');
      assert.equal(source.dataOrigin, 'SYNTHETIC_INTEGRATION');
      assert.match(source.configRevision, /^SPV-[a-f0-9]{64}$/);
      assert.deepEqual(source.draft, { name: `R6-D ${id}`, protocolHint: 'HTTP_JSON',
        endpoint: `${API}/r6-declaration-only`, intervalSeconds: 5, minKhz: 7000, maxKhz: 7200,
        provenanceNote: 'R6-D 构造配置，仅声明及离线格式校验，非实测', enabled: false });
      const row = panel.locator('tbody tr').filter({ hasText: id });
      await click(iconButton(row, '查看或编辑'));
      const form = await unique(drawer(h.page, '采集源配置'));
      await contains(form, source.configRevision);
      const [versions] = await http(h.page, [{ path: `/spectrum/sources/${encodeURIComponent(id)}/versions` }],
        () => click(button(form, '版本记录')));
      const version = versions.data.items.find(item => item.configRevision === source.configRevision);
      assert(version, 'Existing source version must be independently readable');
      assert.deepEqual(version.draft, source.draft);
      await closeDrawer(h.page, '采集源配置');
      return { sourceId: id, configRevision: source.configRevision, requestId: null, reusedExisting: true,
        saveEvidence: 'NOT_RUN_ALREADY_EXISTS', readbackEvidence: 'REAL_UI_HTTP_LIST_AND_VERSION' };
    }
    assert.equal(existing.data.total, 0, 'Source exists; retain its receipt and use runSpectrumSourceReadback to resume');
    await click(button(panel, '新增来源'));
    const form = await unique(drawer(h.page, '采集源配置'));
    await fill(form.getByRole('textbox', { name: '来源编号', exact: true }), id);
    await fill(form.getByRole('textbox', { name: '名称', exact: true }), `R6-D ${id}`);
    await (await unique(form.getByRole('combobox', { name: '协议声明', exact: true }))).selectOption('HTTP_JSON');
    await fill(form.getByRole('textbox', { name: '地址声明', exact: true }), `${API}/r6-declaration-only`);
    await fill(form.getByRole('spinbutton', { name: '声明周期 / s', exact: true }), 5);
    await fill(form.getByRole('spinbutton', { name: '下限 / kHz', exact: true }), 7000);
    await fill(form.getByRole('spinbutton', { name: '上限 / kHz', exact: true }), 7200);
    await fill(form.getByRole('textbox', { name: '来源说明', exact: true }), 'R6-D 构造配置，仅声明及离线格式校验，非实测');
    await (await unique(form.getByRole('checkbox', { name: '启用声明', exact: true }))).uncheck();
    const [saved] = await http(h.page, [{ method: 'POST', path: '/spectrum/sources' }], () => click(button(form, '保存')));
    assert.equal(saved.body.sourceId, id); assert.equal(saved.body.baseConfigRevision, null);
    assert.equal(saved.data.requestId, saved.body.requestId); assert.equal(saved.data.operationType, 'SOURCE_SAVE');
    assert.equal(saved.data.sourceId, id); assert.equal(saved.data.changed, true);
    assert.deepEqual(saved.data.source.draft, saved.body.draft);
    assert.equal(saved.data.source.draft.enabled, false);
    await contains(form, saved.data.configRevision);
    await enabled(button(form, '版本记录'));
    await closeDrawer(h.page, '采集源配置');
    return { sourceId: id, configRevision: saved.data.configRevision, requestId: saved.data.requestId,
      reusedExisting: false, saveEvidence: 'REAL_UI_HTTP_SOURCE_SAVE' };
  });
}

export async function runSpectrumSourceReadback(h) {
  return caseRecord(h, 'spectrum-source-readback', [['POST', /^\/spectrum\/sources\/[^/]+\/checks$/]], async () => {
    await ledger(h);
    const panel = await openSpectrumSources(h), id = identities(h).sourceId;
    await fill(panel.getByRole('textbox', { name: '搜索采集源', exact: true }), id);
    const [listed] = await http(h.page, [{ path: '/spectrum/sources', query: { search: id } }], () => click(iconButton(panel, '搜索')));
    assert.equal(listed.data.total, 1, 'R6-D source must already exist');
    const source = listed.data.items[0], path = `/spectrum/sources/${encodeURIComponent(id)}`;
    assert.equal(source.sourceId, id);
    const row = panel.locator('tbody tr').filter({ hasText: id });
    const [check] = await http(h.page, [{ method: 'POST', path: `${path}/checks` }], () => click(button(row, '离线校验')));
    assert.equal(check.data.sourceId, id); assert.equal(check.data.configRevision, source.configRevision);
    assert.equal(check.data.operationType, 'SOURCE_CHECK'); assert.equal(check.data.changed, false);
    assert.equal(check.data.check.validationMode, 'OFFLINE_ONLY'); assert.equal(check.data.check.connection, 'NOT_ATTEMPTED');
    assert.equal(check.data.check.validation, 'VALID');
    await contains(row, '格式有效'); await contains(row, '连接未尝试');
    await click(iconButton(row, '查看或编辑'));
    const form = await unique(drawer(h.page, '采集源配置'));
    const [versions] = await http(h.page, [{ path: `${path}/versions` }], () => click(button(form, '版本记录')));
    assert(versions.data.items.some(item => item.configRevision === source.configRevision));
    const [checks] = await http(h.page, [{ path: `${path}/checks`, query: { config_revision: source.configRevision } }], () => click(button(form, '本版本校验记录')));
    assert(checks.data.items.some(item => item.checkId === check.data.check.checkId && item.connection === 'NOT_ATTEMPTED'));
    await closeDrawer(h.page, '采集源配置');
    const exported = await exportJson(h, { path: `${path}/export`, query: { config_revision: source.configRevision } }, () => click(iconButton(row, '导出')), 'r6-d-source');
    assert.equal(exported.file.fileKind, 'SPECTRUM_SOURCE_CONFIG'); assert.equal(exported.file.sourceId, id);
    assert.equal(exported.file.configRevision, source.configRevision); assert.deepEqual(exported.file.draft, source.draft);
    // Select is an actual source-read operation; cancel before any observation import.
    const [selected] = await http(h.page, [{ path, query: { config_revision: source.configRevision } }], () => click(button(row, '选择')));
    assert.equal(selected.data.configRevision, source.configRevision);
    const importPanel = await unique(drawer(h.page, '显式导入观测'));
    await contains(importPanel, '不建立采集连接');
    await click(button(importPanel, '取消'));
    await importPanel.waitFor({ state: 'hidden', timeout: TIMEOUT });
    return { sourceId: id, configRevision: source.configRevision, checkId: check.data.check.checkId, connection: 'NOT_ATTEMPTED', download: exported.saved, bytes: exported.bytes, sha256: exported.sha256 };
  });
}

export async function runSpectrumObservation(h) {
  return caseRecord(h, 'spectrum-observation-frozen-readonly', [], async () => {
    await ledger(h);
    const [listing] = await http(h.page, [{ path: `${OBS}/datasets` }], () => click(button(h.page, '频谱观测')));
    const panel = h.page.locator('section.spectrum-monitor');
    const selection = h.observation;
    const dataset = selection ? listing.data.items.find(item => item.datasetId === selection.datasetId && item.datasetRevision === selection.datasetRevision)
      : listing.data.items.find(item => item.frameCount >= 2 && item.frameCount <= 3);
    assert(dataset, 'Main must prepare a bound finite observation in the first page; pass observation:{datasetId,datasetRevision} to select it');
    assert(dataset.frameCount >= 2 && dataset.frameCount <= 256, 'Finite 2..256-frame fixture required');
    const path = `${OBS}/datasets/${encodeURIComponent(dataset.datasetId)}`, query = { dataset_revision: dataset.datasetRevision };
    const row = panel.getByRole('table', { name: '观测集', exact: true }).getByRole('row')
      .filter({ has: h.page.getByRole('cell').filter({ hasText: dataset.datasetId }) })
      .filter({ has: h.page.getByRole('cell', { name: dataset.importedAt, exact: true }) });
    const [context, first, frames, binding] = await http(h.page, [
      { path: `${OBS}/context`, query: { dataset_id: dataset.datasetId, ...query } },
      { path: `${path}/frames/0`, query }, { path: `${path}/frames`, query }, { path: `${path}/device-status-ref`, query },
    ], () => click(button(row, '选择')));
    assert.equal(context.data.selected.datasetRevision, dataset.datasetRevision);
    assert.deepEqual(context.data.replay, { mode: 'FINITE', loop: false, maxFramesPerDataset: 256, maxBinsPerFrame: 256 });
    assert.equal(first.data.index, 0); assert.equal(first.data.hasPrevious, false);
    const ref = binding.data.deviceStatusRef;
    assert(ref && ref.deviceIds.length, 'Selected observation must have a persisted frozen state binding');
    assert.equal(ref.resourceRevision, dataset.resourceRevision);
    await contains(panel.locator('dl.identity'), dataset.datasetRevision);
    const [next] = await http(h.page, [{ path: `${path}/frames/1`, query }], () => click(iconButton(panel, '下一帧')));
    assert.equal(next.data.index, 1); assert.equal(next.data.datasetRevision, dataset.datasetRevision);
    const [previous] = await http(h.page, [{ path: `${path}/frames/0`, query }], () => click(iconButton(panel, '上一帧')));
    assert.deepEqual(previous.data, first.data);
    // Seek to the penultimate frame through the visible stored-frame pager, then play once.
    let framePage = frames.data;
    const penultimate = dataset.frameCount - 2, targetPage = Math.floor(penultimate / framePage.pageSize) + 1;
    assert(targetPage <= 256, 'Bound the UI pager');
    for (let number = 2; number <= targetPage; number++) {
      const [value] = await http(h.page, [{ path: `${path}/frames`, query: { ...query, page: number } }], () => click(iconButton(panel, '后页帧')));
      framePage = value.data;
    }
    const choice = framePage.items.find(item => item.index === penultimate);
    assert(choice, 'Penultimate frame must be present on its visible page');
    if (penultimate !== 0) await http(h.page, [{ path: `${path}/frames/${penultimate}`, query }], () => click(button(panel, `${penultimate + 1} · ${choice.label}`)));
    await fill(panel.getByRole('spinbutton', { name: '回放间隔 / s', exact: true }), 1);
    await panel.getByRole('spinbutton', { name: '回放间隔 / s', exact: true }).press('Tab');
    const [last] = await http(h.page, [{ path: `${path}/frames/${dataset.frameCount - 1}`, query }], () => click(iconButton(panel, '播放')));
    assert.equal(last.data.hasNext, false); assert.equal(last.data.index, dataset.frameCount - 1);
    const terminal = panel.getByRole('status').filter({ hasText: '已到末帧' });
    await contains(terminal, `${dataset.frameCount} / ${dataset.frameCount}`);
    // Finite completion disables the toggle; its active label may remain "暂停".
    const playbackToggle = panel.locator('button[aria-label="播放"], button[aria-label="暂停"]');
    await enabled(playbackToggle, false); await enabled(iconButton(panel, '下一帧'), false);
    const terminalControlLabel = await playbackToggle.getAttribute('aria-label');
    assert(['播放', '暂停'].includes(terminalControlLabel), 'Expected one explicitly labelled playback toggle');
    const terminalRequests = [];
    const listener = request => { if (apiPath(request)?.startsWith(`${path}/frames/`)) terminalRequests.push(apiPath(request)); };
    h.page.on('request', listener);
    try { await delay(1200); assert.deepEqual(terminalRequests, [], 'Finite playback must stop without wrapping during the next interval'); }
    finally { h.page.off('request', listener); }
    await http(h.page, [{ path: `${path}/frames/0`, query }], () => click(iconButton(panel, '重播')));
    await contains(panel.getByRole('status').filter({ hasText: '已暂停' }), `1 / ${dataset.frameCount}`);
    const memberIds = ref.deviceIds.slice(0, 20), statusPath = `/device-status/snapshots/${encodeURIComponent(ref.snapshotId)}`;
    const [rebound, header, ...members] = await http(h.page, [
      { path: `${path}/device-status-ref`, query },
      { path: statusPath, query: { snapshot_revision: ref.snapshotRevision } },
      ...memberIds.map(id => ({ path: `${statusPath}/devices`, query: { snapshot_revision: ref.snapshotRevision, device_id: id, page_size: 1 } })),
    ], () => click(button(panel, '查看冻结引用')));
    assert.deepEqual(rebound.data.deviceStatusRef, ref);
    assert.equal(header.data.snapshot_id, ref.snapshotId); assert.equal(header.data.snapshot_revision, ref.snapshotRevision);
    assert.equal(header.data.resource_revision, ref.resourceRevision);
    const frozen = await unique(drawer(h.page, '观测冻结状态引用'));
    await contains(frozen, dataset.datasetRevision); await contains(frozen, ref.refRevision);
    const table = frozen.getByRole('table', { name: '冻结引用成员', exact: true });
    await until(async () => await table.locator('tbody tr').count() === memberIds.length, 'Frozen member rows must finish loading');
    for (let index = 0; index < memberIds.length; index++) {
      const value = members[index].data;
      assert.equal(value.snapshot_revision, ref.snapshotRevision); assert.equal(value.resource_revision, ref.resourceRevision);
      assert.equal(value.total, 1); assert.equal(value.items[0].device_id, memberIds[index]);
      const item = value.items[0], memberRow = table.getByRole('row').filter({ has: h.page.getByRole('cell', { name: item.device_id, exact: true }) });
      await unique(memberRow);
      if ([item.status, item.alert, item.observed_at].includes(null)) await contains(memberRow, '未知');
    }
    await h.shot('r6-d-observation-frozen-members');
    await closeDrawer(h.page, '观测冻结状态引用');
    const exported = await exportJson(h, { path: `${path}/export`, query: { ...query, include_device_status_ref: true } }, () => click(iconButton(panel, '导出观测')), 'r6-d-observation');
    assert.equal(exported.file.schemaVersion, 2); assert.equal(exported.file.fileKind, 'SPECTRUM_OBSERVATION_DATASET');
    assert.equal(exported.file.dataOrigin, 'SYNTHETIC_INTEGRATION'); assert.equal(exported.file.dataset.datasetId, dataset.datasetId);
    assert.equal(exported.file.dataset.resourceRevision, ref.resourceRevision); assert.equal(exported.file.dataset.frames.length, dataset.frameCount);
    for (const key of ['snapshotId', 'snapshotRevision', 'resourceRevision', 'deviceIds']) assert.deepEqual(exported.file.deviceStatusRef[key], ref[key]);
    return { datasetId: dataset.datasetId, datasetRevision: dataset.datasetRevision, frameCount: dataset.frameCount, replayedSteps: 2, terminalIndex: last.data.index,
      terminalControlLabel, terminalControlDisabled: true,
      snapshotId: ref.snapshotId, snapshotRevision: ref.snapshotRevision, refRevision: ref.refRevision, checkedMembers: memberIds.length,
      memberPagesNotRun: Math.max(0, Math.ceil(ref.deviceIds.length / 20) - 1), download: exported.saved, bytes: exported.bytes, sha256: exported.sha256 };
  });
}

async function systemPage(h, tab, path) {
  await enter(h, 'system', [{ path: '/system/options' }]);
  const [listing] = await http(h.page, [{ path }], () => click(button(h.page, tab)));
  return listing.data;
}
export async function runSystemParameters(h) {
  assert.equal(h.performanceComplete, true, 'Main must finish perf and explicitly pass performanceComplete:true before parameter writes');
  return caseRecord(h, 'system-par01-save-defaults', [['PUT', '/system/parameters/PAR-01'], ['POST', '/system/actions/reset-parameters']], async () => {
    const listing = await systemPage(h, '参数配置', '/system/parameters');
    const original = listing.items.find(item => item.id === 'PAR-01'), timeout = listing.items.find(item => item.id === 'PAR-02');
    assert(original && timeout, 'PAR-01/PAR-02 must be visible');
    assert.equal(timeout.value, 15, 'The real default button includes PAR-02; stop before any writes if it is not already 15');
    assert.equal(original.readonly, false);
    const value = original.value === 31 ? 32 : 31;
    assert(value >= original.min && value <= original.max);
    const row = h.page.locator('.parameters-table').getByRole('row').filter({ has: h.page.getByRole('cell', { name: original.name, exact: true }) });
    const [detail] = await http(h.page, [{ path: '/system/parameters/PAR-01' }], () => click(button(row, '编辑')));
    assert.equal(detail.data.parameter.id, 'PAR-01');
    const form = await unique(drawer(h.page, '参数配置'));
    await fill(form.getByRole('spinbutton'), value);
    const [saved] = await http(h.page, [{ method: 'PUT', path: '/system/parameters/PAR-01', checkRequest: body => assert.equal(body.value, value) }], () => click(button(form, '保存参数')));
    assert.equal(saved.data.objectId, 'PAR-01'); assert.equal(saved.data.changed, true);
    assert.notEqual(saved.data.revision, detail.data.revision);
    await form.waitFor({ state: 'hidden', timeout: TIMEOUT });
    const [readback] = await http(h.page, [{ path: '/system/parameters/PAR-01' }], () => click(button(row, '编辑')));
    assert.equal(readback.data.parameter.value, value);
    await contains(drawer(h.page, '参数配置'), '本标签状态');
    await h.shot('r6-d-par01-saved');
    await closeDrawer(h.page, '参数配置');
    await click(button(h.page, '恢复参数默认值'));
    const decision = await unique(drawer(h.page, '恢复参数默认值'));
    await contains(decision, '账号、角色、业务和历史不变');
    const [restored] = await http(h.page, [{ method: 'POST', path: '/system/actions/reset-parameters', checkRequest: body => {
      assert.deepEqual(body.parameterIds, ['PAR-01', 'PAR-02']); assert.equal(body.confirm, 'RESTORE_PARAMETER_DEFAULTS');
    } }], () => click(button(decision, '确认')));
    assert.equal(restored.data.objectId, 'parameters'); assert.equal(restored.data.changed, true);
    const [after] = await http(h.page, [{ path: '/system/parameters' }], () => click(button(h.page, '查询')));
    assert.equal(after.data.items.find(item => item.id === 'PAR-01').value, 30);
    assert.equal(after.data.items.find(item => item.id === 'PAR-02').value, timeout.value);
    return { parameterId: 'PAR-01', before: original.value, saved: value, restored: 30, par02Before: timeout.value, par02After: 15,
      saveOperationId: saved.data.operationId, restoreOperationId: restored.data.operationId };
  });
}

export async function runSystemLogs(h) {
  return caseRecord(h, 'system-log-query-archive', [['POST', '/system/actions/archive-logs']], async () => {
    await systemPage(h, '操作日志', '/system/logs');
    await (await unique(h.page.getByRole('checkbox', { name: '包含归档历史', exact: true }))).check();
    const [before] = await http(h.page, [{ path: '/system/logs', query: { includeArchived: true } }], () => click(button(h.page, '查询')));
    assert(before.data.items.length, 'At least one persistent audit event is required');
    const event = before.data.items[0];
    assert.equal(event.authSource, 'LOCAL_PASSWORD');
    const checkbox = h.page.getByRole('checkbox', { name: '包含归档历史', exact: true });
    await checkbox.uncheck();
    const [active] = await http(h.page, [{ path: '/system/logs', query: { includeArchived: false } }], () => click(button(h.page, '查询')));
    assert(Number.isSafeInteger(active.data.snapshotSequence));
    await click(button(h.page, '归档日志视图'));
    const decision = await unique(drawer(h.page, '归档日志视图'));
    await contains(decision, '原事件保留');
    const [archived] = await http(h.page, [{ method: 'POST', path: '/system/actions/archive-logs', checkRequest: body => {
      assert.equal(body.confirm, 'ARCHIVE_LOG_VIEW'); assert.equal(body.throughSequence, active.data.snapshotSequence);
      assert.equal(body.baseAuditRevision, active.data.revision);
    } }], () => click(button(decision, '确认')));
    assert.equal(archived.data.objectId, 'audit-view'); assert.equal(archived.data.archivedThroughSequence, active.data.snapshotSequence);
    await enabled(button(h.page, '查询'));
    await checkbox.check();
    const [after] = await http(h.page, [{ path: '/system/logs', query: { includeArchived: true } }], () => click(button(h.page, '查询')));
    assert(after.data.total >= before.data.total, 'Archive must retain original audit records');
    const index = after.data.items.findIndex(item => item.id === event.id);
    assert(index >= 0, 'The most recent retained pre-archive event must remain visible on the first page');
    assert.deepEqual(after.data.items[index], event, 'Archive must not rewrite the original audit event');
    const rows = h.page.locator('.logs-table tbody tr');
    await until(async () => await rows.count() === after.data.items.length, 'Log table must match the HTTP page');
    // Index is taken from the just-asserted HTTP order; detail ID is independently checked.
    const row = rows.nth(index);
    await contains(row, event.summary);
    const [detail] = await http(h.page, [{ path: `/system/logs/${encodeURIComponent(event.id)}` }], () => click(row));
    assert.deepEqual(detail.data, event);
    await contains(drawer(h.page, '操作日志详情'), event.id);
    await h.shot('r6-d-log-retained-detail');
    await closeDrawer(h.page, '操作日志详情');
    return { retainedEventId: event.id, throughSequence: active.data.snapshotSequence, archiveOperationId: archived.data.operationId,
      beforeTotal: before.data.total, afterTotal: after.data.total, includeArchived: true, deletedRecords: 0 };
  });
}

export const cases = Object.freeze({
  deviceConfiguration: runDeviceConfiguration, statusEntry: runStatusEntry, deviceTrace: runDeviceTrace,
  frequencyAdd: runFrequencyAdd, frequencyPatch: runFrequencyPatch, frequencyEnable: runFrequencyEnable,
  frequencyDuplicate: runFrequencyDuplicate, spectrumSource: runSpectrumSource,
  spectrumSourceReadback: runSpectrumSourceReadback, spectrumObservation: runSpectrumObservation,
  systemLogs: runSystemLogs, systemParameters: runSystemParameters,
});

export async function runOperations(h) {
  contract(h);
  const selected = h.caseNames ?? (process.env.R6_D_CASES ? process.env.R6_D_CASES.split(',').map(value => value.trim()) : ['statusEntry']);
  assert(Array.isArray(selected) && selected.length && new Set(selected).size === selected.length, 'Select a nonempty, unique case list');
  assert(selected.every(name => Object.hasOwn(cases, name)), 'Unknown operations case');
  const input = { ...h,
    performanceComplete: h.performanceComplete ?? process.env.R6_D_PERFORMANCE_COMPLETE === '1',
    observation: h.observation ?? (process.env.R6_D_OBSERVATION_ID && process.env.R6_D_OBSERVATION_REVISION ? {
      datasetId: process.env.R6_D_OBSERVATION_ID, datasetRevision: process.env.R6_D_OBSERVATION_REVISION,
    } : undefined),
  };
  const results = {};
  for (const name of selected) results[name] = await cases[name](input);
  return { results, notRun: Object.keys(cases).filter(name => !selected.includes(name)) };
}

async function configureRefreshScenario(h, beforeValue, afterValue, label) {
  assert([[30, 5], [5, 30]].some(([before, after]) => before === beforeValue && after === afterValue), 'Only 30->5 or 5->30 refresh transitions are permitted');
  return caseRecord(h, label, [['PUT', '/system/parameters/PAR-01']], async () => {
    const listing = await systemPage(h, '参数配置', '/system/parameters');
    const refresh = listing.items.find(item => item.id === 'PAR-01');
    const timeout = listing.items.find(item => item.id === 'PAR-02');
    assert(refresh && timeout, 'PAR-01 and PAR-02 must both be visible before editing');
    assert.equal(refresh.value, beforeValue, 'Unexpected refresh interval; stop without submitting or retrying');
    assert.equal(refresh.readonly, false);
    assert(afterValue >= refresh.min && afterValue <= refresh.max, 'Requested interval is outside the actual parameter limits');
    const row = h.page.locator('.parameters-table').getByRole('row').filter({
      has: h.page.getByRole('cell', { name: refresh.name, exact: true }),
    });
    const [detail] = await http(h.page, [{ path: '/system/parameters/PAR-01' }], () => click(button(row, '编辑')));
    assert.equal(detail.data.parameter.id, 'PAR-01');
    assert.equal(detail.data.parameter.value, beforeValue);
    assert.equal(detail.data.parameter.readonly, false);
    assert.equal(detail.data.revision, listing.revision, 'System parameters changed since the initial read');
    const form = await unique(drawer(h.page, '参数配置'));
    await fill(form.getByRole('spinbutton'), afterValue);
    const [saved] = await http(h.page, [{ method: 'PUT', path: '/system/parameters/PAR-01', checkRequest: body => {
      assert.deepEqual(Object.keys(body).sort(), ['baseRevision', 'requestId', 'value']);
      assert.equal(body.baseRevision, detail.data.revision);
      assert.equal(body.value, afterValue);
      assert.equal(typeof body.requestId, 'string');
      assert(body.requestId.length > 0);
    } }], () => click(button(form, '保存参数')));
    assert.equal(saved.data.objectId, 'PAR-01');
    assert.equal(saved.data.changed, true);
    assert.notEqual(saved.data.revision, detail.data.revision);
    await form.waitFor({ state: 'hidden', timeout: TIMEOUT });
    const [readback] = await http(h.page, [{ path: '/system/parameters/PAR-01' }], () => click(button(row, '编辑')));
    assert.equal(readback.data.parameter.id, 'PAR-01');
    assert.equal(readback.data.parameter.value, afterValue);
    await contains(drawer(h.page, '参数配置'), '本标签状态');
    await closeDrawer(h.page, '参数配置');
    const [after] = await http(h.page, [{ path: '/system/parameters' }], () => click(button(h.page, '查询')));
    assert.equal(after.data.items.find(item => item.id === 'PAR-01')?.value, afterValue);
    assert.equal(after.data.items.find(item => item.id === 'PAR-02')?.value, timeout.value, 'PAR-02 must remain unchanged');
    return { resultKind: 'PERFORMANCE_SCENARIO_CONFIGURATION', performanceResult: 'NOT_EVALUATED',
      parameterId: 'PAR-01', before: beforeValue, after: afterValue, par02Before: timeout.value, par02After: timeout.value,
      requestId: saved.body.requestId, operationId: saved.data.operationId, revision: after.data.revision };
  });
}

export async function setupFiveSecondRefresh(h) {
  return configureRefreshScenario(h, 30, 5, 'setup-five-second-refresh');
}

export async function restoreThirtySecondRefresh(h) {
  return configureRefreshScenario(h, 5, 30, 'restore-thirty-second-refresh');
}

// The successful import drawer exposes no receipt-lookup control. This is an
// explicit read-only browser navigation, not a claimed UI-button workflow.
async function observationReceiptNavigation(h, requestId, datasetId) {
  assert.match(requestId, /^[A-Za-z0-9_.:-]{1,120}$/, 'Invalid original observation request ID');
  const path = `${OBS}/imports/${encodeURIComponent(requestId)}`;
  const url = `${FRONTEND}${PREFIX}${path}?include_device_status_ref=true`;
  const response = await h.page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  assert(response, 'Original receipt navigation returned no response');
  assert.equal(response.url(), url);
  assert.equal(response.request().method(), 'GET');
  assert.equal(response.request().resourceType(), 'document');
  assert.equal(response.fromServiceWorker(), false);
  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'] ?? '', /application\/json/i);
  const envelope = await response.json();
  assert.equal(envelope.code, 0);
  const operation = envelope.data;
  assert.equal(operation.schemaVersion, 2);
  assert.equal(operation.dataOrigin, 'SYNTHETIC_INTEGRATION');
  assert.equal(operation.operationType, 'OBSERVATION_IMPORT');
  assert.equal(operation.requestId, requestId);
  assert.equal(operation.status, 'COMMITTED', 'Original receipt is unresolved; do not create another import request');
  assert.equal(operation.receipt.requestId, requestId);
  assert.equal(operation.receipt.datasetId, datasetId);
  assert.equal(operation.receipt.frameCount, 3);
  assert.equal(operation.receipt.dataOrigin, 'SYNTHETIC_INTEGRATION');
  assert.equal(operation.deviceStatusRef.resourceRevision, operation.receipt.resourceRevision);
  assert(operation.deviceStatusRef.deviceIds.length >= 1 && operation.deviceStatusRef.deviceIds.length <= 2);
  return operation;
}

export async function runSpectrumObservationImport(h) {
  assert.equal(h.performanceComplete, true, 'Main must finish browser performance first; pass --performance-complete 1 when arranging this fixture');
  return caseRecord(h, 'spectrum-observation-import-v2', [['POST', `${OBS}/import-preview`], ['POST', `${OBS}/imports`]], async () => {
    const suffix = createHash('sha256').update(`${h.taskId}:${h.planId}`).digest('hex').slice(0, 12);
    const datasetId = `OBS-R6-D-${suffix}`;
    const originalId = h.observationRequestId ?? process.env.R6_D_OBSERVATION_REQUEST_ID;
    if (originalId) {
      await h.login('editor');
      assert.equal(urlOf(h.page.url()).origin, FRONTEND);
      const original = await observationReceiptNavigation(h, originalId, datasetId);
      return { datasetId, datasetRevision: original.receipt.datasetRevision, requestId: originalId,
        snapshotId: original.deviceStatusRef.snapshotId, snapshotRevision: original.deviceStatusRef.snapshotRevision,
        deviceIds: original.deviceStatusRef.deviceIds, resourceRevision: original.receipt.resourceRevision,
        resumedOriginal: true, importSubmitted: false, receiptReadbackMethod: 'READ_ONLY_BROWSER_NAVIGATION',
        performanceResult: 'NOT_EVALUATED' };
    }
    const baseline = await ledger(h, [{ path: '/device-status/snapshots', query: { context: 'ledger' } }]);
    const snapshotId = h.statusSnapshotId ?? process.env.R6_D_STATUS_SNAPSHOT_ID;
    const snapshot = baseline.other[0].data.items.find(item => item.resource_revision === baseline.context.revision
      && (!snapshotId || item.snapshot_id === snapshotId));
    assert(snapshot, 'Main must provide an existing same-resource DSS in the first directory page; this case never imports device status');
    const statusPanel = await unique(region(h.page, '设备状态快照'));
    const directory = statusPanel.locator('details').filter({ has: h.page.locator('summary').filter({ hasText: /^已导入批次\s*·/ }) });
    await unique(directory);
    if (await directory.getAttribute('open') === null) await click(directory.locator('summary'));
    const snapshotRow = directory.locator('li').filter({ hasText: snapshot.snapshot_id });
    const statusPath = `/device-status/snapshots/${encodeURIComponent(snapshot.snapshot_id)}`;
    const [header, members] = await http(h.page, [
      { path: statusPath, query: { snapshot_revision: snapshot.snapshot_revision } },
      { path: `${statusPath}/devices`, query: { snapshot_revision: snapshot.snapshot_revision, page: 1, page_size: 20 } },
    ], () => click(button(snapshotRow, snapshot.source_label)));
    assert.equal(header.data.snapshot_id, snapshot.snapshot_id);
    assert.equal(header.data.snapshot_revision, snapshot.snapshot_revision);
    assert.equal(header.data.resource_revision, baseline.context.revision);
    assert.equal(header.data.data_origin, 'SYNTHETIC_INTEGRATION');
    assert.equal(members.data.resource_revision, baseline.context.revision);
    assert.equal(members.data.snapshot_revision, snapshot.snapshot_revision);
    const requestedIds = h.deviceIds ?? ['DV-0001', 'DV-0002'].filter(id => members.data.items.some(item => item.device_id === id));
    assert(Array.isArray(requestedIds) && requestedIds.length >= 1 && requestedIds.length <= 2 && new Set(requestedIds).size === requestedIds.length,
      'Select one or two existing declared DSS members, normally DV-0001/DV-0002');
    const deviceIds = [...requestedIds].sort();
    for (const id of deviceIds) assert(members.data.items.some(item => item.device_id === id), `${id} must actually be present in the selected DSS page`);
    const deviceStatusRef = { snapshotId: snapshot.snapshot_id, snapshotRevision: snapshot.snapshot_revision,
      resourceRevision: baseline.context.revision, deviceIds };
    // Check existence before opening the importer. A previous write may have
    // succeeded even if its response was lost; never create a replacement ID.
    const [datasets] = await http(h.page, [{ path: `${OBS}/datasets` }], () => click(button(h.page, '频谱观测')));
    assert.equal(datasets.data.page, 1);
    assert(datasets.data.total <= datasets.data.pageSize, 'Inspect the existing dataset pages before importing; automatic pagination is disabled');
    assert(!datasets.data.items.some(item => item.datasetId === datasetId),
      `Dataset ${datasetId} already exists; supply its original R6_D_OBSERVATION_REQUEST_ID for read-only receipt recovery`);
    const sources = await openSpectrumSources(h), sourceId = identities(h).sourceId;
    await fill(sources.getByRole('textbox', { name: '搜索采集源', exact: true }), sourceId);
    const [listed] = await http(h.page, [{ path: '/spectrum/sources', query: { search: sourceId } }], () => click(iconButton(sources, '搜索')));
    assert.equal(listed.data.total, 1, 'Reuse the deterministic source already created by runSpectrumSource/Readback');
    const source = listed.data.items[0];
    assert.equal(source.sourceId, sourceId);
    assert.equal(source.dataOrigin, 'SYNTHETIC_INTEGRATION');
    assert.match(source.configRevision, /^SPV-[a-f0-9]{64}$/);
    assert(Number.isFinite(source.draft.minKhz) && Number.isFinite(source.draft.maxKhz) && source.draft.minKhz > 0 && source.draft.maxKhz > source.draft.minKhz);
    const sourceRow = sources.locator('tbody tr').filter({ hasText: sourceId });
    const [selected] = await http(h.page, [{ path: `/spectrum/sources/${encodeURIComponent(sourceId)}`, query: { config_revision: source.configRevision } }],
      () => click(button(sourceRow, '选择')));
    assert.equal(selected.data.configRevision, source.configRevision);
    assert.deepEqual(selected.data.draft, source.draft);
    const panel = await unique(drawer(h.page, '显式导入观测'));
    const provenanceNote = `R6-D有限回放浏览器验收；内存构造3帧，非实测，不建立采集连接；采集时间、占用率、功率、异常判定均未知；登记来源${sourceId}@${source.configRevision}；只读引用既有${snapshot.snapshot_id}，不生成或修改设备状态`;
    assert(provenanceNote.length <= 500);
    const file = { schemaVersion: 2, fileKind: 'SPECTRUM_OBSERVATION_DATASET', dataOrigin: 'SYNTHETIC_INTEGRATION', deviceStatusRef,
      dataset: { datasetId, provenanceNote, resourceRevision: baseline.context.revision, deviceStatusSnapshotId: null,
        source: { sourceId, name: source.draft.name, configRevision: source.configRevision, minKhz: source.draft.minKhz,
          maxKhz: source.draft.maxKhz, intervalSeconds: source.draft.intervalSeconds },
        frames: Array.from({ length: 3 }, (_, index) => ({ frameId: `R6-D-FRAME-${index}`, index, observedAt: null,
          label: `构造非实测帧 ${index + 1}`, occupancyPercent: null, abnormalBandCount: null,
          unknownReasons: ['构造验收资料，未提供真实观测值和采集时间'],
          bins: [{ binId: `R6-D-BIN-${index}`, minKhz: source.draft.minKhz, maxKhz: source.draft.maxKhz,
            occupancyPercent: null, powerDbm: null, abnormal: null, reason: null,
            unknownReasons: ['未实测，占用率、接收功率与异常判定均未知'] }] })) } };
    const buffer = Buffer.from(JSON.stringify(file), 'utf8');
    assert(buffer.length < 2 * 1024 * 1024);
    const input = await unique(panel.getByLabel('观测 JSON', { exact: true }));
    await input.setInputFiles({ name: `${datasetId}.json`, mimeType: 'application/json', buffer });
    await contains(panel.locator('dl.summary'), datasetId);
    await contains(panel.locator('dl.summary'), snapshot.snapshot_id);
    const [preview] = await http(h.page, [{ method: 'POST', path: `${OBS}/import-preview`,
      checkRequest: body => assert.deepEqual(body.file, file) }], () => click(button(panel, '预检')));
    assert.equal(preview.data.schemaVersion, 2);
    assert.equal(preview.data.sourceBinding, 'REGISTERED_VERSION');
    assert.equal(preview.data.frameCount, 3);
    assert.equal(preview.data.resourceRevision, baseline.context.revision);
    assert.match(preview.data.previewHash, /^[a-f0-9]{64}$/);
    assert.match(preview.data.datasetContentHash, /^[a-f0-9]{64}$/);
    assert.equal(preview.data.datasetRevision, `observation-${preview.data.datasetContentHash}`);
    for (const key of Object.keys(deviceStatusRef)) assert.deepEqual(preview.data.deviceStatusRef[key], deviceStatusRef[key]);
    await contains(panel.locator('.preview'), '预检通过 · 尚未写入');
    let requestId = '';
    const captureOriginal = request => {
      if (apiPath(request) === `${OBS}/imports` && request.method() === 'POST') {
        const body = request.postDataJSON();
        if (body?.file?.dataset?.datasetId === datasetId) requestId = body.requestId;
      }
    };
    h.page.on('request', captureOriginal);
    try {
      const [submitted] = await http(h.page, [{ method: 'POST', path: `${OBS}/imports`, checkRequest: body => {
        assert.deepEqual(body.file, file);
        assert.equal(body.previewHash, preview.data.previewHash);
        assert.equal(body.datasetContentHash, preview.data.datasetContentHash);
        assert.equal(body.requestId, requestId);
      } }], () => click(button(panel, '确认导入')));
      assert.equal(submitted.data.requestId, requestId);
      assert.equal(submitted.data.status, 'COMMITTED');
      assert.equal(submitted.data.receipt.datasetRevision, preview.data.datasetRevision);
      for (const key of Object.keys(deviceStatusRef)) assert.deepEqual(submitted.data.deviceStatusRef[key], deviceStatusRef[key]);
      await contains(panel.locator('dl.summary').filter({ hasText: '持久化回执' }), requestId);
      await h.shot('r6-d-observation-import-ui-receipt');
      await click(button(panel, '关闭'));
      await panel.waitFor({ state: 'hidden', timeout: TIMEOUT });
      const original = await observationReceiptNavigation(h, requestId, datasetId);
      assert.deepEqual(original, submitted.data, 'Original GET receipt must equal the UI-submitted operation');
      return { datasetId, datasetRevision: original.receipt.datasetRevision, requestId, sourceId, configRevision: source.configRevision,
        resourceRevision: baseline.context.revision, snapshotId: snapshot.snapshot_id, snapshotRevision: snapshot.snapshot_revision, deviceIds,
        frameCount: 3, provenanceNote, fileBytes: buffer.length, fileSha256: createHash('sha256').update(buffer).digest('hex'),
        frozenMembersReadOnly: true, importSubmitted: true, receiptReadbackMethod: 'READ_ONLY_BROWSER_NAVIGATION',
        performanceResult: 'NOT_EVALUATED' };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.message += `; datasetId=${datasetId}; originalRequestId=${requestId || 'NOT_OBSERVED'}; stop and recover the original receipt, do not resubmit`;
      throw failure;
    } finally { h.page.off('request', captureOriginal); }
  });
}

// 末尾独立入口：只由主显式 --entry 调用，不加入 cases 或默认流程。
const OPERATIONS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESOURCE_SAVE = /^\/resource\/(?:changes|workspace\/changes)$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const omitHeight = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'antenna_height_m'));

async function lateWriteFile(h, kind) {
  contract(h);
  assert.equal(h.performanceComplete, true, '末尾入口须由主显式传入 --performance-complete 1');
  const runtime = path.resolve(h.runtime);
  assert.equal(path.dirname(runtime), path.join(OPERATIONS_ROOT, 'data/runtime/r2'));
  assert.match(path.basename(runtime), /^r4-[a-f0-9]{32}$/);
  const file = path.join(runtime, `r6-d-${kind}-${digest(`${h.taskId}:${h.planId}`).slice(0, 12)}.json`);
  let previous;
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!previous, `已有末尾检查点 ${file}；原号=${previous?.requestId ?? previous?.payload?.request_id ?? '尚未观察到'}，DSS=${previous?.response?.snapshot_id ?? '未知'}。只核实原号，不自动重提或删除检查点。`);
  return file;
}

async function armLateWrite(h, file, kind, detail) {
  const state = { schema: 'r6-d-late-write-v1', kind, taskId: h.taskId, planId: h.planId,
    runtime: path.resolve(h.runtime), phase: 'ARMED_NO_RETRY', sentCount: 0, ...detail };
  // 独占创建：跨CLI也不能用新证据目录绕过一次提交保护。只读/写本组检查点，不读private。
  await fs.writeFile(file, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
  let pending = Promise.resolve(), sequence = 0;
  const save = patch => {
    Object.assign(state, patch);
    const text = JSON.stringify(state, null, 2), temporary = `${file}.${process.pid}.${++sequence}.tmp`;
    pending = pending.then(async () => {
      await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, file);
    });
    pending.catch(() => {});
    return pending;
  };
  await h.record(`R6-D-${kind}-intent-only`, async () => ({ resultKind: 'MUTATION_INTENT_CHECKPOINT',
    acceptanceResult: 'NOT_EVALUATED', checkpoint: file, ...state }));
  return { state, save, flush: () => pending, file };
}

async function submitLateOnce(h, guard, endpoint, action, checkRequest) {
  let captureError;
  const capture = request => {
    if (request.method() !== 'POST' || !apiPath(request)
      || !(typeof endpoint === 'string' ? apiPath(request) === endpoint : endpoint.test(apiPath(request)))) return;
    try {
      const body = request.postDataJSON();
      void guard.save({ phase: 'SENT_NO_RETRY', sentCount: guard.state.sentCount + 1,
        requestId: body.request_id, requestPath: apiPath(request), actualRequest: body });
    } catch (error) { captureError = error; }
  };
  h.page.on('request', capture);
  try {
    const [result] = await http(h.page, [{ method: 'POST', path: endpoint }], action);
    // 回执先落盘，再断言字段；断言失败也保留已受理事实，不能再点一次。
    await guard.save({ phase: 'ACK_RECEIVED_NO_RETRY', response: result.data });
    if (captureError) throw captureError;
    assert.equal(guard.state.sentCount, 1, '一个明确UI动作只能发出一次持久化请求');
    assert.equal(typeof guard.state.requestId, 'string'); assert(guard.state.requestId);
    assert.equal(result.body.request_id, guard.state.requestId);
    checkRequest(result.body);
    return result.data;
  } catch (error) {
    await guard.flush().catch(() => {});
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.message += `；保留检查点=${guard.file}；原号=${guard.state.requestId ?? '未观察到'}；DSS=${guard.state.response?.snapshot_id ?? '未观察到'}；禁止重提交`;
    throw failure;
  } finally { h.page.off('request', capture); }
}

async function completeLedger(h, baseline) {
  const table = await unique(h.page.locator('.split > section.panel .p-datatable'));
  await click(table.getByRole('combobox'));
  const [first] = await http(h.page, [{ path: '/resource/devices', query: {
    context: 'ledger', revision: baseline.context.revision, page: 1, page_size: 50,
  } }], () => click(h.page.getByRole('option', { name: '50', exact: true })));
  const total = baseline.context.stats.devices;
  assert(Number.isSafeInteger(total) && total > 0 && total <= 1000, '完整状态导入只接受当前1至1000台设备');
  const items = [], pages = Math.ceil(total / 50);
  let current = first;
  for (let page = 1; page <= pages; page++) {
    const data = current.data;
    assert.equal(data.revision, baseline.context.revision); assert.equal(data.content_hash, baseline.context.content_hash);
    assert.equal(data.total, total); assert.equal(data.page, page); assert.equal(data.page_size, 50);
    assert(!data.observation_snapshot_id && (!data.status_mode || data.status_mode === 'baseline'));
    assert.equal(data.items.length, Math.min(50, total - items.length));
    for (const item of data.items) {
      for (const key of ['device_id', 'node_id', 'model_id']) {
        assert.equal(typeof item[key], 'string');
        assert(item[key].length > 0 && item[key].length <= 120 && !/\s|[\u0000-\u001f\u007f]/.test(item[key]), `当前设备关联无效：${key}`);
      }
      assert(['ACTIVE', 'OFF_SHELF'].includes(item.availability), '未知可用性不能补成ACTIVE');
      await unique(table.getByRole('checkbox', { name: `勾选 ${item.device_id}`, exact: true }));
    }
    items.push(...data.items);
    if (page < pages) [current] = await http(h.page, [{ path: '/resource/devices', query: {
      context: 'ledger', revision: baseline.context.revision, page: page + 1, page_size: 50,
    } }], () => click(table.locator('button.p-paginator-next')));
  }
  assert.equal(new Set(items.map(item => item.device_id)).size, total, '当前设备分页重复或遗漏');
  await enabled(table.locator('button.p-paginator-next'), false);
  return items.sort((a, b) => a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0);
}

async function traceTarget(h, baseline, id) {
  // 当前页已由真实HTTP读取时直接点该行；给相同搜索值不能凭空产生新GET。
  if (baseline.devices.items.some(item => item.device_id === id)) return openDevice({ ...h, deviceId: id }, baseline);
  const search = h.page.getByRole('textbox', { name: '搜索设备', exact: true });
  assert.notEqual(await search.inputValue(), id, '同一搜索的当前页没有原设备，先核对原查询，不盲等新GET');
  const [found] = await http(h.page, [{ path: '/resource/devices', query: {
    context: 'ledger', revision: baseline.context.revision, search: id, page: 1,
  } }], () => fill(search, id));
  assert(found.data.items.some(item => item.device_id === id), 'A维护的原设备在当前真实台账中不可见');
  return openDevice({ ...h, deviceId: id }, { ...baseline, devices: found.data });
}

async function allTraceHistory(h, device, revision) {
  const endpoint = `/device-traces/${encodeURIComponent(device.id)}`;
  const [first] = await http(h.page, [{ path: `${endpoint}/history`, query: { resource_revision: revision, page: 1 } }],
    () => click(button(device.panel, '变更追溯与历史版本')));
  const panel = await unique(drawer(h.page, '设备资源追溯'));
  assert(Number.isSafeInteger(first.data.total) && first.data.total > 0 && first.data.total <= 400,
    '历史不存在或超过本次有限UI分页范围，交主核对，不跳过历史查验');
  const items = [], pages = Math.ceil(first.data.total / first.data.page_size);
  let current = first.data;
  for (let page = 1; page <= pages; page++) {
    assert.equal(current.page, page); assert.equal(current.page_size, 20); assert.equal(current.total, first.data.total);
    for (const item of current.items) { assert.equal(item.device_id, device.id); items.push({ ...item, uiPage: page }); }
    if (page < pages) [current] = (await http(h.page, [{ path: `${endpoint}/history`, query: { resource_revision: revision, page: page + 1 } }],
      () => click(button(panel, '下一页')))).map(result => result.data);
  }
  assert.equal(items.length, first.data.total);
  let uiPage = pages;
  const select = async item => {
    while (uiPage !== item.uiPage) {
      const next = uiPage + (uiPage < item.uiPage ? 1 : -1);
      await http(h.page, [{ path: `${endpoint}/history`, query: { resource_revision: revision, page: next } }],
        () => click(button(panel, uiPage < item.uiPage ? '下一页' : '上一页')));
      uiPage = next;
    }
    if (item.request_id === null) { await click(button(panel, '留存基线（不是修改）')); return null; }
    const [detail] = await http(h.page, [{ path: `${endpoint}/operations/${encodeURIComponent(item.request_id)}`,
      query: { resource_revision: revision } }], () => click(button(panel, item.request_id)));
    assert.equal(detail.data.request_id, item.request_id); assert.equal(detail.data.device_id, device.id);
    return detail.data;
  };
  return { endpoint, panel, items, select };
}

function rawDeviceMatches(raw, item) {
  const numeric = new Set(['antenna_height_m', 'tx_power_dbm', 'work_freq_khz', 'tilt_deg', 'azimuth_deg']);
  for (const [field, value] of Object.entries(raw)) {
    const expected = numeric.has(field) ? value === '' || value === null ? null : Number(value)
      : field === 'status' ? value || null : field === 'availability' ? value || 'ACTIVE' : field === 'origin' ? value || 'SOURCE' : value;
    assert.deepEqual(item[field], expected, `维护原历史与当前设备字段不符：${field}`);
  }
}

async function refreshTarget(h, id) {
  const [context, devices] = await http(h.page, [
    { path: '/resource/context', query: { context: 'ledger' } }, { path: '/resource/devices', query: { context: 'ledger' } },
  ], () => click(button(h.page, '刷新资源')));
  return { baseline: { context: context.data, devices: devices.data },
    device: await traceTarget(h, { context: context.data, devices: devices.data }, id) };
}

export async function runDeviceTraceRestore(h) {
  const checkpoint = await lateWriteFile(h, 'trace-height-restore');
  const aFile = path.resolve(h.resourceWritesCheckpoint ?? process.env.R6_D_A_CHECKPOINT ??
    (process.env.R6_RESOURCE_WRITES_RUN_ID ? path.join(OPERATIONS_ROOT, 'data/runtime/r6', process.env.R6_RESOURCE_WRITES_RUN_ID, 'resource-writes-state.json') : ''));
  assert.equal(path.dirname(path.dirname(aFile)), path.join(OPERATIONS_ROOT, 'data/runtime/r6'), '必须提供本轮A原checkpoint路径');
  assert.match(path.basename(path.dirname(aFile)), /^[a-f0-9-]{36}$/); assert.equal(path.basename(aFile), 'resource-writes-state.json');
  const aBytes = await fs.readFile(aFile), a = JSON.parse(aBytes.toString('utf8'));
  assert.equal(a.schema, 'r6-resource-writes-v1'); assert.equal(path.resolve(a.runtime), path.resolve(h.runtime));
  assert.equal(a.taskId, h.taskId); assert.equal(a.planId, h.planId);
  const maintained = a.cases['A-R03-maintenance-save-discard'], operation = a.operations['R03-save'];
  const gisEdited = a.cases['A-G02-edit-undo-redo-save-readback'], gisOperation = a.operations['G02-save'];
  assert.equal(maintained?.phase, 'PASS'); assert.equal(operation?.phase, 'READBACK_CONFIRMED');
  assert.equal(gisEdited?.phase, 'PASS'); assert.equal(gisOperation?.phase, 'READBACK_CONFIRMED');
  const { id, before_height_m: targetHeight, saved_height_m: maintenanceHeight } = maintained.detail;
  const { id: gisDeviceId, before_height_m: gisBeforeHeight, saved_height_m: currentHeight } = gisEdited.detail;
  assert.equal(id, a.anchors.maintained_device_id);
  assert.equal(id, h.expectedMaintainedDeviceId ?? process.env.R6_D_MAINTAINED_DEVICE_ID ?? 'DV-0001', '非预期维护设备，须先交主核对');
  assert.equal(gisDeviceId, id, 'A的GIS有效设备选择与maintained_device_id不同，交主核对，不恢复另一设备');
  assert(Number.isFinite(targetHeight) && targetHeight >= 0 && Number.isFinite(maintenanceHeight) && Number.isFinite(currentHeight));
  assert.equal(maintenanceHeight, Number((targetHeight + 0.1).toFixed(4))); assert.equal(maintained.detail.discarded_input_not_saved, true);
  assert.equal(gisBeforeHeight, maintenanceHeight, 'G02前值必须精确衔接R03保存后值');
  assert.equal(currentHeight, Number((gisBeforeHeight + 0.2).toFixed(4))); assert.equal(gisEdited.detail.undo_redo_without_write, true);
  const originalId = operation.request?.request_id; assert.equal(typeof originalId, 'string'); assert(originalId);
  const gisId = gisOperation.request?.request_id; assert.equal(typeof gisId, 'string'); assert(gisId); assert.notEqual(gisId, originalId);
  for (const [op, context, height] of [[operation, 'ledger', maintenanceHeight], [gisOperation, 'gis', currentHeight]]) {
    assert.equal(op.request.context, context); assert.equal(op.request.base_revision, op.before_revision);
    const changes = op.request.changes ?? op.request;
    assert.equal(changes.devices.length, 1); assert.equal(changes.devices[0].id, id);
    assert.equal(changes.devices[0].antennaHeightM ?? changes.devices[0].antenna_height_m, height);
    for (const [key, rows] of Object.entries(changes)) {
      if ((op.request.changes && key !== 'devices') || (!op.request.changes && key === 'stations')) assert.deepEqual(rows, [], `A原操作含额外资源修改：${key}`);
    }
  }
  return caseRecord(h, 'trace-height-restore-once', [['POST', /^\/device-traces\/[^/]+\/restore-preview$/], ['POST', RESOURCE_SAVE]], async () => {
    const baseline = await ledger(h), device = await traceTarget(h, baseline, id);
    assert.equal(device.item.antenna_height_m, currentHeight, '最终当前值须以G02实际回读为准，不把R03 after当最终值');
    const trace = await allTraceHistory(h, device, baseline.context.revision);
    const index = trace.items.findIndex(item => item.request_id === originalId && item.kind === 'RESOURCE_CHANGE');
    assert(index >= 0, '当前UI历史没有A实际维护原号，不以基线冒充该修改分支');
    const gisIndex = trace.items.findIndex(item => item.request_id === gisId && item.kind === 'RESOURCE_CHANGE');
    assert.equal(gisIndex, 0, 'G02必须是该设备最新实际修改；出现额外后续修改则交主核对');
    assert.equal(index, gisIndex + 1, 'R03与G02之间存在额外设备修改，不跳过未知历史');
    const original = await trace.select(trace.items[index]);
    assert.deepEqual(original.changed_fields, ['antenna_height_m']);
    assert(original.before.antenna_height_m !== '' && original.before.antenna_height_m !== null);
    assert(original.after.antenna_height_m !== '' && original.after.antenna_height_m !== null);
    assert.equal(Number(original.before.antenna_height_m), targetHeight); assert.equal(Number(original.after.antenna_height_m), maintenanceHeight);
    assert.deepEqual(omitHeight(original.before), omitHeight(original.after), 'A维护不能包含其他业务字段差异');
    assert.equal(original.base_revision, operation.before_revision);
    assert.equal(original.revision, (operation.response.receipt ?? operation.response).revision);
    assert.equal(original.revision, maintained.detail.revision);
    const gis = await trace.select(trace.items[gisIndex]);
    assert.deepEqual(gis.changed_fields, ['antenna_height_m']);
    assert.deepEqual(gis.before, original.after, '两次原历史的完整设备字段必须衔接，不只比较挂高');
    assert.equal(Number(gis.after.antenna_height_m), currentHeight);
    assert.deepEqual(omitHeight(gis.before), omitHeight(gis.after), 'G02不能包含其他设备字段差异');
    assert.equal(gis.base_revision, gisOperation.before_revision);
    assert.equal(gis.revision, (gisOperation.response.receipt ?? gisOperation.response).revision);
    assert.equal(gis.revision, gisEdited.detail.revision);
    rawDeviceMatches(gis.after, device.item);
    let source, proposal;
    const preview = async candidate => {
      await trace.select(candidate);
      const [result] = await http(h.page, [{ method: 'POST', path: `${trace.endpoint}/restore-preview`, checkRequest: body => {
        assert.deepEqual(body, { schema_version: 'device-trace-a1', context: 'ledger', base_revision: baseline.context.revision,
          source_revision: candidate.revision, source_request_id: candidate.request_id });
      } }], () => click(button(trace.panel, '生成三参数恢复候选')));
      const p = result.data;
      assert.equal(p.device_id, id); assert.equal(p.model_id, device.item.model_id);
      assert.equal(p.base_revision, baseline.context.revision); assert.equal(p.source_revision, candidate.revision);
      assert.equal(p.source_request_id, candidate.request_id);
      return p;
    };
    for (const candidate of trace.items.slice(index + 1)) {
      const value = await preview(candidate);
      if (value.compatible && Object.keys(value.patch).length === 1 && value.patch.antenna_height_m === targetHeight) {
        assert.deepEqual(value.changes, [{ field: 'antenna_height_m', before: currentHeight, after: targetHeight, known: true }]);
        source = candidate; proposal = value; break;
      }
    }
    assert(source && proposal, 'UI历史没有仅挂高恢复至A前值的兼容候选；保留边界，不手填或调用API代替');
    const loadCandidate = async () => {
      const [context] = await http(h.page, [{ path: /^\/resource\/(?:maintenance-context|edit-context)$/, query: { context: 'ledger', revision: baseline.context.revision } }],
        () => click(button(region(h.page, '参数恢复候选'), '交资源维护确认')));
      assert.equal(context.data.revision, baseline.context.revision);
      const form = await unique(drawer(h.page, '编辑设备参数'));
      await until(async () => Number(await form.locator('#ledger-device-antennaHeightM').inputValue()) === targetHeight, '恢复候选没有进入真实表单');
      for (const [field, expected] of [['txPowerDbm', device.item.tx_power_dbm], ['workFreqKhz', device.item.work_freq_khz]]) {
        const text = await form.locator(`#ledger-device-${field}`).inputValue();
        assert.equal(text === '' ? null : Number(text), expected, `候选意外改变${field}`);
      }
      return form;
    };
    let mutations = 0;
    const observe = request => { if (request.method() === 'POST' && RESOURCE_SAVE.test(apiPath(request) ?? '')) mutations++; };
    h.page.on('request', observe);
    try {
      const cancelled = await loadCandidate();
      await click(button(cancelled, '关闭'));
      const decision = await unique(drawer(h.page, '设备参数尚未保存'));
      await click(button(decision, '放弃本次修改')); await cancelled.waitFor({ state: 'hidden', timeout: TIMEOUT });
      await closeDrawer(h.page, '设备资源追溯'); await closeDrawer(h.page, '设备实例详情');
      const unchanged = await refreshTarget(h, id);
      assert.equal(unchanged.baseline.context.revision, baseline.context.revision);
      assert.equal(unchanged.baseline.context.content_hash, baseline.context.content_hash);
      assert.deepEqual(unchanged.device.item, device.item); assert.equal(mutations, 0, '取消候选不能发出资源写入');
      await closeDrawer(h.page, '设备实例详情');
      // 取消后重新从同一真实历史选择；不使用候选对象写隐藏store或填高度框。
      const again = await traceTarget(h, unchanged.baseline, id), reopened = await allTraceHistory(h, again, baseline.context.revision);
      const selected = reopened.items.find(item => item.revision === source.revision && item.request_id === source.request_id);
      assert(selected, '取消后原历史来源丢失');
      await reopened.select(selected);
      const [candidate] = await http(h.page, [{ method: 'POST', path: `${reopened.endpoint}/restore-preview` }],
        () => click(button(reopened.panel, '生成三参数恢复候选')));
      assert.deepEqual(candidate.data, proposal);
      const form = await loadCandidate();
      const guard = await armLateWrite(h, checkpoint, 'trace-height-restore', { aCheckpoint: aFile, aCheckpointSha256: digest(aBytes),
        originalMaintenanceRequestId: originalId, originalGisEditRequestId: gisId, deviceId: id,
        maintenanceHeight, beforeHeight: currentHeight, targetHeight,
        baseRevision: baseline.context.revision, baseContentHash: baseline.context.content_hash, source, original, gisEdit: gis, beforeDevice: device.item });
      const response = await submitLateOnce(h, guard, RESOURCE_SAVE, () => click(button(form, '保存当前设备')), body => {
        assert.equal(body.context, 'ledger'); assert.equal(body.base_revision, baseline.context.revision);
        const changes = body.changes ?? body;
        assert.deepEqual(changes.stations, []); assert.equal(changes.devices.length, 1);
        const patch = changes.devices[0], camel = Object.hasOwn(patch, 'antennaHeightM');
        assert.equal(patch.id, id); assert.equal(patch[camel ? 'antennaHeightM' : 'antenna_height_m'], targetHeight);
        const allowed = camel ? { antennaHeightM: targetHeight, txPowerDbm: device.item.tx_power_dbm, workFreqKhz: device.item.work_freq_khz }
          : { antenna_height_m: targetHeight, tx_power_dbm: device.item.tx_power_dbm, work_freq_khz: device.item.work_freq_khz };
        for (const [field, value] of Object.entries(patch)) if (field !== 'id') {
          assert(Object.hasOwn(allowed, field), `超出恢复范围的字段${field}`); assert.deepEqual(value, allowed[field]);
        }
        if (body.changes) for (const [key, rows] of Object.entries(changes)) if (key !== 'devices') assert.deepEqual(rows, [], `超出恢复范围的${key}`);
      });
      const receipt = response.receipt ?? response;
      assert.equal(receipt.changed, true); assert.notEqual(receipt.revision, baseline.context.revision);
      assert.equal(receipt.objectId ?? receipt.object_id, id);
      assert.equal(receipt.readRevision ?? receipt.read_revision, receipt.revision);
      assert.deepEqual(receipt.affectedIds ?? receipt.affected_ids, [id]);
      await contains(form, '当前没有未保存修改'); await click(button(form, '关闭'));
      await form.waitFor({ state: 'hidden', timeout: TIMEOUT });
      // 保存刷新改变maintenanceBinding.revision，真实组件会自动关闭旧追溯抽屉。
      await drawer(h.page, '设备资源追溯').waitFor({ state: 'hidden', timeout: TIMEOUT });
      await closeDrawer(h.page, '设备实例详情');
      const readback = await refreshTarget(h, id);
      assert.equal(readback.baseline.context.revision, receipt.revision);
      assert.equal(readback.device.item.antenna_height_m, targetHeight);
      assert.deepEqual(omitHeight(readback.device.item), omitHeight(device.item));
      const history = await allTraceHistory(h, readback.device, receipt.revision);
      for (const previous of [original, gis]) {
        const retained = history.items.find(item => item.request_id === previous.request_id);
        assert(retained, `A原历史不得丢失：${previous.request_id}`);
        assert.deepEqual(await history.select(retained), previous, '恢复不能改写任一原维护/GIS历史的字段');
      }
      const restored = history.items.find(item => item.request_id === guard.state.requestId);
      assert(restored, '恢复原号必须保留在实际历史中');
      const detail = await history.select(restored);
      assert.deepEqual(detail.changed_fields, ['antenna_height_m']);
      assert.deepEqual(detail.before, gis.after);
      assert.equal(Number(detail.after.antenna_height_m), targetHeight);
      assert.deepEqual(omitHeight(detail.after), omitHeight(detail.before));
      assert.equal(mutations, 1); await guard.save({ phase: 'READBACK_CONFIRMED', restoredRevision: receipt.revision, restoreHistory: detail });
      return { checkpoint, deviceId: id, originalMaintenanceRequestId: originalId, requestId: guard.state.requestId,
        originalGisEditRequestId: gisId, sourceRevision: source.revision, sourceRequestId: source.request_id,
        maintenanceHeight, beforeHeight: currentHeight, restoredHeight: targetHeight,
        revision: receipt.revision, cancelledWithoutWrite: true, saveCount: mutations, otherDeviceFieldsUnchanged: true, historyRetained: true };
    } finally { h.page.off('request', observe); }
  });
}

export async function runStatusImportPositive(h) {
  const checkpoint = await lateWriteFile(h, 'status-positive');
  const templateFile = path.join(OPERATIONS_ROOT, 'data/runtime/r6/563f24e31f094761934e4c067befe138/import-payload-0.json');
  const templateBytes = await fs.readFile(templateFile), template = JSON.parse(templateBytes.toString('utf8'));
  assert.equal(template.schema_version, 'device-status-snapshot-a1'); assert.equal(template.context, 'ledger');
  assert.equal(template.data_origin, 'SYNTHETIC_INTEGRATION'); assert.equal(template.records.length, 414);
  const old = new Map(template.records.map(item => [item.device_id, item])); assert.equal(old.size, 414);
  const templateCounts = { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 0 };
  for (const item of template.records) {
    assert.deepEqual(Object.keys(item).sort(), ['device_id', 'node_id', 'model_id', 'observed_at', 'status', 'alert', 'unknown_reasons'].sort());
    assert(Object.hasOwn(templateCounts, item.status ?? 'UNKNOWN')); templateCounts[item.status ?? 'UNKNOWN']++;
  }
  assert.deepEqual(templateCounts, { NORMAL: 104, FAULT: 104, OFFLINE: 103, UNKNOWN: 103 });
  let importCount = 0;
  const observe = request => { if (request.method() === 'POST' && apiPath(request) === '/device-status/imports') importCount++; };
  h.page.on('request', observe);
  try { return await caseRecord(h, 'status-positive-import-once', [['POST', '/device-status/imports']], async () => {
    const baseline = await ledger(h), devices = await completeLedger(h, baseline);
    const suffix = digest(`${h.taskId}:${h.planId}`).slice(0, 12), requestId = `status-r6-d-positive-${suffix}`;
    let reused = 0;
    const records = devices.map(device => {
      const previous = old.get(device.device_id), same = previous?.node_id === device.node_id && previous?.model_id === device.model_id;
      if (same) reused++;
      const reasons = [...new Set([...(same ? previous.unknown_reasons : []), same
        ? '复用既有构造验收状态，非实测；本次采集时间未知'
        : '新增设备或node/model关联已变，无观测资料；状态、告警和采集时间未知'])];
      assert(reasons.length > 0 && reasons.length <= 16 && reasons.every(value => typeof value === 'string' && value.trim() && value.length <= 500));
      const status = same ? previous.status : null, alert = same ? previous.alert : null;
      assert(status === null || ['NORMAL', 'FAULT', 'OFFLINE'].includes(status)); assert(alert === null || typeof alert === 'boolean');
      return { device_id: device.device_id, node_id: device.node_id, model_id: device.model_id, observed_at: null, status, alert, unknown_reasons: reasons };
    });
    const payload = { schema_version: 'device-status-snapshot-a1', context: 'ledger', request_id: requestId,
      base_revision: baseline.context.revision, data_origin: 'SYNTHETIC_INTEGRATION', source_label: `R6-D末尾构造状态 ${suffix}`,
      provenance_note: 'SYNTHETIC构造UI验收，非实测；仅对同设备且node/model未变者复用既有414模板的构造状态/告警；新设备及变更关联未知，所有采集时间未知，不代表全设备正常或在线。', records };
    const counts = { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 0, total: records.length };
    for (const item of records) counts[item.status ?? 'UNKNOWN']++;
    assert(counts.FAULT + counts.OFFLINE + counts.UNKNOWN > 0, '不得构造全正常资料');
    const buffer = Buffer.from(JSON.stringify(payload), 'utf8'); assert(buffer.length <= 2 * 1024 * 1024);
    const panel = await unique(region(h.page, '设备状态快照'));
    await expand(panel, '显式导入构造状态');
    const guard = await armLateWrite(h, checkpoint, 'status-positive', { requestId, payload, payloadSha256: digest(buffer), fileBytes: buffer.length,
      templateFile, templateSha256: digest(templateBytes), resourceContentHash: baseline.context.content_hash,
      reusedRecords: reused, newOrChangedRecords: records.length - reused, expectedAvailability: Object.fromEntries(devices.map(item => [item.device_id, item.availability])) });
    await (await unique(panel.getByLabel('构造状态 JSON 文件', { exact: true }))).setInputFiles({ name: `${requestId}.json`, mimeType: 'application/json', buffer });
    const raw = panel.getByRole('textbox', { name: '状态导入 JSON', exact: true });
    await until(async () => await raw.inputValue() === buffer.toString('utf8'), '真实文件控件未读入原构造JSON');
    await enabled(button(panel, '校验并导入'));
    const receipt = await submitLateOnce(h, guard, '/device-status/imports', () => click(button(panel, '校验并导入')),
      body => assert.deepEqual(body, payload));
    assert.equal(receipt.request_id, requestId); assert.equal(receipt.resource_revision, baseline.context.revision);
    assert.equal(receipt.total, records.length); assert.equal(receipt.data_origin, 'SYNTHETIC_INTEGRATION');
    assert.match(receipt.snapshot_id, /^DSS-[a-f0-9]{32}$/); assert.match(receipt.content_hash, /^[a-f0-9]{64}$/);
    assert.match(receipt.imported_at, /^\d{4}-\d{2}-\d{2}T.*Z$/); assert(Number.isFinite(Date.parse(receipt.imported_at)));
    assert.equal(receipt.snapshot_revision, `device-status-${receipt.content_hash}`);
    await contains(panel, `持久化回执 ${requestId} · ${receipt.snapshot_id}`);
    const [listing] = await http(h.page, [{ path: '/device-status/snapshots', query: {
      context: 'ledger', resource_revision: baseline.context.revision, page: 1, page_size: 20,
    } }], () => click(button(panel, '读取批次')));
    const snapshot = listing.data.items.find(item => item.snapshot_id === receipt.snapshot_id);
    assert(snapshot, '新DSS必须在真实目录首屏；未找到则核实原号，不重导入');
    const directory = panel.locator('details').filter({ has: h.page.locator('summary').filter({ hasText: /^已导入批次\s*·/ }) });
    await unique(directory); if (await directory.getAttribute('open') === null) await click(directory.locator('summary'));
    const row = directory.locator('li').filter({ hasText: receipt.snapshot_id }), endpoint = `/device-status/snapshots/${receipt.snapshot_id}`;
    const [header, first] = await http(h.page, [
      { path: endpoint, query: { context: 'ledger', snapshot_revision: receipt.snapshot_revision } },
      { path: `${endpoint}/devices`, query: { context: 'ledger', snapshot_revision: receipt.snapshot_revision, status_filter: 'ALL', page: 1, page_size: 20 } },
    ], () => click(button(row, payload.source_label)));
    const expectedHeader = { snapshot_id: receipt.snapshot_id, snapshot_revision: receipt.snapshot_revision, content_hash: receipt.content_hash,
      resource_revision: baseline.context.revision, resource_content_hash: baseline.context.content_hash, total: records.length, counts,
      source_label: payload.source_label, provenance_note: payload.provenance_note, data_origin: 'SYNTHETIC_INTEGRATION', first_observed_at: null, last_observed_at: null };
    for (const [key, value] of Object.entries(expectedHeader)) assert.deepEqual(header.data[key], value, `DSS头字段${key}`);
    assert.equal(header.data.imported_at, receipt.imported_at);
    assert.equal(typeof header.data.actor_id, 'string'); assert(header.data.actor_id);
    const detail = await unique(region(h.page, '快照明细')), expected = new Map(records.map(item => [item.device_id, item]));
    const seen = new Set(), pages = Math.ceil(records.length / 20);
    let current = first.data;
    for (let page = 1; page <= pages; page++) {
      assert.equal(current.snapshot_id, receipt.snapshot_id); assert.equal(current.snapshot_revision, receipt.snapshot_revision);
      assert.equal(current.resource_revision, baseline.context.revision); assert.equal(current.total, records.length);
      assert.equal(current.page, page); assert.equal(current.page_size, 20);
      assert.equal(current.items.length, Math.min(20, records.length - seen.size));
      for (const item of current.items) {
        assert(!seen.has(item.device_id) && expected.has(item.device_id), '快照分页重复或含额外设备');
        assert.deepEqual(item, { ...expected.get(item.device_id), availability: guard.state.expectedAvailability[item.device_id] });
        const displayed = await unique(detail.locator('tbody tr').filter({ has: h.page.getByText(item.device_id, { exact: true }) }));
        assert.equal(await displayed.getAttribute('data-status'), item.status ?? 'UNKNOWN');
        assert.equal(await displayed.getAttribute('data-snapshot-revision'), receipt.snapshot_revision);
        seen.add(item.device_id);
      }
      if (page < pages) [current] = (await http(h.page, [{ path: `${endpoint}/devices`, query: {
        context: 'ledger', snapshot_revision: receipt.snapshot_revision, status_filter: 'ALL', page: page + 1, page_size: 20,
      } }], () => click(button(detail, '下一明细页')))).map(result => result.data);
    }
    assert.equal(seen.size, records.length); await enabled(button(detail, '下一明细页'), false);
    assert.equal(await panel.getByRole('combobox', { name: '状态显示来源', exact: true }).inputValue(), 'observed');
    const [after] = await http(h.page, [{ path: '/resource/context', query: { context: 'ledger' } }], () => click(button(h.page, '刷新资源')));
    assert.equal(after.data.revision, baseline.context.revision); assert.equal(after.data.content_hash, baseline.context.content_hash);
    await contains(panel, receipt.snapshot_id);
    assert.equal(importCount, 1, '全流程只能发出一次状态导入POST，不允许自动重导入');
    await guard.save({ phase: 'READBACK_CONFIRMED', snapshotId: receipt.snapshot_id, snapshotRevision: receipt.snapshot_revision,
      readbackCount: seen.size, counts, resourceRevisionUnchanged: true });
    return { checkpoint, requestId, snapshotId: receipt.snapshot_id, snapshotRevision: receipt.snapshot_revision,
      resourceRevision: baseline.context.revision, records: records.length, reusedRecords: reused, newOrChangedRecords: records.length - reused,
      counts, allObservedAtNull: true, payloadSha256: digest(buffer), importCount, resourceRevisionUnchanged: true };
  }); } finally { h.page.off('request', observe); }
}

async function priorFrequencyCases(h, id) {
  const supplied = h.frequencyResultsFiles ?? process.env.R6_D_FREQUENCY_RESULTS;
  assert(supplied, '须提供既定四项实际结果路径R6_D_FREQUENCY_RESULTS；本入口不会代跑ADD/PATCH/ENABLE/重复失败');
  const files = Array.isArray(supplied) ? supplied : supplied.trim().startsWith('[') ? JSON.parse(supplied) : [supplied];
  assert(Array.isArray(files) && files.length >= 1 && files.length <= 4 && files.every(file => typeof file === 'string'));
  const resolved = files.map(file => path.resolve(file)); assert.equal(new Set(resolved).size, resolved.length);
  const names = ['frequency-add', 'frequency-patch', 'frequency-enable', 'frequency-duplicate-rejection'];
  const found = new Map(), evidence = [];
  for (const file of resolved) {
    assert.equal(path.dirname(path.dirname(file)), path.join(path.resolve(h.runtime), 'browser'));
    assert.match(path.basename(path.dirname(file)), /^r6-browser-\d+-[a-f0-9]{6}$/); assert.equal(path.basename(file), 'results.json');
    const bytes = await fs.readFile(file), result = JSON.parse(bytes.toString('utf8'));
    assert.equal(result.method, 'REAL_BROWSER_EDGE_LOCAL_PASSWORD'); assert.equal(result.group, 'operations');
    assert.equal(result.frontend, FRONTEND); assert.equal(result.taskId, h.taskId); assert.equal(result.planId, h.planId);
    evidence.push({ file, sha256: digest(bytes), completed: result.completed });
    for (const name of names) for (const item of result.cases.filter(item => item.id === `R6-D-${name}` && item.state === 'PASS')) {
      assert(!found.has(name), `同一频率case有多份PASS，先核对原号：${name}`);
      assert.equal(item.detail.frequencyId, id);
      const writes = item.requests.filter(request => request.method === 'POST' && request.path.split('?')[0] === `${PREFIX}${FREQ}/changes`);
      assert.equal(writes.length, name === 'frequency-duplicate-rejection' ? 0 : 1);
      if (writes.length) assert.equal(writes[0].status, 200);
      found.set(name, item.detail);
    }
  }
  assert.equal(found.size, 4, '须有四项各自真实PASS；不将未执行/失败或原组整体状态替代该case结果');
  const [add, patch, enable, duplicate] = names.map(name => found.get(name));
  assert.equal(add.available, false); assert.equal(patch.channel, 0); assert.equal(enable.available, true);
  assert.equal(duplicate.httpStatus, 422); assert.equal(duplicate.businessCode, 1001);
  assert.equal(duplicate.unchangedRevision, enable.revision);
  const originals = [add, patch, enable];
  assert(originals.every(item => typeof item.requestId === 'string' && item.requestId));
  assert.equal(new Set(originals.map(item => item.requestId)).size, 3);
  return { evidence, originals, duplicate };
}

async function frequencyHistoryRead(h, requestId) {
  const panel = await unique(region(h.page, '本人频点操作历史'));
  await fill(panel.getByLabel('请求号', { exact: true }), requestId);
  const [listing] = await http(h.page, [{ path: `${FREQ}/operations`, query: { context: 'ledger', search: requestId, page: 1 } }],
    () => click(button(panel, '查询历史')));
  assert.equal(listing.data.total, 1); assert.equal(listing.data.items.length, 1);
  const summary = listing.data.items[0]; assert.equal(summary.request_id, requestId);
  await unique(panel.getByRole('row').filter({ has: h.page.getByText(requestId, { exact: true }) }));
  await fill(panel.getByLabel('核实原请求', { exact: true }), requestId);
  const [operation] = await http(h.page, [{ path: `${FREQ}/operations/${encodeURIComponent(requestId)}`, query: { context: 'ledger' } }],
    () => click(button(panel, '读取回执')));
  const value = operation.data;
  assert.equal(value.request_id, requestId); assert.equal(value.receipt.request_id, requestId);
  for (const key of ['base_revision', 'revision', 'changed']) assert.deepEqual(summary[key], value.receipt[key]);
  assert.equal(summary.operation, value.operation); assert.equal(summary.created_at, value.created_at);
  assert.equal(summary.selected_count, value.receipt.selected_ids.length);
  assert.equal(summary.updated_count, value.receipt.updated.length); assert.equal(summary.unchanged_count, value.receipt.unchanged.length);
  const detail = await unique(drawer(h.page, '历史操作回执'));
  await contains(detail, requestId); await contains(detail, value.receipt.base_revision); await contains(detail, value.receipt.revision);
  await closeDrawer(h.page, '历史操作回执');
  return { summary, operation: value };
}

async function completeFrequencyHistory(h) {
  const panel = await unique(region(h.page, '本人频点操作历史'));
  await fill(panel.getByLabel('请求号', { exact: true }), '');
  const [first] = await http(h.page, [{ path: `${FREQ}/operations`, query: { context: 'ledger', search: '', page: 1 } }],
    () => click(button(panel, '查询历史')));
  assert(Number.isSafeInteger(first.data.total) && first.data.total >= 3 && first.data.total <= 200,
    '本人历史超出本次200条有限UI核对范围时先停，不跳过历史保留验证');
  assert.equal(first.data.page_size, 10);
  const table = await unique(panel.locator('.p-datatable')), rows = [], pages = Math.ceil(first.data.total / 10);
  let current = first.data;
  for (let page = 1; page <= pages; page++) {
    assert.equal(current.page, page); assert.equal(current.page_size, 10); assert.equal(current.total, first.data.total);
    assert.equal(current.items.length, Math.min(10, current.total - rows.length));
    for (const item of current.items) await unique(table.getByRole('row').filter({ has: h.page.getByText(item.request_id, { exact: true }) }));
    rows.push(...current.items);
    if (page < pages) [current] = (await http(h.page, [{ path: `${FREQ}/operations`, query: { context: 'ledger', search: '', page: page + 1 } }],
      () => click(table.locator('button.p-paginator-next')))).map(result => result.data);
  }
  assert.equal(new Set(rows.map(item => item.request_id)).size, first.data.total);
  await enabled(table.locator('button.p-paginator-next'), false);
  return rows;
}

export async function runFrequencyDisableHistory(h) {
  const checkpoint = await lateWriteFile(h, 'frequency-disable-history');
  const id = identities({ ...h, frequencyId: undefined }).frequencyId;
  assert.equal(identities(h).frequencyId, id, '只能停用本轮默认constructedID，禁止替换为源频点');
  const prior = await priorFrequencyCases(h, id);
  let disableWrites = 0;
  const observe = request => { if (request.method() === 'POST' && apiPath(request) === `${FREQ}/disable`) disableWrites++; };
  h.page.on('request', observe);
  try { return await caseRecord(h, 'frequency-disable-history-once', [
    ['POST', `${FREQ}/disable/validate`], ['POST', `${FREQ}/disable`],
  ], async () => {
    const { panel, listing } = await frequencyPage(h);
    assert.equal(listing.total, 1); assert.equal(listing.items.length, 1);
    assert.equal(listing.revision, prior.duplicate.unchangedRevision, '四项后资源另有变化，先核对，不以旧版直接停用');
    const before = listing.items[0];
    assert.equal(before.freq_id, id); assert.equal(before.is_available, true, '已停用时只核实原号，不重复enable或提交停用');
    assert.equal(before.channel_no, 0); assert.equal(before.occupied_by, null);
    assert.equal(before.center_freq_khz, 7105); assert.equal(before.bandwidth_khz, 3);
    assert(before.note?.startsWith('[人工构造规划频点；非正式频率授权] ') && before.note.includes('R6-D'));
    const originals = [];
    for (const recorded of prior.originals) {
      const actual = await frequencyHistoryRead(h, recorded.requestId), receipt = actual.operation.receipt;
      assert.equal(actual.operation.operation, 'FREQUENCY_CHANGES'); assert.equal(receipt.object_id, 'resource-frequency-changes');
      assert.equal(receipt.revision, recorded.revision); assert.equal(receipt.changed, true);
      assert.deepEqual(receipt.selected_ids, [id]); assert.deepEqual(receipt.updated, [id]); assert.deepEqual(receipt.unchanged, []);
      assert.deepEqual(receipt.affected_ids, [id]); assert.equal(receipt.items.length, 1); assert.equal(receipt.items[0].freq_id, id);
      originals.push(actual);
    }
    const [add, patch, enable] = originals.map(value => value.operation.receipt);
    assert.equal(add.items[0].is_available, false);
    assert.equal(patch.base_revision, add.revision); assert.deepEqual(patch.items[0], { ...add.items[0], channel_no: 0 });
    assert.equal(enable.base_revision, patch.revision); assert.deepEqual(enable.items[0], { ...patch.items[0], is_available: true });
    assert.deepEqual(before, enable.items[0], '当前行必须完整匹配本轮ENABLE原回执，不能换源频点');
    const historyBefore = await completeFrequencyHistory(h);
    const previewDisable = async () => {
      await (await unique(panel.getByRole('checkbox', { name: `选择频点 ${id}`, exact: true }))).check();
      const [preview] = await http(h.page, [{ method: 'POST', path: `${FREQ}/disable/validate`, checkRequest: body => {
        assert.deepEqual(body, { context: 'ledger', revision: listing.revision, ids: [id] });
      } }], () => click(button(panel, '停用所选')));
      assert.equal(preview.data.revision, listing.revision); assert.equal(preview.data.base_revision, listing.revision);
      assert.equal(preview.data.content_hash, listing.content_hash); assert.deepEqual(preview.data.items, [before]);
      assert.deepEqual(preview.data.selected_ids, [id]); assert.deepEqual(preview.data.would_disable, [id]); assert.deepEqual(preview.data.unchanged, []);
      assert.deepEqual(preview.data.impact, { resource_revision_will_change: true, historical_resources_preserved: true,
        saved_plans_require_recompute: true, link_impact: 'UNKNOWN' });
      return unique(drawer(h.page, '确认停用规划频点'));
    };
    const firstDecision = await previewDisable();
    await click(button(firstDecision, '取消')); await firstDecision.waitFor({ state: 'hidden', timeout: TIMEOUT });
    const refresh = async revision => {
      const [result] = await http(h.page, [{ path: `${FREQ}/query`, query: { context: 'ledger', search: id, revision } }],
        () => click(button(panel, '刷新')));
      await enabled(button(panel, '刷新'));
      assert.equal(result.data.revision, revision); assert.equal(result.data.total, 1); assert.equal(result.data.items.length, 1);
      return result.data;
    };
    const cancelled = await refresh(listing.revision);
    assert.deepEqual(cancelled, listing, '取消不能改变频点行、资源版本或哈希'); assert.equal(disableWrites, 0);
    assert.deepEqual(await completeFrequencyHistory(h), historyBefore, '取消不能新增或改写历史');
    const confirmation = await previewDisable();
    const guard = await armLateWrite(h, checkpoint, 'frequency-disable-history', { frequencyId: id,
      baseRevision: listing.revision, baseContentHash: listing.content_hash, beforeItem: before,
      priorEvidence: prior.evidence, priorCaseResults: prior.originals, originalOperations: originals, historyBefore,
      cancelledWithoutWrite: true });
    const receipt = await submitLateOnce(h, guard, `${FREQ}/disable`, () => click(button(confirmation, '确认停用')), body => {
      assert.deepEqual(Object.keys(body).sort(), ['context', 'base_revision', 'request_id', 'ids'].sort());
      assert.equal(body.context, 'ledger'); assert.equal(body.base_revision, listing.revision); assert.deepEqual(body.ids, [id]);
    });
    assert.equal(receipt.request_id, guard.state.requestId); assert.equal(receipt.object_id, 'resource-frequency-disable');
    assert.equal(receipt.base_revision, listing.revision); assert.equal(receipt.changed, true);
    assert.match(receipt.revision, /^resource-[a-f0-9]{16}$/); assert.notEqual(receipt.revision, listing.revision);
    assert.equal(receipt.read_revision, receipt.revision); assert.equal(receipt.data_origin, 'SYNTHETIC_INTEGRATION');
    assert.deepEqual(receipt.selected_ids, [id]); assert.deepEqual(receipt.updated, [id]); assert.deepEqual(receipt.affected_ids, [id]);
    assert.deepEqual(receipt.unchanged, []); assert.deepEqual(receipt.warnings, []);
    const disabled = { ...before, is_available: false }; assert.deepEqual(receipt.items, [disabled]);
    await contains(region(h.page, '本次停用回执'), receipt.request_id); await contains(region(h.page, '本次停用回执'), receipt.revision);
    await confirmation.waitFor({ state: 'hidden', timeout: TIMEOUT }); await enabled(button(panel, '刷新'));
    const historyAfter = await completeFrequencyHistory(h), retained = new Map(historyAfter.map(item => [item.request_id, item]));
    assert.equal(historyAfter.length, historyBefore.length + 1);
    for (const summary of historyBefore) assert.deepEqual(retained.get(summary.request_id), summary, '所有旧历史摘要必须保留且全等');
    const originalDisable = await frequencyHistoryRead(h, receipt.request_id);
    assert.equal(originalDisable.operation.operation, 'FREQUENCY_DISABLE'); assert.deepEqual(originalDisable.operation.receipt, receipt);
    assert.deepEqual(retained.get(receipt.request_id), originalDisable.summary);
    for (const previous of originals) assert.deepEqual(await frequencyHistoryRead(h, previous.operation.request_id), previous, 'ADD/PATCH/ENABLE原回执不得改写');
    const current = await refresh(receipt.revision);
    assert.deepEqual(current.items, [disabled]); assert.notEqual(current.content_hash, listing.content_hash);
    await contains(frequencyRow(h.page, id), '已停用'); assert.equal(disableWrites, 1, '取消零写，最终只能有一次DISABLE');
    await guard.save({ phase: 'READBACK_CONFIRMED', disabledRevision: receipt.revision, originalDisable,
      historyAfter, finalItem: current.items[0], finalContentHash: current.content_hash });
    return { checkpoint, frequencyId: id, requestId: receipt.request_id, revision: receipt.revision,
      cancelledWithoutWrite: true, disableCount: disableWrites, available: false,
      preservedRequestIds: originals.map(value => value.operation.request_id), historyBefore: historyBefore.length,
      historyAfter: historyAfter.length, originalReceiptsUnchanged: true, retainedHistoryCount: historyBefore.length };
  }); } finally { h.page.off('request', observe); }
}
