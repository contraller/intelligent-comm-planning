// Imported by the R6 host. No browser, service, login secret, or global parameter is created here.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://127.0.0.24:5324';
const API = '/api/v1';
const SOURCE = path.join(ROOT, 'data/runtime/r6/563f24e31f094761934e4c067befe138/anchor.json');
const RESOURCE = 'resource-7c8bd11ec30d0ed4';
const PLAN = 'PLAN-5273d94aa08345e4b047d62b915e2928';
const LIMIT_MS = 60000;
const POLL_MS = 100;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, name) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escapeRegex(name)}\\s*$`) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// B组锚点使用按键排序的JSON对象摘要，文件缩进字节另行留证。
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

async function envelope(response, label) {
  const status = response.status();
  const body = await response.json();
  assert([200, 201].includes(status) && body.code === 0 && body.data, `${label}: HTTP ${status}, code ${body.code}, ${body.message}`);
  return body.data;
}

function pngDecoder(options) {
  const bases = [options.pngPackage, process.env.R6_PNG_PACKAGE,
    path.join(ROOT, 'front_design/radio-planning-20261022/package.json'), process.execPath].filter(Boolean);
  for (const base of bases) {
    try { return createRequire(path.resolve(base))('pngjs').PNG; } catch { /* Try another existing dependency root. */ }
  }
  throw new Error('pngjs is required from an existing runtime; supply pngPackage/R6_PNG_PACKAGE. Do not install or copy dependencies.');
}

async function context(args, options, work) {
  const { page, runtime, taskId, planId, login, record, shot } = args;
  assert(page && typeof page.request?.post === 'function');
  for (const helper of [login, record, shot]) assert.equal(typeof helper, 'function');
  assert(runtime && taskId && planId === PLAN, 'Use the approved R6 runtime/task/plan.');
  assert(page.url() === 'about:blank' || new URL(page.url()).origin === ORIGIN);
  const anchorBytes = await fs.readFile(SOURCE), anchor = JSON.parse(anchorBytes);
  assert.equal(anchor.schema, 'r6-situation-anchor-v1');
  assert.equal(anchor.validation, 'COMMITTED_HTTP_VERIFIED');
  assert.equal(anchor.environment.frontend, ORIGIN);
  assert.equal(anchor.environment.api, 'http://127.0.0.24:8124');
  assert.equal(path.resolve(runtime), path.resolve(anchor.environment.runtime_root));
  assert.equal(anchor.resource_revision, RESOURCE);
  const payloadFile = path.join(path.dirname(SOURCE), 'import-payload-0.json');
  assert.equal(path.resolve(anchor.payload_file), payloadFile);
  const bytes = await fs.readFile(payloadFile), payload = JSON.parse(bytes);
  assert.equal(sha(JSON.stringify(canonical(payload))), anchor.payload_sha256);
  assert.equal(payload.base_revision, RESOURCE); assert.equal(payload.records.length, 414);
  assert.equal(payload.data_origin, 'SYNTHETIC_INTEGRATION');
  assert.equal(new Set(payload.records.map(row => row.device_id)).size, 414);
  const runId = crypto.randomUUID(), output = path.join(ROOT, 'data/runtime/r6', runId);
  await fs.mkdir(output, { recursive: false });
  const requests = [], failures = [], offset = performance.now();
  const capture = request => {
    const url = new URL(request.url());
    if (url.origin === ORIGIN && url.pathname.startsWith(API + '/device-status/')) requests.push({
      path: url.pathname + url.search, method: request.method(), at_ms: performance.now() - offset,
    });
  };
  page.on('request', capture);
  const c = { ...args, output, runId, anchor, payload, requests, failures, options, PNG: pngDecoder(options), index: 0, previousImage: null };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    schema: 'r6-browser-performance-v1', run_id: runId, frontend: ORIGIN, taskId, planId, resource_revision: RESOURCE,
    source_anchor: SOURCE, source_anchor_sha256: sha(anchorBytes), payload_file: payloadFile,
    payload_sha256: anchor.payload_sha256, payload_file_sha256: sha(bytes),
    external_writer: 'page.request with current real UI session CSRF; not UI import acceptance',
    parameter_changes_by_script: false, criterion_ms: LIMIT_MS, dom_poll_ms: POLL_MS,
  }, null, 2));
  try { return await work(c); }
  finally { page.off('request', capture); }
}

async function readView(c) {
  return c.workspace.evaluate((root, deviceId) => {
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      && getComputedStyle(el).opacity !== '0';
    const info = el => el ? { ...el.dataset, text: el.innerText, visible: visible(el),
      inViewport: el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight } : null;
    const panel = root.querySelector('.resource-status-panel');
    const row = [...root.querySelectorAll('.device-monitor tbody tr')].find(el => el.querySelector('button')?.innerText.trim() === deviceId);
    const cells = row ? [...row.querySelectorAll('td')].map(el => el.innerText.trim()) : [];
    const viewport = root.querySelector('.frozen-map .ol-viewport');
    return {
      url: location.href, state: info(panel?.querySelector('[data-testid="gis-status-state"]')),
      refresh: info(panel?.querySelector('[data-testid="gis-status-refresh"]')),
      cycle: info(root.querySelector('[data-testid="gis-status-cycle"]')),
      map: info(root.querySelector('[data-testid="gis-device-status-render"]')),
      label: panel?.querySelector('section[aria-label="快照明细"] h3')?.innerText ?? '',
      row: { visible: visible(row), cells },
      canvas: { visible: visible(viewport), count: viewport?.querySelectorAll('canvas').length ?? 0,
        nonzero: [...viewport?.querySelectorAll('canvas') ?? []].filter(el => el.width > 0 && el.height > 0).length },
      alerts: [...panel?.querySelectorAll('[role="alert"]') ?? []].filter(visible).map(el => el.innerText),
    };
  }, c.deviceId);
}

function parameters(c, view) {
  assert(view.cycle?.visible, 'The actual parameter consumer must be visible.');
  assert.equal(Number(view.cycle.intervalSeconds), c.intervalSeconds, 'PAR-01 differs from the explicitly requested group; the script never changes it.');
  assert(view.cycle.parameterRevision && view.cycle.parameterEpoch, 'Runtime parameter revision/epoch is missing.');
  if (c.parameter) assert.deepEqual([view.cycle.parameterEpoch, view.cycle.parameterRevision], c.parameter, 'Runtime parameters changed within this group.');
  else c.parameter = [view.cycle.parameterEpoch, view.cycle.parameterRevision];
}

function sameApplied(view, expected) {
  return view.state?.visible && view.map?.visible && view.state.snapshotId === expected.snapshotId
    && view.state.snapshotRevision === expected.snapshotRevision && view.state.resourceRevision === RESOURCE
    && view.map.snapshotId === expected.snapshotId && view.map.snapshotRevision === expected.snapshotRevision
    && view.map.resourceRevision === RESOURCE && view.map.appliedAt === view.state.appliedAt
    && !!view.map.renderedAt && Number.isFinite(Date.parse(view.map.renderedAt));
}

async function until(c, condition, timeout = 90000) {
  const deadline = performance.now() + timeout;
  let view;
  while (performance.now() < deadline) {
    view = await readView(c);
    if (await condition(view)) return view;
    await sleep(POLL_MS);
  }
  throw new Error('UI condition timed out: ' + JSON.stringify(view));
}

async function directoryPageOne(c) {
  const panel = c.workspace.locator('.resource-status-panel');
  // has查询须相对候选details，不能重复带入外层region定位链。
  const directory = panel.locator('details').filter({ hasText: /^\s*已导入批次/ });
  if (await directory.getAttribute('open') === null) await directory.locator(':scope > summary').click();
  await until(c, async () => await button(panel, '读取批次').isEnabled(), 30000);
  for (let i = 0; i < 20; i++) {
    const previous = button(directory, '上一批次页');
    if (await previous.isDisabled()) return directory;
    await previous.click();
    await button(panel, '读取批次').waitFor({ state: 'visible' });
    await until(c, async () => await button(panel, '读取批次').isEnabled(), 30000);
  }
  throw new Error('Directory page-one navigation exceeded its UI bound.');
}

async function chooseAnchor(c) {
  const panel = c.workspace.locator('.resource-status-panel');
  await button(panel, '读取批次').click();
  await until(c, async () => await button(panel, '读取批次').isEnabled(), 30000);
  const directory = await directoryPageOne(c);
  for (let page = 1; page <= 20; page++) {
    const target = button(directory, c.anchor.source_label);
    if (await target.count()) {
      await target.click();
      return until(c, view => sameApplied(view, { snapshotId: c.anchor.snapshot_id, snapshotRevision: c.anchor.snapshot_revision }));
    }
    const next = button(directory, '下一批次页');
    if (await next.isDisabled()) break;
    await next.click();
    // Wait for the page's own foreground list, without bypassing the UI paginator.
    await until(c, async () => await button(panel, '读取批次').isEnabled(), 30000);
  }
  throw new Error('The approved anchor batch is not within the bounded real UI directory; no substitute batch was selected.');
}

async function setup(c) {
  await c.login('editor');
  await c.page.goto(`${ORIGIN}/?r6a=${c.runId}#/situation`, { waitUntil: 'domcontentloaded' });
  await c.page.getByRole('heading', { name: 'GIS 态势', exact: true }).waitFor({ timeout: 60000 });
  await button(c.page, '查看已保存方案').click();
  c.workspace = c.page.getByRole('region', { name: '数据库冻结方案', exact: true });
  // The production section has an aria-label, but no explicit region role in older browser mappings.
  if (await c.workspace.count() === 0) c.workspace = c.page.locator('section[aria-label="数据库冻结方案"]');
  await c.workspace.getByLabel('方案搜索', { exact: true }).fill(c.planId);
  const [catalog] = await Promise.all([
    c.page.waitForResponse(response => new URL(response.url()).origin === ORIGIN && new URL(response.url()).pathname === API + '/plan/saved-plans' && response.request().method() === 'GET'),
    button(c.workspace, '查询').click(),
  ]);
  await envelope(catalog, 'UI plan directory');
  const row = c.workspace.locator('.catalog-table tbody tr').filter({ hasText: c.planId });
  assert.equal(await row.count(), 1, 'The approved plan must be uniquely selected through the UI.');
  const [response] = await Promise.all([
    c.page.waitForResponse(value => new URL(value.url()).origin === ORIGIN && new URL(value.url()).pathname === API + `/gis/plans/${encodeURIComponent(c.planId)}/network`),
    button(row, '打开冻结网络').click(),
  ]);
  c.network = await envelope(response, 'UI frozen network');
  assert.equal(c.network.identity.plan_id, c.planId); assert.equal(c.network.identity.task_id, c.taskId);
  assert.equal(c.network.identity.resource_revision, RESOURCE); assert.equal(c.network.identity.source_changed, false);
  const ids = new Set(c.payload.records.map(value => value.device_id));
  const device = c.network.devices.find(value => ids.has(value.id));
  assert(device, 'The frozen network and 414-record batch have no shared device.'); c.deviceId = device.id;
  const nodes = new Map(c.network.nodes.map(value => [value.id, value]));
  c.pointCount = c.network.devices.filter(value => nodes.get(value.station_id)?.coordinate?.length === 2).length;
  await c.workspace.getByRole('tab', { name: '设备状态', exact: true }).click();
  await c.workspace.getByLabel('筛选监控设备', { exact: true }).fill(c.deviceId);
  await c.workspace.getByLabel('筛选设备状态', { exact: true }).selectOption('all');
  const selected = await chooseAnchor(c);
  assert(selected.state.text.includes('已读 414/414'), 'A complete 414-record status selection is required.');
  await button(c.workspace.locator('.device-monitor'), c.deviceId).click();
  const current = await until(c, view => sameApplied(view, { snapshotId: c.anchor.snapshot_id, snapshotRevision: c.anchor.snapshot_revision }));
  parameters(c, current);
  assert.equal(current.refresh.mode, 'fixed', 'The initial real UI selection must be fixed.');
  c.previousImage = await pixels(c, 'baseline', null);
  return { taskId: c.taskId, planId: c.planId, network: c.network.identity, deviceId: c.deviceId,
    source_snapshot: c.anchor.snapshot_id, resource_revision: RESOURCE, records: 414, overlay_points: c.pointCount,
    interval_seconds: c.intervalSeconds, parameter: c.parameter, output: c.output, initial_view: current, png: c.previousImage.evidence };
}

