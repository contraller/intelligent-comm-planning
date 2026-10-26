import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dismissBeforeUnload } from './r6_browser_leave.mjs';

// Imported by the main harness only. No browser, server, credentials or CLI entry here.
const API = '/api/v1';
const FAULT = `${API}/fault/workbench`;
const KG = `${API}/kg/workbench`;
// Match DOM text; PrimeIcons pseudo-elements can contribute to accessible names.
const button = (scope, text) => {
  const pattern = text.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return scope.getByRole('button').filter({ hasText: new RegExp(`^\\s*${pattern}\\s*$`) });
};
const label = (scope, name) => scope.getByLabel(name, { exact: true });
// Native select option text participates in its wrapping label; scope the control explicitly.
const nativeSelect = (scope, name) => scope.locator('label').filter({
  hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
}).locator(':scope > select');
const digest = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value;
}
const snapshotHash = version => digest(stable({ entities: version.entities, relations: version.relations }));

function assertOrigin(value, expected) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'Only the isolated HTTP test origin is allowed');
  assert.equal(url.hostname, '127.0.0.24', 'Refusing to operate outside the .24 isolation');
  if (expected) assert.equal(url.origin, expected, 'Browser/API origin changed');
  return url.origin;
}

async function context(input) {
  for (const key of ['login', 'record', 'download', 'shot']) assert.equal(typeof input[key], 'function', `Missing harness ${key}`);
  assert.ok(input.page && input.taskId && input.planId, 'A real Page and this run taskId/planId are required');
  const config = typeof input.runtime === 'string' ? { dir: input.runtime } : input.runtime;
  assert.ok(config && typeof config.dir === 'string', 'runtime must be an absolute F: directory or {dir, origin?, timeoutMs?, jobTimeoutMs?}');
  assert.match(config.dir, /^F:[\\/]/i, 'Evidence/checkpoints must stay on F:');
  const dir = path.resolve(config.dir);
  let candidateOrigin = config.origin;
  if (!candidateOrigin && input.page.url() === 'about:blank') {
    // The harness passes its runtime root before login. Only read its public manifest.
    const manifest = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    candidateOrigin = manifest.frontend;
  }
  const origin = assertOrigin(candidateOrigin ?? input.page.url());
  if (input.page.url() !== 'about:blank') assertOrigin(input.page.url(), origin);
  const file = path.join(dir, 'r6-browser-sr56-state.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!state) state = { schema: 1, origin, taskId: input.taskId, planId: input.planId, tag: `R6-SR56-${randomUUID()}`, operations: {}, checks: {} };
  assert.equal(state.schema, 1);
  assert.equal(state.origin, origin);
  assert.equal(state.taskId, input.taskId, 'Checkpoint belongs to another task; use its original runtime');
  assert.equal(state.planId, input.planId, 'Checkpoint belongs to another plan; do not overwrite it');
  await mkdir(dir, { recursive: true });
  const ctx = { ...input, config, origin, file, state, timeout: config.timeoutMs ?? 60_000, jobTimeout: config.jobTimeoutMs ?? 600_000 };
  // Serialize checkpoint writes, including the automatic impact-response observer.
  let writing = Promise.resolve();
  ctx.save = () => {
    const bytes = JSON.stringify(state, null, 2) + '\n';
    writing = writing.then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, file);
    });
    return writing;
  };
  await ctx.save();
  return ctx;
}

function matches(ctx, response, endpoint, method = 'GET', query = {}) {
  const url = new URL(response.url());
  return url.origin === ctx.origin && url.pathname === endpoint && response.request().method() === method
    && Object.entries(query).every(([key, value]) => url.searchParams.get(key) === String(value));
}

async function responseData(ctx, response) {
  assertOrigin(response.url(), ctx.origin);
  assert.equal(response.ok(), true, `${response.status()} ${new URL(response.url()).pathname}`);
  const raw = await response.json();
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'data') && Object.hasOwn(raw, 'code')) {
    assert.equal(raw.code, 0, `Business response rejected: ${raw.code} ${raw.message}`);
    return raw.data;
  }
  return raw;
}

async function uiRead(ctx, endpoint, action, query = {}, method = 'GET') {
  assertOrigin(ctx.page.url(), ctx.origin);
  const waiting = ctx.page.waitForResponse(response => matches(ctx, response, endpoint, method, query), { timeout: ctx.timeout });
  const [response] = await Promise.all([waiting, action()]);
  return { data: await responseData(ctx, response), response };
}

async function drawer(ctx, title) {
  const result = ctx.page.locator('.p-drawer:visible').filter({ has: ctx.page.getByText(title, { exact: true }) });
  await result.waitFor({ state: 'visible', timeout: ctx.timeout });
  assert.equal(await result.count(), 1, `Drawer is not unique: ${title}`);
  return result;
}

async function confirm(ctx, title, action) {
  const dialog = ctx.page.getByRole('dialog', { name: title, exact: true });
  await dialog.waitFor({ state: 'visible', timeout: ctx.timeout });
  await button(dialog, action).click();
}

async function loginAs(ctx, role) {
  if (ctx.page.url() !== 'about:blank') assertOrigin(ctx.page.url(), ctx.origin);
  await ctx.login(role);
  assertOrigin(ctx.page.url(), ctx.origin);
}

