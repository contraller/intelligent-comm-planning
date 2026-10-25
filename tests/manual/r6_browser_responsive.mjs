// Imported by the main R6 harness; no browser, network, or file work at import time.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'http://127.0.0.24:5324';
const API_ORIGIN = 'http://127.0.0.24:8124';
const FRAME_COUNT = 6, FRAME_INTERVAL_MS = 1000, READY_TIMEOUT_MS = 240000;
const DIAGNOSIS_ROOT = '/api/v1/fault/workbench';
const DIAGNOSIS_RUN_ID = 'FR-3a67f1773487493aa949';
const DIAGNOSIS_RUN = `/fault/workbench/runs/${DIAGNOSIS_RUN_ID}`;
const DIAGNOSIS_RUN_READ = /^\/api\/v1\/fault\/workbench\/runs\/([^/]+)\/(progress|detail|stage|report)$/;
const VIEWS = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];
const read = (pathname, context) => ({ pathname: '/api/v1' + pathname, ...(context ? { context } : {}) });
const ROUTES = [
  { route: 'situation', role: 'editor', title: 'GIS 态势', content: '.situation-page', map: true,
    sources: [read('/resource/context', 'gis'), read('/resource/map', 'gis')] },
  { route: 'resources', role: 'editor', title: '资源管理', content: '.resource-summary',
    sources: [read('/resource/context', 'ledger'), read('/resource/devices', 'ledger')] },
  { route: 'planning', role: 'editor', title: '网络规划', content: '.task-panel', map: true,
    sources: [read('/resource/context', 'planning'), read('/resource/map', 'planning'),
      read('/resource/param-presets', 'planning'), read('/resource/frequency-pool', 'planning')] },
  { route: 'diagnosis', role: 'editor', title: '故障诊断', content: '.diagnosis-workspace',
    sources: [read('/fault/workbench'), read('/fault/workbench/catalog/scenarios'), read('/fault/workbench/catalog/history'),
      read(DIAGNOSIS_RUN + '/progress'), read(DIAGNOSIS_RUN + '/detail'),
      { ...read(DIAGNOSIS_RUN + '/stage'), query: { stage: 'impact' } }, read(DIAGNOSIS_RUN + '/report')] },
  { route: 'knowledge', role: 'editor', title: '知识图谱', content: '.kg-workspace',
    sources: [read('/kg/workbench'), read('/kg/workbench/browse/graph'), read('/kg/workbench/browse/search')] },
  { route: 'system', role: 'admin', title: '系统管理', content: '.system-table',
    sources: [read('/system/options'), read('/system/accounts')] },
];
const PRIOR_RUN_ID = '05d3737a-898e-4076-be56-a2bb38ad56de';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const correctPage = page => page.url() === 'about:blank' || new URL(page.url()).origin === ORIGIN;

function caseScope(caseNames) {
  const requested = caseNames ?? [];
  assert(Array.isArray(requested) && requested.every(id => typeof id === 'string' && id.length > 0), 'caseNames must contain actual nonempty case IDs.');
  assert.equal(new Set(requested).size, requested.length, 'Duplicate responsive case ID.');
  const matrix = VIEWS.flatMap(view => ROUTES.map(spec => `RESP-${view.width}-${spec.route}`));
  for (const id of requested) assert(matrix.includes(id), `Unknown responsive case ID: ${id}`);
  const selected = requested.length ? matrix.filter(id => requested.includes(id)) : matrix;
  return { mode: selected.length === matrix.length ? 'FULL_MATRIX' : 'SELECTED_CASES',
    requestedCaseIds: [...requested], selectedCaseIds: selected, notSelectedCaseIds: matrix.filter(id => !selected.includes(id)),
    matrixCaseCount: matrix.length, expectedCaseCount: selected.length, expectedFrameCount: selected.length * FRAME_COUNT,
    expectedResizeExclusions: selected.some(id => id.startsWith('RESP-390-')) ? 1 : 0,
    interpretation: 'PASS applies only to selected cases; historical references are not new frames or a combined matrix verdict' };
}