async function pixels(c, label, state, previous = null, unchanged = false) {
  const file = path.join(c.output, label + '.png');
  const bytes = await c.workspace.locator('.frozen-map .ol-viewport').screenshot({ path: file, type: 'png', animations: 'disabled' });
  const png = c.PNG.sync.read(bytes), colors = new Set(); let fault = 0, opaque = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b, a] = png.data.subarray(i, i + 4);
    if (a > 0) opaque++;
    if (a > 200 && Math.abs(r - 242) <= 2 && Math.abs(g - 120) <= 2 && Math.abs(b - 135) <= 2) fault++;
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  assert(png.width > 0 && png.height > 0 && opaque > 0 && colors.size >= 8, 'Real viewport PNG is blank or lacks rendered content.');
  let changed = null;
  if (previous) {
    assert.equal(png.width, previous.png.width); assert.equal(png.height, previous.png.height);
    changed = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (Math.max(...[0, 1, 2].map(channel => Math.abs(png.data[i + channel] - previous.png.data[i + channel]))) > 12) changed++;
    }
    if (unchanged) assert(changed / (png.width * png.height) <= 0.005, 'Fixed/failure-retained map pixels changed beyond the evidence tolerance.');
    else if (state && state !== previous.state) assert(changed >= 20, 'A changed state did not produce an observable PNG change.');
    if (state === 'NORMAL' && previous.state === 'FAULT' && !unchanged) assert(fault < previous.evidence.fault_color_pixels, 'Fault-colored device pixels did not decrease for the normal state.');
  }
  if (state === 'FAULT') assert(fault >= 3, 'The viewport lacks actual fault-colored device rendering.');
  return { png, state, evidence: { file, sha256: sha(bytes), width: png.width, height: png.height, opaque_pixels: opaque,
    quantized_colors: colors.size, fault_color_pixels: fault, changed_pixels: changed,
    method: 'decoded real OL viewport PNG; color and prior-frame comparison; dimensions alone are not acceptance' } };
}