async function route(ctx, routePath, endpoint, query = {}) {
  const marker=randomUUID();
  const currentDocument=response=>{
    const referer=response.request().headers().referer;
    return !!referer&&new URL(referer).searchParams.get('r6sr56')===marker;
  };
  const read=(path,parameters={})=>ctx.page.waitForResponse(response=>matches(ctx,response,path,'GET',parameters)&&currentDocument(response),{timeout:ctx.timeout})
    .then(response=>responseData(ctx,response));
  const [identity,business] = await Promise.all([
    read(`${API}/auth/session`),
    read(endpoint,query),
    ctx.page.goto(`${ctx.origin}/?r6sr56=${marker}#${routePath}`,{waitUntil:'domcontentloaded',timeout:ctx.timeout}),
  ]);
  assert.ok(identity.account_id && Array.isArray(identity.permissions));
  assert.notEqual(identity.integration_mode, true, 'LOCAL account login is required');
  // Do not persist session identifiers, credentials, cookies or authorization headers.
  ctx.actor = { accountId: identity.account_id, roleId: identity.role_id, permissions: identity.permissions };
  return business;
}

function publicState(ctx) {
  const { scenarioId, versionId, runId, changeId, baseVersionId, publishedVersionId, rolledBackVersionId } = ctx.state;
  return { origin: ctx.origin, taskId: ctx.taskId, planId: ctx.planId, scenarioId, versionId, runId, changeId,
    baseVersionId, publishedVersionId, rolledBackVersionId, checkpoint: ctx.file };
}

async function finish(ctx, id, evidence) {
  await ctx.save();
  const screenshot = await ctx.shot(id);
  console.log(JSON.stringify({stage:id,...publicState(ctx)}));
  return { ...evidence, state: publicState(ctx), screenshot };
}

function requestIdentity(payload) {
  return { requestId: payload.requestId, actorId: payload.actorId, baseRevision: payload.baseRevision,
    scenarioId: payload.scenarioId, scenarioVersionId: payload.scenarioVersionId, runId: payload.runId,
    changeId: payload.changeId, versionId: payload.versionId, revision: payload.revision,
    submission: payload.submission, planId: payload.draft?.planId };
}

function checkpointReceipt(ctx, key, receipt) {
  const s = ctx.state;
  if (key === 'scenario-save') [s.scenarioId, s.versionId] = receipt.entityIds;
  if (key === 'diagnosis-submit') s.runId = receipt.objectId;
  if (key === 'feedback') s.changeId = receipt.entityIds?.[1];
  if (key === 'publish') s.publishedVersionId = receipt.currentVersionId;
  if (key === 'rollback') s.rolledBackVersionId = receipt.currentVersionId;
}

// Once a write is armed, retry must reconcile it rather than clicking Submit again.
async function mutate(ctx, key, endpoint, action, checkRequest) {
  const known = ctx.state.operations[key];
  if (known?.phase === 'accepted') {
    checkpointReceipt(ctx, key, known.receipt);
    return { receipt: known.receipt, request: known.request, reused: true };
  }
  assert.ok(!known, `${key} is ${known?.phase}; inspect the retained UI/request ID and use caseSr56Readback. No automatic resubmission.`);
  const operation = { phase: 'armed', endpoint, armedAt: new Date().toISOString() };
  ctx.state.operations[key] = operation;
  await ctx.save();
  const capture = request => {
    if (request.method() !== 'POST' || new URL(request.url()).origin !== ctx.origin || new URL(request.url()).pathname !== endpoint) return;
    try { operation.request = requestIdentity(request.postDataJSON()); }
    catch { operation.requestParseFailed = true; }
  };
  ctx.page.on('request', capture);
  try {
    const { data: receipt, response } = await uiRead(ctx, endpoint, action, {}, 'POST');
    const payload = response.request().postDataJSON();
    operation.request = requestIdentity(payload);
    operation.receipt = receipt;
    operation.phase = 'observed';
    checkpointReceipt(ctx, key, receipt);
    await ctx.save();
    checkRequest(payload);
    assert.ok(receipt.objectId && receipt.revision, `${key} receipt has no business identity`);
    operation.phase = 'accepted';
    await ctx.save();
    return { receipt, request: operation.request, reused: false };
  } catch (error) {
    operation.phase = operation.phase === 'observed' ? 'observed-needs-review' : 'uncertain';
    operation.error = error.message;
    await ctx.save();
    throw error;
  } finally { ctx.page.off('request', capture); }
}

function assertNetwork(ctx, network) {
  assert.equal(network.id, ctx.planId);
  assert.equal(network.taskId, ctx.taskId);
  assert.equal(network.state, 'CONFIRMED');
  assert.equal(network.sourceChanged, false);
  assert.ok(network.snapshotId && network.inputSnapshot);
}

async function diagnosisReady(ctx) {
  const control=button(ctx.page,'重新加载');
  await control.waitFor({state:'visible',timeout:ctx.timeout});
  const deadline=Date.now()+ctx.timeout;
  while(!await control.isEnabled()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await control.isEnabled(),true,'Wait for the real diagnosis workspace to finish loading before selecting an ID');
}

async function openScenario(ctx) {
  assert.ok(ctx.state.scenarioId && ctx.state.versionId, 'No saved scenario checkpoint');
  const query = { scenarioId: ctx.state.scenarioId, versionId: ctx.state.versionId };
  const value=await route(ctx,`/diagnosis?${new URLSearchParams(query)}`,`${FAULT}/version`,query);
  await diagnosisReady(ctx);
  assert.equal(value.id, ctx.state.versionId);
  assert.equal(value.scenarioId, ctx.state.scenarioId);
  assert.equal(value.planId, ctx.planId);
  assertNetwork(ctx, value.network);
  return value;
}

async function openRun(ctx) {
  assert.ok(ctx.state.runId && ctx.state.scenarioName, 'No diagnosis run checkpoint');
  await route(ctx, '/diagnosis', FAULT);
  await diagnosisReady(ctx);
  const history = ctx.page.locator('button.history-card').filter({ has: ctx.page.getByText(ctx.state.scenarioName, { exact: true }) });
  await history.waitFor({ state: 'visible', timeout: ctx.timeout });
  assert.equal(await history.count(), 1, 'Select original run explicitly; refusing ambiguous history names');
  const value = (await uiRead(ctx, `${FAULT}/runs/${encodeURIComponent(ctx.state.runId)}/detail`, () => history.click())).data;
  assert.equal(value.run.id, ctx.state.runId);
  assert.equal(value.run.scenario.id, ctx.state.versionId);
  assertNetwork(ctx, value.run.scenario.network);
  return value;
}