async function priorEvidence(scope) {
  if (scope.mode === 'FULL_MATRIX') return null;
  const file = path.join(ROOT, 'data/runtime/r6', PRIOR_RUN_ID, 'responsive.json');
  const bytes = await fs.readFile(file), previous = JSON.parse(bytes);
  assert.equal(previous.schema, 'r6-browser-responsive-v1');
  assert.equal(previous.runId, PRIOR_RUN_ID);
  assert.equal(previous.frontend, ORIGIN); assert.equal(previous.api, API_ORIGIN);
  assert.equal(previous.completed, true); assert.equal(previous.outcome, 'FAIL', 'Do not silently replace the original failed run.');
  const passed = previous.cases.filter(row => row.state === 'PASS' && row.frames.length === FRAME_COUNT);
  const failed = previous.cases.filter(row => row.state === 'FAIL');
  assert.equal(passed.length, 11);
  assert.deepEqual(failed.map(row => row.id), ['RESP-1440-planning']);
  return { runId: previous.runId, report: file, sha256: sha(bytes), outcome: previous.outcome,
    passedCaseIds: passed.map(row => row.id), failedCaseIds: failed.map(row => row.id),
    recordedFrames: previous.cases.reduce((sum, row) => sum + row.frames.length, 0),
    screenshotIndex: path.join(path.dirname(file), 'screenshot-index.md'),
    supplementedFailedCaseIds: scope.selectedCaseIds.filter(id => failed.some(row => row.id === id)),
    referenceOnly: true, combinedFullMatrixOutcome: 'NOT_EVALUATED',
    screenshotsReview: previous.screenshotsReview, originalReportModified: false };
}

function pngDecoder(h) {
  for (const base of [h.pngPackage, process.env.R6_PNG_PACKAGE,
    path.join(ROOT, 'front_design/radio-planning-20261022/package.json'), process.execPath].filter(Boolean)) {
    try { return createRequire(path.resolve(base))('pngjs').PNG; } catch { /* Existing runtime only. */ }
  }
  throw new Error('Use an existing pngjs runtime via the host --png-package; never install or copy dependencies.');
}

// Keep source identity/counts only, never response bodies, account values, headers, or cookies.
function sourceSummary(data, prefix = '', depth = 0) {
  const result = {};
  if (!data || typeof data !== 'object' || depth > 3) return result;
  for (const [key, value] of Object.entries(data)) {
    const name = prefix ? prefix + '.' + key : key;
    if (/^(revision|resource_revision|resourceRevision|content_hash|resource_content_hash|data_origin|dataOrigin|schema_version|versionId|currentVersionId|publishedVersionId|total|page|page_size|pageNum|pageSize)$/.test(key)
      && ['string', 'number', 'boolean'].includes(typeof value)) result[name] = typeof value === 'string' ? value.slice(0, 200) : value;
    else if (Array.isArray(value)) result[name + '.length'] = value.length;
    else if (['workspace', 'metadata', 'source', 'counts', 'current', 'version', 'sources', 'catalog'].includes(key))
      Object.assign(result, sourceSummary(value, name, depth + 1));
  }
  return result;
}