async function prepareWrite(c, state, label) {
  const guid = crypto.randomUUID(), observedAt = new Date().toISOString();
  const payload = { ...c.payload, request_id: `r6a-${guid}`, source_label: `r6a-${guid}-${label}-${state}`,
    provenance_note: 'R6 explicit external API writer, constructed state; this is not a UI file-import acceptance result.',
    records: c.payload.records.map(row => ({ ...row, status: state, alert: state === 'FAULT', observed_at: observedAt, unknown_reasons: [] })) };
  assert(payload.source_label.length <= 120); assert.equal(payload.records.length, 414);
  const file = path.join(c.output, label + '-payload.json');
  await fs.writeFile(file, JSON.stringify(payload));
  // Cookies belong to the real UI Page. Never read private.json or synthesize a test identity.
  const csrf = await envelope(await c.page.request.get(ORIGIN + API + '/auth/csrf', { headers: { Origin: ORIGIN }, timeout: 30000 }), 'external writer CSRF');
  assert(typeof csrf.csrf_token === 'string' && csrf.csrf_token && typeof csrf.session_id === 'string' && csrf.session_id);
  return { payload, file, observedAt, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token, 'X-Session-Id': csrf.session_id } };
}

async function write(c, prepared, t0) {
  const response = await c.page.request.post(ORIGIN + API + '/device-status/imports', { headers: prepared.headers, data: prepared.payload, timeout: 60000 });
  const receipt = await envelope(response, 'external writer import');
  assert.equal(receipt.request_id, prepared.payload.request_id); assert.equal(receipt.resource_revision, RESOURCE);
  assert.equal(receipt.data_origin, 'SYNTHETIC_INTEGRATION'); assert.equal(receipt.total, 414);
  assert.equal(receipt.snapshot_revision, 'device-status-' + receipt.content_hash);
  return { receipt, ack_elapsed_ms: performance.now() - t0, payload_file: prepared.file, source_label: prepared.payload.source_label,
    request_id: prepared.payload.request_id, ui_import_acceptance: false };
}