async function openChange(ctx, expectedState) {
  await route(ctx, '/knowledge', KG);
  const catalog = (await uiRead(ctx, `${KG}/history/changes`, () => button(ctx.page, '知识维护').click())).data;
  const summary = catalog.items.find(item => item.id === ctx.state.changeId);
  assert.ok(summary, `Original change ${ctx.state.changeId} is not on this page; main must select its history page, not create another draft`);
  const row = ctx.page.getByRole('row').filter({ has: ctx.page.getByText(summary.summary, { exact: true }) });
  const data = (await uiRead(ctx, `${KG}/detail/change/${encodeURIComponent(summary.id)}`, () => button(row, '查看 / 处理').click())).data;
  assert.equal(data.id, ctx.state.changeId);
  if (expectedState) assert.equal(data.state, expectedState);
  return { data, scope: await drawer(ctx, `知识变更 · ${data.id}`) };
}

async function rereadChange(ctx, expectedState) {
  const scope = await drawer(ctx, `知识变更 · ${ctx.state.changeId}`);
  await button(scope, '关闭').click();
  return openChange(ctx, expectedState);
}

async function openVersion(ctx, id) {
  await route(ctx, '/knowledge', KG);
  const list = (await uiRead(ctx, `${KG}/history/versions`, () => button(ctx.page, '版本记录').click())).data;
  const version = list.items.find(item => item.id === id);
  assert.ok(version, `Version ${id} is not on this page; select the original history page instead of rerunning a write`);
  const row = ctx.page.getByRole('row').filter({ has: ctx.page.getByText(`v${version.number}`, { exact: true }) });
  const data = (await uiRead(ctx, `${KG}/detail/version/${encodeURIComponent(id)}`, () => button(row, '快照与差异').click())).data;
  assert.equal(data.id, id);
  return { data, scope: await drawer(ctx, `知识版本 v${data.number}`) };
}

export async function caseSr5Scenario(input) {
  return input.record('R6-SR5-scenario-valid-invalid-save', async () => {
    const ctx = await context(input), s = ctx.state;
    const retainedGisDraft=s.scenarioDraftStarted&&ctx.page.url().includes('/situation');
    if (!retainedGisDraft || s.versionId) await loginAs(ctx, 'editor');
    if (s.versionId) return finish(ctx, 'sr5-scenario-readback', { savedVersion: await openScenario(ctx), reusedOriginalId: true });
    assert.ok(!s.operations['scenario-save'],'A saved/uncertain operation exists; reconcile its original ID instead of recreating a draft');
    if (!retainedGisDraft) {
      const metadata = await route(ctx, '/diagnosis', FAULT);
      assert.equal(metadata.dataOrigin, 'SAMPLE');
      assert.equal(metadata.capabilities?.twoStep, true);
      assert.equal(metadata.capabilities?.demoControls, false);
      assert.ok(metadata.sources.plans.some(plan => plan.id === ctx.planId && plan.taskId === ctx.taskId && plan.canCreate));
      await button(ctx.page, '新建场景').click();
      const source = await drawer(ctx, '新建故障场景');
      await label(source, '新场景绑定网络').selectOption(ctx.planId);
      const network = (await uiRead(ctx, `${FAULT}/sources`, () => button(source, '创建场景草稿').click(), { planId: ctx.planId })).data;
      assertNetwork(ctx, network);
      const device = network.inputSnapshot.devices[0];
      assert.ok(device && metadata.symptoms.length, 'Need an actual frozen device and symptom, not an invented ID');
      s.faultObjectKey ??= ctx.config.faultObjectKey ?? `DEVICE:${device.id}`;
      s.symptom ??= metadata.symptoms.find(item => item.id === ctx.config.symptomId) ?? metadata.symptoms[0];
      assert.ok(metadata.symptoms.some(item=>item.id===s.symptom.id&&item.label===s.symptom.label),'Original symptom changed; stop rather than substitute another one');
      s.scenarioName ??= `${s.tag} 构造故障场景`;
      s.scenarioDraftStarted = true;
      await ctx.save();
      await button(ctx.page, '在 GIS 标绘').click();
      await ctx.page.waitForURL(url => url.hash.includes('/situation') && url.hash.includes('faultEdit=1'), { timeout: ctx.timeout });
    } else {
      assert.ok(ctx.page.url().includes('/situation'), 'Unsaved scenario exists; restore its retained GIS page before retrying this case');
    }
    let config = ctx.page.locator('.p-drawer:visible').filter({ has: ctx.page.getByText('故障场景配置', { exact: true }) });
    if (!await config.isVisible()) await button(ctx.page, '配置场景参数').click();
    config = await drawer(ctx, '故障场景配置');
    if (!await nativeSelect(config, '故障对象').count()) await button(config, '添加故障对象').click();
    assert.equal(await nativeSelect(config, '故障对象').count(), 1, 'This minimal case must contain exactly one fault');
    await nativeSelect(config, '故障对象').selectOption(s.faultObjectKey);
    await label(config, '故障 1 类型：硬件故障').check();
    const phenomena = config.locator('details').filter({ has: ctx.page.locator('summary').filter({ hasText: /^现象（/ }) });
    if (await phenomena.getAttribute('open') === null) await phenomena.locator('summary').click();
    await label(phenomena, s.symptom.label).check();
    await label(config, '场景名称').fill('');
    const [invalidResponse]=await Promise.all([
      ctx.page.waitForResponse(response=>matches(ctx,response,`${FAULT}/validate`,'POST'),{timeout:ctx.timeout}),
      button(config,'应用到场景草稿').click(),
    ]);
    assert.equal(invalidResponse.status(),422,'Empty name must receive the real schema-validation rejection');
    const invalidBody=await invalidResponse.json();
    assert.equal(invalidBody.code,1001);
    const invalid={response:invalidResponse,data:invalidBody.data};
    assert.ok(Array.isArray(invalid.data) && invalid.data.some(issue => issue.field === 'name'), 'Empty scene name must be rejected');
    assert.ok(invalid.data.every(issue=>issue.field==='name'),'Unexpected invalid fields must not be counted as the empty-name case');
    assert.equal(invalid.response.request().postDataJSON().planId, ctx.planId);
    assert.equal(invalid.response.request().postDataJSON().name,'');
    s.checks.invalidScenario = { field: 'name', issues: invalid.data, status:invalidResponse.status(),code:invalidBody.code };
    await ctx.shot('sr5-invalid-empty-scene-name');
    await label(config, '场景名称').fill(s.scenarioName);
    await label(config, '备注').fill('R6显式构造资料，非实测；不包含外部协议或ML验收。');
    const valid = await uiRead(ctx, `${FAULT}/validate`, () => button(config, '应用到场景草稿').click(), {}, 'POST');
    assert.deepEqual(valid.data, []);
    await config.waitFor({ state: 'hidden', timeout: ctx.timeout });
    const saved = await mutate(ctx, 'scenario-save', `${FAULT}/actions/save`, () => button(ctx.page, '保存场景').click(), request => {
      assert.equal(request.draft.planId, ctx.planId);
      assert.equal(request.draft.name, s.scenarioName);
      assert.equal(request.draft.faults.length, 1);
      assert.ok(request.draft.faults[0].symptomIds.includes(s.symptom.id));
    });
    assert.ok(s.scenarioId && s.versionId);
    await button(ctx.page, '去诊断').click();
    const frozen = await openScenario(ctx);
    return finish(ctx, 'sr5-saved-scene', { invalid: s.checks.invalidScenario, save: saved, frozen });
  });
}

