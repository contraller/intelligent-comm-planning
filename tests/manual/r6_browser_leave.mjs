import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Main-harness imports only. No browser, server, credentials or standalone entry.
const ORIGIN = 'http://127.0.0.24:5324';
const API_ORIGIN = 'http://127.0.0.24:8124';
const API = '/api/v1';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (scope, role, text) => scope.getByRole(role).filter({ hasText: new RegExp(`^\\s*${escape(text)}\\s*$`) });
const button = (scope, text) => named(scope, 'button', text);
const label = (scope, text) => scope.getByLabel(text, { exact: true });
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

// Uses Chromium's real navigation dialog, never dispatchEvent or a hidden store.
export async function dismissBeforeUnload({ page, timeoutMs = 30_000 }) {
  const originalUrl = page.url();
  assert.equal(new URL(originalUrl).origin, ORIGIN, 'Native reload is restricted to the .24 frontend');
  const navigations = [];
  const navigated = frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); };
  page.on('framenavigated', navigated);
  try {
    // Attach rejection handlers before triggering reload; cancellation may reject it immediately.
    const waiting = page.waitForEvent('dialog', { timeout: Math.min(timeoutMs,15_000) }).then(dialog => ({ dialog }), error => ({ error }));
    const reloading = page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs,5_000) }).then(
      response => ({ resolved: true, status: response?.status() ?? null }),
      error => ({ resolved: false, errorName: error.name, error: error.message.split('\n')[0] }),
    );
    const event = await waiting;
    if (event.error) { await reloading; throw event.error; }
    const type = event.dialog.type();
    await event.dialog.dismiss();
    const result = await reloading;
    assert.equal(type, 'beforeunload', 'Expected the native beforeunload dialog, not a product modal');
    // Chromium may leave Playwright's navigation waiter pending after a real dismissal.
    // Prove cancellation from the native event, unchanged document and caller's DOM values.
    assert.equal(navigations.length, 0, 'Dismiss must not replace the document');
    assert.equal(page.url(), originalUrl, 'Dismiss must keep the exact URL');
    return { type, action: 'dismiss', urlRetained: true, topLevelNavigations: 0,
      navigationWaitTimedOutAfterDismiss:result.errorName==='TimeoutError',reload:result };
  } finally { page.off('framenavigated', navigated); }
}

async function environment(input) {
  for (const name of ['login', 'record', 'download', 'shot']) assert.equal(typeof input[name], 'function', `Missing harness ${name}`);
  assert.ok(input.page && input.taskId && input.planId, 'A real Page and this run task/plan are required');
  const config = typeof input.runtime === 'string' ? { dir: input.runtime } : input.runtime;
  assert.ok(config?.dir && /^F:[\\/]/i.test(config.dir), 'Use the current F: isolated runtime');
  const manifest = JSON.parse(await readFile(path.join(config.dir, 'workspace.json'), 'utf8'));
  assert.equal(manifest.frontend, ORIGIN);
  assert.equal(manifest.api, API_ORIGIN);
  assert.ok(input.page.url() === 'about:blank' || new URL(input.page.url()).origin === ORIGIN, 'Refusing another browser origin');
  return { ...input, timeout: config.timeoutMs ?? 120_000, sources: [], prohibited: [], results: [] };
}

function matches(response, endpoint, method = 'GET', query = {}) {
  const url = new URL(response.url());
  return [ORIGIN, API_ORIGIN].includes(url.origin) && url.pathname === API + endpoint
    && response.request().method() === method
    && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === String(value));
}