async function observeNew(c, prepared, old, t0, cancelled = { value: false }) {
  const deadline = t0 + (c.options.observationTimeoutMs ?? 90000);
  let tableAt = null, mapAt = null, last;
  while (performance.now() < deadline && !cancelled.value) {
    last = await readView(c); parameters(c, last);
    const state = last.state, map = last.map, cells = last.row.cells;
    const fresh = last.label.includes(prepared.payload.source_label) && state?.snapshotRevision !== old.state.snapshotRevision
      && state?.resourceRevision === RESOURCE && state?.text.includes('已读 414/414');
    const table = fresh && state.visible && last.row.visible && cells[3] === (prepared.payload.records[0].status === 'FAULT' ? '故障' : '正常')
      && cells[4] === (prepared.payload.records[0].alert ? '有告警标记' : '无告警标记')
      && Date.parse(cells[5]) === Date.parse(prepared.observedAt) && cells[6]?.includes(state.snapshotId) && cells[6]?.includes(state.snapshotRevision);
    const rendered = fresh && map?.visible && sameApplied(last, state) && map.networkSnapshotId === c.network.identity.snapshot_id
      && Number(map.pointCount) === c.pointCount && last.canvas.visible && last.canvas.nonzero > 0;
    const now = performance.now() - t0;
    if (table && tableAt === null) tableAt = now;
    if (rendered && mapAt === null) mapAt = now;
    if (table && rendered) return { table_first_visible_ms: tableAt, map_first_complete_visible_ms: mapAt,
      elapsed_ms: Math.max(tableAt, mapAt), last_visible: last,
      clock: 'Node performance.now, started immediately before POST; never ACK-based',
      visibility: 'actual layout-visible DOM; viewport co-visibility is separately reported, not assumed' };
    await sleep(POLL_MS);
  }
  throw new Error('New table/map version not observed: ' + JSON.stringify({ tableAt, mapAt, cancelled: cancelled.value, last }));
}