export async function caseSr5DiagnosisImpact(input) {
  return input.record('R6-SR5-diagnosis-independent-impact', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'editor');
    let observerError;
    const observed = [];
    const capture = response => {
      if (!matches(ctx, response, `${FAULT}/actions/impact`, 'POST')) return;
      observed.push((async () => {
        const request = response.request().postDataJSON();
        if (request.runId !== s.runId) return;
        const receipt = await responseData(ctx, response);
        assert.equal(request.runId, s.runId);
        s.impactWrite = { request: requestIdentity(request), receipt, status: response.status() };
        await ctx.save();
      })().catch(error => { observerError = error; }));
    };
    ctx.page.on('response', capture);
    try {
      if (s.runId) await openRun(ctx);
      else {
        await openScenario(ctx);
        await mutate(ctx, 'diagnosis-submit', `${FAULT}/actions/submit`, () => button(ctx.page, '开始诊断').click(), request => {
          assert.equal(request.scenarioVersionId, s.versionId);
          assert.equal(request.demo, undefined, 'No preset failure or ML demonstration branch');
        });
      }
      const progress = ctx.page.locator('.progress-panel .title').getByText(/^(已完成|执行失败|已取消) · /);
      await progress.waitFor({ state: 'visible', timeout: ctx.jobTimeout });
      await Promise.all(observed);
      if (observerError) throw observerError;
      const detail = await openRun(ctx);
      assert.equal(detail.state, 'SUCCESS');
      assert.equal(detail.diagnosisReady, true);
      assert.equal(detail.impactReady, true);
      assert.equal(detail.dataOrigin, 'SAMPLE');
      assert.ok(detail.run.diagnoseTaskId && detail.run.impactTaskId);
      assert.notEqual(detail.run.diagnoseTaskId, detail.run.impactTaskId);
      assert.ok(s.impactWrite, 'Automatic impact POST was not observed. Keep original run and report this branch unverified, do not resubmit diagnosis.');
      assert.equal(s.impactWrite.request.runId, s.runId);
      s.diagnoseTaskId = detail.run.diagnoseTaskId;
      s.impactTaskId = detail.run.impactTaskId;
      await button(ctx.page, '影响').click();
      return finish(ctx, 'sr5-impact-complete', { runId: s.runId, diagnoseTaskId: s.diagnoseTaskId, impactTaskId: s.impactTaskId,
        automaticImpact: s.impactWrite, frozenPlan: detail.run.scenario.network.id, dataOrigin: detail.dataOrigin });
    } finally { ctx.page.off('response', capture); await Promise.all(observed); }
  });
}

async function reportReadback(ctx) {
  const waiting = ctx.page.waitForResponse(response => matches(ctx, response, `${FAULT}/runs/${encodeURIComponent(ctx.state.runId)}/report`), { timeout: ctx.timeout });
  const [, response] = await Promise.all([openRun(ctx), waiting]);
  const report = await responseData(ctx, response);
  assert.equal(report.id, ctx.state.runId);
  assert.equal(report.scenarioId, ctx.state.scenarioId);
  assert.equal(report.scenarioVersion, ctx.state.versionId);
  assert.equal(report.dataOrigin, 'SAMPLE');
  assertNetwork(ctx, report.network);
  return report;
}

async function exported(ctx, kind, format, control) {
  let business;
  const file = await ctx.download(async () => {
    const waiting = ctx.page.waitForResponse(response => matches(ctx, response, `${FAULT}/export/${encodeURIComponent(ctx.state.runId)}`, 'GET', { kind, format }), { timeout: ctx.timeout });
    const [response] = await Promise.all([waiting, control.click()]);
    assert.equal(response.ok(), true);
    const bytes = await response.body();
    assert.ok(bytes.length, 'Empty download response');
    if (format === 'pdf') assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    if (format === 'docx' || format === 'xlsx') assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    if (format === 'png') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    if (format === 'json') assert.equal(JSON.parse(bytes.toString('utf8')).id, ctx.state.runId);
    business = { path: new URL(response.url()).pathname, kind, format, bytes: bytes.length, sha256: digest(bytes) };
  }, `sr5-${ctx.state.runId}-${kind}-${format}`);
  assert.ok(file, 'download helper must return the saved F: file summary');
  return { file, business };
}