async function payload(ctx, response) {
  assert.equal(response.ok(), true, `HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  const raw = await response.json();
  assert.equal(raw.code, 0, `Business response rejected: ${raw.code} ${raw.message}`);
  ctx.sources.push({ path: new URL(response.url()).pathname + new URL(response.url()).search,
    method: response.request().method(), status: response.status() });
  return raw.data;
}

async function until(ctx, read, expected, message) {
  const deadline = Date.now() + ctx.timeout;
  let actual;
  do {
    actual = await read();
    if (actual === expected) return;
    await pause();
  } while (Date.now() < deadline);
  assert.equal(actual, expected, message);
}

const panel = ctx => ctx.page.locator('section[aria-label="冻结规划覆盖缓存"]');
const editor = ctx => panel(ctx).locator('section[aria-label="覆盖带宽选择"]');
const navigation = ctx => ctx.page.getByRole('navigation', { name: '主导航', exact: true });
const decision = ctx => ctx.page.getByRole('dialog', { name: '未确认的覆盖带宽选择', exact: true });

async function cleanTask(ctx) {
  const chip = ctx.page.locator('.task-panel .panel-head .chip');
  assert.equal((await chip.textContent()).trim(), '已保存任务', 'Do not borrow task dirty to prove coverage protection');
  assert.ok((await ctx.page.locator('.task-meta').textContent()).includes(ctx.taskId));
  assert.equal(await ctx.page.getByRole('dialog', { name: '处理未保存任务输入', exact: true }).isVisible(), false);
}

async function step(ctx, number) {
  const titles = ['任务与约束输入', '规划计算与结果', '方案调整与对比'];
  await until(ctx, async () => (await ctx.page.locator('.steps button.active').innerText()).trim(),
    `${number} · ${titles[number - 1]}`, 'The planning step changed unexpectedly');
}

async function answer(ctx, text) {
  await decision(ctx).waitFor({ state: 'visible', timeout: ctx.timeout });
  await button(decision(ctx), text).click();
  await decision(ctx).waitFor({ state: 'hidden', timeout: ctx.timeout });
}

async function openPlan(ctx) {
  const marker=String(Date.now());
  const currentDocument=response=>{
    const referer=response.request().headers().referer;
    return !!referer&&new URL(referer).searchParams.get('r6leave')===marker;
  };
  const read=(endpoint,query={})=>ctx.page.waitForResponse(response=>matches(response,endpoint,'GET',query)&&currentDocument(response),{timeout:ctx.timeout})
    .then(async response=>({response,data:await payload(ctx,response)}));
  const waits = [
    read(`/plans/${encodeURIComponent(ctx.planId)}`),
    read(`/task-inputs/${encodeURIComponent(ctx.taskId)}`),
    read(`/planning-coverages/${encodeURIComponent(ctx.planId)}/bandwidth-options`,{task_id:ctx.taskId,context:'planning'}),
    read('/auth/session'),
  ];
  const observed = await Promise.all([...waits, ctx.page.goto(
    `${ORIGIN}/?r6leave=${marker}#/planning?taskId=${encodeURIComponent(ctx.taskId)}&planId=${encodeURIComponent(ctx.planId)}`,
    { waitUntil: 'domcontentloaded', timeout: ctx.timeout },
  )]);
  const [plan, task, options, identity] = observed.slice(0,4).map(value=>value.data);
  assert.equal(plan.plan_id, ctx.planId); assert.equal(plan.task_id, ctx.taskId);
  assert.equal(plan.state, 'CONFIRMED');
  assert.equal(task.task_id, ctx.taskId);
  assert.notEqual(identity.integration_mode, true, 'Use the real local editor login');
  assert.ok(identity.account_id);
  assert.ok(identity.permissions.includes('planning.execute') && identity.permissions.includes('resources.view'));
  assert.equal(options.anchor.plan_id, ctx.planId); assert.equal(options.anchor.task_id, ctx.taskId);
  assert.equal(options.anchor.snapshot_id, plan.result.snapshot_id);
  assert.equal(options.anchor.resource_revision, plan.resource_revision);
  assert.equal(new URL(observed[2].response.url()).searchParams.get('snapshot_id'), plan.result.snapshot_id);
  assert.equal(options.current_selection, null, 'This case requires the original plan with no saved bandwidth selection');
  if (ctx.anchor) assert.deepEqual(options.anchor, ctx.anchor, 'Original coverage source changed');
  ctx.anchor = options.anchor; ctx.catalog = options;
  await panel(ctx).waitFor({ state: 'visible', timeout: ctx.timeout });
  await step(ctx, 2); await cleanTask(ctx);
  await until(ctx, () => button(panel(ctx), '刷新带宽选项与选择').isEnabled(), true, 'Bandwidth options did not become readable');
  return { planId: plan.plan_id, taskId: task.task_id, state: plan.state, anchor: ctx.anchor,
    currentSelection: options.current_selection, accountId: identity.account_id };
}