async function sample(c, index, results) {
  const label = `${c.options.group}-${String(index + 1).padStart(2, '0')}`, state = index % 2 === 0 ? 'FAULT' : 'NORMAL';
  const result = { index: index + 1, state: 'FAIL', requested_status: state, latency_ms: null };
  results.push(result);
  let t0;
  try {
    return await c.record('A-' + label, async () => {
      const old = await readView(c); parameters(c, old); assert.equal(old.refresh.mode, 'latest');
      const prepared = await prepareWrite(c, state, label);
      Object.assign(result, { source_label: prepared.payload.source_label, request_id: prepared.payload.request_id, payload_file: prepared.file });
      const cancelled = { value: false };
      t0 = performance.now();
      const sending = write(c, prepared, t0).catch(error => { cancelled.value = true; throw error; });
      const observing = observeNew(c, prepared, old, t0, cancelled);
      const [sent, seen] = await Promise.allSettled([sending, observing]);
      if (sent.status === 'fulfilled') Object.assign(result, sent.value);
      else throw sent.reason;
      if (seen.status === 'rejected') throw seen.reason;
      assert.equal(seen.value.last_visible.state.snapshotId, sent.value.receipt.snapshot_id);
      assert.equal(seen.value.last_visible.state.snapshotRevision, sent.value.receipt.snapshot_revision);
      assert.notEqual(sent.value.receipt.snapshot_revision, old.state.snapshotRevision, 'Each sample must be a new actual content version.');
      const image = await pixels(c, label, state, c.previousImage);
      Object.assign(result, seen.value, { latency_ms: seen.value.elapsed_ms, png: image.evidence, criterion_pass: seen.value.elapsed_ms <= LIMIT_MS });
      c.previousImage = image;
      result.state = result.criterion_pass ? 'PASS' : 'FAIL';
      assert(result.criterion_pass, `Actual refresh exceeded ${LIMIT_MS}ms: ${result.latency_ms}`);
      return result;
    });
  } catch (error) {
    result.state = 'FAIL'; result.error = String(error.message); result.duration_until_failure_ms = t0 === undefined ? null : performance.now() - t0;
    if (result.criterion_pass !== false) result.latency_ms = null;
    await fs.writeFile(path.join(c.output, label + '-failure.json'), JSON.stringify(result, null, 2));
    return null;
  }
}