async function feedbackLeaveBeforeSubmit(ctx, feedback) {
  return ctx.record('R6-B2-feedback-reload-close-continue', async () => {
    const names = ['诊断结论', '人工确认故障类型', '根因', '故障部件', '处置方案', '诊断步骤'];
    const field = name => ['诊断结论', '人工确认故障类型'].includes(name) ? nativeSelect(feedback, name) : label(feedback, name);
    const values = async () => Object.fromEntries(await Promise.all(names.map(async name => [name, await field(name).inputValue()])));
    const before = await values(), operation = stable(ctx.state.operations.feedback ?? null), runId = ctx.state.runId;
    const writes = [];
    const capture = request => {
      if (request.method() === 'POST' && new URL(request.url()).origin === ctx.origin
        && new URL(request.url()).pathname === `${FAULT}/actions/feedback`) writes.push(new URL(request.url()).pathname);
    };
    ctx.page.on('request', capture);
    try {
      await label(feedback, '处置方案').click();
      const native = await dismissBeforeUnload({ page: ctx.page, timeoutMs: ctx.timeout });
      await feedback.waitFor({ state: 'visible', timeout: ctx.timeout });
      assert.deepEqual(await values(), before, 'Native reload dismissal lost feedback input');
      const nativeScreenshot = await ctx.shot('sr5-feedback-beforeunload-dismiss');
      await button(feedback, '关闭').click();
      const decision = ctx.page.getByRole('dialog', { name: '未提交的诊断知识反馈', exact: true });
      await decision.waitFor({ state: 'visible', timeout: ctx.timeout });
      await button(decision, '继续填写').click();
      await decision.waitFor({ state: 'hidden', timeout: ctx.timeout });
      await feedback.waitFor({ state: 'visible', timeout: ctx.timeout });
      assert.deepEqual(await values(), before, 'Continue must keep the original feedback fields');
      assert.equal(ctx.state.runId, runId);
      assert.equal(stable(ctx.state.operations.feedback ?? null), operation, 'Do not replace or re-arm the original feedback operation');
      assert.deepEqual(writes, [], 'No feedback POST is allowed during leave-protection checks');
      const evidence = { runId, native, nativeScreenshot, closeAction: '继续填写', fields: before,
        valuesRetained: true, feedbackRequests: 0, originalOperationUnchanged: true };
      ctx.state.checks.feedbackLeave = evidence;
      await ctx.save();
      return evidence;
    } finally { ctx.page.off('request', capture); }
  });
}

