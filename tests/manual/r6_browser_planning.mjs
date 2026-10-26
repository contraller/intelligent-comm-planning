// Imported by the R6 host. This module never creates a browser or starts a service.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ORIGIN = 'http://127.0.0.24:5324';
const API_ORIGINS = new Set([ORIGIN, 'http://127.0.0.24:8124']);
const PREFIX = '/api/v1';
const WB = '/interference/workbench';
const LIMIT = 360000;
const terminal = value => ['SUCCESS', 'FAILED', 'CANCELLED'].includes(value.status);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (scope, name) => scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${escapeRegex(name)}\\s*$`) });
const iconButton = (scope, name) => scope.getByRole('button', { name, exact: true });
const enc = encodeURIComponent;
const RECOVERY = Object.freeze({
  taskId: 'r4-network-89db2499fcf6',
  planId: 'PLAN-5273d94aa08345e4b047d62b915e2928',
  inputVersion: 'TREV-b5de4a8273904944acdf57ca578adeb2',
  conditionVersion: 'TCOND-23bae78ad99f4d3f824adc224fa011c7',
  resourceRevision: 'resource-7c8bd11ec30d0ed4',
  failedJobId: 'tsk-c122e2c8cc06',
});

function recoveryTask(task) {
  assert.equal(task.task_id, RECOVERY.taskId, '恢复入口只接受主明确给定的原任务');
  assert.equal(task.input_version, RECOVERY.inputVersion, '任务版本变化，停止并交主核实');
  assert.equal(task.revision, RECOVERY.inputVersion);
  assert.equal(task.condition_version, RECOVERY.conditionVersion);
  assert.equal(task.resource_revision, RECOVERY.resourceRevision);
}

function matches(response, method, pathname) {
  const url = new URL(response.url());
  return API_ORIGINS.has(url.origin) && response.request().method() === method
    && (pathname instanceof RegExp ? pathname.test(url.pathname) : url.pathname === PREFIX + pathname);
}

async function environment(args, work) {
  const { page, runtime, taskId, planId, login, record, download, shot } = args;
  assert(page && typeof page.getByRole === 'function', '须提供真实 Playwright Page');
  assert(runtime && taskId && planId, '须提供本轮 runtime/taskId/planId');
  for (const helper of [login, record, download, shot]) assert.equal(typeof helper, 'function');
  assert(page.url() === 'about:blank' || new URL(page.url()).origin === ORIGIN, '禁止使用原环境 Page');
  const responses = [], consumed = [], writes = [], anchors = { taskId, planId };
  const listener = response => {
    const url = new URL(response.url());
    if (API_ORIGINS.has(url.origin) && /^\/api\/v1\/(task-inputs|task-files\/preview|plan\/|plans|gis\/plans\/|interference)/.test(url.pathname)) responses.push(response);
  };
  const writeListener = request => {
    const url = new URL(request.url());
    if (!API_ORIGINS.has(url.origin) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
      || !/^\/api\/v1\/(task-inputs|plan\/|plans|tasks\/|interference)/.test(url.pathname)) return;
    const payload = request.postData() ? request.postDataJSON() : null;
    const write = { method: request.method(), path: url.pathname, request: payload };
    writes.push(write);
    // Retain the original write identity even if the response cannot be decoded.
    anchors.lastWrite = write;
  };
  page.on('response', listener);
  page.on('request', writeListener);
  async function data(response) {
    const body = await response.json();
    const request = response.request();
    const row = { url: response.url(), method: request.method(), http: response.status(),
      request: request.postData() ? request.postDataJSON() : null, response: body };
    consumed.push(row);
    if (row.method !== 'GET') {
      const value = body.data ?? {};
      anchors.lastReceipt = { method: row.method, path: new URL(row.url).pathname, http: row.http,
        code: body.code, requestId: body.request_id ?? value.request_id,
        taskId: value.task_id, jobId: value.job_id ?? value.planning_job_id,
        planId: value.plan_id ?? value.result_plan_id, runId: value.run_id,
        adoptionId: value.adoption_id, state: value.state ?? value.status };
    }
    assert([200, 201, 202].includes(row.http), JSON.stringify(row));
    if (body.code !== 0) {
      const pathname = new URL(response.url()).pathname;
      assert(/^\/api\/v1\/plan\/(sr4-flow|tasks\/[^/]+)$/.test(pathname), JSON.stringify(row));
      assert(body.code === 2002 && ['PENDING', 'RUNNING'].includes(body.data?.status)
        || [3001, 3002].includes(body.code) && body.data?.status === 'SUCCESS'
          && body.data?.outcome?.code === body.code && body.data?.result, JSON.stringify(row));
    }
    assert(body.data && typeof body.data === 'object', JSON.stringify(row));
    if (row.request?.request_id && body.request_id !== undefined) assert.equal(body.request_id, row.request.request_id);
    if (row.request?.request_id && body.data.request_id !== undefined) assert.equal(body.data.request_id, row.request.request_id);
    return body.data;
  }
  async function http(method, pathname, action, predicate = () => true) {
    const [response] = await Promise.all([
      page.waitForResponse(value => matches(value, method, pathname) && predicate(value), { timeout: 60000 }),
      action(),
    ]);
    return data(response);
  }
  // Observe the product's own polling, including a fast response arriving before the POST resolves.
  async function observed(pathname, accept, since = 0) {
    const deadline = Date.now() + LIMIT;
    let cursor = since;
    while (Date.now() < deadline) {
      while (cursor < responses.length) {
        const response = responses[cursor++];
        if (matches(response, 'GET', pathname)) {
          const value = await data(response);
          if (accept(value)) return value;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.fail(`真实页面轮询未在 ${LIMIT}ms 内返回目标终态：${String(pathname)}`);
  }
  async function test(id, action) {
    return record(id, async () => {
      const start = consumed.length, writeStart = writes.length, responseStart = responses.length;
      try {
        const detail = await action();
        return { ...detail, anchors: { ...anchors }, http: consumed.slice(start), writes: writes.slice(writeStart) };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const original = { name: failure.name, message: failure.message, stack: failure.stack };
        const failedReads = [];
        // Capture already received failures outside an awaited response, without sending requests.
        for (const response of responses.slice(responseStart)) {
          if (response.status() < 400) continue;
          const request = response.request();
          failedReads.push({ url: response.url(), method: request.method(), http: response.status(),
            response: await response.json().catch(reason => ({ unavailable: String(reason) })) });
        }
        const full = { case_id: id, anchors, http: consumed.slice(start), failed_reads: failedReads,
          writes: writes.slice(writeStart), original_error: original };
        let file = null, artifactError = null;
        try {
          assert.match(id, /^[A-Za-z0-9_-]+$/);
          assert.equal(typeof args.evidence, 'string', '宿主未提供完整HTTP证据目录');
          const relative = path.relative(path.join(path.resolve(runtime), 'browser'), path.resolve(args.evidence));
          assert.match(relative, /^r6-browser-\d+-[a-f0-9]+$/, '证据目录必须是本轮runtime/browser内的独立run目录');
          const target = path.join(path.resolve(args.evidence), id + '-http.json');
          await writeFile(target, JSON.stringify(full, null, 2), { encoding: 'utf8', flag: 'wx' });
          file = target;
        } catch (reason) { artifactError = String(reason).slice(0, 500); }
        const writeSummary = row => ({ method: row.method, path: row.path,
          request_id: row.request?.request_id, task_id: row.request?.task_id,
          job_id: row.request?.job_id, run_id: row.request?.run_id, adoption_id: row.request?.adoption_id });
        const compactAnchors = { ...anchors };
        if (compactAnchors.lastWrite) compactAnchors.lastWrite = writeSummary(compactAnchors.lastWrite);
        if (compactAnchors.outcome) compactAnchors.outcome = { code: compactAnchors.outcome.code,
          message: compactAnchors.outcome.message, gap_count: compactAnchors.outcome.gap?.length };
        const httpSummary = [...consumed.slice(start), ...failedReads].map(row => ({ method: row.method,
            path: new URL(row.url).pathname + new URL(row.url).search, http: row.http,
            code: row.response?.code, request_id: row.response?.request_id ?? row.request?.request_id }));
        const evidence = { anchors: compactAnchors, full_http_file: file, artifact_error: artifactError,
          http_count: httpSummary.length,
          http: httpSummary.length > 24 ? [...httpSummary.slice(0, 6), ...httpSummary.slice(-18)] : httpSummary,
          writes: writes.slice(writeStart).map(writeSummary) };
        const firstLine = original.message.split(/\r?\n/, 1)[0];
        const message = /^\s*[\[{]/.test(firstLine)
          ? 'HTTP响应断言失败；完整报文见HTTP证据文件' : firstLine.slice(0, 500);
        failure.message = message + '\nR6-E evidence: ' + JSON.stringify(evidence);
        const frames = (original.stack ?? '').split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 12);
        failure.stack = `${failure.name}: ${failure.message}\n${frames.join('\n')}`;
        throw failure;
      }
    });
  }
  async function shown(locator) { await locator.waitFor({ state: 'visible', timeout: 60000 }); return locator; }
  async function text(scope, pattern) { await shown(scope.getByText(pattern, { exact: true })); }
  async function enabled(locator, expected = true) {
    await shown(locator);
    const deadline = Date.now() + 30000;
    while (await locator.isEnabled() !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await locator.isEnabled(), expected, `控件状态不符：${await locator.innerText()}`);
  }
  const drawer = title => page.locator('.p-drawer:visible').filter({ has: page.getByText(title, { exact: true }) });
  const dialog = title => page.getByRole('dialog', { name: title, exact: true });
  async function closeDrawer(scope) {
    const close = scope.locator('button.p-drawer-close-button');
    assert.equal(await close.count(), 1); await close.click();
    await scope.waitFor({ state: 'hidden' });
  }
  async function expand(summary, scope = page) {
    const details = scope.locator('details').filter({ has: page.getByText(summary, { exact: true }) });
    assert.equal(await details.count(), 1, `details 必须唯一：${summary}`);
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    return details;
  }
  async function openPlan(id = planId) {
    const target = new URL(page.url());
    assert.equal(target.origin, ORIGIN);
    target.hash = `/planning?taskId=${enc(taskId)}&planId=${enc(id)}`;
    const value = await http('GET', `/plans/${enc(id)}`, async () => {
      // Preserve the logged-in document; a new search string repeats the entire cold module load.
      if (target.href !== page.url()) {
        await page.goto(target.href, { waitUntil: 'domcontentloaded' });
        return;
      }
      await button(page, '规划历史').click();
      const history = drawer('规划历史'); await shown(history);
      await http('GET', '/plan/saved-plans', () => button(history, '已保存方案').click());
      await history.getByLabel('搜索规划历史', { exact: true }).fill(id);
      const found = await http('GET', '/plan/saved-plans', () => button(history, '查询').click(),
        response => new URL(response.url()).searchParams.get('search') === id);
      assert.equal(found.items.length, 1); assert.equal(found.items[0].plan_id, id);
      assert.equal(found.items[0].task_id, taskId);
      await enabled(button(history, '查询'));
      assert.equal(await button(history, '打开方案').count(), 1);
      await button(history, '打开方案').click();
    });
    assert.equal(value.plan_id, id); assert.equal(value.task_id, taskId);
    await text(page.locator('.workflow-summary'), `${value.name} · ${value.version}`);
    await button(page, '3 · 方案调整与对比').click();
    await text(page.locator('.selected-plan'), `${value.name} · ${value.version}`);
    anchors.openPlanId = id; anchors.snapshotId = value.result.snapshot_id;
    anchors.conditionVersion = value.condition_version; anchors.resourceRevision = value.resource_revision;
    return value;
  }
  async function openJob(id) {
    await button(page, '规划历史').click();
    const history = drawer('规划历史'); await shown(history);
    await enabled(button(history, '作业记录'));
    await http('GET', '/plan/jobs', () => button(history, '作业记录').click());
    await history.getByLabel('搜索规划历史', { exact: true }).fill(id);
    const list = await http('GET', '/plan/jobs', () => button(history, '查询').click(),
      response => new URL(response.url()).searchParams.get('search') === id);
    assert.equal(list.items.length, 1); assert.equal(list.items[0].job_id, id);
    assert.equal(list.items[0].task_id, taskId);
    await enabled(button(history, '查询'));
    // Job IDs are in row details, not necessarily in the visible summary row.
    assert.equal(await button(history, '打开作业').count(), 1);
    const value = await http('GET', `/plan/tasks/${enc(id)}`, () => button(history, '打开作业').click());
    assert.equal(value.job_id, id); assert.equal(value.task_id, taskId);
    await history.waitFor({ state: 'hidden' });
    return value;
  }
  async function openSavedTask() {
    await button(page, '1 · 任务与约束输入').click();
    await http('GET', '/task-inputs', () => button(page, '打开任务').click());
    const library = drawer('已保存任务'); await shown(library);
    await library.getByPlaceholder('任务编号或名称', { exact: true }).fill(taskId);
    const list = await http('GET', '/task-inputs', () => button(library, '查询').click(),
      response => new URL(response.url()).searchParams.get('search') === taskId);
    assert.equal(list.items.length, 1); assert.equal(list.items[0].task_id, taskId);
    await shown(library.getByRole('row').filter({ hasText: taskId }));
    const since = responses.length;
    const task = await http('GET', `/task-inputs/${enc(taskId)}`,
      () => button(library.getByRole('row').filter({ hasText: taskId }), '打开').click());
    await library.waitFor({ state: 'hidden' });
    await text(page.locator('.task-panel'), `已打开任务“${task.input.name}”及服务端保存版本。`);
    anchors.taskRevision = task.revision; anchors.inputVersion = task.input_version;
    anchors.conditionVersion = task.condition_version; anchors.resourceRevision = task.resource_revision;
    anchors.previousJobId = task.active_job_id;
    if (task.active_job_id) {
      const previous = await observed(`/plan/tasks/${enc(task.active_job_id)}`, () => true, since);
      anchors.previousJobState = previous.status;
      assert(terminal(previous), `原作业尚未终结，禁止新提交：${JSON.stringify(previous)}`);
    }
    return task;
  }
  async function submit() {
    await button(page, '1 · 任务与约束输入').click();
    await enabled(button(page, '提交规划'));
    const job = await http('POST', '/plan/sr4-flow', () => button(page, '提交规划').click());
    assert.equal(job.task_id, taskId); assert(job.job_id);
    anchors.jobId = job.job_id;
    return job;
  }
  async function finish(job, since = 0) {
    const value = terminal(job) ? job : await observed(`/plan/tasks/${enc(job.job_id)}`, terminal, since);
    assert.equal(value.job_id, job.job_id); assert.equal(value.task_id, taskId);
    anchors.jobId = value.job_id; anchors.jobState = value.status; anchors.outcome = value.outcome;
    return value;
  }
  async function saveJob(job, name, adjusting = false) {
    assert.equal(job.status, 'SUCCESS', `保留实际作业失败：${JSON.stringify(job)}`);
    assert(job.result, 'SUCCESS 必须有真实结果');
    await button(page, '3 · 方案调整与对比').click();
    await page.getByLabel('方案名称', { exact: true }).fill(name);
    const since = responses.length;
    const plan = await http('POST', '/plans', () => button(page, adjusting ? '保存调整为新版本' : '保存为方案').click());
    anchors.savedPlanId = plan.plan_id; anchors.savedState = plan.state;
    assert.equal(plan.job_id, job.job_id); assert.equal(plan.task_id, taskId);
    assert.equal(plan.result.snapshot_id, job.result.snapshot_id);
    const readback = await observed(`/plans/${enc(plan.plan_id)}`, value => value.plan_id === plan.plan_id, since);
    assert.deepEqual(readback.result, plan.result);
    await text(page.locator('.selected-plan'), `${plan.name} · ${plan.version}`);
    if (plan.state === 'REFERENCE') await referenceDisabled(plan);
    return plan;
  }
  async function referenceDisabled(plan) {
    assert.equal(plan.state, 'REFERENCE'); assert.equal(plan.current, false);
    await enabled(button(page, '转正并设为当前方案'), false);
    await text(page.locator('.selected-plan'), '此版本为参考方案，不能设为当前方案。');
  }
  try {
    return await work({ page, taskId, planId, login, download, shot, anchors, responses,
      data, http, observed, test, shown, text, enabled, drawer, dialog, closeDrawer, expand, writes,
      openPlan, openJob, openSavedTask, submit, finish, saveJob, referenceDisabled });
  } finally { page.off('response', listener); page.off('request', writeListener); }
}

/** Minimal host entry: saved task query/edit/validation/save, then one cancellation. */
export async function runPlanning(args) {
  return environment(args, async c => {
    const { page, taskId, planId } = c;
    await c.test('E-P01-saved-task-open', async () => {
      await c.login('editor');
      const plan = await c.openPlan();
      assert.equal(plan.state, 'CONFIRMED'); assert.equal(plan.current, true); assert.equal(plan.source_changed, false);
      await button(page, '1 · 任务与约束输入').click();
      await c.http('GET', '/task-inputs', () => button(page, '打开任务').click());
      const library = c.drawer('已保存任务');
      await library.getByPlaceholder('任务编号或名称', { exact: true }).fill(`R6-E-no-match-${Date.now()}`);
      const empty = await c.http('GET', '/task-inputs', () => button(library, '查询').click());
      assert.equal(empty.total, 0); assert.deepEqual(empty.items, []);
      await c.text(library, '0 项 · 第 1 页');
      await library.getByPlaceholder('任务编号或名称', { exact: true }).fill(taskId);
      const found = await c.http('GET', '/task-inputs', () => button(library, '查询').click());
      assert.equal(found.items.length, 1); assert.equal(found.items[0].task_id, taskId);
      const task = await c.http('GET', `/task-inputs/${enc(taskId)}`, () => button(library, '打开').click());
      await library.waitFor({ state: 'hidden' });
      await c.text(page.locator('.task-panel'), `已打开任务“${task.input.name}”及服务端保存版本。`);
      return { task, plan, no_match: empty };
    });
    await c.test('E-P02-invalid-edit-save', async () => {
      const input = page.locator('.task-form input[data-validation-field="name"]');
      const before = await input.inputValue();
      const writes = [];
      const capture = request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === PREFIX + `/task-inputs/${enc(taskId)}`) writes.push(request.url()); };
      page.on('request', capture);
      try {
        await input.fill(''); await button(page, '保存任务').click();
        await c.shown(input.locator('..').getByRole('alert'));
        assert.equal(await input.getAttribute('aria-invalid'), 'true');
        await c.enabled(button(page, '提交规划'), false);
        assert.equal(writes.length, 0, '非法任务不得 PUT');
        await input.fill((before.slice(0, 48) + ' R6-E').slice(0, 60));
        const saved = await c.http('PUT', `/task-inputs/${enc(taskId)}`, () => button(page, '保存任务').click());
        assert.equal(saved.input.name, await input.inputValue());
        assert.equal(saved.condition_version, c.anchors.conditionVersion, '仅修改名称不得改变规划条件版本');
        assert.equal(saved.resource_revision, c.anchors.resourceRevision);
        await c.text(page.locator('.task-panel'), '任务输入已保存；规划需单独提交。');
        // Reopen through the task library: this is a persisted read, not a store assertion.
        await c.http('GET', '/task-inputs', () => button(page, '打开任务').click());
        const library = c.drawer('已保存任务');
        await library.getByPlaceholder('任务编号或名称', { exact: true }).fill(taskId);
        await c.http('GET', '/task-inputs', () => button(library, '查询').click());
        const actual = await c.http('GET', `/task-inputs/${enc(taskId)}`, () => button(library, '打开').click());
        assert.equal(actual.input_version, saved.input_version); assert.deepEqual(actual.input, saved.input);
        return { invalid_puts: 0, original_name: before, saved: actual, numeric_conditions_changed: false };
      } finally { page.off('request', capture); }
    });
    return c.test('E-P03-cancel-original-job', async () => {
      const job = await c.submit();
      assert(['PENDING', 'RUNNING'].includes(job.status), '作业已终结，取消分支未覆盖；禁止重提交碰运气');
      await c.shown(page.getByRole('progressbar', { name: '规划任务进度', exact: true }));
      await button(page, '取消规划').click();
      const dialog = c.dialog('取消规划任务'); await c.shown(dialog);
      const since = c.responses.length;
      const cancelled = await c.http('DELETE', `/tasks/${enc(job.job_id)}`, () => button(dialog, '请求取消').click());
      assert.equal(cancelled.job_id, job.job_id);
      const readback = await c.observed(`/plan/tasks/${enc(job.job_id)}`, terminal, since);
      assert.equal(readback.status, 'CANCELLED', '取消必须回读原 job 为 CANCELLED；完成竞争保留为未覆盖');
      // Explicit history open verifies the original ID again without submitting a new job.
      await c.http('GET', '/plan/jobs', () => button(page, '规划历史').click());
      const history = c.drawer('规划历史');
      await history.getByLabel('搜索规划历史', { exact: true }).fill(job.job_id);
      const list = await c.http('GET', '/plan/jobs', () => button(history, '查询').click());
      assert.equal(list.items.length, 1); assert.equal(list.items[0].job_id, job.job_id);
      const reopened = await c.http('GET', `/plan/tasks/${enc(job.job_id)}`, () => button(history, '打开作业').click());
      assert.equal(reopened.status, 'CANCELLED'); assert.equal(reopened.job_id, job.job_id);
      await c.text(page.locator('.result-column'), '已取消');
      return { taskId, planId, cancelled_job: reopened, next: 'runPlanningCompute' };
    });
  });
}

/** Recovery-only verification of the original failed job; this entry never submits. */
export async function runPlanningCheckpoint(args) {
  return environment(args, async c => c.test('E-P00-original-checkpoint-readonly', async () => {
    await c.login('editor');
    assert.equal(c.planId, RECOVERY.planId);
    const plan = await c.openPlan(), task = await c.openSavedTask(); recoveryTask(task);
    const job = await c.openJob(RECOVERY.failedJobId);
    assert.equal(job.status, 'FAILED'); assert.match(job.error, /^MemoryError:/); assert.equal(job.result, null);
    assert.equal(c.writes.length, 0, 'checkpoint 只能读，不能更改原事务');
    return { task, plan, original_failed_job: job, current_observed: plan.current, readonly: true };
  }));
}

/** One separately authorized cancellation attempt, with a persisted submit checkpoint. */
export async function runPlanningCancel(args) {
  return environment(args, async c => {
    let task, job, submittedSince;
    await c.test('E-P03R-load-saved-task', async () => {
      await c.login('editor'); const plan = await c.openPlan();
      task = await c.openSavedTask(); recoveryTask(task);
      assert.equal(plan.condition_version, task.condition_version);
      assert.equal(plan.resource_revision, task.resource_revision);
      assert.equal(c.writes.length, 0);
      return { task, source_plan: plan, retained_failed_job_id: RECOVERY.failedJobId };
    });
    await c.test('E-P03R-submit-once', async () => {
      submittedSince = c.responses.length;
      job = await c.submit();
      assert.equal(job.input_version, task.input_version);
      assert.equal(job.condition_version, task.condition_version);
      assert.equal(job.resource_revision, task.resource_revision);
      assert.notEqual(job.job_id, RECOVERY.failedJobId);
      assert.equal(c.writes.filter(row => row.path === PREFIX + '/plan/sr4-flow').length, 1);
      return { submitted: job, next: 'E-P03R-cancel-readback', submission_limit: 1 };
    });
    return c.test('E-P03R-cancel-readback', async () => {
      assert(['PENDING', 'RUNNING'].includes(job.status), '提交回执已终结，保留原号；取消未覆盖，不重提');
      let latest = job;
      for (const response of c.responses.slice(submittedSince)) {
        if (matches(response, 'GET', `/plan/tasks/${enc(job.job_id)}`)) latest = await c.data(response);
      }
      if (terminal(latest)) {
        const actual = await c.openJob(job.job_id);
        c.anchors.jobState = actual.status;
        assert.fail(`取消前作业已结束，保留原号且不重提：${JSON.stringify(actual)}`);
      }
      await c.shown(c.page.getByRole('progressbar', { name: '规划任务进度', exact: true }));
      // Opening the dialog and requesting cancellation are distinct UI actions.
      await c.enabled(button(c.page, '取消规划'));
      await button(c.page, '取消规划').click();
      const dialog = c.dialog('取消规划任务'); await c.shown(dialog);
      const since = c.responses.length;
      const receipt = await c.http('DELETE', `/tasks/${enc(job.job_id)}`, () => button(dialog, '请求取消').click());
      c.anchors.cancelReceipt = { jobId: receipt.job_id, status: receipt.status, error: receipt.error };
      assert.equal(receipt.job_id, job.job_id);
      await dialog.waitFor({ state: 'hidden' });
      const settled = await c.finish(receipt, since);
      const actual = await c.openJob(job.job_id);
      assert.equal(actual.status, settled.status);
      assert.equal(actual.status, 'CANCELLED', `取消未覆盖，保留真实终态且禁止换号：${JSON.stringify(actual)}`);
      assert.equal(c.writes.filter(row => row.method === 'DELETE').length, 1);
      assert.equal(c.writes.filter(row => row.path === PREFIX + '/plan/sr4-flow').length, 1);
      await c.text(c.page.locator('.result-column'), '已取消');
      return { submitted: job, cancel_receipt: receipt, original_job_readback: actual, submissions: 1, cancel_requests: 1 };
    });
  });
}

/** Real file round trips, then draft-only application/discard; no save or compute. */
export async function runPlanningImport(args) {
  return environment(args, async c => {
    const { page, taskId } = c;
    const require = createRequire(new URL('../../front_design/radio-planning-20261022/package.json', import.meta.url));
    const Papa = require('papaparse'), Excel = require('exceljs');
    const files = {}, tables = {}, previewName = 'R6-E import draft only';
    const nameInput = page.locator('.task-form input[data-validation-field="name"]');
    let saved, workbook;
    const noWrites = () => assert.equal(c.writes.length, 0, '模板/预检/应用草稿不得保存任务或提交规划');
    const summary = input => input.map(file => ({ name: file.name, bytes: file.buffer.length,
      sha256: createHash('sha256').update(file.buffer).digest('hex') }));
    async function preview(input) {
      const scope = c.drawer('导入任务输入');
      await scope.locator('input[type="file"]').setInputFiles(input);
      await c.enabled(button(scope, '解析并校验'));
      const value = await c.http('POST', '/task-files/preview', () => button(scope, '解析并校验').click());
      assert.equal(value.requestContext.taskId, taskId);
      assert.equal(value.requestContext.taskRevision, saved.revision);
      assert.equal(value.resourceRevision, saved.resource_revision);
      assert.equal(await nameInput.inputValue(), saved.input.name, '预检不得替换任务草稿');
      await c.enabled(button(scope, '解析并校验'));
      noWrites(); return value;
    }
    function csvInput(invalid) {
      return ['task_scenarios', 'task_links'].map(kind => {
        const table = tables[kind], rows = structuredClone(table.data);
        for (const row of rows) row.task_id = taskId;
        if (kind === 'task_scenarios') rows[0].task_name = invalid ? '' : previewName;
        return { name: kind + '.csv', mimeType: 'text/csv',
          buffer: Buffer.from(Papa.unparse({ fields: table.meta.fields,
            data: rows.map(row => table.meta.fields.map(field => row[field])) }), 'utf8') };
      });
    }
    await c.test('E-P06-task-import-templates', async () => {
      await c.login('editor'); await c.openPlan(); saved = await c.openSavedTask(); recoveryTask(saved);
      await button(page.locator('.task-panel'), '导入').click();
      const scope = c.drawer('导入任务输入'); await c.shown(scope);
      for (const [key, label, format, kind] of [
        ['xlsx', 'XLSX 模板', 'xlsx', 'task_scenarios'],
        ['task_scenarios', '任务 CSV 模板', 'csv', 'task_scenarios'],
        ['task_links', '需求 CSV 模板', 'csv', 'task_links'],
      ]) {
        const [response, file] = await Promise.all([
          page.waitForResponse(value => matches(value, 'POST', '/task-files/template')
            && value.request().postDataJSON().format === format, { timeout: 60000 }),
          c.download(() => button(scope, label).click(), 'E-P06-template-' + key),
        ]);
        assert.equal(response.status(), 200);
        const request = response.request().postDataJSON();
        assert.equal(request.context, 'planning'); assert.equal(request.kind, kind);
        assert.deepEqual(request.input, saved.input);
        assert.match(response.headers()['content-type'], format === 'csv' ? /^text\/csv/ : /^application\/vnd\.openxmlformats/);
        files[key] = { ...file, http: response.status(), path: new URL(response.url()).pathname, request };
        if (format === 'csv') {
          const table = Papa.parse(await readFile(file.file, 'utf8'), { header: true, skipEmptyLines: true });
          assert.deepEqual(table.errors, []); assert(table.data.length); assert(table.meta.fields.includes('task_id'));
          tables[key] = table;
        } else {
          workbook = new Excel.Workbook(); await workbook.xlsx.readFile(file.file);
          assert(workbook.getWorksheet('task_scenarios')); assert(workbook.getWorksheet('task_links'));
        }
      }
      assert.equal(tables.task_scenarios.data.length, 1);
      assert.equal(tables.task_links.data.length, saved.input.demands.length);
      noWrites(); return { saved_task: saved, downloads: files, task_writes: 0, compute_requests: 0 };
    });
    await c.test('E-P07-task-import-invalid-valid-cancel', async () => {
      const scope = c.drawer('导入任务输入'), invalid = csvInput(true);
      const rejected = await preview(invalid);
      assert.equal(rejected.input, null); assert(rejected.issues.length);
      const issue = rejected.issues.find(row => row.sheet === 'task_scenarios' && row.field === 'task_name' && row.row === 2);
      assert(issue, '非法任务名称必须返回实际工作表/行号/字段问题');
      await c.shown(scope.getByRole('row').filter({ hasText: issue.message }).first());
      assert.equal(await button(scope, '确认替换当前草稿').count(), 0);
      await c.shot('E-P07-invalid-preflight');
      const valid = csvInput(false), accepted = await preview(valid);
      assert.deepEqual(accepted.issues, []); assert.equal(accepted.existing, true);
      assert.equal(accepted.taskId, taskId); assert.equal(accepted.taskRevision, saved.revision);
      assert.deepEqual(accepted.input, { ...saved.input, name: previewName });
      await c.enabled(button(scope, '确认替换当前草稿'));
      await scope.locator('button.p-drawer-close-button').click();
      const decision = c.dialog('放弃导入预览'); await c.shown(decision);
      await button(decision, '放弃导入').click(); await scope.waitFor({ state: 'hidden' });
      assert.equal(await nameInput.inputValue(), saved.input.name); noWrites();
      return { invalid_files: summary(invalid), rejected, valid_files: summary(valid), accepted,
        preview_cancelled: true, draft_unchanged: true, task_writes: 0 };
    });
    return c.test('E-P08-task-import-apply-draft-discard', async () => {
      const scenes = workbook.getWorksheet('task_scenarios'), links = workbook.getWorksheet('task_links');
      for (const sheet of [scenes, links]) {
        const column = sheet.getRow(1).values.indexOf('task_id'); assert(column > 0);
        sheet.eachRow((row, index) => { if (index > 1) row.getCell(column).value = taskId; });
      }
      const nameColumn = scenes.getRow(1).values.indexOf('task_name'); assert(nameColumn > 0);
      scenes.getRow(2).getCell(nameColumn).value = previewName;
      const input = [{ name: 'task-template.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from(await workbook.xlsx.writeBuffer()) }];
      await button(page.locator('.task-panel'), '导入').click();
      const scope = c.drawer('导入任务输入'); await c.shown(scope);
      const accepted = await preview(input);
      assert.deepEqual(accepted.issues, []); assert.equal(accepted.existing, true);
      assert.equal(accepted.taskId, taskId); assert.equal(accepted.taskRevision, saved.revision);
      assert.deepEqual(accepted.input, { ...saved.input, name: previewName });
      const target = await c.http('GET', `/task-inputs/${enc(taskId)}`,
        () => button(scope, '确认替换当前草稿').click());
      assert.equal(target.revision, saved.revision); assert.deepEqual(target.input, saved.input);
      await scope.waitFor({ state: 'hidden' });
      await c.text(page.locator('.task-panel'), '导入已应用到草稿，尚未保存。');
      assert.equal(await nameInput.inputValue(), previewName);
      await c.enabled(button(page, '提交规划'), false); noWrites();
      await c.shot('E-P08-applied-unsaved-draft');
      await c.http('GET', '/task-inputs', () => button(page, '打开任务').click());
      const library = c.drawer('已保存任务'); await c.shown(library);
      await library.getByPlaceholder('任务编号或名称', { exact: true }).fill(taskId);
      const found = await c.http('GET', '/task-inputs', () => button(library, '查询').click());
      assert.equal(found.items.length, 1); assert.equal(found.items[0].task_id, taskId);
      await c.shown(library.getByRole('row').filter({ hasText: taskId }));
      await button(library, '打开').click();
      let decision = c.dialog('处理未保存任务输入'); await c.shown(decision);
      await button(decision, '继续编辑').click(); await decision.waitFor({ state: 'hidden' });
      assert.equal(await nameInput.inputValue(), previewName, '取消离开应保留应用后的未保存草稿');
      await c.enabled(button(library, '打开'));
      const readback = await c.http('GET', `/task-inputs/${enc(taskId)}`, async () => {
        await button(library, '打开').click();
        decision = c.dialog('处理未保存任务输入'); await c.shown(decision);
        await button(decision, '放弃本次输入').click();
      });
      await library.waitFor({ state: 'hidden' }); recoveryTask(readback);
      assert.deepEqual(readback.input, saved.input); assert.equal(readback.active_job_id, saved.active_job_id);
      assert.equal(await nameInput.inputValue(), saved.input.name); noWrites();
      return { uploaded_files: summary(input), accepted, application_target: target,
        saved_task_readback: readback, draft_discarded: true, task_writes: 0, compute_requests: 0 };
    });
  });
}

/** One deliberate new compute after the previous job is known to be terminal. */
export async function runPlanningCompute(args) {
  return environment(args, async c => {
    let job, saved, since;
    await c.test('E-P04-submit-checkpoint', async () => {
      await c.login('editor'); const plan = await c.openPlan();
      const task = await c.openSavedTask(); recoveryTask(task);
      assert.equal(plan.condition_version, task.condition_version);
      assert.equal(plan.resource_revision, task.resource_revision);
      since = c.responses.length;
      job = await c.submit();
      assert.equal(job.input_version, task.input_version);
      assert.equal(job.condition_version, task.condition_version);
      assert.equal(job.resource_revision, task.resource_revision);
      assert.equal(c.writes.filter(row => row.path === PREFIX + '/plan/sr4-flow').length, 1);
      return { task, submitted: job, source_plan: plan, submission_limit: 1 };
    });
    await c.test('E-P04-compute-result-save', async () => {
      job = await c.finish(job, since);
      saved = await c.saveJob(job, 'R6-E planning result');
      return { job, saved, acceptance: saved.state === 'REFERENCE' ? 'REFERENCE_RETAINED' : 'SAVED' };
    });
    if (saved.state === 'REFERENCE') return { taskId: c.taskId, planId: saved.plan_id, state: 'REFERENCE', confirmed: false };
    return c.test('E-P05-confirm-readback', async () => {
      assert.equal(saved.state, 'SAVED'); assert.equal(saved.current, false); assert.equal(saved.source_changed, false);
      assert.equal(saved.outcome?.code, 0); assert.deepEqual(saved.outcome.gap, []);
      assert.deepEqual(saved.input, job.input);
      assert.equal(saved.condition_version, job.condition_version); assert.equal(saved.resource_revision, job.resource_revision);
      assert.equal(saved.result.checks.length, 4);
      for (const id of ['connectivity', 'survivability', 'relay', 'frequency']) {
        assert.equal(saved.result.checks.filter(row => row.id === id && row.passed === true).length, 1,
          `转正前真实硬约束必须通过：${id}`);
      }
      const survivability = saved.result.metrics.survivabilityPercent;
      assert(Number.isFinite(survivability) && survivability >= Math.max(90, job.input.constraints.survivabilityPercent),
        `实际抗毁未达标，保留已保存原号但不得转正：${survivability}`);
      assert(saved.result.configuration?.devices.length && saved.result.configuration.routes.length
        && saved.result.configuration.frequencies.length, '不得确认缺少完整配置的方案');
      await c.enabled(button(c.page, '转正并设为当前方案'));
      await button(c.page, '转正并设为当前方案').click();
      let dialog = c.dialog('确认方案转正'); await c.shown(dialog);
      await button(dialog, '取消').click(); await dialog.waitFor({ state: 'hidden' });
      await c.text(c.page.locator('.selected-plan'), '已保存 · 待转正');
      await button(c.page, '转正并设为当前方案').click();
      dialog = c.dialog('确认方案转正'); await c.shown(dialog);
      const since = c.responses.length;
      const confirmed = await c.http('POST', `/plans/${enc(saved.plan_id)}/confirm`, () => button(dialog, '确认转正').click());
      assert.equal(confirmed.plan_id, saved.plan_id); assert.equal(confirmed.state, 'CONFIRMED'); assert.equal(confirmed.current, true);
      const actual = await c.observed(`/plans/${enc(saved.plan_id)}`, value => value.state === 'CONFIRMED' && value.current, since);
      assert.equal(actual.result.snapshot_id, saved.result.snapshot_id);
      await c.text(c.page.locator('.selected-plan'), '已转正 · 当前方案');
      return { taskId: c.taskId, planId: actual.plan_id, state: actual.state, confirmed: true, confirmed_plan: actual };
    });
  });
}

/** Final-token only: adopt the frozen current resource revision without editing task input. */
export async function runPlanningFinalRefresh(args) {
  return environment(args, async c => {
    const { page, taskId } = c;
    const metricsBaselinePlanId = 'PLAN-4d974f02b63b465ca03e030dcda8eff9', connectivityTolerance = 1e-8;
    let baseline, metricsBaseline, resource, task, job, saved, submittedSince, validation;
    function taskIdentity(actual) {
      assert.equal(actual.task_id, taskId);
      assert.equal(actual.revision, task.revision, '任务版本变化，停止；不得自动重存或重算');
      assert.equal(actual.input_version, task.input_version);
      assert.equal(actual.condition_version, baseline.condition_version);
      assert.equal(actual.resource_revision, resource.revision);
      assert.deepEqual(actual.input, baseline.input, '最终刷新不得改名、条件或数值');
    }
    function frozenIdentity(actual) {
      taskIdentity(actual);
      assert.equal(actual.source_changed, false, '资源/任务来源变化，停止最终链');
      assert.equal(actual.parent_plan_id, null, '最终入口必须是正常规划，不是调整或采纳重算');
      assert(!actual.adjustment && !actual.interference_origin);
    }
    function validatedResult(plan) {
      frozenIdentity(plan); assert.equal(plan.state, 'SAVED'); assert.equal(plan.current, false);
      assert.equal(plan.outcome?.code, 0); assert.deepEqual(plan.outcome.gap, []);
      const result = plan.result; assert(result?.snapshot_id && result.configuration);
      const checks = new Map(result.checks.map(row => [row.id, row]));
      assert.equal(checks.size, 4); assert.equal(result.checks.length, 4);
      for (const id of ['connectivity', 'survivability', 'relay', 'frequency']) {
        assert.equal(checks.get(id)?.passed, true, `必须通过真实硬约束：${id}`);
      }
      const metrics = result.metrics, threshold = Math.max(90, baseline.input.constraints.survivabilityPercent);
      assert(Number.isFinite(metrics.connectivityPercent) && metrics.connectivityPercent >= 0 && metrics.connectivityPercent <= 100);
      const difference = metrics.connectivityPercent - metricsBaseline.result.metrics.connectivityPercent;
      const connectivityComparison = { baseline_plan_id: metricsBaseline.plan_id,
        baseline_snapshot_id: metricsBaseline.result.snapshot_id, baseline_source_changed: metricsBaseline.source_changed,
        baseline_metrics: metricsBaseline.result.metrics, candidate_plan_id: plan.plan_id,
        candidate_snapshot_id: result.snapshot_id, candidate_metrics: metrics,
        difference_percentage_points: difference, tolerance_percentage_points: connectivityTolerance,
        passed: difference >= -connectivityTolerance };
      c.anchors.finalConnectivityComparison = connectivityComparison;
      assert(connectivityComparison.passed,
        `最终全网连通率低于原父V2，保留原号且禁止确认：${JSON.stringify(connectivityComparison)}`);
      assert(Number.isFinite(metrics.survivabilityPercent) && metrics.survivabilityPercent >= threshold && metrics.survivabilityPercent <= 100);
      assert(Number.isFinite(metrics.totalRadiatedPowerW) && metrics.totalRadiatedPowerW >= 0);
      const configuration = result.configuration, details = result.result_details;
      assert(configuration.devices.length && configuration.routes.length && configuration.frequencies.length, '缺少完整配置');
      assert(Array.isArray(details?.unreachableDemandIds), '缺少真实不可达需求列表，不补空列表');
      const required = baseline.input.demands.filter(row => row.mandatory);
      assert(required.length, '当前资料没有必要需求，不能声称完成必要通联验证');
      const links = new Map(result.links.map(row => [row.id, row]));
      const routes = required.map(demand => {
        assert(!details.unreachableDemandIds.includes(demand.id), `必要需求不可达：${demand.id}`);
        const main = configuration.routes.filter(row => row.demandId === demand.id && row.backup === false);
        assert.equal(main.length, 1, `必要需求必须有真实唯一主路由：${demand.id}`);
        const route = main[0];
        assert.equal(route.nodeIds[0], demand.sourceId); assert.equal(route.nodeIds.at(-1), demand.targetId);
        assert.equal(route.linkIds.length, route.nodeIds.length - 1); assert(route.linkIds.length);
        route.linkIds.forEach((id, index) => {
          const link = links.get(id), a = route.nodeIds[index], b = route.nodeIds[index + 1];
          assert(link && (link.a === a && link.b === b || link.a === b && link.b === a), `冻结路由/链路身份不符：${id}`);
        });
        return { demand_id: demand.id, route, quality: details.routeQuality?.find(row => row.routeId === route.id) ?? null };
      });
      // The network-wide metric is not mandatory end-to-end connectivity.
      return { checks: result.checks, mandatory_routes: routes, unreachable_demand_ids: details.unreachableDemandIds,
        network_connectivity_percent: metrics.connectivityPercent, survivability_percent: metrics.survivabilityPercent,
        connectivity_comparison: connectivityComparison,
        required_survivability_percent: threshold, snapshot_id: result.snapshot_id };
    }
    const countWrites = (method, path) => c.writes.filter(row => row.method === method && row.path === PREFIX + path).length;
    await c.test('E-F01-load-current-task', async () => {
      await c.login('editor');
      metricsBaseline = await c.openPlan(metricsBaselinePlanId);
      assert.equal(metricsBaseline.state, 'CONFIRMED');
      assert.equal(metricsBaseline.result.snapshot_id, 'SNP-PL-E4AFB9A0');
      assert.equal(metricsBaseline.result.metrics.connectivityPercent, 98.29, '原父V2冻结指标变化，停止核实');
      // Resource edits may truthfully invalidate the old source; its saved metrics remain the baseline.
      c.anchors.finalMetricsBaseline = { planId: metricsBaseline.plan_id,
        snapshotId: metricsBaseline.result.snapshot_id, inputVersion: metricsBaseline.input_version,
        conditionVersion: metricsBaseline.condition_version, resourceRevision: metricsBaseline.resource_revision,
        current: metricsBaseline.current, sourceChanged: metricsBaseline.source_changed,
        metrics: metricsBaseline.result.metrics };
      const target = new URL(page.url()); assert.equal(target.origin, ORIGIN);
      target.hash = `/planning?taskId=${enc(taskId)}`;
      const routed = await c.http('GET', `/task-inputs/${enc(taskId)}`,
        () => page.goto(target.href, { waitUntil: 'domcontentloaded' }));
      baseline = await c.openSavedTask();
      assert.equal(baseline.task_id, taskId); assert(baseline.revision && baseline.input_version && baseline.condition_version);
      assert.equal(baseline.revision, routed.revision); assert.deepEqual(baseline.input, routed.input);
      assert.equal(baseline.input.constraints.connectivityPercent, 100, '不改原输入，也不降低必要通联门槛');
      assert(Number.isFinite(baseline.input.constraints.survivabilityPercent) && baseline.input.constraints.survivabilityPercent >= 90,
        '原约束低于90或缺失，交主处理，不擅自改任务');
      assert.equal(c.writes.length, 0);
      c.anchors.finalBaseline = { inputVersion: baseline.input_version, conditionVersion: baseline.condition_version,
        resourceRevision: baseline.resource_revision, activeJobId: baseline.active_job_id };
      return { baseline, metrics_baseline_plan: metricsBaseline,
        connectivity_tolerance_percentage_points: connectivityTolerance, recovery_gate_used: false, input_edited: false };
    });
    await c.test('E-F02-refresh-save-checkpoint', async () => {
      const panel = page.locator('.task-panel'), meta = await c.expand('任务详情与版本', panel);
      const refresh = button(meta, '刷新已保存资源引用'); await c.enabled(refresh);
      resource = await c.http('GET', '/resource/context', () => refresh.click(),
        response => new URL(response.url()).searchParams.get('context') === 'planning');
      assert.equal(typeof resource.revision, 'string'); assert(resource.revision);
      c.anchors.finalResourceRevision = resource.revision;
      await c.enabled(refresh);
      await c.shown(meta.locator('p.meta').filter({ hasText: new RegExp(`资源版本：\\s*${escapeRegex(resource.revision)}(?:\\s|$)`) }));
      await c.enabled(button(panel, '保存任务'));
      const since = c.responses.length;
      task = await c.http('PUT', `/task-inputs/${enc(taskId)}`, () => button(panel, '保存任务').click());
      c.anchors.finalInputVersion = task.input_version;
      assert.equal(task.task_id, taskId); assert.equal(task.revision, task.input_version);
      assert.equal(task.condition_version, baseline.condition_version); assert.equal(task.resource_revision, resource.revision);
      assert.deepEqual(task.input, baseline.input);
      if (resource.revision !== baseline.resource_revision) assert.notEqual(task.input_version, baseline.input_version);
      else assert.equal(task.input_version, baseline.input_version, '同资源同输入不能伪造新版本');
      const write = c.writes.find(row => row.method === 'PUT');
      assert(write?.request.request_id); assert.equal(write.request.expected_revision, baseline.revision);
      assert.equal(write.request.resource_revision, resource.revision); assert.deepEqual(write.request.input, baseline.input);
      assert.equal(countWrites('PUT', `/task-inputs/${enc(taskId)}`), 1); assert.equal(c.writes.length, 1);
      const readback = await c.observed(`/task-inputs/${enc(taskId)}`, () => true, since); taskIdentity(readback);
      await c.text(panel, '任务输入已保存；规划需单独提交。');
      return { original: baseline, resource_context: resource, saved_task: readback, save_requests: 1, input_edited: false };
    });
    await c.test('E-F03-submit-checkpoint', async () => {
      const actualTask = await c.openSavedTask(); taskIdentity(actualTask);
      assert.equal(actualTask.active_job_id, baseline.active_job_id, '刷新期间出现其他作业，停止最终链');
      submittedSince = c.responses.length; job = await c.submit();
      frozenIdentity(job); assert.equal(job.expired, false);
      assert.equal(countWrites('POST', '/plan/sr4-flow'), 1); assert.equal(c.writes.length, 2);
      return { submitted: job, saved_task: task, submissions: 1, next: 'E-F04-result-save-validate' };
    });
    await c.test('E-F04-result-save-validate', async () => {
      job = await c.finish(job, submittedSince); frozenIdentity(job);
      assert.equal(job.status, 'SUCCESS', `真实计算未成功，保留原号，不换号：${JSON.stringify(job)}`);
      assert.equal(job.expired, false);
      const actualTask = await c.openSavedTask(); taskIdentity(actualTask);
      assert.equal(actualTask.active_job_id, job.job_id, '保存前任务的当前作业已变化');
      saved = await c.saveJob(job, baseline.input.name);
      assert.equal(saved.job_id, job.job_id);
      assert.equal(saved.state, 'SAVED', '真实REFERENCE已保留，最终链停止；不能转正或重算碰运气');
      validation = validatedResult(saved);
      assert.equal(countWrites('POST', '/plans'), 1); assert.equal(c.writes.length, 3);
      return { job, saved_plan: saved, validation, confirmed: false };
    });
    return c.test('E-F05-confirm-current-readback', async () => {
      const actualTask = await c.openSavedTask(); taskIdentity(actualTask);
      assert.equal(actualTask.active_job_id, job.job_id, '确认前任务的当前作业已变化');
      const before = await c.openPlan(saved.plan_id); validation = validatedResult(before);
      assert.equal(before.version, saved.version); assert.deepEqual(before.result, saved.result);
      await c.enabled(button(page, '转正并设为当前方案'));
      await button(page, '转正并设为当前方案').click();
      const dialog = c.dialog('确认方案转正'); await c.shown(dialog);
      const since = c.responses.length;
      const receipt = await c.http('POST', `/plans/${enc(saved.plan_id)}/confirm`, () => button(dialog, '确认转正').click());
      c.anchors.finalConfirmedPlanId = receipt.plan_id;
      frozenIdentity(receipt); assert.equal(receipt.plan_id, saved.plan_id);
      assert.equal(receipt.state, 'CONFIRMED'); assert.equal(receipt.current, true);
      const confirmed = await c.observed(`/plans/${enc(saved.plan_id)}`, () => true, since);
      frozenIdentity(confirmed); assert.equal(confirmed.state, 'CONFIRMED'); assert.equal(confirmed.current, true);
      assert.equal(confirmed.plan_id, saved.plan_id); assert.equal(confirmed.job_id, job.job_id);
      assert.equal(confirmed.version, saved.version); assert.deepEqual(confirmed.result, saved.result);
      if (confirmed.confirmed_configuration != null) {
        const configuration = confirmed.confirmed_configuration;
        assert.equal(configuration.source_plan_id, confirmed.plan_id);
        assert.equal(configuration.source_plan_version, confirmed.version);
        assert.equal(configuration.source_snapshot_id, confirmed.result.snapshot_id);
        assert.deepEqual(configuration.configuration, confirmed.result.configuration);
      }
      await c.text(page.locator('.selected-plan'), '已转正 · 当前方案');
      assert.equal(countWrites('POST', `/plans/${enc(saved.plan_id)}/confirm`), 1);
      assert.equal(c.writes.length, 4, '最终链仅允许一次保存任务、提交、保存方案、确认');
      return { taskId, planId: confirmed.plan_id, jobId: job.job_id, inputVersion: task.input_version,
        conditionVersion: task.condition_version, resourceRevision: resource.revision, validation,
        confirmed_plan: confirmed, confirmed_configuration_provided: confirmed.confirmed_configuration != null,
        confirmed: true, current: true, input_edited: false };
    });
  });
}

/** One combined manual-route/device adjustment; no preset search or repeated submissions. */
export async function runPlanningAdjustment(args) {
  return environment(args, async c => {
    const { page } = c;
    let parent, device, attempt;
    await c.test('E-A01-invalid-cancel-edit', async () => {
      await c.login('editor'); parent = await c.openPlan();
      device = parent.result.configuration.devices[0]; assert(device, '父方案没有可调整设备');
      await button(page, '调整此方案').click();
      const editor = page.locator('.inline-editor:visible'); await c.shown(editor);
      await editor.getByLabel('选择调整设备', { exact: true }).selectOption(device.deviceId);
      const input = editor.getByLabel(`${device.deviceId} 发射功率`, { exact: true });
      await input.fill('invalid-R6');
      await c.text(editor, /项输入待完善/); await c.enabled(button(editor, '重试预览'), false);
      await button(editor, '收起调整').click();
      let dialog = c.dialog('未提交的方案调整'); await c.shown(dialog);
      await button(dialog, '继续编辑').click();
      assert.equal(await input.inputValue(), 'invalid-R6');
      await button(editor, '收起调整').click(); dialog = c.dialog('未提交的方案调整');
      await button(dialog, '放弃调整').click(); await editor.waitFor({ state: 'hidden' });
      return { parent_plan_id: parent.plan_id, device_id: device.deviceId, invalid_text_retained: true, edit_discarded: true };
    });
    await c.test('E-A02-submit-checkpoint', async () => {
      await button(page, '调整此方案').click();
      const editor = page.locator('.inline-editor:visible');
      await editor.getByLabel('选择调整设备', { exact: true }).selectOption(device.deviceId);
      const power = editor.getByLabel(`${device.deviceId} 发射功率`, { exact: true });
      // Keep the draft invalid while composing the route so debounce cannot submit partial edits.
      await power.fill('invalid-R6');
      const main = parent.result.configuration.routes.find(row => !row.backup && row.nodeIds.length >= 2);
      assert(main, '父方案没有主路由，人工路径分支阻断');
      const backup = parent.result.configuration.routes.find(row => row.backup && row.demandId === main.demandId);
      const target = backup?.nodeIds ?? main.nodeIds;
      await editor.getByRole('tab', { name: '主路由', exact: true }).click();
      await editor.getByLabel('选择调整需求', { exact: true }).selectOption(main.demandId);
      const route = editor.locator('.route-row:visible');
      const intermediate = () => route.locator('select');
      // Explicitly enter a path even when only the parent's existing path is available.
      if (target.length === 2 && await intermediate().count() === 0) {
        await button(route, '增加中间节点').click(); await button(route, '移除').click();
      }
      for (let count = await intermediate().count(); count > target.length - 2; count--) await button(route, '移除').last().click();
      for (let count = await intermediate().count(); count < target.length - 2; count++) await button(route, '增加中间节点').click();
      assert.equal(await intermediate().count(), target.length - 2);
      for (let i = 1; i < target.length - 1; i++) await route.getByLabel(`${main.demandId} 中间节点 ${i}`, { exact: true }).selectOption(target[i]);
      await editor.getByRole('tab', { name: '设备参数', exact: true }).click();
      const newPower = Number((device.txPowerDbm - 0.1).toFixed(3));
      const since = c.responses.length;
      const submitted = await c.http('POST', '/plan/sr4-flow', () => power.fill(String(newPower)));
      c.anchors.jobId = submitted.job_id;
      const adjustment = submitted.adjustment;
      assert.equal(submitted.parent_plan_id, parent.plan_id);
      assert.equal(adjustment.source_snapshot_id, parent.result.snapshot_id);
      assert.deepEqual(adjustment.manual_override, [{ device_id: device.deviceId, tx_power_dbm: newPower }]);
      assert.deepEqual(adjustment.manual_paths, [{ demand_id: main.demandId, node_path: target }]);
      assert.equal(c.writes.filter(row => row.path === PREFIX + '/plan/sr4-flow').length, 1);
      attempt = { submitted, adjustment, target, newPower, since,
        path_origin: backup ? 'EXISTING_BACKUP_EXPLICITLY_SELECTED' : 'EXISTING_MAIN_EXPLICITLY_ENTERED' };
      return { submitted, adjustment, target, new_power: newPower, path_origin: attempt.path_origin, submissions: 1 };
    });
    return c.test('E-A02-manual-route-device-async-save', async () => {
      const { submitted, adjustment, target, newPower, since } = attempt;
      const job = await c.finish(submitted, since);
      const saved = await c.saveJob(job, 'R6-E manual adjustment', true);
      assert.equal(saved.parent_plan_id, parent.plan_id); assert.deepEqual(saved.adjustment, adjustment);
      assert.notEqual(saved.result.snapshot_id, parent.result.snapshot_id);
      const actual = saved.result.configuration.devices.find(row => row.deviceId === device.deviceId);
      assert.equal(actual.txPowerDbm, newPower);
      assert.deepEqual(saved.result.configuration.routes.find(row => !row.backup && row.demandId === adjustment.manual_paths[0].demand_id)?.nodeIds, target);
      assert.equal(c.writes.filter(row => row.path === PREFIX + '/plan/sr4-flow').length, 1);
      return { taskId: c.taskId, planId: saved.plan_id, parentPlanId: parent.plan_id, state: saved.state,
        saved, path_origin: attempt.path_origin };
    });
  });
}

/** One new legal adjustment selected only from the confirmed parent's frozen UI evidence. */
export async function runPlanningAdjustmentLegal(args) {
  assert.equal(args.taskId, RECOVERY.taskId);
  assert.equal(args.planId, 'PLAN-4d974f02b63b465ca03e030dcda8eff9');
  const sourceFile = path.join(args.runtime, 'browser', 'r6-browser-1792879930240-ff5d96', 'results.json');
  const source = JSON.parse(await readFile(sourceFile, 'utf8'));
  assert.equal(source.completed, true); assert.equal(source.taskId, args.taskId); assert.equal(source.planId, args.planId);
  assert.equal(source.cases.length, 4); assert(source.cases.every(row => row.state === 'PASS'));
  const scene = source.cases.find(row => row.id === 'E-I01-original-scene-readback').detail.scene.version;
  assert.equal(scene.scene_id, 'ISC-78232efa-d4b7-4760-b2b9-ecd006fa6b30');
  assert.equal(scene.version_id, 'ISV-461c806f9a4f4d70be1d2b0b009b18ec');
  const frozen = scene.plan_snapshot, raw = frozen.raw_snapshot;
  assert.equal(frozen.task_id, args.taskId); assert.equal(frozen.plan_id, args.planId);
  assert.equal(frozen.source, 'SR4');
  assert.equal(frozen.input_version, RECOVERY.inputVersion); assert.equal(frozen.condition_version, RECOVERY.conditionVersion);
  assert.equal(frozen.resource_revision, RECOVERY.resourceRevision); assert.equal(scene.resource_revision, RECOVERY.resourceRevision);
  assert.equal(raw.solution_id, 'PL-E4AFB9A0');
  const rows = raw.detail.params.params;
  assert(Array.isArray(rows) && rows.length);
  assert.equal(new Set(rows.map(row => row.device_id)).size, rows.length);
  return environment(args, async c => {
    const { page } = c;
    let parent, failed, choice, routeIntent, input, attempt;
    await c.test('E-AL01-failed-job-parent-frozen-source', async () => {
      await c.login('editor'); parent = await c.openPlan();
      assert.equal(parent.state, 'CONFIRMED'); assert.equal(parent.current, true); assert.equal(parent.source_changed, false);
      assert.equal(parent.source, frozen.source);
      assert.equal(parent.version, frozen.plan_version); assert.equal(parent.result.snapshot_id, 'SNP-' + raw.solution_id);
      assert.equal(parent.input_version, frozen.input_version); assert.equal(parent.condition_version, frozen.condition_version);
      assert.equal(parent.resource_revision, frozen.resource_revision); assert.deepEqual(parent.input, frozen.input_snapshot);
      failed = await c.openJob('tsk-aa60dc27b628');
      assert.equal(failed.status, 'FAILED'); assert.equal(failed.saved_plan_id, null);
      assert.equal(failed.error, 'ValueError: 人工设备参数无效：设备 DV-0001 功率不属于型号档位 [51.76]');
      assert.equal(failed.parent_plan_id, parent.plan_id); assert.equal(failed.input_version, parent.input_version);
      assert.equal(failed.condition_version, parent.condition_version); assert.equal(failed.resource_revision, parent.resource_revision);
      const reopened = await c.openPlan(parent.plan_id);
      assert.equal(reopened.current, true); assert.deepEqual(reopened.result, parent.result);
      const configured = parent.result.configuration.devices;
      assert.equal(new Set(configured.map(row => row.deviceId)).size, configured.length);
      assert(configured.every(device => rows.some(row => row.device_id === device.deviceId)), '配置设备必须属于此冻结原参数集合');
      const candidates = configured.map(device => ({ device, row: rows.find(row => row.device_id === device.deviceId) }))
        .filter(({ row }) => row.active === true);
      const power = candidates.find(({ row }) => Array.isArray(row.tx_power_levels_dbm)
        && row.tx_power_levels_dbm.every(Number.isFinite) && row.tx_power_levels_dbm.some(value => value !== row.tx_power_dbm));
      if (power) {
        assert.equal(power.device.txPowerDbm, power.row.tx_power_dbm, '配置原功率须与冻结原参数一致');
        assert(power.row.tx_power_levels_dbm.includes(power.row.tx_power_dbm));
        choice = { device: power.device, frozen: power.row, kind: 'FROZEN_POWER_LEVEL', key: 'tx_power_dbm',
          label: '发射功率', value: power.row.tx_power_levels_dbm.find(value => value !== power.row.tx_power_dbm) };
      } else {
        const height = candidates.find(({ row }) => Array.isArray(row.antenna_height_range_m)
          && row.antenna_height_range_m.length === 2 && row.antenna_height_range_m.every(Number.isFinite)
          && row.antenna_height_range_m[0] < row.antenna_height_range_m[1] && Number.isFinite(row.antenna_height_m));
        assert(height, '无不同合法功率档位或明确连续高度范围；不猜数值、不换来源');
        assert.equal(height.device.txPowerDbm, height.row.tx_power_dbm);
        assert.equal(height.device.antennaHeightM, height.row.antenna_height_m);
        const [low, high] = height.row.antenna_height_range_m, middle = (low + high) / 2;
        assert(low <= height.row.antenna_height_m && height.row.antenna_height_m <= high);
        choice = { device: height.device, frozen: height.row, kind: 'FROZEN_CONTINUOUS_HEIGHT_FALLBACK',
          key: 'antenna_height_m', label: '天线高度', value: middle === height.row.antenna_height_m ? low : middle };
        assert(low <= choice.value && choice.value <= high); assert.notEqual(choice.value, height.row.antenna_height_m);
      }
      assert.equal(choice.device.deviceId, choice.frozen.device_id);
      assert.equal(choice.device.stationId, choice.frozen.node_id);
      const main = parent.result.configuration.routes.find(row => !row.backup && row.nodeIds.length >= 2);
      assert(main, '父方案没有可显式设置的主路径');
      const backup = parent.result.configuration.routes.find(row => row.backup && row.demandId === main.demandId);
      routeIntent = { demand_id: main.demandId, node_path: backup?.nodeIds ?? main.nodeIds,
        origin: backup ? 'EXISTING_BACKUP_EXPLICITLY_SELECTED' : 'EXISTING_MAIN_EXPLICITLY_ENTERED' };
      assert.equal(c.writes.length, 0);
      return { retained_failed_job: failed, parent, source_file: sourceFile, scene_id: scene.scene_id,
        scene_version_id: scene.version_id, snapshot_hash: scene.snapshot_hash, frozen_selection: choice, route_intent: routeIntent };
    });
    await c.test('E-AL02-legal-adjustment-intent', async () => {
      await button(page, '调整此方案').click();
      const editor = page.locator('.inline-editor:visible'); await c.shown(editor);
      await editor.getByLabel('选择调整设备', { exact: true }).selectOption(choice.device.deviceId);
      input = editor.getByLabel(`${choice.device.deviceId} ${choice.label}`, { exact: true });
      const originalValue = choice.key === 'tx_power_dbm' ? choice.device.txPowerDbm : choice.device.antennaHeightM;
      assert.equal(await input.getAttribute('placeholder'), String(originalValue));
      // An incomplete draft blocks debounce while composing; it is never submitted as a physical value.
      await input.fill('-'); await c.enabled(button(editor, '重试预览'), false);
      await editor.getByRole('tab', { name: '主路由', exact: true }).click();
      await editor.getByLabel('选择调整需求', { exact: true }).selectOption(routeIntent.demand_id);
      const route = editor.locator('.route-row:visible'), target = routeIntent.node_path;
      const intermediates = () => route.locator('select');
      if (target.length === 2 && await intermediates().count() === 0) {
        await button(route, '增加中间节点').click(); await button(route, '移除').click();
      }
      for (let count = await intermediates().count(); count > target.length - 2; count--) await button(route, '移除').last().click();
      for (let count = await intermediates().count(); count < target.length - 2; count++) await button(route, '增加中间节点').click();
      assert.equal(await intermediates().count(), target.length - 2);
      for (let index = 1; index < target.length - 1; index++) {
        await route.getByLabel(`${routeIntent.demand_id} 中间节点 ${index}`, { exact: true }).selectOption(target[index]);
      }
      await editor.getByRole('tab', { name: '设备参数', exact: true }).click();
      await c.enabled(button(editor, '重试预览'), false); assert.equal(c.writes.length, 0);
      return { intent: 'ONE_NEW_FROZEN_LEGAL_ADJUSTMENT', source_file: sourceFile, retained_failed_job_id: failed.job_id,
        parent_plan_id: parent.plan_id, parent_snapshot_id: parent.result.snapshot_id,
        input_version: parent.input_version, condition_version: parent.condition_version, resource_revision: parent.resource_revision,
        frozen_selection: choice, manual_path: routeIntent, allowed_submits: 1, allowed_saves: 1, confirm_allowed: false };
    });
    await c.test('E-AL03-submit-checkpoint', async () => {
      const since = c.responses.length;
      const submitted = await c.http('POST', '/plan/sr4-flow', () => input.fill(String(choice.value)));
      c.anchors.jobId = submitted.job_id;
      assert.notEqual(submitted.job_id, failed.job_id); assert.equal(submitted.parent_plan_id, parent.plan_id);
      assert.equal(submitted.input_version, parent.input_version); assert.equal(submitted.condition_version, parent.condition_version);
      assert.equal(submitted.resource_revision, parent.resource_revision);
      assert.equal(submitted.adjustment.source_plan_id, parent.plan_id);
      assert.equal(submitted.adjustment.source_snapshot_id, parent.result.snapshot_id);
      assert.deepEqual(submitted.adjustment.manual_override, [{ device_id: choice.device.deviceId, [choice.key]: choice.value }]);
      assert.deepEqual(submitted.adjustment.manual_paths, [{ demand_id: routeIntent.demand_id, node_path: routeIntent.node_path }]);
      assert.equal(c.writes.length, 1); assert.equal(c.writes[0].path, PREFIX + '/plan/sr4-flow');
      attempt = { submitted, since };
      return { submitted, selection: choice, manual_path: routeIntent, submissions: 1, next: 'E-AL04-result-save-readback' };
    });
    return c.test('E-AL04-result-save-readback', async () => {
      const job = await c.finish(attempt.submitted, attempt.since);
      c.anchors.jobError = job.error;
      assert.equal(job.status, 'SUCCESS', `合法原号实际失败，禁止换号：${JSON.stringify({ job_id: job.job_id,
        status: job.status, error: job.error, outcome: job.outcome })}`);
      const saved = await c.saveJob(job, 'R6-E frozen legal adjustment', true);
      assert.equal(saved.parent_plan_id, parent.plan_id); assert.equal(saved.current, false); assert.equal(saved.source_changed, false);
      assert.deepEqual(saved.adjustment, attempt.submitted.adjustment);
      assert.deepEqual(saved.result, job.result); assert.deepEqual(saved.outcome, job.outcome);
      const actual = saved.result.configuration.devices.find(row => row.deviceId === choice.device.deviceId);
      assert(actual); assert.equal(actual[choice.key === 'tx_power_dbm' ? 'txPowerDbm' : 'antennaHeightM'], choice.value);
      assert.deepEqual(saved.result.configuration.routes.find(row => !row.backup && row.demandId === routeIntent.demand_id)?.nodeIds,
        routeIntent.node_path);
      let referenceEvidence = null;
      if (saved.state === 'REFERENCE') {
        assert.equal(saved.outcome.code, 3001);
        await button(page, '2 · 规划计算与结果').click();
        const outcome = page.getByRole('status', { name: '当前方案服务结论', exact: true });
        await c.text(outcome, saved.outcome.message);
        for (const gap of saved.outcome.gap) await c.shown(outcome.locator('p').filter({ hasText: gap.message }).first());
        referenceEvidence = { outcome: saved.outcome, visible_text: await outcome.innerText(),
          screenshot: await c.shot('E-AL04-reference-gap'), confirm_disabled: true };
      } else {
        assert.equal(saved.state, 'SAVED'); assert.equal(saved.outcome.code, 0);
        assert.equal(saved.outcome.gap.length, 0); assert(saved.result.checks.every(check => check.passed === true));
      }
      const current = await c.openPlan(parent.plan_id);
      assert.equal(current.current, true); assert.equal(current.state, 'CONFIRMED'); assert.deepEqual(current.result, parent.result);
      assert.deepEqual(c.writes.map(row => [row.method, row.path]), [['POST', PREFIX + '/plan/sr4-flow'], ['POST', PREFIX + '/plans']]);
      return { taskId: c.taskId, planId: saved.plan_id, parentPlanId: parent.plan_id, state: saved.state, job,
        saved, selection: choice, manual_path: routeIntent, reference_evidence: referenceEvidence,
        retained_failed_job_id: failed.job_id, parent_unchanged: true, confirmed: false };
    });
  });
}

/** args.planId is the child; its actual parent supplies the second comparison version. */
export async function runPlanningComparison(args) {
  return environment(args, async c => c.test('E-V01-compare-json-xlsx', async () => {
    const { page } = c;
    await c.login('editor'); const plan = await c.openPlan();
    assert(plan.parent_plan_id, '须传入实际调整子方案，与其父版本进行同任务对比');
    const library = page.locator('details.version-library');
    if (await library.getAttribute('open') === null) await library.locator(':scope > summary').click();
    const versions = await c.http('GET', '/plans', () => button(library, '刷新版本').click());
    const ids = [plan.parent_plan_id, plan.plan_id];
    await button(library, '清空选择').click();
    for (const id of ids) {
      const value = versions.items.find(row => row.plan_id === id);
      assert(value, `版本不在当前真实页，停止并由主选择同页父子版本：${id}`);
      const row = library.getByRole('row').filter({ hasText: value.name }).filter({ hasText: value.version });
      await c.shown(row);
      assert.equal(await row.count(), 1); await row.getByRole('checkbox').check();
    }
    const compared = await c.http('POST', '/plans/compare', () => button(library, '对比所选 2 个版本').click());
    assert.deepEqual(compared.map(row => row.plan_id), ids);
    for (const value of compared) {
      assert.equal(value.task_id, c.taskId); assert.equal(value.condition_version, plan.condition_version);
      assert.equal(value.resource_revision, plan.resource_revision);
    }
    await c.shown(page.getByRole('region', { name: '方案横向对比', exact: true }));
    await button(page, '收起方案对比').click();
    await c.expand('导出与复制任务条件', page.locator('.selected-plan'));
    await button(page.locator('.selected-plan'), '导出').click();
    const drawer = c.drawer('导出已保存方案');
    const formatControl = drawer.getByRole('combobox');
    await c.shown(formatControl); assert.equal(await formatControl.count(), 1);
    const files = [];
    for (const format of ['json', 'xlsx']) {
      await formatControl.selectOption(format);
      let file;
      const exported = await c.http('GET', `/plans/${enc(plan.plan_id)}/export`, async () => {
        file = await c.download(() => button(drawer, '下载方案').click(), `E-V01-${format}`);
      }, response => new URL(response.url()).searchParams.get('format') === 'json');
      assert.equal(exported.plan_id, plan.plan_id);
      assert.equal(exported.result.snapshot_id, plan.result.snapshot_id);
      assert(file.bytes > 0); assert.match(file.suggested_name, new RegExp(`\\.${format}$`));
      let snapshot;
      if (format === 'json') snapshot = JSON.parse(await readFile(file.file, 'utf8'));
      else {
        const require = createRequire(new URL('../../front_design/radio-planning-20261022/package.json', import.meta.url));
        const Excel = require('exceljs'); const book = new Excel.Workbook(); await book.xlsx.readFile(file.file);
        const sheet = book.getWorksheet('完整快照'); assert(sheet, 'XLSX 缺少完整快照');
        let json = ''; for (let row = 2; row <= sheet.rowCount; row++) json += sheet.getRow(row).getCell(2).value;
        snapshot = JSON.parse(json);
      }
      assert.equal(snapshot.plan.id, plan.plan_id); assert.equal(snapshot.plan.taskId, c.taskId);
      assert.equal(snapshot.plan.result.snapshotId, plan.result.snapshot_id);
      assert.equal(snapshot.plan.state, plan.state); assert.equal(snapshot.source, plan.source);
      files.push(file);
    }
    await c.closeDrawer(drawer);
    return { ids, compared, files, xlsx_transport: 'real frozen JSON HTTP then current frontend ExcelJS encoding' };
  }));
}

/** Recheck XLSX only against the JSON already downloaded in the third comparison run. */
export async function runPlanningXlsxReadback(args) {
  return environment(args, async c => c.test('E-V03-xlsx-existing-json', async () => {
    const baselineFile = path.join(args.runtime, 'browser', 'r6-browser-1792881902358-33d817', 'E-V01-json.json');
    const baselineBytes = await readFile(baselineFile), baseline = JSON.parse(baselineBytes.toString('utf8'));
    assert.equal(baseline.schemaVersion, 'planning-http-draft-0.1');
    assert.equal(baseline.plan.id, c.planId); assert.equal(baseline.plan.taskId, c.taskId);
    assert.equal(baseline.plan.state, 'REFERENCE'); assert.equal(baseline.plan.current, false);
    assert.equal(baseline.plan.sourceChanged, false); assert(baseline.plan.parentPlanId);
    const baselineSha256 = createHash('sha256').update(baselineBytes).digest('hex');
    c.anchors.jsonBaseline = { file: baselineFile, bytes: baselineBytes.length, sha256: baselineSha256 };
    await c.login('editor'); const plan = await c.openPlan();
    for (const [raw, saved] of [['input_version', 'inputVersion'], ['condition_version', 'conditionVersion'],
      ['resource_revision', 'resourceRevision'], ['parent_plan_id', 'parentPlanId'], ['job_id', 'jobId']]) {
      assert.equal(plan[raw], baseline.plan[saved], `已保存JSON来源变化：${raw}`);
    }
    assert.equal(plan.result.snapshot_id, baseline.plan.result.snapshotId);
    assert.equal(plan.state, baseline.plan.state); assert.equal(plan.current, baseline.plan.current);
    assert.equal(plan.source_changed, baseline.plan.sourceChanged); assert.equal(plan.source, baseline.source);
    const { page } = c;
    await c.expand('导出与复制任务条件', page.locator('.selected-plan'));
    await button(page.locator('.selected-plan'), '导出').click();
    const drawer = c.drawer('导出已保存方案'), formatControl = drawer.getByRole('combobox');
    await c.shown(formatControl); assert.equal(await formatControl.count(), 1);
    await formatControl.selectOption('xlsx'); await c.enabled(button(drawer, '下载方案'));
    let file;
    const exported = await c.http('GET', `/plans/${enc(plan.plan_id)}/export`, async () => {
      file = await c.download(() => button(drawer, '下载方案').click(), 'E-V03-xlsx');
    }, response => new URL(response.url()).searchParams.get('format') === 'json');
    assert.deepEqual(exported, plan, 'XLSX编码须读取同一已保存方案原件');
    assert(file.bytes > 0); assert.match(file.suggested_name, /\.xlsx$/);
    const require = createRequire(new URL('../../front_design/radio-planning-20261022/package.json', import.meta.url));
    const Excel = require('exceljs'), book = new Excel.Workbook(); await book.xlsx.readFile(file.file);
    const sheet = book.getWorksheet('完整快照'); assert(sheet, 'XLSX缺少完整快照');
    assert(sheet.rowCount > 2, '实际大快照必须完整分片保存');
    assert.equal(sheet.getCell(1, 1).value, '顺序'); assert.equal(sheet.getCell(1, 2).value, 'JSON片段');
    let json = '';
    for (let row = 2; row <= sheet.rowCount; row++) {
      assert.equal(sheet.getCell(row, 1).value, row - 1);
      const piece = sheet.getCell(row, 2).value; assert.equal(typeof piece, 'string'); json += piece;
    }
    const snapshot = JSON.parse(json);
    assert.equal(snapshot.schemaVersion, baseline.schemaVersion); assert.equal(snapshot.source, baseline.source);
    assert.deepEqual(snapshot.plan, baseline.plan, 'XLSX完整冻结快照必须与原JSON逐项一致');
    assert(Number.isFinite(Date.parse(snapshot.exportedAt)), '导出时间必须真实提供');
    for (const name of ['方案说明', '人工设备输入', '人工主路由', '指标', '校验']) {
      assert(book.getWorksheet(name), `XLSX缺少工作表：${name}`);
    }
    await c.closeDrawer(drawer); await c.referenceDisabled(plan);
    const parent = await c.openPlan(plan.parent_plan_id);
    assert.equal(parent.state, 'CONFIRMED'); assert.equal(parent.current, true);
    assert.equal(parent.source_changed, false); assert.equal(parent.condition_version, plan.condition_version);
    assert.equal(parent.resource_revision, plan.resource_revision); assert.equal(c.writes.length, 0);
    return { json_baseline: c.anchors.jsonBaseline, xlsx: file, plan_id: plan.plan_id,
      parent_plan_id: parent.plan_id, parent_current: parent.current, snapshot_id: plan.result.snapshot_id,
      complete_snapshot_matches_json: true, business_writes: c.writes.length,
      xlsx_transport: 'real frozen JSON HTTP then current frontend ExcelJS encoding' };
  }));
}

/** Existing real REFERENCE only. No synthetic failure or parameter search is generated. */
export async function runPlanningReference(args) {
  return environment(args, async c => c.test('E-V02-reference-no-confirm', async () => {
    await c.login('editor'); await c.openPlan();
    await button(c.page, '规划历史').click();
    const history = c.drawer('规划历史'); await c.shown(history);
    await c.enabled(button(history, '已保存方案'));
    await c.http('GET', '/plan/saved-plans', () => button(history, '已保存方案').click());
    await history.getByLabel('方案状态', { exact: true }).selectOption('REFERENCE');
    const list = await c.http('GET', '/plan/saved-plans', () => button(history, '查询').click(),
      response => new URL(response.url()).searchParams.get('state') === 'REFERENCE');
    const reference = list.items.find(row => row.task_id === c.taskId);
    assert(reference, '前置阻断：当前页无同任务真实REFERENCE；不造数据、不重复试参数，交主提供原号');
    await c.enabled(button(history, '查询'));
    await history.getByLabel('搜索规划历史', { exact: true }).fill(reference.plan_id);
    const found = await c.http('GET', '/plan/saved-plans', () => button(history, '查询').click(),
      response => new URL(response.url()).searchParams.get('search') === reference.plan_id);
    assert.equal(found.items.length, 1); assert.equal(found.items[0].plan_id, reference.plan_id);
    assert.equal(found.items[0].task_id, c.taskId); assert.equal(found.items[0].state, 'REFERENCE');
    await c.enabled(button(history, '查询')); assert.equal(await button(history, '打开方案').count(), 1);
    const plan = await c.http('GET', `/plans/${enc(reference.plan_id)}`, () => button(history, '打开方案').click());
    await history.waitFor({ state: 'hidden' });
    await button(c.page, '3 · 方案调整与对比').click(); await c.referenceDisabled(plan);
    return { plan, rejection: 'UI_DISABLED', server_409_tested: false };
  }));
}

/** Resume only the already accepted scene from this exact failed run, never a latest row. */
export async function runInterferenceFromScene(args) {
  const evidence = JSON.parse(await readFile(path.join(args.runtime, 'browser',
    'r6-browser-1792871478143-83ad76', 'E-I01-frozen-source-scene-save-http.json'), 'utf8'));
  assert.equal(evidence.anchors.taskId, args.taskId); assert.equal(evidence.anchors.planId, args.planId);
  assert.equal(evidence.writes.length, 1);
  const saved = evidence.http.find(row => row.method === 'PUT');
  assert.equal(saved.http, 200); assert.equal(saved.response.code, 0);
  assert.equal(saved.request.request_id, '4a363435-cbc3-4f44-9930-4060f3d4ff68');
  assert.equal(saved.response.data.scene_id, 'ISC-78232efa-d4b7-4760-b2b9-ecd006fa6b30');
  assert.equal(saved.response.data.version_id, 'ISV-461c806f9a4f4d70be1d2b0b009b18ec');
  return runInterference({ ...args, resumeScene: { receipt: saved.response.data,
    name: saved.request.name, interferenceIds: saved.request.interference_ids } });
}

/** Resume the original successful analysis; this path cannot POST another run. */
export async function runInterferenceFromRun(args) {
  const evidence = JSON.parse(await readFile(path.join(args.runtime, 'browser',
    'r6-browser-1792871694328-9820bf', 'results.json'), 'utf8'));
  assert.equal(evidence.taskId, args.taskId); assert.equal(evidence.planId, args.planId);
  const checkpoint = evidence.cases.find(row => row.id === 'E-I02-submit-checkpoint');
  assert.equal(checkpoint?.state, 'PASS');
  const receipt = checkpoint.detail.receipt;
  assert.equal(receipt.request_id, '6fd7eb46-3708-4646-9497-2fb328005673');
  assert.equal(receipt.object_id, 'IRN-c393b6a276864f1696dd93cfe241a937');
  return runInterferenceFromScene({ ...args, resumeRun: receipt });
}

/** Read the failed adoption/child job and parent; no retry or new business write. */
export async function runInterferenceFailureReadback(args) {
  const evidence = JSON.parse(await readFile(path.join(args.runtime, 'browser',
    'r6-browser-1792871871550-83a284', 'results.json'), 'utf8'));
  assert.equal(evidence.taskId, args.taskId); assert.equal(evidence.planId, args.planId);
  const checkpoint = evidence.cases.find(row => row.id === 'E-I03-adopt-checkpoint');
  assert.equal(checkpoint?.state, 'PASS');
  assert.equal(checkpoint.detail.receipt.request_id, '58187ea0-f0dc-4cfd-b3bc-3ccd9f7926a9');
  assert.equal(checkpoint.detail.receipt.object_id, 'IAD-a9fe72310cc24e229eb79740bf9d1341');
  return runInterferenceFromRun({ ...args, readonlyAdoption: checkpoint.detail.receipt });
}

/** Separately authorized new analysis/adoption; never retry the retained FAILED adoption. */
export async function runInterferenceFreshAfterBridgeFix(args) {
  assert.equal(args.taskId, RECOVERY.taskId);
  assert.equal(args.planId, 'PLAN-4d974f02b63b465ca03e030dcda8eff9');
  assert(!args.resumeRun && !args.readonlyAdoption && !args.freshTrial, '新案入口禁止混入旧run/采纳恢复参数');
  const archiveFile = path.join(args.runtime, 'browser', 'r6-browser-1792872044379-aee1b4', 'results.json');
  const archive = JSON.parse(await readFile(archiveFile, 'utf8'));
  assert.equal(archive.taskId, args.taskId); assert.equal(archive.planId, args.planId);
  const retained = archive.cases.find(row => row.id === 'E-I03-failed-adoption-child-parent-readback');
  assert.equal(retained?.state, 'PASS');
  const old = retained.detail.adoption, job = retained.detail.original_child_job;
  assert.equal(old.adoption_id, 'IAD-a9fe72310cc24e229eb79740bf9d1341');
  assert.equal(old.run_id, 'IRN-c393b6a276864f1696dd93cfe241a937');
  assert.equal(old.state, 'FAILED'); assert.equal(old.error, '桥回报与持久化作业状态不一致');
  assert.equal(old.result_plan_id, null); assert.equal(old.planning_job_id, 'tsk-d447a171c25d');
  assert.equal(job.job_id, old.planning_job_id); assert.equal(job.parent_plan_id, args.planId);
  assert.equal(job.status, 'SUCCESS'); assert.equal(job.saved_plan_id, null); assert.equal(job.outcome.code, 3001);
  assert.equal(job.input_version, RECOVERY.inputVersion); assert.equal(job.condition_version, RECOVERY.conditionVersion);
  assert.equal(job.resource_revision, RECOVERY.resourceRevision); assert(job.outcome.gap.length);
  return runInterferenceFromScene({ ...args, freshTrial: { archive_file: archiveFile, adoption: old,
    child_job: { job_id: job.job_id, status: job.status, saved_plan_id: job.saved_plan_id, outcome: job.outcome } } });
}

/** Completed-only readback of ef5f14; preserve its six checkpoints and original failure. */
export async function runInterferenceAcceptedReadback(args) {
  assert.equal(args.taskId, RECOVERY.taskId);
  assert.equal(args.planId, 'PLAN-4d974f02b63b465ca03e030dcda8eff9');
  assert(!args.resumeRun && !args.readonlyAdoption && !args.freshTrial
    && !args.readonlyAcceptedAdoption && !args.readonlyCompletedAdoption);
  const archiveDir = path.join(args.runtime, 'browser', 'r6-browser-1792875916123-ef5f14');
  const archive = JSON.parse(await readFile(path.join(archiveDir, 'results.json'), 'utf8'));
  assert.equal(archive.taskId, args.taskId); assert.equal(archive.planId, args.planId);
  const checkpoints = ['E-I01-original-scene-readback', 'E-I02-new-analysis-intent', 'E-I02-submit-checkpoint',
    'E-I02-analysis-measure-preview', 'E-I03-new-adoption-intent', 'E-I03-adopt-checkpoint'];
  const failureId = 'E-I03-adopt-real-child-original-receipt';
  assert.equal(archive.completed, false);
  assert.deepEqual(archive.cases.map(row => [row.id, row.state]),
    [...checkpoints.map(id => [id, 'PASS']), [failureId, 'FAIL']]);
  const analysis = archive.cases.find(row => row.id === 'E-I02-submit-checkpoint');
  const adopted = archive.cases.find(row => row.id === 'E-I03-adopt-checkpoint');
  assert.equal(analysis.detail.receipt.request_id, 'eca181d7-9dd3-4c0a-b3d4-202a05edf432');
  assert.equal(analysis.detail.receipt.object_id, 'IRN-aace31d38ce44ccdbb9904569579aad3');
  assert.equal(adopted.detail.receipt.request_id, '5b6d1f4e-b40a-472a-8899-185db38497ff');
  assert.equal(adopted.detail.receipt.object_id, 'IAD-8eebc0ad511c4744bcc38eeb5ceff183');
  assert.equal(adopted.detail.receipt.planning_request_id, 'interference-IAD-8eebc0ad511c4744bcc38eeb5ceff183');
  const failed = JSON.parse(await readFile(path.join(archiveDir, failureId + '-http.json'), 'utf8'));
  assert.equal(failed.case_id, failureId);
  assert(failed.original_error.message.includes('360000ms')
    && failed.original_error.message.includes(adopted.detail.receipt.object_id));
  assert.equal(failed.anchors.lastWrite.request.request_id, adopted.detail.receipt.request_id);
  assert.equal(failed.anchors.lastWrite.request.run_id, analysis.detail.receipt.object_id);
  const original = failed.http.filter(row => row.method === 'GET' && new URL(row.url).pathname
    === PREFIX + WB + '/adoptions/' + adopted.detail.receipt.object_id).at(-1);
  assert.equal(original.http, 200); assert.equal(original.response.code, 0);
  const previous = original.response.data;
  assert.equal(previous.state, 'RUNNING'); assert.equal(previous.error, '本地规划操作缺少可信业务上下文');
  assert.equal(previous.planning_job_id, 'tsk-8f6b3b3f904b'); assert.equal(previous.planning_state, 'SUCCESS');
  assert.equal(previous.result_plan_id, null);
  const parentRead = archive.cases[0].detail.http.find(row => row.method === 'GET'
    && new URL(row.url).pathname === PREFIX + '/plans/' + args.planId);
  assert.equal(parentRead.http, 200); assert.equal(parentRead.response.code, 0);
  const parent = parentRead.response.data;
  assert.equal(parent.state, 'CONFIRMED'); assert.equal(parent.current, true);
  const preview = archive.cases.find(row => row.id === 'E-I02-analysis-measure-preview').detail;
  assert.equal(preview.selected_measure.measure_id, 'CM-a8a8670f0359b55871f5f02d');
  const retained = archive.cases.find(row => row.id === 'E-I02-new-analysis-intent').detail.retained_failure;
  assert.equal(retained.adoption.adoption_id, 'IAD-a9fe72310cc24e229eb79740bf9d1341');
  assert.equal(retained.adoption.state, 'FAILED');
  return runInterferenceFromScene({ ...args, resumeRun: analysis.detail.receipt,
    readonlyCompletedAdoption: { receipt: adopted.detail.receipt, job_id: previous.planning_job_id,
      measure_id: preview.selected_measure.measure_id, source_hash: preview.run.source_hash,
      parent_result: parent.result, retained_failed_adoption: retained.adoption.adoption_id,
      original_failure: { directory: archiveDir, case_id: failureId, message: failed.original_error.message } } });
}

/** Frozen scene edit/save -> one analysis -> one measure -> real child job/plan. */
export async function runInterference(args) {
  return environment(args, async c => {
    const { page, taskId, planId } = c;
    const fresh = args.freshTrial;
    const completed = args.readonlyCompletedAdoption;
    if (completed) {
      assert(args.resumeScene && args.resumeRun && !fresh && !args.readonlyAdoption && !args.readonlyAcceptedAdoption);
      c.anchors.adoptionId = completed.receipt.object_id; c.anchors.childJobId = completed.job_id;
      c.anchors.retainedFailedAdoptionId = completed.retained_failed_adoption;
    }
    if (fresh) {
      assert(args.resumeScene && !args.resumeRun && !args.readonlyAdoption);
      c.anchors.retainedFailedAdoptionId = fresh.adoption.adoption_id;
      c.anchors.retainedRunId = fresh.adoption.run_id;
      c.anchors.retainedChildJobId = fresh.adoption.planning_job_id;
    }
    let plan, panel, scene, run, measure, adoption, childJob, analysisReceipt, analysisSince, adoptionReceipt, adoptionSince;
    await c.test(args.resumeScene ? 'E-I01-original-scene-readback' : 'E-I01-frozen-source-scene-save', async () => {
      await c.login('editor'); plan = await c.openPlan();
      assert.equal(plan.state, 'CONFIRMED'); assert.equal(plan.current, true); assert.equal(plan.source_changed, false);
      if (fresh || completed) {
        assert.equal(plan.input_version, RECOVERY.inputVersion); assert.equal(plan.condition_version, RECOVERY.conditionVersion);
        assert.equal(plan.resource_revision, RECOVERY.resourceRevision);
      }
      if (completed) assert.deepEqual(plan.result, completed.parent_result, '父V2必须与ef5f14原冻结结果完全一致');
      await c.http('GET', WB, () => button(page, '进入干扰分析').click(), response => new URL(response.url()).searchParams.get('task_id') === taskId);
      panel = page.getByRole('region', { name: '干扰分析', exact: true }); await c.shown(panel);
      const context = await c.http('GET', WB, () => iconButton(panel, '刷新干扰上下文').click());
      assert.equal(context.task_id, taskId);
      const source = context.source_options.find(row => row.plan_id === planId);
      assert(source?.eligible && source.current); assert.equal(source.resource_revision, plan.resource_revision);
      const sources = context.interference_sources.filter(row => row.active === 'true');
      assert(sources.length, '无生效干扰源，停止；不改变默认资料或干扰强度');
      await button(panel, '场景与版本').click(); const drawer = c.drawer('干扰场景与版本');
      let receipt;
      if (args.resumeScene) {
        const original = args.resumeScene;
        receipt = original.receipt;
        await drawer.locator('input[aria-label="搜索场景"]').fill(original.name);
        const found = await c.http('GET', '/interference/scenes', () => iconButton(drawer, '搜索场景').click(),
          response => new URL(response.url()).searchParams.get('search') === original.name);
        assert.equal(found.items.length, 1);
        const row = found.items[0];
        assert.equal(row.scene_id, receipt.scene_id); assert.equal(row.version_id, receipt.version_id);
        assert.equal(row.plan_id, planId); assert.equal(row.task_id, taskId);
        const select = button(drawer, `${row.name} · ${row.plan_version} · v${row.version_no}`);
        await c.shown(select); assert.equal(await select.count(), 1);
        scene = await c.http('GET', `/interference/scenes/${enc(receipt.scene_id)}`, () => select.click(),
          response => new URL(response.url()).searchParams.get('version_id') === receipt.version_id);
        assert.deepEqual(scene.version.interference_ids, original.interferenceIds);
        assert.equal(c.writes.length, 0, '恢复只能选择原场景，不能再次保存');
      } else {
      await drawer.getByLabel('场景名称', { exact: true }).fill(`R6-E frozen scene ${Date.now()}`);
      await drawer.getByLabel('备注', { exact: true }).fill('R6 构造联调验收，冻结选源；非实测。');
      for (const source of sources.slice(0, 1)) {
        const row = drawer.locator('label.source-option').filter({ hasText: source.interference_id });
        await row.getByRole('checkbox').check();
      }
      const checked = drawer.locator('label.source-option input[type="checkbox"]:checked');
      assert.equal(await checked.count(), 1); assert.equal(await checked.getAttribute('value'), sources[0].interference_id);
      const since = c.responses.length;
      receipt = await c.http('PUT', /^\/api\/v1\/interference\/scenes\/[^/]+$/, () => button(drawer, '保存版本').click());
      scene = await c.observed(`/interference/scenes/${enc(receipt.scene_id)}`, value => value.version.version_id === receipt.version_id, since);
      }
      c.anchors.sceneId = receipt.scene_id; c.anchors.sceneVersionId = receipt.version_id;
      assert.equal(receipt.plan_id, planId); assert.equal(receipt.task_id, taskId);
      assert.equal(scene.source_state.state, 'CURRENT'); assert.equal(scene.version.snapshot_hash, receipt.snapshot_hash);
      assert.equal(scene.version.plan_snapshot.plan_id, planId);
      assert.equal(scene.version.resource_revision, plan.resource_revision);
      assert.deepEqual(scene.version.interference_ids, [sources[0].interference_id]);
      await c.text(drawer, `${receipt.scene_id} · 版本 ${receipt.version_no} · 当前来源`);
      await c.closeDrawer(drawer);
      if (!args.resumeScene) await c.text(panel, '场景版本已保存；尚未提交分析');
      await c.enabled(button(panel, '提交干扰分析'));
      return { receipt, scene, source_edit_scope: 'FROZEN_SCENE_SELECTION', master_parameters_changed: false,
        reused_original_scene: Boolean(args.resumeScene) };
    });
    if (fresh) await c.test('E-I02-new-analysis-intent', async () => {
      assert.equal(c.writes.length, 0);
      return { intent: 'ONE_NEW_ANALYSIS_AFTER_BRIDGE_FIX', retained_failure: fresh,
        taskId, parentPlanId: planId, inputVersion: plan.input_version, conditionVersion: plan.condition_version,
        resourceRevision: plan.resource_revision, sceneId: scene.version.scene_id, sceneVersionId: scene.version.version_id,
        snapshotHash: scene.version.snapshot_hash, allowed_analysis_posts: 1, allowed_adoption_posts: 1,
        scene_save_allowed: false, confirm_allowed: false, next: 'E-I02-submit-checkpoint' };
    });
    await c.test(args.resumeRun ? 'E-I02-original-run-readback' : 'E-I02-submit-checkpoint', async () => {
      analysisSince = c.responses.length;
      if (args.resumeRun) {
        analysisReceipt = args.resumeRun;
        await c.http('GET', WB + '/runs', () => panel.getByRole('button').filter({ hasText: /^\s*历史 \d+\s*$/ }).click());
        const history = c.drawer('干扰分析历史'); await c.shown(history);
        await history.getByLabel('搜索运行或方案编号', { exact: true }).fill(analysisReceipt.object_id);
        const found = await c.http('GET', WB + '/runs', () => iconButton(history, '查询历史').click(),
          response => new URL(response.url()).searchParams.get('search') === analysisReceipt.object_id);
        assert.equal(found.items.length, 1); assert.equal(found.items[0].run_id, analysisReceipt.object_id);
        const row = history.locator('button.history-row').filter({ hasText: analysisReceipt.object_id });
        await c.shown(row); assert.equal(await row.count(), 1);
        run = await c.http('GET', WB + `/runs/${enc(analysisReceipt.object_id)}`, () => row.click());
        await history.waitFor({ state: 'hidden' });
        assert.equal(c.writes.length, 0, '恢复只能打开原run，不得再次提交分析');
      } else {
      analysisReceipt = await c.http('POST', WB + '/runs', () => button(panel, '提交干扰分析').click());
      }
      c.anchors.analysisRequestId = analysisReceipt.request_id; c.anchors.runId = analysisReceipt.object_id;
      if (fresh) {
        assert.notEqual(analysisReceipt.object_id, fresh.adoption.run_id, '必须是独立新分析，不能重开旧run冒充新案');
        assert.notEqual(analysisReceipt.request_id, '6fd7eb46-3708-4646-9497-2fb328005673');
      }
      assert.equal(c.writes.filter(row => row.path === PREFIX + WB + '/runs').length, args.resumeRun ? 0 : 1);
      return { receipt: analysisReceipt, original_run: run, submissions: args.resumeRun ? 0 : 1, next: 'E-I02-analysis-measure-preview' };
    });
    await c.test('E-I02-analysis-measure-preview', async () => {
      if (!run) run = await c.observed(WB + `/runs/${enc(analysisReceipt.object_id)}`, value => ['SUCCESS', 'FAILED', 'CANCELLED'].includes(value.state), analysisSince);
      assert.equal(run.task_id, taskId); assert.equal(run.plan_id, planId);
      assert.equal(run.scene_version_id, scene.version.version_id);
      assert.equal(run.source.version_id, scene.version.version_id);
      assert.equal(run.source.snapshot_hash, scene.version.snapshot_hash);
      assert.deepEqual(run.source.plan_snapshot, scene.version.plan_snapshot);
      assert.match(run.source_hash, /^[a-f0-9]{64}$/, '运行级来源摘要必须真实提供，随后与preview/adoption逐级核对');
      assert.equal(run.state, 'SUCCESS', `保留实际分析失败：${JSON.stringify(run)}`);
      if (fresh) { assert.equal(run.run_id, analysisReceipt.object_id); assert.equal(run.adoptions.length, 0); }
      if (completed) assert.equal(run.source_hash, completed.source_hash);
      await c.text(panel, `${run.plan_version} · 分析完成`);
      measure = run.result.measures.find(row => (!completed || row.measure_id === completed.measure_id)
        && row.available && run.adoption_capabilities[row.type]?.enabled);
      assert(measure, '真实模型没有可采纳措施；保留分析/五类结论，不提高干扰强度或换源碰运气');
      const control = panel.locator(`.measure-row[data-measure-id=${JSON.stringify(measure.measure_id)}]`);
      await c.shown(control);
      assert.equal(await control.count(), 1);
      const previewButton = control.getByRole('button').filter({ has: page.locator('strong') });
      assert.equal(await previewButton.count(), 1);
      const preview = await c.http('GET', WB + `/runs/${enc(run.run_id)}/measures/${enc(measure.measure_id)}/preview`, () => previewButton.click());
      assert.equal(preview.run_id, run.run_id); assert.equal(preview.measure_id, measure.measure_id);
      assert.equal(preview.source_hash, run.source_hash); assert.equal(preview.preview_hash, measure.preview_hash);
      assert.equal(preview.available, true); assert.deepEqual(preview.proposed_changes, measure.change_set);
      const drawer = c.drawer('抗干扰措施与预评估'); await c.text(drawer, '拟应用变更');
      if (preview.impact_after) { await button(drawer, '措施后预测').click(); await button(drawer, '措施前').click(); }
      return { run, selected_measure: measure, preview };
    });
    async function openAdoptionDetails(measureDrawer, label) {
      const since = c.responses.length;
      const actual = await c.http('GET', WB + `/adoptions/${enc(adoption.adoption_id)}`,
        () => button(measureDrawer, '采纳详情').click(),
        response => new URL(response.url()).searchParams.get('task_id') === taskId);
      // The underlying measure drawer also contains a button named "采纳详情".
      const details = page.locator('.p-drawer:visible').filter({
        has: page.locator('.p-drawer-title').filter({ hasText: /^\s*采纳详情\s*$/ }),
      });
      await c.shown(details); assert.equal(await details.count(), 1);
      const source = await c.observed(WB + `/runs/${enc(run.run_id)}`,
        value => value.run_id === run.run_id, since);
      const identityKeys = ['adoption_id', 'task_id', 'run_id', 'measure_id', 'source_hash',
        'planning_request_id', 'planning_job_id'];
      if (!args.readonlyAcceptedAdoption) identityKeys.push('result_plan_id', 'result_plan_state', 'state');
      for (const key of identityKeys) {
        assert.deepEqual(actual[key], adoption[key], `采纳详情原号/结论不符：${key}`);
      }
      // A still-active original adoption may legitimately finish between the two GETs.
      // Only this read-only path accepts that advance; its UI fields use the actual detail GET.
      if (args.readonlyAcceptedAdoption) adoption = actual;
      assert.equal(source.task_id, taskId); assert.equal(source.plan_id, planId);
      assert.equal(source.plan_version, plan.version); assert.equal(source.source_hash, actual.source_hash);
      assert(source.adoptions.some(row => row.adoption_id === actual.adoption_id
        && row.planning_request_id === actual.planning_request_id), '原分析必须保留同一采纳及规划请求号');
      await c.enabled(iconButton(details, '重新读取采纳详情'));
      assert.equal(await details.getByRole('alert').count(), 0, '采纳详情不得含读取错误');
      const expected = {
        '采纳编号': actual.adoption_id, '任务编号': actual.task_id, '采纳请求号': null,
        '规划请求号': actual.planning_request_id, '原分析编号': actual.run_id,
        '措施编号': actual.measure_id, '措施名称': measure.title,
        '父方案编号': source.plan_id, '父方案版本': source.plan_version,
        '子规划作业编号': actual.planning_job_id, '子规划状态': actual.planning_state,
        '子规划进度': actual.planning_progress == null ? null : `${actual.planning_progress}%`,
        '子方案编号': actual.result_plan_id, '子方案状态': actual.result_plan_state,
        '结论': `${{ SUCCESS: '重算结果已保存', FAILED: '重算失败', CANCELLED: '重算已取消' }[actual.state]} · ${actual.state}`,
        '失败信息': actual.error, '来源摘要': actual.source_hash,
      };
      const visibleFields = {};
      for (const [name, value] of Object.entries(expected)) {
        const term = details.locator('dl.adoption-fields > dt').filter({
          hasText: new RegExp(`^\\s*${escapeRegex(name)}\\s*$`),
        });
        assert.equal(await term.count(), 1, `详情字段必须唯一：${name}`);
        const field = term.locator('xpath=following-sibling::dd[1]');
        visibleFields[name] = (await field.innerText()).trim();
        assert.equal(visibleFields[name], value == null || value === '' ? '未提供' : String(value), name);
      }
      const screenshot = await c.shot(label);
      const close = details.locator('button.p-drawer-close-button');
      assert.equal(await close.count(), 1); await close.click();
      await details.waitFor({ state: 'hidden' }); await c.shown(measureDrawer);
      assert.equal(c.responses.slice(since).filter(response => matches(response, 'POST', WB + '/adoptions')).length,
        0, '只读详情不得再次提交采纳');
      return { adoption: actual, source_run_id: source.run_id, visible_fields: visibleFields,
        screenshot, closed: true, underlying_measure_visible: true };
    }
    if (args.readonlyAcceptedAdoption || completed) {
      return c.test(completed ? 'E-I03-saved-original-adoption-readback' : 'E-I03-accepted-original-adoption-readback', async () => {
        const original = completed ?? args.readonlyAcceptedAdoption;
        adoption = run.adoptions.find(row => row.adoption_id === original.receipt.object_id);
        assert(adoption, '原run必须回显该次受理采纳，禁止另建');
        assert.equal(adoption.planning_job_id, original.job_id);
        assert.equal(adoption.planning_request_id, original.receipt.planning_request_id);
        if (completed) {
          assert.equal(adoption.state, 'SUCCESS', `原号尚未完成保存：${JSON.stringify({ state: adoption.state,
            error: adoption.error, job_id: adoption.planning_job_id, plan_id: adoption.result_plan_id })}`);
          assert.equal(adoption.error, null); assert.equal(adoption.planning_state, 'SUCCESS');
          assert.equal(adoption.planning_progress, 100); assert.equal(adoption.result_plan_state, 'REFERENCE');
          assert(adoption.result_plan_id); assert.notEqual(adoption.result_plan_id, planId);
        }
        const drawer = c.drawer('抗干扰措施与预评估');
        await c.enabled(button(drawer, '采纳措施并提交规划重算'), false);
        if (completed) await c.text(drawer, '已保存未达标参考方案；采纳未改变原确认方案。');
        const details = await openAdoptionDetails(drawer, 'E-I03-accepted-original-detail');
        childJob = await c.http('GET', `/plan/tasks/${enc(original.job_id)}`,
          () => button(drawer, '查看规划作业').click());
        assert.equal(childJob.job_id, original.job_id); assert.equal(childJob.task_id, taskId);
        assert.equal(childJob.parent_plan_id, planId); assert.equal(childJob.status, 'SUCCESS');
        if (completed) {
          assert.equal(childJob.input_version, plan.input_version); assert.equal(childJob.condition_version, plan.condition_version);
          assert.equal(childJob.resource_revision, plan.resource_revision); assert.equal(childJob.source_changed, false);
        }
        c.anchors.adoptionId = adoption.adoption_id; c.anchors.adoptionState = adoption.state;
        c.anchors.adoptionError = adoption.error; c.anchors.childJobId = childJob.job_id;
        c.anchors.childPlanId = adoption.result_plan_id; c.anchors.outcome = childJob.outcome;
        let child = null, gapEvidence = null;
        if (adoption.state === 'SUCCESS') {
          assert(adoption.result_plan_id); assert(['SAVED', 'REFERENCE'].includes(adoption.result_plan_state));
          assert.equal(childJob.saved_plan_id, adoption.result_plan_id);
          child = await c.openPlan(adoption.result_plan_id);
          assert.equal(child.state, adoption.result_plan_state); assert.equal(child.current, false);
          assert.equal(child.parent_plan_id, planId); assert.equal(child.job_id, childJob.job_id);
          assert.deepEqual(child.result, childJob.result); assert.deepEqual(child.outcome, childJob.outcome);
          if (completed) {
            assert.equal(child.source_changed, false); assert.deepEqual(child.input, plan.input);
            assert.equal(child.input_version, plan.input_version); assert.equal(child.condition_version, plan.condition_version);
            assert.equal(child.resource_revision, plan.resource_revision); assert(child.outcome.gap.length);
          }
          if (child.state === 'REFERENCE') {
            await c.referenceDisabled(child); assert.equal(child.outcome.code, 3001);
            await button(page, '2 · 规划计算与结果').click();
            const outcome = page.getByRole('status', { name: '当前方案服务结论', exact: true });
            await c.text(outcome, child.outcome.message);
            for (const gap of child.outcome.gap) await c.shown(outcome.locator('p').filter({ hasText: gap.message }).first());
            gapEvidence = { gap: child.outcome.gap, visible_text: await outcome.innerText(),
              screenshot: await c.shot('E-I03-original-reference-gap'), confirm_disabled: true };
          }
        } else {
          assert.equal(adoption.result_plan_id, null);
        }
        const parent = await c.openPlan(planId);
        assert.equal(parent.current, true); assert.equal(parent.state, 'CONFIRMED');
        assert.deepEqual(parent.result, plan.result); assert.equal(c.writes.length, 0);
        return { readonly: true, original_receipt: original.receipt, adoption: details.adoption, child_job: childJob,
          child, gap_evidence: gapEvidence, parent, business_writes: 0, confirmed: false,
          business_acceptance: adoption.state === 'SUCCESS' ? 'PERSISTED_ORIGINAL_ADOPTION' : 'ORIGINAL_ADOPTION_NOT_COMPLETED',
          historical_failure_preserved: 'r6-browser-1792875916123-ef5f14',
          retained_failed_adoption: completed?.retained_failed_adoption ?? null };
      });
    }
    if (args.readonlyAdoption) {
      return c.test('E-I03-failed-adoption-child-parent-readback', async () => {
        adoption = run.adoptions.find(row => row.adoption_id === args.readonlyAdoption.object_id);
        assert(adoption, '原分析必须包含原失败采纳，不另造采纳');
        assert.equal(adoption.state, 'FAILED'); assert.equal(adoption.planning_job_id, 'tsk-d447a171c25d');
        assert.equal(adoption.error, '桥回报与持久化作业状态不一致');
        const drawer = c.drawer('抗干扰措施与预评估');
        await c.enabled(button(drawer, '采纳措施并提交规划重算'), false);
        const details = await openAdoptionDetails(drawer, 'E-I03-failed-adoption-detail');
        const childJob = await c.http('GET', `/plan/tasks/${enc(adoption.planning_job_id)}`,
          () => button(drawer, '查看规划作业').click());
        assert.equal(childJob.job_id, adoption.planning_job_id); assert.equal(childJob.task_id, taskId);
        assert.equal(childJob.parent_plan_id, planId); assert.equal(childJob.status, adoption.planning_state);
        const parent = await c.openPlan(planId);
        assert.equal(parent.current, true); assert.equal(parent.state, 'CONFIRMED');
        assert.deepEqual(parent.result, plan.result);
        assert.equal(c.writes.length, 0, '失败原号回读不得重试分析/采纳/保存/确认');
        return { adoption: details.adoption, details, original_child_job: childJob, parent,
          parent_unchanged: true, business_writes: 0, acceptance: 'FAILED_ADOPTION_RETAINED' };
      });
    }
    if (fresh) await c.test('E-I03-new-adoption-intent', async () => {
      assert.equal(c.writes.length, 1); assert.equal(c.writes[0].path, PREFIX + WB + '/runs');
      const drawer = c.drawer('抗干扰措施与预评估');
      await c.enabled(button(drawer, '采纳措施并提交规划重算'));
      return { intent: 'ONE_NEW_ADOPTION_FOR_NEW_ANALYSIS', retained_failure: fresh, analysis_receipt: analysisReceipt,
        runId: run.run_id, sourceHash: run.source_hash, measureId: measure.measure_id, measureType: measure.type,
        change_set: measure.change_set, parentPlanId: planId, sceneVersionId: scene.version.version_id,
        allowed_adoption_posts: 1, confirm_allowed: false, next: 'E-I03-adopt-checkpoint' };
    });
    await c.test('E-I03-adopt-checkpoint', async () => {
      const drawer = c.drawer('抗干扰措施与预评估'); adoptionSince = c.responses.length;
      adoptionReceipt = await c.http('POST', WB + '/adoptions', () => button(drawer, '采纳措施并提交规划重算').click());
      c.anchors.adoptionRequestId = adoptionReceipt.request_id; c.anchors.adoptionId = adoptionReceipt.object_id;
      if (fresh) {
        assert.notEqual(adoptionReceipt.object_id, fresh.adoption.adoption_id);
        assert.notEqual(adoptionReceipt.request_id, '58187ea0-f0dc-4cfd-b3bc-3ccd9f7926a9');
        assert.notEqual(adoptionReceipt.planning_request_id, fresh.adoption.planning_request_id);
      }
      assert.equal(c.writes.filter(row => row.path === PREFIX + WB + '/adoptions').length, 1);
      return { receipt: adoptionReceipt, adoption_requests: 1, next: 'E-I03-adopt-real-child-original-receipt' };
    });
    await c.test('E-I03-adopt-real-child-original-receipt', async () => {
      const drawer = c.drawer('抗干扰措施与预评估');
      adoption = await c.observed(WB + `/adoptions/${enc(adoptionReceipt.object_id)}`, value => ['SUCCESS', 'FAILED', 'CANCELLED'].includes(value.state), adoptionSince);
      c.anchors.childJobId = adoption.planning_job_id; c.anchors.childPlanId = adoption.result_plan_id;
      c.anchors.adoptionState = adoption.state; c.anchors.adoptionError = adoption.error;
      assert.equal(adoption.task_id, taskId); assert.equal(adoption.run_id, run.run_id);
      assert.equal(adoption.measure_id, measure.measure_id); assert.equal(adoption.source_hash, run.source_hash);
      assert(adoption.planning_request_id && adoption.planning_job_id, '采纳必须产生真实子规划原号');
      assert.equal(adoption.state, 'SUCCESS', `保留真实采纳失败：${JSON.stringify({ state: adoption.state,
        error: adoption.error, adoption_id: adoption.adoption_id, job_id: adoption.planning_job_id,
        planning_state: adoption.planning_state, plan_id: adoption.result_plan_id, plan_state: adoption.result_plan_state })}`);
      assert(adoption.result_plan_id); assert(['SAVED', 'REFERENCE'].includes(adoption.result_plan_state));
      assert.notEqual(adoption.result_plan_id, planId);
      await c.shown(button(drawer, '打开重算方案'));
      const details = await openAdoptionDetails(drawer, 'E-I03-adoption-detail');
      await c.enabled(button(drawer, '采纳措施并提交规划重算'), false);
      childJob = await c.http('GET', `/plan/tasks/${enc(adoption.planning_job_id)}`, () => button(drawer, '查看规划作业').click());
      assert.equal(childJob.job_id, adoption.planning_job_id); assert.equal(childJob.parent_plan_id, planId);
      assert.equal(childJob.task_id, taskId); assert.equal(childJob.status, 'SUCCESS');
      if (fresh) {
        assert.notEqual(childJob.job_id, fresh.adoption.planning_job_id);
        assert.equal(childJob.saved_plan_id, adoption.result_plan_id);
        assert.equal(childJob.resource_revision, RECOVERY.resourceRevision);
      }
      // Request ID is exposed in adoption detail; job GET does not promise to echo request_id.
      return { receipt: adoptionReceipt, adoption: details.adoption, details, child_job: childJob,
        request_id_verification: 'REAL_ADOPTION_DETAIL_UI_AND_GET', repeated_adoption_posts: 0 };
    });
    return c.test('E-I04-child-and-parent-readback', async () => {
      const child = await c.openPlan(adoption.result_plan_id);
      assert.equal(child.parent_plan_id, planId); assert.equal(child.job_id, adoption.planning_job_id);
      assert.equal(child.state, adoption.result_plan_state); assert.equal(child.current, false);
      if (child.state === 'REFERENCE') await c.referenceDisabled(child);
      let referenceEvidence = null;
      if (fresh) {
        assert.equal(child.input_version, plan.input_version); assert.equal(child.condition_version, plan.condition_version);
        assert.equal(child.resource_revision, plan.resource_revision); assert.deepEqual(child.input, plan.input);
        assert.equal(child.source_changed, false);
        assert.deepEqual(child.result, childJob.result); assert.deepEqual(child.outcome, childJob.outcome);
        c.anchors.childPlanState = child.state; c.anchors.outcome = child.outcome;
        if (child.state === 'REFERENCE') {
          assert.equal(child.outcome.code, 3001); assert(child.outcome.gap.length, '真实REFERENCE必须保留硬约束gap');
          await button(page, '2 · 规划计算与结果').click();
          const outcome = page.getByRole('status', { name: '当前方案服务结论', exact: true });
          await c.text(outcome, child.outcome.message);
          for (const gap of child.outcome.gap) {
            assert(gap.message); await c.shown(outcome.locator('p').filter({ hasText: gap.message }).first());
          }
          referenceEvidence = { code: child.outcome.code, gap: child.outcome.gap, visible_text: await outcome.innerText(),
            screenshot: await c.shot('E-I04-reference-gap'), confirm_disabled: true };
        } else {
          assert.equal(child.state, 'SAVED'); assert.equal(child.outcome.code, 0);
          assert.equal(child.outcome.gap.length, 0); assert(child.result.checks.every(check => check.passed === true));
        }
      }
      const parent = await c.openPlan(planId);
      assert.equal(parent.current, true); assert.equal(parent.state, 'CONFIRMED');
      assert.deepEqual(parent.result, plan.result);
      // Reopen the persisted analysis and click the same detail command again, without adopting again.
      await c.http('GET', WB, () => button(page, '进入干扰分析').click(),
        response => new URL(response.url()).searchParams.get('task_id') === taskId);
      panel = page.getByRole('region', { name: '干扰分析', exact: true }); await c.shown(panel);
      await c.http('GET', WB + '/runs', () => panel.getByRole('button').filter({ hasText: /^\s*历史 \d+\s*$/ }).click());
      const history = c.drawer('干扰分析历史');
      await history.getByLabel('搜索运行或方案编号', { exact: true }).fill(run.run_id);
      const list = await c.http('GET', WB + '/runs', () => iconButton(history, '查询历史').click());
      assert.equal(list.items.length, 1); assert.equal(list.items[0].run_id, run.run_id);
      const historyRow = history.locator('button.history-row').filter({ hasText: run.run_id });
      await c.shown(historyRow); assert.equal(await historyRow.count(), 1);
      const reopened = await c.http('GET', WB + `/runs/${enc(run.run_id)}`,
        () => historyRow.click());
      assert.equal(reopened.plan_id, planId); assert.equal(reopened.source_hash, adoption.source_hash);
      assert(reopened.adoptions.some(row => row.adoption_id === adoption.adoption_id), '历史必须保留原采纳');
      await history.waitFor({ state: 'hidden' });
      const control = panel.locator(`.measure-row[data-measure-id=${JSON.stringify(measure.measure_id)}]`);
      await c.shown(control);
      assert.equal(await control.count(), 1);
      await c.http('GET', WB + `/runs/${enc(run.run_id)}/measures/${enc(measure.measure_id)}/preview`,
        () => control.getByRole('button').filter({ has: page.locator('strong') }).click());
      const drawer = c.drawer('抗干扰措施与预评估');
      await c.enabled(button(drawer, '采纳措施并提交规划重算'), false);
      const details = await openAdoptionDetails(drawer, 'E-I04-adoption-detail-reopened');
      await c.closeDrawer(drawer);
      if (fresh) {
        assert.equal(c.writes.length, 2, '新案只允许一分析一采纳，禁止另存场景/方案、确认或重提');
        assert.deepEqual(c.writes.map(row => row.path), [PREFIX + WB + '/runs', PREFIX + WB + '/adoptions']);
      }
      return { taskId, planId, adoption: details.adoption, child, details, reference_evidence: referenceEvidence,
        retained_failure: fresh ?? null, confirmed: false, parent_unchanged: true };
    });
  });
}

export default runPlanning;