function distribution(samples, expected) {
  const scores = samples.map(value => value.latency_ms ?? Infinity).sort((a, b) => a - b);
  const percentile = fraction => {
    const value = scores[Math.max(0, Math.ceil(expected * fraction) - 1)];
    return Number.isFinite(value) ? value : 'UNBOUNDED_FAILURE';
  };
  return { expected_samples: expected, recorded_samples: samples.length, passed: samples.filter(value => value.state === 'PASS').length,
    failed: samples.filter(value => value.state !== 'PASS').length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: percentile(1),
    criterion_ms: LIMIT_MS, all_samples_passed: samples.length === expected && samples.every(value => value.state === 'PASS'),
    quantile_rule: 'nearest rank; failed/unobserved or not-run samples remain in denominator as +Infinity; completed over-limit observations retain measured latency' };
}

/** Configurable group; the host must set PAR-01 explicitly before invoking it. */
export async function runPerformanceSamples(args, options = {}) {
  const settings = { intervalSeconds: 30, sampleCount: 3, group: 'PERF30', ...options };
  assert(Number.isInteger(settings.sampleCount) && settings.sampleCount >= 1 && settings.sampleCount <= 100);
  assert(Number.isInteger(settings.intervalSeconds) && settings.intervalSeconds >= 1 && settings.intervalSeconds <= 3600);
  assert(/^[A-Za-z0-9_-]+$/.test(settings.group));
  assert((settings.observationTimeoutMs ?? 90000) > settings.intervalSeconds * 1000 && (settings.observationTimeoutMs ?? 90000) <= 180000,
    'Observation budget must exceed the configured interval and stay bounded; do not silently lower PAR-01.');
  return context(args, settings, async c => {
    c.intervalSeconds = settings.intervalSeconds;
    const samples = []; let setupFailure = null;
    try {
      await c.record('A-' + settings.group + '-setup', () => setup(c));
      await c.workspace.getByRole('radio', { name: '跟随最新', exact: true }).check();
      for (let i = 0; i < settings.sampleCount; i++) {
        // 任何未核实或呈现失败均停止新写入，剩余样本明确记为未执行。
        if (!await sample(c, i, samples)) break;
      }
    } catch (error) { setupFailure = String(error.message); }
    finally {
      while (samples.length < settings.sampleCount) samples.push({ index: samples.length + 1, state: 'NOT_RUN', latency_ms: null, error: setupFailure ?? 'Prior setup did not complete.' });
      const report = { schema: 'r6-performance-samples-v1', run_id: c.runId, interval_seconds: settings.intervalSeconds, parameter: c.parameter,
        setup_failure: setupFailure, resource_revision: RESOURCE, planId: c.planId, taskId: c.taskId, source_anchor: SOURCE,
        external_writer_is_not_ui_import: true, samples, distribution: distribution(samples, settings.sampleCount), requests: c.requests };
      await fs.writeFile(path.join(c.output, 'samples.json'), JSON.stringify(report, null, 2));
      await c.record('A-' + settings.group + '-distribution', async () => {
        assert(report.distribution.all_samples_passed, JSON.stringify({ output: c.output, distribution: report.distribution, setup_failure: setupFailure }));
        return { output: c.output, ...report.distribution };
      });
    }
    return { output: c.output, distribution: distribution(samples, settings.sampleCount) };
  });
}

/** Entry for the current/default 30-second configuration: exactly three samples. */
export const runPerformance = args => runPerformanceSamples(args, { intervalSeconds: 30, sampleCount: 3, group: 'PERF30' });
/** Separate group: requires the host to have explicitly configured five seconds. */
export const runFiveSecondPerformance = args => runPerformanceSamples(args, { intervalSeconds: 5, sampleCount: 20, group: 'PERF05' });