// Read-only report patch acceptance after the original CR was reviewed/published.
// Deliberately independent from the feedback/DRAFT workflow below.
function reportFieldDiff(before, after, pointer = '') {
  if (stable(before) === stable(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length)
    return before.flatMap((value, index) => reportFieldDiff(value, after[index], `${pointer}/${index}`));
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key =>
      reportFieldDiff(before[key], after[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: pointer || '/', before: before === undefined ? { missing: true } : before,
    after: after === undefined ? { missing: true } : after }];
}

async function preservedReportComparison(ctx, baseline, actual, stage) {
  assert.equal(typeof ctx.evidence, 'string', 'Main evidence directory is required to retain complete GET JSON');
  const relative = path.relative(path.join(ctx.config.dir, 'browser'), ctx.evidence);
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Keep report evidence under the original runtime/browser');
  const rawFile = path.join(ctx.evidence, `sr5-report-get-${stage}.json`);
  const diffFile = path.join(ctx.evidence, `sr5-report-diff-${stage}.json`);
  // Save the complete business GET object and field diff before any mismatch can throw.
  await writeFile(rawFile, JSON.stringify(actual, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  const differences = reportFieldDiff(baseline, actual);
  const currentCanonicalHash = digest(stable(actual)), originalCanonicalHash = digest(stable(baseline));
  // Exclude ONLY the root status object. All nested network/result/source fields remain.
  const frozen = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'source'));
  const frozenHash = digest(stable(frozen(actual))), originalFrozenHash = digest(stable(frozen(baseline)));
  const expectedSource = { state: 'HISTORICAL', reasons: ['所选方案不是任务的当前确认方案'] };
  const reconstructedHash = digest(stable({ ...baseline, source: expectedSource }));
  const comparison = { rawFile, diffFile, differences, originalCanonicalHash, currentCanonicalHash,
    originalFrozenHash, frozenHash, reconstructedHash, normalization: 'ROOT_SOURCE_STATUS_ONLY' };
  await writeFile(diffFile, JSON.stringify(comparison, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  assert.equal(originalCanonicalHash, ctx.state.reportHash, 'Old downloaded JSON must match the preserved original baseline');
  assert.deepEqual(baseline.source, { state: 'CURRENT', reasons: [] });
  assert.deepEqual(actual.source, expectedSource, 'Only the known current-plan replacement is permitted');
  assert.equal(frozenHash, originalFrozenHash, 'Frozen report fields changed; inspect retained field diff and stop');
  assert.equal(currentCanonicalHash, reconstructedHash, 'Root-source-only reconstruction must match the entire actual GET');
  assert(differences.every(row => row.path.startsWith('/source/')), 'Do not normalize nested sources or other fields');
  return comparison;
}

export async function caseSr5ReportFilesReadback(input) {
  return input.record('R6-SR5-original-report-five-files-readonly', async () => {
    const dir = typeof input.runtime === 'string' ? input.runtime : input.runtime?.dir;
    assert.equal(typeof dir, 'string');
    const original = JSON.parse(await readFile(path.join(dir, 'r6-browser-sr56-state.json'), 'utf8'));
    assert.equal(original.runId, 'FR-3a67f1773487493aa949', 'Existing original checkpoint is required; never initialize a replacement');
    assert.match(original.reportHash ?? '', /^[a-f0-9]{64}$/);
    const ctx = await context(input), s = ctx.state;
    assert.equal(s.runId, 'FR-3a67f1773487493aa949', 'Only the original completed diagnosis run');
    assert.match(s.reportHash ?? '', /^[a-f0-9]{64}$/, 'The original canonical report hash must already exist');
    const reportHash = s.reportHash;
    const baseline = JSON.parse(await readFile(path.join(dir, 'browser', 'r6-browser-1792865551816-7fa87a',
      `sr5-${s.runId}-report-json.json`), 'utf8'));
    assert.equal(digest(stable(baseline)), reportHash, 'Keep the original downloaded report as immutable baseline');
    const identity = () => stable({ ...publicState(ctx), reportHash: s.reportHash, operations: s.operations });
    const before = identity(), writes = [];
    await loginAs(ctx, 'editor');
    const capture = request => {
      const url = new URL(request.url());
      if (url.origin === ctx.origin && url.pathname.startsWith(API + '/') && !url.pathname.startsWith(API + '/auth/')
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push({ path: url.pathname, method: request.method() });
    };
    ctx.page.on('request', capture);
    try {
      const report = await reportReadback(ctx);
      const beforeComparison = await preservedReportComparison(ctx, baseline, report, 'before');
      await button(ctx.page, '预览与下载完整报告').click();
      const preview = await drawer(ctx, '诊断报告预览');
      assert.ok((await preview.innerText()).includes(s.scenarioName));
      const files = [];
      for (const format of ['json', 'docx', 'pdf']) files.push(await exported(ctx, 'report', format, button(preview, `下载 ${format.toUpperCase()}`)));
      const close = preview.getByRole('button', { name: /^(Close|关闭)$/i });
      assert.equal(await close.count(), 1, 'Use the report header close control only'); await close.click();
      await button(ctx.page, '影响').click();
      files.push(await exported(ctx, 'impact', 'xlsx', button(ctx.page, '影响清单 XLSX')));
      files.push(await exported(ctx, 'impact', 'png', button(ctx.page, '示意图 PNG')));
      assert.equal(files.length, 5);
      const jsonFile = files.find(item => item.business.kind === 'report' && item.business.format === 'json');
      const exportedJson = JSON.parse(await readFile(jsonFile.file.file, 'utf8'));
      assert.equal(digest(stable(exportedJson)), beforeComparison.currentCanonicalHash, 'Downloaded JSON differs from the actual report GET');
      const reread = await reportReadback(ctx);
      const afterComparison = await preservedReportComparison(ctx, baseline, reread, 'after');
      assert.equal(afterComparison.currentCanonicalHash, beforeComparison.currentCanonicalHash, 'Report changed during exports');
      assert.equal(identity(), before, 'Do not change original run/feedback/knowledge/checkpoint operation identities');
      assert.deepEqual(writes, [], 'Report-only readback must not submit diagnosis, impact, feedback or knowledge writes');
      const evidence = { runId: s.runId, reportHash, files, businessWrites: 0, newDiagnosis: false,
        changeWorkflowOpened: false, reportReadBeforeAndAfter: true, beforeComparison, afterComparison };
      s.checks.reportFilesReadback = evidence;
      return finish(ctx, 'sr5-original-report-files-readonly', evidence);
    } finally { ctx.page.off('request', capture); }
  });
}

export async function caseSr5ReportFeedback(input) {
  return input.record('R6-SR5-report-files-knowledge-feedback', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'editor');
    const report = await reportReadback(ctx);
    const hash = digest(stable(report));
    if (s.reportHash) assert.equal(hash, s.reportHash, 'Original report changed');
    else { s.reportHash = hash; await ctx.save(); }
    await button(ctx.page, '预览与下载完整报告').click();
    const preview = await drawer(ctx, '诊断报告预览');
    assert.ok((await preview.innerText()).includes(s.scenarioName));
    const files = [];
    for (const format of ['json', 'docx', 'pdf']) files.push(await exported(ctx, 'report', format, button(preview, `下载 ${format.toUpperCase()}`)));
    const close = preview.getByRole('button', { name: /^(Close|关闭)$/i });
    assert.equal(await close.count(), 1, 'Use the report header close control only');
    await close.click();
    await button(ctx.page, '影响').click();
    files.push(await exported(ctx, 'impact', 'xlsx', button(ctx.page, '影响清单 XLSX')));
    files.push(await exported(ctx, 'impact', 'png', button(ctx.page, '示意图 PNG')));
    if (!s.changeId) {
      await button(ctx.page, '知识反馈').click();
      const feedback = await drawer(ctx, '诊断知识反馈');
      await label(feedback, '根因').fill(`${s.tag} 人工构造根因，仅验证工作流`);
      await label(feedback, '故障部件').fill('R6构造部件，未实测确认');
      await label(feedback, '处置方案').fill('构造处置：核对保存参数并由人工复核；未下发设备。');
      await label(feedback, '诊断步骤').fill('核对冻结来源\n复核故障现象\n保留人工确认记录');
      await feedbackLeaveBeforeSubmit(ctx, feedback);
      await mutate(ctx, 'feedback', `${FAULT}/actions/feedback`, () => button(feedback, '提交知识草稿').click(), request => {
        assert.equal(request.runId, s.runId);
        assert.ok(request.feedback.root_cause.includes(s.tag));
      });
      assert.ok(s.changeId, 'Feedback did not return its SR6 draft ID');
      await button(feedback, '关闭').click();
    }
    const { data } = await openChange(ctx, 'DRAFT');
    s.originalChangeSummary = data.content.summary;
    s.changeSummary = data.content.summary;
    s.authorId = data.authorId;
    s.baseVersionId = data.content.baseVersionId;
    await ctx.save();
    return finish(ctx, 'sr5-feedback-draft', { files, reportHash: s.reportHash, changeId: data.id, authorId: data.authorId,
      feedbackLeave: s.checks.feedbackLeave ?? { state: 'NOT_RUN_ALREADY_SAVED', reason: 'Original feedback already exists; do not create a second one to manufacture B2 evidence' } });
  });
}

export async function caseSr6Draft(input) {
  return input.record('R6-SR6-edit-original-feedback-draft', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'editor');
    const { data, scope } = await openChange(ctx, 'DRAFT');
    assert.equal(data.authorId, s.authorId);
    assert.ok(data.content.entities.length, 'Feedback must contain a real editable case');
    s.changeSummary = `${s.tag} 构造知识草稿编辑`;
    if (!s.operations['draft-edit']) {
      await label(scope, '变更摘要').fill(s.changeSummary);
      await mutate(ctx, 'draft-edit', `${KG}/actions/save`, () => button(scope, '保存草稿').click(), request => {
        assert.equal(request.changeId, s.changeId);
        assert.equal(request.draft.baseVersionId, s.baseVersionId);
        assert.equal(request.draft.summary, s.changeSummary);
      });
    } else await mutate(ctx, 'draft-edit', `${KG}/actions/save`, () => assert.fail('Do not repeat saved edits'), () => {});
    const reread = await rereadChange(ctx, 'DRAFT');
    assert.equal(reread.data.content.summary, s.changeSummary);
    assert.equal(reread.data.content.baseVersionId, s.baseVersionId);
    return finish(ctx, 'sr6-edited-draft', { changeId: s.changeId, revision: reread.data.revision, summary: s.changeSummary });
  });
}