async function sampleDom(page, spec) {
  return page.evaluate(spec => {
    const round = value => Math.round(value * 1000) / 1000;
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
      && getComputedStyle(el).display !== 'none' && getComputedStyle(el).opacity !== '0';
    const dimensions = el => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: round(rect.width), height: round(rect.height), x: round(rect.x), y: round(rect.y),
        clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop, scrollLeft: el.scrollLeft };
    };
    const main = document.querySelector('main.app-content'), heading = main?.querySelector('h1');
    const pageRoot = main?.querySelector('.situation-page, .page'), doc = document.documentElement, body = document.body;
    const blockers = [...document.querySelectorAll('main [role="alert"], .session-freeze, .auth-freeze, .reset-error, main .read-status .warning, main .kg-error')]
      .filter(visible).map(el => el.textContent.trim().slice(0, 300));
    if ([...document.querySelectorAll('main .feedback.warning')].some(el => visible(el) && /来源有效性无法核实/.test(el.textContent))) blockers.push('SOURCE_VALIDITY_UNAVAILABLE');
    const loading = [...document.querySelectorAll('main .request-state, main .read-status .loading, main [role="status"], main .diagnosis-main > .context-card')]
      .filter(el => visible(el) && /正在加载|正在读取|正在刷新/.test(el.textContent)).map(el => el.textContent.trim().slice(0, 160));
    const viewportNodes = [...document.querySelectorAll('main .ol-viewport')].filter(visible);
    const maps = viewportNodes.map((viewport, mapIndex) => {
      const rect = viewport.getBoundingClientRect();
      const canvases = [...viewport.querySelectorAll('canvas')].filter(visible).map((canvas, canvasIndex) => {
        const bounds = canvas.getBoundingClientRect(), colors = new Set();
        const result = { index: canvasIndex, width: canvas.width, height: canvas.height, cssWidth: round(bounds.width), cssHeight: round(bounds.height), opaque: 0, colors: 0, error: null };
        if (canvas.width < 1 || canvas.height < 1 || bounds.width < 1 || bounds.height < 1) return result;
        try {
          const context = canvas.getContext('2d');
          if (!context) { result.error = 'NO_2D_CONTEXT'; return result; }
          for (let y = 0; y < canvas.height; y += Math.max(1, Math.floor(canvas.height / 25)))
            for (let x = 0; x < canvas.width; x += Math.max(1, Math.floor(canvas.width / 25))) {
              const [r, g, b, a] = context.getImageData(x, y, 1, 1).data;
              if (a > 0) { result.opaque++; colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)); }
            }
          result.colors = colors.size;
        } catch (error) { result.error = error.name; }
        return result;
      });
      return { index: mapIndex, dimensions: dimensions(viewport), inViewport: rect.bottom > 0 && rect.top < innerHeight
        && rect.right > 0 && rect.left < innerWidth, canvases };
    });
    const sourceNodes = [...document.querySelectorAll('[aria-label="当前视图数据来源"], .resource-summary, .diagnosis-origin, .kg-context > .chip, .task-panel > .panel-head > .chip')]
      .filter(visible).map(el => ({ selector: el.getAttribute('aria-label') || el.className, text: el.textContent.trim().slice(0, 300) }));
    const overflow = Math.max(doc.scrollWidth, body?.scrollWidth ?? 0) - innerWidth;
    const offenders = overflow > 1 ? [...document.querySelectorAll('body *')].filter(el => {
      if (!visible(el) || el.closest('svg, .ol-viewport, .p-drawer-mask')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
    }).slice(0, 30).map(el => ({ tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', dimensions: dimensions(el) })) : [];
    const reload = spec.route === 'diagnosis' ? [...pageRoot?.querySelectorAll('.page-actions button') ?? []]
      .find(el => el.textContent.trim() === '重新加载') : null;
    const progress = pageRoot?.querySelector('.progress-panel'), report = pageRoot?.querySelector('.result-panel button.report');
    const diagnosisUi = spec.route === 'diagnosis' ? { unlocked: visible(reload) && !reload.disabled,
      progressVisible: visible(progress), progressLabel: progress?.querySelector('.title > strong')?.textContent.trim() ?? '',
      progressValue: progress?.querySelector('progress')?.value ?? null,
      networkVisible: visible(pageRoot?.querySelector('.network-panel')),
      resultVisible: visible(pageRoot?.querySelector('.result-workspace .result-panel')),
      reportEnabled: visible(report) && !report.disabled,
      queryErrorVisible: visible(progress?.querySelector('.error button')) || visible(pageRoot?.querySelector('.diagnosis-main > .feedback.error')) } : null;
    return { at: new Date().toISOString(), route: location.hash.split('?')[0], documentTitle: document.title,
      heading: heading?.textContent.trim() ?? '', headingVisible: visible(heading), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      document: dimensions(doc), body: dimensions(body), main: dimensions(main), page: dimensions(pageRoot), title: dimensions(heading),
      scroll: { x: scrollX, y: scrollY }, fontsReady: !document.fonts || document.fonts.status === 'loaded',
      contentReady: visible(document.querySelector(spec.content)), blockers, loading, sourceNodes, maps, diagnosisUi,
      bodyHorizontalOverflow: overflow, overflowOffenders: offenders };
  }, { content: spec.content, route: spec.route });
}

function drawnMap(frame) {
  return frame.maps.some(map => map.canvases.some(canvas => !canvas.error && canvas.opaque > 0 && canvas.colors >= 8));
}

function sameSource(response, spec) {
  return response.path === spec.pathname && (!spec.context || response.context === spec.context)
    && Object.entries(spec.query ?? {}).every(([key, value]) => response.query?.[key] === value);
}

function diagnosisReadiness(responses, frame) {
  const good = responses.filter(row => row.http === 200 && row.code === 0 && !row.serviceWorker && !row.error);
  const metadata = good.filter(row => row.path === DIAGNOSIS_ROOT).at(-1), ui = frame.diagnosisUi;
  const pending = reason => ({ ready: false, reason, runId: metadata?.diagnosis?.latestRunId ?? null, ui });
  if (!metadata?.diagnosis) return pending('WAIT_METADATA_RUN_ID');
  if (metadata.diagnosis.latestRunId !== DIAGNOSIS_RUN_ID) return pending('APPROVED_R6_DEFAULT_RUN_MISSING');
  if (!good.some(row => row.path === DIAGNOSIS_ROOT + '/catalog/history' && row.diagnosis?.historyContainsFixture))
    return pending('APPROVED_R6_HISTORY_RUN_MISSING');
  if (!ui?.unlocked || ui.queryErrorVisible) return pending('WAIT_VISIBLE_UI_UNLOCK_AND_QUERY_SUCCESS');
  const runId = DIAGNOSIS_RUN_ID;
  const reads = good.filter(row => row.diagnosis?.runId === runId);
  const progress = reads.filter(row => row.diagnosis.kind === 'progress').at(-1)?.diagnosis;
  if (!progress) return pending('WAIT_CURRENT_RUN_PROGRESS');
  if (!reads.some(row => row.diagnosis.kind === 'detail')) return pending('WAIT_CURRENT_RUN_DETAIL');
  if (progress.state !== 'SUCCESS' || !progress.diagnosisReady || !progress.impactReady) return pending('WAIT_APPROVED_RUN_COMPLETE_IMPACT');
  if (!ui.progressVisible || !ui.progressLabel.startsWith('已完成') || ui.progressValue !== progress.progress || !ui.networkVisible)
    return pending('WAIT_CURRENT_RUN_PROGRESS_AND_NETWORK_DOM');
  const stage = 'impact';
  if (!reads.some(row => row.diagnosis.kind === 'stage' && row.diagnosis.stage === stage && row.diagnosis.resultVersion === progress.resultVersion))
    return pending('WAIT_CURRENT_RESULT_VERSION_STAGE');
  if (!ui.resultVisible) return pending('WAIT_RESULT_PANEL_DOM');
  if (!reads.some(row => row.diagnosis.kind === 'report') || !ui.reportEnabled)
    return pending('WAIT_CURRENT_RUN_REPORT_AND_ENABLED_PREVIEW');
  return { ready: true, runId, state: progress.state, resultVersion: progress.resultVersion, stage, ui,
    observedReads: reads.map(row => ({ path: row.path, kind: row.diagnosis.kind, stage: row.diagnosis.stage,
      resultVersion: row.diagnosis.resultVersion, readCompleteAt: row.readCompleteAt })) };
}

async function waitReady(c, spec, since) {
  const started = performance.now();
  let frame, diagnosis;
  while (performance.now() - started < READY_TIMEOUT_MS) {
    assert(correctPage(c.page), 'Page left the approved .24 frontend.');
    assert.equal(c.report.prohibitedWrites.length, 0, 'Unexpected non-read API request.');
    assert.equal(c.report.foreignRequests.length, 0, 'A request targeted an unapproved HTTP origin.');
    assert.equal(c.report.pageErrors.length, 0, 'An unhandled pageerror occurred.');
    frame = await sampleDom(c.page, spec);
    const responses = c.report.sources.slice(since);
    const sourcesReady = spec.sources.every(source => responses.some(response => sameSource(response, source) && response.http === 200 && response.code === 0 && !response.serviceWorker && !response.error));
    diagnosis = spec.route === 'diagnosis' ? diagnosisReadiness(responses, frame) : null;
    if (frame.route === '#/' + spec.route && frame.heading === spec.title && frame.headingVisible && frame.contentReady && frame.fontsReady
      && !frame.loading.length && !frame.blockers.length && sourcesReady && (!diagnosis || diagnosis.ready) && (!spec.map || drawnMap(frame)))
      return { waitedMs: performance.now() - started, frame, diagnosis, sources: responses.filter(response => spec.sources.some(source => sameSource(response, source))
        || spec.route === 'diagnosis' && response.diagnosis?.runId === diagnosis?.runId) };
    await sleep(250);
  }
  const error = new Error('Real route/source readiness timed out: ' + spec.route);
  error.detail = { classification: 'READINESS_NOT_OBSERVED_WITHIN_TOOL_BUDGET; not a diagnosis of a production defect',
    lastFrame: frame, diagnosis, expected: spec.sources, observed: c.report.sources.slice(since) };
  throw error;
}

function validateFrames(result, spec, viewport) {
  const frames = result.frames;
  assert.equal(frames.length, FRAME_COUNT, 'Six consecutive frames are required; none may be discarded.');
  for (const frame of frames) {
    assert.equal(frame.route, '#/' + spec.route);
    assert.equal(frame.heading, spec.title);
    assert(frame.headingVisible && frame.main?.width > 0 && frame.page?.width > 0 && frame.page?.height > 0, 'Actual route heading/layout is not visible.');
    assert(frame.documentTitle.includes(spec.title), 'Document title does not identify the route.');
    assert.equal(frame.documentTitle, frames[0].documentTitle, 'Document title changed within the series.');
    assert.equal(frame.viewport.width, viewport.width);
    assert.equal(frame.viewport.height, viewport.height);
    assert(frame.contentReady && frame.fontsReady && !frame.loading.length && !frame.blockers.length, 'Page lost readiness during sampling.');
    assert(frame.bodyHorizontalOverflow <= 1, 'Body/document horizontal overflow exceeds one CSS rounding pixel.');
    if (spec.map) assert(drawnMap(frame), 'A real map canvas is blank/unreadable during sampling.');
  }
  result.ranges = {};
  for (const element of ['document', 'body', 'main', 'page', 'title']) {
    for (const dimension of ['width', 'height', 'scrollWidth', 'scrollHeight']) {
      const values = frames.map(frame => frame[element]?.[dimension]);
      assert(values.every(Number.isFinite), `Missing DOM dimensions: ${element}.${dimension}`);
      const min = Math.min(...values), max = Math.max(...values), range = max - min;
      result.ranges[element + '.' + dimension] = { min, max, range };
      assert(range <= 1, `Post-ready layout changed: ${element}.${dimension}, ${range}px`);
    }
  }
  result.actualIntervalsMs = frames.slice(1).map((frame, i) => frame.elapsedMs - frames[i].elapsedMs);
  result.sampleExclusions = [];
}

function pngColors(PNG, bytes) {
  const png = PNG.sync.read(bytes), colors = new Set();
  let opaque = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b, a] = png.data.subarray(i, i + 4);
    if (a > 0) { opaque++; colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)); }
  }
  return { width: png.width, height: png.height, opaquePixels: opaque, quantizedColors: colors.size };
}