async function deviceControl(ctx) {
  const source = ctx.catalog.devices.find(row => row.state === 'SELECTION_REQUIRED' && row.options_khz?.length);
  assert.ok(source, 'No legal unselected coverage option exists; do not manufacture data or a task dirty state');
  await label(editor(ctx), '筛选带宽型号').selectOption(source.model_id);
  const pages = Math.ceil(ctx.catalog.devices.filter(row => row.model_id === source.model_id).length / 20);
  const control = label(editor(ctx), `设备 ${source.device_id} 带宽`);
  for (let index = 1; index <= pages; index++) {
    await until(ctx, async () => (await editor(ctx).locator('.pager > span').innerText()).trim().startsWith(`${index} / `), true, 'Bandwidth page did not settle');
    if (await control.count()) {
      await control.waitFor({ state: 'visible', timeout: ctx.timeout });
      await until(ctx, () => control.isEnabled(), true, 'The original device bandwidth control remained disabled');
      return { control, source };
    }
    assert.ok(index < pages, 'The original device is absent from its UI model/page');
    await button(editor(ctx), '下一页').click();
  }
  assert.fail('No coverage device page found');
}

async function makeDirty(ctx) {
  await cleanTask(ctx);
  const { control, source } = await deviceControl(ctx);
  const before = await control.inputValue();
  assert.equal(before, '', 'Expected a genuinely unselected device in the original plan');
  const selected = String(source.options_khz[0]);
  assert.equal(await control.locator('option').filter({ hasText: new RegExp(`^${escape(selected)}$`) }).count(), 1,
    'The chosen bandwidth must be an actual UI option');
  // The trusted click also supplies the sticky activation required by beforeunload.
  await control.click(); await control.selectOption(selected);
  await until(ctx, () => control.inputValue(), selected, 'Local bandwidth choice was not retained');
  await until(ctx, async () => (await editor(ctx).locator('.feedback').innerText()).trim(),
    '待确认 1 台；未确认内容尚未保存', 'Coverage alone must become dirty');
  ctx.choice = { deviceId: source.device_id, modelId: source.model_id, before, selected, optionsKhz: source.options_khz };
  return ctx.choice;
}

async function assertDirty(ctx) {
  await cleanTask(ctx); await step(ctx, 2);
  const control = label(editor(ctx), `设备 ${ctx.choice.deviceId} 带宽`);
  assert.equal(await control.inputValue(), ctx.choice.selected);
  assert.equal((await editor(ctx).locator('.feedback').innerText()).trim(), '待确认 1 台；未确认内容尚未保存');
  return ctx.choice;
}