async function submitChange(ctx, scope, key) {
  return mutate(ctx, key, `${KG}/actions/submit`, async () => {
    await button(scope, '提交审核').click();
    await confirm(ctx, '提交审核', '确认送审');
  }, request => assert.equal(request.changeId, ctx.state.changeId));
}

export async function caseSr6Submit(input) {
  return input.record('R6-SR6-submit-original-draft', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'editor');
    let current = await openChange(ctx);
    if (s.operations['submit-second']?.phase === 'accepted') {
      assert.equal(current.data.state, 'PENDING');
    } else {
      if (!s.operations['submit-final']) assert.equal(current.data.state, 'DRAFT');
      await submitChange(ctx, current.scope, 'submit-final');
      current = await rereadChange(ctx, 'PENDING');
    }
    return finish(ctx, 'sr6-submitted-original', { changeId: s.changeId, revision: current.data.revision,
      state: current.data.state, authorId: current.data.authorId });
  });
}

export async function caseSr6SubmitWithdrawSelfReview(input) {
  return input.record('R6-SR6-submit-withdraw-self-review-block', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'editor');
    let current = await openChange(ctx);
    if (!s.operations['withdraw']) {
      await submitChange(ctx, current.scope, 'submit-first');
      current = await rereadChange(ctx, 'PENDING');
      await mutate(ctx, 'withdraw', `${KG}/actions/withdraw`, async () => {
        await button(current.scope, '撤回').click();
        await confirm(ctx, '撤回待审核变更', '确认撤回');
      }, request => assert.equal(request.changeId, s.changeId));
    } else await mutate(ctx, 'withdraw', `${KG}/actions/withdraw`, () => assert.fail('Do not repeat withdrawal'), () => {});
    current = await rereadChange(ctx);
    if (!s.operations['submit-second']) {
      assert.equal(current.data.state, 'DRAFT');
      assert.ok(current.data.submissions.some(item => item.outcome === 'WITHDRAWN'));
      await submitChange(ctx, current.scope, 'submit-second');
      current = await rereadChange(ctx, 'PENDING');
    } else {
      await mutate(ctx, 'submit-second', `${KG}/actions/submit`, () => assert.fail('Do not resubmit'), () => {});
      assert.equal(current.data.state, 'PENDING');
    }
    assert.equal(current.data.authorId, s.authorId);
    assert.equal(ctx.actor.accountId, s.authorId);
    assert.ok(ctx.actor.permissions.includes('knowledge.review'),
      'To prove author-specific self-review rejection, the .24 editor test role needs knowledge.edit + knowledge.review; a role-only denial is insufficient');
    assert.equal(await button(current.scope, '审核通过').count(), 0, 'HTTP author must not receive a self-review control');
    assert.equal(await button(current.scope, '驳回').count(), 0);
    s.checks.selfReview = { changeId: s.changeId, authorId: s.authorId, state: 'PENDING',
      authorHasReviewPermission: true, result: 'BLOCKED_BY_UI_NO_REVIEW_CONTROL', server403Tested: false };
    return finish(ctx, 'sr6-author-self-review-blocked', { submissions: current.data.submissions.map(item => ({ number: item.number, outcome: item.outcome })), selfReview: s.checks.selfReview });
  });
}