async function screenshot(c, name, locator) {
  const file = path.join(c.output, name + '.png');
  const bytes = locator ? await locator.screenshot({ path: file, type: 'png', timeout: 30000 })
    : await c.page.screenshot({ path: file, fullPage: false, type: 'png', timeout: 30000 });
  return { file, sha256: sha(bytes), ...pngColors(c.PNG, bytes) };
}

async function routeCase(c, spec, viewport) {
  const id = `RESP-${viewport.width}-${spec.route}`, result = c.report.cases.find(row => row.id === id);
  const started = performance.now(), errorIndex = c.report.pageErrors.length;
  result.state = 'RUNNING';
  try {
    await c.login(spec.role);
    assert(correctPage(c.page), 'Harness login must stay on the approved frontend.');
    const since = c.report.sources.length;
    c.epoch++;
    const destination = `${ORIGIN}/?r6-responsive=${c.report.runId}-${id}#/${spec.route}`;
    await c.page.goto(destination, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });
    const ready = await waitReady(c, spec, since);
    result.ready = { waitedMs: ready.waitedMs, sources: ready.sources, sourceNodes: ready.frame.sourceNodes, diagnosis: ready.diagnosis };
    const context = ready.sources.find(row => row.path === '/api/v1/resource/context');
    if (context) {
      result.resourceRevision = context.anchor?.revision;
      assert.match(result.resourceRevision ?? '', /^resource-[a-f0-9]{16}$/);
      for (const source of ready.sources.filter(row => ['/api/v1/resource/map', '/api/v1/resource/devices'].includes(row.path)))
        assert.equal(source.anchor?.revision, result.resourceRevision, 'Visible read sources belong to different resource versions.');
    }
    const sampling = performance.now();
    let nextSampleAt = sampling;
    for (let i = 0; i < FRAME_COUNT; i++) {
      if (i) await sleep(Math.max(0, nextSampleAt - performance.now()));
      const frame = await sampleDom(c.page, spec);
      frame.index = i + 1; frame.elapsedMs = performance.now() - sampling; result.frames.push(frame);
      if (spec.route === 'diagnosis') {
        const current = diagnosisReadiness(c.report.sources.slice(since), frame);
        assert(current.ready && current.runId === ready.diagnosis.runId && current.resultVersion === ready.diagnosis.resultVersion,
          'Diagnosis initial source/UI readiness changed during the formal six frames.');
      }
      nextSampleAt = performance.now() + FRAME_INTERVAL_MS;
      if (i === 0 || i === FRAME_COUNT - 1) result.screenshots.push(await screenshot(c, `${id}-frame-${i + 1}`));
    }
    validateFrames(result, spec, viewport);
    if (spec.map) {
      // Locator screenshot may scroll, but only after the six-frame series; record it explicitly.
      const before = await c.page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
      const maps = c.page.locator('main .ol-viewport:visible');
      result.mapScreenshots = [];
      for (let i = 0; i < await maps.count(); i++) {
        const png = await screenshot(c, `${id}-map-${i + 1}`, maps.nth(i));
        result.mapScreenshots.push(png);
        assert(png.width > 0 && png.height > 0 && png.opaquePixels > 0 && png.quantizedColors >= 8, 'Real map PNG is blank/near-single-color.');
      }
      assert(result.mapScreenshots.length > 0, 'No actual map screenshot was captured.');
      result.mapScreenshotScroll = { before, after: await c.page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })),
        occursAfterSampling: true, changesBusinessData: false };
    }
    assert.equal(c.report.pageErrors.length, errorIndex, 'Pageerror during this case.');
    assert.equal(c.report.prohibitedWrites.length, 0, 'An unexpected non-read API request was observed.');
    assert.equal(c.report.foreignRequests.length, 0, 'A request targeted an unapproved origin.');
    result.state = 'PASS';
  } catch (error) {
    result.state = 'FAIL'; result.error = { name: error.name, message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
    result.screenshots.push(await screenshot(c, id + '-failed').catch(() => ({ unavailable: true })));
  } finally {
    result.durationMs = performance.now() - started;
    await c.save();
    console.log(JSON.stringify({ responsive: id, state: result.state, frames: result.frames.length, output: c.output,
      ...(result.error ? { error: result.error.message } : {}) }));
  }
}