export async function runCoverageLeave(input) {
  const ctx = await environment(input);
  const capture = request => {
    const url = new URL(request.url()), method = request.method();
    if (![ORIGIN, API_ORIGIN].includes(url.origin) || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    if (url.pathname.startsWith(`${API}/planning-coverages/`) || url.pathname === `${API}/plan/sr4-flow`
      || url.pathname === `${API}/auth/logout` || /^\/api\/v1\/(?:plans|task-inputs)(?:\/|$)/.test(url.pathname)) {
      ctx.prohibited.push({ path: url.pathname, method });
    }
  };
  ctx.page.on('request', capture);
  const record = async (id, action) => {
    const start = ctx.sources.length;
    const result = await ctx.record(id, async () => {
      try {
        const detail = await action();
        assert.deepEqual(ctx.prohibited, [], 'Unexpected save/recompute/logout request; stop and retain the page');
        return { ...detail, taskId: ctx.taskId, planId: ctx.planId, anchor: ctx.anchor,
          sources: ctx.sources.slice(start), prohibitedWrites: [...ctx.prohibited] };
      } catch (error) {
        error.message += '\nCoverage leave source: ' + JSON.stringify({ taskId: ctx.taskId, planId: ctx.planId,
          anchor: ctx.anchor, choice: ctx.choice, prohibitedWrites: ctx.prohibited });
        throw error;
      }
    });
    ctx.results.push(result); return result;
  };
  try {
    await record('R6-COV-01-open-frozen-source', async () => {
      await ctx.login('editor');
      assert.equal(new URL(ctx.page.url()).origin, ORIGIN);
      return openPlan(ctx);
    });
    await record('R6-COV-02-step-continue-discard', async () => {
      const choice = await makeDirty(ctx);
      await button(ctx.page, '1 · 任务与约束输入').click(); await answer(ctx, '继续选择');
      await assertDirty(ctx);
      await button(ctx.page, '1 · 任务与约束输入').click(); await answer(ctx, '放弃未确认选择');
      await step(ctx, 1); await cleanTask(ctx);
      await button(ctx.page, '2 · 规划计算与结果').click(); await step(ctx, 2);
      assert.equal(await label(editor(ctx), `设备 ${choice.deviceId} 带宽`).inputValue(), choice.before);
      assert.equal((await editor(ctx).locator('.feedback').innerText()).trim(), '待确认 0 台；未确认内容尚未保存');
      return { choice, continued: true, discardedOnStepChange: true, saved: false };
    });
    await record('R6-COV-03-beforeunload-dismiss', async () => {
      const choice = await makeDirty(ctx);
      const native = await dismissBeforeUnload({ page: ctx.page, timeoutMs: ctx.timeout });
      await assertDirty(ctx);
      return { choice, native, valueRetained: true };
    });
    await record('R6-COV-04-route-continue', async () => {
      const before = ctx.page.url();
      await named(navigation(ctx), 'link', '资源管理').click(); await answer(ctx, '继续选择');
      assert.equal(ctx.page.url(), before); await assertDirty(ctx);
      return { continuedOnOriginalRoute: true, choice: ctx.choice };
    });
    await record('R6-COV-05-logout-cancel', async () => {
      const before = ctx.page.url(), identity = await ctx.page.locator('.user-entry').innerText();
      await button(ctx.page.locator('.app-header'), '退出').click(); await answer(ctx, '继续选择');
      await until(ctx, () => button(ctx.page.locator('.app-header'), '退出').isEnabled(), true, 'Logout transition did not finish');
      assert.equal(ctx.page.url(), before); assert.equal(await ctx.page.locator('.user-entry').innerText(), identity);
      await assertDirty(ctx);
      return { cancelled: true, sessionRetained: true, logoutRequests: 0, choice: ctx.choice };
    });
    await record('R6-COV-06-route-discard-readback', async () => {
      const waiting = ctx.page.waitForResponse(response => matches(response, '/resource/devices', 'GET', { context: 'ledger' }), { timeout: ctx.timeout });
      const [response] = await Promise.all([waiting, (async () => {
        await named(navigation(ctx), 'link', '资源管理').click(); await answer(ctx, '放弃未确认选择');
      })()]);
      const resources = await payload(ctx, response);
      await ctx.page.waitForURL(url => url.hash === '#/resources', { timeout: ctx.timeout });
      await ctx.page.getByRole('heading', { name: '资源管理', exact: true }).waitFor({ state: 'visible', timeout: ctx.timeout });
      assert.ok(resources.revision, 'The target route must read the real ledger');
      await ctx.shot('coverage-route-discard-resources');
      const original = await openPlan(ctx);
      const { control } = await deviceControl(ctx);
      assert.equal(await control.inputValue(), ctx.choice.before);
      assert.equal((await editor(ctx).locator('.feedback').innerText()).trim(), '待确认 0 台；未确认内容尚未保存');
      return { discardedOnRouteChange: true, ledgerRevision: resources.revision, original,
        serverSelectionStillNull: true, saved: false, recomputed: false };
    });
    return ctx.results;
  } finally {
    // Never discard a failed case's input or silently retry a business write.
    ctx.page.off('request', capture);
  }
}

export default runCoverageLeave;