export async function caseSr6ReviewPublish(input) {
  return input.record('R6-SR6-independent-review-publish', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'reviewer');
    if (!s.baseSnapshotHash) {
      const baseline = await openVersion(ctx, s.baseVersionId);
      s.baseSnapshotHash = snapshotHash(baseline.data);
      await ctx.save();
    }
    let current = await openChange(ctx);
    if (!s.operations.review) {
      assert.equal(current.data.state, 'PENDING');
      await label(current.scope, '审核意见（驳回必填）').fill('R6构造资料独立审核，仅确认本测试工作流。');
      await mutate(ctx, 'review', `${KG}/actions/review`, () => button(current.scope, '审核通过').click(), request => {
        assert.equal(request.changeId, s.changeId);
        assert.equal(request.approved, true);
      });
      current = await rereadChange(ctx, 'APPROVED');
    } else {
      await mutate(ctx, 'review', `${KG}/actions/review`, () => assert.fail('Do not repeat review'), () => {});
      assert.ok(['APPROVED', 'PUBLISHED'].includes(current.data.state));
    }
    const review = current.data.submissions.at(-1)?.review;
    assert.ok(review?.actorId);
    assert.notEqual(review.actorId, current.data.authorId, 'Independent reviewer must differ from the author');
    s.reviewerId = review.actorId;
    await mutate(ctx, 'publish', `${KG}/actions/publish`, async () => {
      await button(current.scope, '发布已审核内容').click();
      await confirm(ctx, '发布知识版本', '确认发布');
    }, request => assert.equal(request.changeId, s.changeId));
    const published = await openVersion(ctx, s.publishedVersionId);
    assert.equal(published.data.kind, 'PUBLISH');
    assert.equal(published.data.parentId, s.baseVersionId);
    assert.equal(published.data.changeId, s.changeId);
    s.publishedSnapshotHash = snapshotHash(published.data);
    await ctx.save();
    return finish(ctx, 'sr6-independent-published', { authorId: s.authorId, reviewerId: s.reviewerId,
      publishedVersionId: s.publishedVersionId, parentId: published.data.parentId, snapshotHash: s.publishedSnapshotHash });
  });
}

export async function caseSr6RollbackHistory(input) {
  return input.record('R6-SR6-rollback-original-history-readback', async () => {
    const ctx = await context(input), s = ctx.state;
    await loginAs(ctx, 'reviewer');
    if (!s.rolledBackVersionId) {
      const published = await openVersion(ctx, s.publishedVersionId);
      await label(published.scope, '回滚原因').fill('R6构造验收：恢复本次发布的父版本并保留历史。');
      await mutate(ctx, 'rollback', `${KG}/actions/rollback`, async () => {
        await button(published.scope, '恢复上一版并生成新版本').click();
        await confirm(ctx, '恢复上一版知识', '确认回滚并生效');
      }, request => assert.equal(request.versionId, s.publishedVersionId));
    }
    const rolledBack = await openVersion(ctx, s.rolledBackVersionId);
    assert.equal(rolledBack.data.kind, 'ROLLBACK');
    assert.equal(rolledBack.data.parentId, s.publishedVersionId);
    assert.equal(rolledBack.data.restoredFromVersionId, s.baseVersionId);
    assert.equal(snapshotHash(rolledBack.data), s.baseSnapshotHash);
    const original = await openVersion(ctx, s.publishedVersionId);
    assert.equal(snapshotHash(original.data), s.publishedSnapshotHash, 'Published history was overwritten');
    const change = await openChange(ctx, 'PUBLISHED');
    assert.equal(change.data.publishedVersionId, s.publishedVersionId);
    if (s.operations.withdraw?.phase === 'accepted') assert.ok(change.data.submissions.some(item => item.outcome === 'WITHDRAWN'));
    assert.ok(change.data.submissions.some(item => item.outcome === 'APPROVED' && item.review.actorId !== change.data.authorId));
    await loginAs(ctx, 'editor');
    const report = await reportReadback(ctx);
    assert.equal(digest(stable(report)), s.reportHash, 'Historical SR5 report changed after SR6 publish/rollback');
    return finish(ctx, 'sr56-history-retained', { rolledBackVersionId: s.rolledBackVersionId, restoredFrom: s.baseVersionId,
      oldPublishedVersionRetained: true, reportHash: s.reportHash, originalRunId: s.runId });
  });
}

// Read-only recovery: exact IDs via normal page navigation, never action/API replay.
export async function caseSr56Readback(input) {
  return input.record('R6-SR56-readback-original-ids-only', async () => {
    const ctx = await context(input), evidence = {};
    await loginAs(ctx, 'editor');
    if (ctx.state.versionId) evidence.scenario = await openScenario(ctx);
    if (ctx.state.runId) evidence.run = await openRun(ctx);
    if (ctx.state.changeId) evidence.change = (await openChange(ctx)).data;
    evidence.operations = ctx.state.operations;
    return finish(ctx, 'sr56-readback-only', evidence);
  });
}

export async function runSr56(input) {
  const results = [];
  for (const run of [caseSr5Scenario, caseSr5DiagnosisImpact, caseSr5ReportFeedback, caseSr6Draft,
    caseSr6Submit, caseSr6ReviewPublish]) {
    // The harness records and rethrows failures; do not clean state or start a new write.
    results.push(await run(input));
  }
  return results;
}

// Freeze is run separately so the main session can release E before the remaining chain.
export async function runSr56AfterFreeze(input) {
  const ctx=await context(input);
  assert.ok(ctx.state.scenarioId&&ctx.state.versionId,'Freeze the original scenario first; never create another one here');
  const results=[];
  for(const run of [caseSr5DiagnosisImpact,caseSr5ReportFeedback,caseSr6Draft,
    caseSr6SubmitWithdrawSelfReview,caseSr6ReviewPublish,caseSr6RollbackHistory])results.push(await run(input));
  return results;
}

export async function runSr56Complete(input) {
  const frozen=await caseSr5Scenario(input);
  return [frozen,...await runSr56AfterFreeze(input)];
}

export async function runSr56VerifiedContinuation(input) {
  const readback=await caseSr56Readback(input);
  return [readback,...await runSr56AfterFreeze(input)];
}

export async function runSr6ReleaseAndReadback(input) {
  return [await caseSr6ReviewPublish(input),await caseSr6RollbackHistory(input)];
}