export async function runResponsive(h) {
  assert.equal(h.performanceComplete, true, 'Main must release its exclusive performance window before invoking responsive.');
  const scope = caseScope(h.caseNames);
  assert(h.page && typeof h.page.evaluate === 'function' && typeof h.login === 'function', 'Reuse the real main-harness Page/login; no substitutes.');
  assert(correctPage(h.page), 'Refusing a Page outside .24.');
  assert.match(ROOT, /^F:[\\/]/i);
  const runtime = path.resolve(h.runtime);
  assert(samePath(path.dirname(runtime), path.join(ROOT, 'data/runtime/r2')) && /^r4-[a-f0-9]{32}$/.test(path.basename(runtime)), 'Explicit R6 service runtime required.');
  // Public manifest only. Login credentials remain exclusively inside the supplied main closure.
  const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'workspace.json'), 'utf8'));
  assert.equal(manifest.frontend, ORIGIN); assert.equal(manifest.api, API_ORIGIN);
  assert(samePath(manifest.key_file, path.join(runtime, 'private.json')));
  assert.equal(manifest.database_url, `sqlite:///${path.join(ROOT, 'data/runtime/tmp', path.basename(runtime), 'workspace.sqlite').replaceAll('\\', '/')}`);
  const reference = await priorEvidence(scope);
  const PNG = pngDecoder(h), runId = randomUUID(), base = path.join(ROOT, 'data/runtime/r6');
  assert(samePath(await fs.realpath(base), base), 'R6 output root must not redirect elsewhere.');
  const output = path.join(base, runId);
  await fs.mkdir(output, { recursive: false });
  const report = { schema: 'r6-browser-responsive-v1', runId, output, frontend: ORIGIN, api: API_ORIGIN,
    scope, priorEvidence: reference, fullMatrixPassed: false,
    source: 'REAL_FRONTEND_DEV_SOURCE_WITH_PRODUCT_FETCH_XHR', serviceRuntime: runtime,
    credentials: 'MAIN_HARNESS_LOGIN_CLOSURE_ONLY; no private/header/cookie logging',
    frameCount: FRAME_COUNT, frameIntervalMs: FRAME_INTERVAL_MS, readyTimeoutMs: READY_TIMEOUT_MS,
    dimensionToleranceCssPx: 1, colorProbe: 'canvas grid plus decoded real map PNG; >=8 quantized colors is a local nonblank check, not a project standard',
    sampleTiming: 'One-second minimum spacing; real intervals retained; slow screenshot I/O never causes catch-up bursts',
    diagnosisReadiness: `Approved R6 fixture ${DIAGNOSIS_RUN_ID}: current metadata/history plus progress/detail, matching resultVersion impact stage and report; visible reload unlocked, completed progress/network/result DOM and enabled report preview; empty history is not accepted; no fixed sleep or discarded formal frames`,
    resizeExclusions: [], initialViewport: h.page.viewportSize(), sources: [], pageErrors: [], prohibitedWrites: [], foreignRequests: [],
    cases: VIEWS.flatMap(view => ROUTES.map(spec => ({ id: `RESP-${view.width}-${spec.route}`, role: spec.role, route: spec.route, viewport: view,
      state: 'NOT_RUN', frames: [], screenshots: [] }))).filter(row => scope.selectedCaseIds.includes(row.id)),
    screenshotsReview: 'PENDING_MAIN_VISUAL_REVIEW; PNG/color checks do not prove all text is unobscured',
    completed: false, outcome: 'NOT_RUN' };
  const c = { page: h.page, login: h.login, output, PNG, report, epoch: 0,
    save: async () => {
      const temporary = path.join(output, `responsive-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      // ENOSPC leaves the previous complete report intact; never clean files on a save failure.
      await fs.rename(temporary, path.join(output, 'responsive.json'));
    } };
  const pending = new Set(), requestEpochs = new WeakMap();
  let activeSources = [];
  const onError = error => report.pageErrors.push({ at: new Date().toISOString(), message: error.message });
  const onRequest = request => {
    requestEpochs.set(request, c.epoch);
    let url; try { url = new URL(request.url()); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (![ORIGIN, API_ORIGIN].includes(url.origin)) report.foreignRequests.push({ origin: url.origin, path: url.pathname, method: request.method() });
    if (url.pathname.startsWith('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      && !(url.pathname === '/api/v1/auth/login' && request.method() === 'POST'))
      report.prohibitedWrites.push({ at: new Date().toISOString(), path: url.pathname, method: request.method() });
  };
  const onResponse = response => {
    const url = new URL(response.url());
    const runRead = activeSources.some(source => source.pathname === DIAGNOSIS_ROOT) ? DIAGNOSIS_RUN_READ.exec(url.pathname) : null;
    if (![ORIGIN, API_ORIGIN].includes(url.origin) || response.request().method() !== 'GET'
      || requestEpochs.get(response.request()) !== c.epoch || !runRead && !activeSources.some(source => source.pathname === url.pathname)) return;
    const row = { path: url.pathname, context: url.searchParams.get('context'),
      query: Object.fromEntries(['stage', 'resultVersion'].filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)])), http: response.status(), code: null,
      navigationEpoch: c.epoch, serviceWorker: response.fromServiceWorker(), resourceType: response.request().resourceType(), at: new Date().toISOString() };
    report.sources.push(row);
    const work = (async () => {
      try {
        assert(['fetch', 'xhr'].includes(row.resourceType), 'Source evidence is not a product fetch/XHR.');
        const body = await response.json(); row.code = body.code; row.anchor = sourceSummary(body.data);
        assert(body.data && typeof body.data === 'object', 'Missing real source data.');
        if (!runRead) assert(!body.data.error && !body.data.sources?.error, 'Source metadata reports an unavailable source.');
        if (url.pathname === DIAGNOSIS_ROOT) {
          assert.equal(body.data.latestRunId, DIAGNOSIS_RUN_ID, 'The approved R6 default run must exist; empty history is not this fixture.');
          row.diagnosis = { latestRunId: body.data.latestRunId };
        }
        if (url.pathname === DIAGNOSIS_ROOT + '/catalog/history') {
          assert(Array.isArray(body.data.items) && body.data.items.some(item => item.id === DIAGNOSIS_RUN_ID), 'The actual history DTO does not contain the approved R6 run.');
          row.diagnosis = { historyContainsFixture: true };
        }
        if (runRead) {
          const runId = decodeURIComponent(runRead[1]), kind = runRead[2], data = body.data;
          assert.equal(runId, DIAGNOSIS_RUN_ID, 'Unexpected run outside the approved R6 diagnosis fixture.');
          row.diagnosis = { runId, kind }; row.anchor.diagnosisRunId = runId;
          if (kind === 'progress') {
            assert.equal(data.id, runId, 'Diagnosis progress run identity mismatch.');
            assert(['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'].includes(data.state) && Number.isFinite(data.progress)
              && typeof data.diagnosisReady === 'boolean' && typeof data.impactReady === 'boolean'
              && typeof data.resultVersion === 'string' && data.resultVersion.length > 0, 'Invalid diagnosis progress readiness fields.');
            Object.assign(row.diagnosis, { state: data.state, progress: data.progress, diagnosisReady: data.diagnosisReady,
              impactReady: data.impactReady, resultVersion: data.resultVersion });
          } else if (kind === 'detail') assert.equal(data.run?.id, runId, 'Diagnosis detail run identity mismatch.');
          else if (kind === 'report') assert.equal(data.id, runId, 'Diagnosis report run identity mismatch.');
          else {
            const stage = url.searchParams.get('stage'), resultVersion = url.searchParams.get('resultVersion');
            assert(['diagnosis', 'impact'].includes(stage) && resultVersion, 'Missing actual diagnosis stage/version query.');
            Object.assign(row.diagnosis, { stage, resultVersion });
          }
        }
        assert(Object.keys(row.anchor).length > 0, 'Missing source identity/count evidence.');
        row.readCompleteAt = new Date().toISOString();
      } catch (error) { row.error = error.message; }
    })();
    pending.add(work); void work.finally(() => pending.delete(work));
  };
  h.page.on('pageerror', onError); h.page.on('request', onRequest); h.page.on('response', onResponse);
  await c.save();
  try {
    assert.deepEqual(h.page.viewportSize(), VIEWS[0], 'Use a fresh harness Page at 1440x1000; do not hide additional resizes.');
    for (const [index, view] of VIEWS.entries()) {
      const selectedRoutes = ROUTES.filter(spec => scope.selectedCaseIds.includes(`RESP-${view.width}-${spec.route}`));
      if (!selectedRoutes.length) continue;
      if (index) {
        const before = await sampleDom(h.page, ROUTES.at(-1));
        await h.page.setViewportSize(view);
        const after = await sampleDom(h.page, ROUTES.at(-1));
        report.resizeExclusions.push({ reason: 'ONE_EXPECTED_1440_TO_390_VIEWPORT_TRANSITION', before, after,
          excludedFromStableFrames: true, removedFromCaseFrames: 0, doesNotExcuseOverflowOrLaterLayoutChanges: true });
        await c.save();
      }
      for (const spec of selectedRoutes) {
        if (report.prohibitedWrites.length || report.foreignRequests.length) throw new Error('Safety boundary violation; remaining routes are NOT_RUN.');
        activeSources = spec.sources;
        await routeCase(c, spec, view);
      }
    }
    report.completed = report.cases.every(row => ['PASS', 'FAIL'].includes(row.state));
  } catch (error) { report.failure = { name: error.name, message: error.message }; }
  finally {
    await Promise.allSettled([...pending]);
    h.page.off('pageerror', onError); h.page.off('request', onRequest); h.page.off('response', onResponse);
    const actualFrames = report.cases.reduce((sum, row) => sum + row.frames.length, 0);
    report.coverage = { expectedCases: scope.expectedCaseCount, executedCases: report.cases.filter(row => row.state !== 'NOT_RUN').length,
      passedCases: report.cases.filter(row => row.state === 'PASS').length, failedCases: report.cases.filter(row => row.state === 'FAIL').length,
      expectedFrames: scope.expectedFrameCount, actualFrames, notSelectedCases: scope.notSelectedCaseIds.length };
    report.outcome = report.completed && report.cases.length === scope.expectedCaseCount
      && report.cases.every(row => row.state === 'PASS' && row.frames.length === FRAME_COUNT) && actualFrames === scope.expectedFrameCount
      && report.pageErrors.length === 0 && report.prohibitedWrites.length === 0 && report.foreignRequests.length === 0
      && report.resizeExclusions.length === scope.expectedResizeExclusions ? 'PASS' : 'FAIL';
    report.fullMatrixPassed = scope.mode === 'FULL_MATRIX' && report.outcome === 'PASS';
    report.endedAt = new Date().toISOString();
    await c.save();
    const index = report.cases.map(row => ({ case: row.id, role: row.role, viewport: row.viewport, state: row.state,
      frames: row.frames.length, screenshots: [...row.screenshots, ...(row.mapScreenshots ?? [])],
      visualReview: 'PENDING_MAIN_VISUAL_REVIEW' }));
    await fs.writeFile(path.join(output, 'screenshot-index.json'), JSON.stringify({ scope, priorEvidence: reference, coverage: report.coverage,
      fullMatrixPassed: report.fullMatrixPassed, cases: index }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    const lines = ['# R6 Responsive Screenshot Index', '', `Scope: ${scope.mode}; ${scope.expectedCaseCount}/${scope.matrixCaseCount} cases; ${actualFrames}/${scope.expectedFrameCount} new frames.`, '',
      'Visual review: PENDING_MAIN_VISUAL_REVIEW. Generated screenshots and color checks are not visual acceptance.', '',
      ...(reference ? [`Historical reference only: ${reference.report}; original outcome FAIL; combined full-matrix outcome NOT_EVALUATED.`, ''] : []),
      '| Case | Role | Viewport | Automated State | Frames | Screenshots |', '|---|---|---|---|---:|---|'];
    for (const row of index) lines.push(`| ${row.case} | ${row.role} | ${row.viewport.width}x${row.viewport.height} | ${row.state} | ${row.frames} | ${row.screenshots.filter(shot => shot.file).map(shot => `[${path.basename(shot.file)}](${path.basename(shot.file)})`).join(' / ')} |`);
    await fs.writeFile(path.join(output, 'screenshot-index.md'), lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  assert.equal(report.outcome, 'PASS', `Responsive ${scope.mode} failed; preserve ${path.join(output, 'responsive.json')}`);
  return { output, outcome: report.outcome, scope, coverage: report.coverage, fullMatrixPassed: report.fullMatrixPassed,
    priorEvidence: reference, cases: report.cases.length, frames: report.cases.reduce((sum, row) => sum + row.frames.length, 0),
    pageErrors: report.pageErrors.length, resizeExclusions: report.resizeExclusions.length, screenshotsReview: report.screenshotsReview };
}

export default runResponsive;