/** Functional scenarios are isolated from the un-intercepted performance samples. */
export async function runPerformanceBehavior(args, options = {}) {
  const settings = { intervalSeconds: 30, group: 'BEHAVIOR', ...options };
  return context(args, settings, async c => {
    c.intervalSeconds = settings.intervalSeconds;
    await c.record('A-STATE-setup', () => setup(c));
    await c.record('A-STATE-fixed-history', async () => {
      const panel = c.workspace.locator('.resource-status-panel');
      await c.workspace.getByRole('radio', { name: '固定批次', exact: true }).check();
      await directoryPageOne(c);
      const old = await readView(c), before = await pixels(c, 'fixed-before', null);
      const prepared = await prepareWrite(c, 'FAULT', 'fixed-injection'), t0 = performance.now();
      const injected = await write(c, prepared, t0);
      const view = await until(c, current => current.refresh.mode === 'fixed' && current.refresh.checkedAt && current.refresh.checkedAt !== old.refresh.checkedAt,
        c.intervalSeconds * 1000 + 60000);
      assert(sameApplied(view, old.state)); assert.equal(view.state.appliedAt, old.state.appliedAt); assert.equal(view.map.renderedAt, old.map.renderedAt);
      assert.equal(view.label, old.label); assert.notEqual(view.state.snapshotRevision, injected.receipt.snapshot_revision);
      const image = await pixels(c, 'fixed-after', null, before, true);
      await button(panel, '读取批次').click();
      const target = button(panel, prepared.payload.source_label); await target.waitFor({ state: 'visible' });
      await target.click();
      const applied = await until(c, current => sameApplied(current, { snapshotId: injected.receipt.snapshot_id, snapshotRevision: injected.receipt.snapshot_revision }));
      assert.equal(applied.refresh.mode, 'fixed');
      c.previousImage = await pixels(c, 'fixed-explicit-apply', 'FAULT', image);
      return { old, injected, retained: view, explicit_apply: applied, png: image.evidence };
    });
    await c.record('A-STATE-failure-retains-atomic-state', async () => {
      await c.workspace.getByRole('radio', { name: '跟随最新', exact: true }).check();
      const old = await readView(c), before = await pixels(c, 'failure-before', 'FAULT');
      const aborted = [], pattern = ORIGIN + API + '/device-status/snapshots/*/devices?*';
      const block = async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname !== API + `/device-status/snapshots/${old.state.snapshotId}/devices`) {
          aborted.push({ path: url.pathname + url.search, reason: 'explicit browser network abort, not a simulated backend response' });
          await route.abort('failed');
        } else await route.continue();
      };
      let prepared, injected, retained;
      await c.page.route(pattern, block);
      try {
        prepared = await prepareWrite(c, 'NORMAL', 'failure-injection');
        injected = await write(c, prepared, performance.now());
        retained = await until(c, view => view.alerts.some(text => text.includes('刷新失败，保留最近有效状态')), c.intervalSeconds * 1000 + 60000);
        assert(aborted.length > 0, 'The intended real browser read was not aborted.');
        assert(sameApplied(retained, old.state)); assert.equal(retained.state.appliedAt, old.state.appliedAt); assert.equal(retained.map.renderedAt, old.map.renderedAt);
        await pixels(c, 'failure-retained', 'FAULT', before, true);
      } finally { await c.page.unroute(pattern, block); }
      // Let the actual product retry its own read. No second write and no forged response.
      const recovered = await until(c, view => sameApplied(view, { snapshotId: injected.receipt.snapshot_id, snapshotRevision: injected.receipt.snapshot_revision }), c.intervalSeconds * 1000 + 60000);
      c.previousImage = await pixels(c, 'failure-recovered', 'NORMAL', before);
      return { method: 'CONTROLLED_READ_ABORT_ONLY; excluded from the separate performance groups', injected, aborted, retained, recovered, png: c.previousImage.evidence };
    });
    await c.record('A-STATE-leave-stops-polling', async () => {
      const before = await readView(c); parameters(c, before); assert.equal(before.refresh.mode, 'latest');
      await c.page.getByRole('link').filter({ hasText: /^\s*知识图谱\s*$/ }).click();
      await c.page.waitForURL(url => url.hash.startsWith('#/knowledge'));
      await c.page.locator('[data-testid="gis-status-cycle"]').waitFor({ state: 'hidden' });
      const requestIndex = c.requests.length, started = performance.now(), observationMs = c.intervalSeconds * 1000 + 1500;
      while (performance.now() - started < observationMs) await sleep(200);
      const late = c.requests.slice(requestIndex).filter(value => value.method === 'GET');
      assert.deepEqual(late, [], 'New device-status reads started after the GIS page had unmounted.');
      return { departed_url: c.page.url(), interval_seconds: c.intervalSeconds, observed_ms: performance.now() - started,
        observation: 'request starts after actual route leave; responses from already-started reads are not new polls', late };
    });
    return { output: c.output, functional_only: true, performance_distribution: 'Run runPerformance/runFiveSecondPerformance separately.' };
  });
}

export default runPerformance;
