import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allPermissions } from '../src/config/permissions';
import { deviceStatusSchema, type DeviceStatusImport, type DeviceStatusReceipt } from '../src/types/device-status-snapshot';
import { deviceTraceSchema, type RestoreInput, type RestoreProposal } from '../src/types/device-trace';
import type { SpectrumSourceVersion } from '../src/types/spectrum-source';
import type { WorkbenchContext, WriteReceipt } from '../src/types/interference-workbench';

type HttpModule = typeof import('../src/services/http');
const factoryMethods = {
  deviceStatuses: ['importSnapshot', 'getImport', 'listSnapshots', 'getSnapshot', 'queryDevices'],
  deviceTraces: ['queryHistory', 'getOperation', 'previewRestore'],
  spectrumSources: ['querySources', 'getSource', 'saveSource', 'checkSource', 'queryVersions', 'queryChecks', 'getSourceReceipt', 'exportSource'],
  interferenceWorkbench: ['getContext', 'listSources', 'submitRun', 'listRuns', 'getProgress', 'getRun', 'getPreview', 'cancelRun', 'adoptMeasure', 'getAdoption', 'cancelAdoption', 'getOperation'],
} as const;
type FactoryName = keyof typeof factoryMethods;

const originalPermissions = [
  'situation.view', 'resources.view', 'resources.edit', 'resources.reset',
  'planning.view', 'planning.execute', 'planning.save', 'planning.confirm', 'planning.reset',
  'diagnosis.view', 'diagnosis.scenario', 'diagnosis.execute', 'diagnosis.export', 'diagnosis.reset',
  'knowledge.view', 'knowledge.edit', 'knowledge.review', 'knowledge.publish', 'knowledge.rollback', 'knowledge.reset',
  'system.view', 'system.accounts', 'system.roles', 'system.logs', 'system.parameters', 'system.reset',
];
const approvedNewPermissions = [
  'resources.device.edit', 'resources.device.availability', 'resources.frequency.disable',
  'resources.import', 'resources.create', 'resources.workspace.edit', 'resources.frequency.maintain',
  'resources.spectrum.edit', 'resources.device.status.import', 'situation.observation.import',
];

function serverPermissionCodes() {
  const source = readFileSync(new URL('../../../algorithm-service/app/permission_registry.py', import.meta.url), 'utf8');
  const tables = [...source.matchAll(/^_NAMES\s*=\s*\{([^]*?)^\}/gm)];
  if (tables.length !== 1 || !tables[0]?.[1]) throw new Error('Expected exactly one literal Python _NAMES table');
  // 只审查静态目录，不执行 Python；表达式或无法识别的条目必须显式失败。
  return tables[0][1].split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const entry = /^\s*(["'])([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)\1\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,?\s*(?:#.*)?$/.exec(line);
    if (!entry?.[2]) throw new Error('Non-literal permission registry entry: ' + line);
    return entry[2];
  });
}

describe('shared permission registry static contract', () => {
  it('matches every backend literal permission against imported TS allPermissions, without duplicates', () => {
    const backend = serverPermissionCodes();
    expect(new Set(backend).size).toBe(backend.length);
    expect(new Set(allPermissions).size).toBe(allPermissions.length);
    expect([...backend].sort()).toEqual([...allPermissions].sort());
  });

  it('contains exactly the original registry plus the approved new permissions', () => {
    const approved = [...originalPermissions, ...approvedNewPermissions];
    expect(new Set(approved).size).toBe(approved.length);
    expect([...allPermissions].sort()).toEqual(approved.sort());
  });
});

const baseUrl = '/api/v1/shared-http-test';
const origin = 'https://shared-http.invalid';
const revision = 'resource-1111111111111111';
const sourceRevision = 'resource-2222222222222222';
const snapshotId = 'DSS-' + 'a'.repeat(32);
const snapshotRevision = 'device-status-' + 'b'.repeat(64);
const stamp = '2026-10-23T08:00:00.000000Z';
const hash = 'a'.repeat(64);

const identity = (account = 'alpha') => ({
  session_id: 'shared-session-' + account, account_id: account, username: account, display_name: account,
  role_id: 'shared-test-role', role_name: 'shared HTTP test', permissions: [...allPermissions],
  identity_revision: 'identity-1', session_generation: 'generation-1',
});
function response(data: unknown, code = 0, status = 200) {
  return new Response(JSON.stringify({ code, message: code ? 'shared HTTP rejected' : 'success', data, request_id: 'shared-http-trace' }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
const statusInput = (): DeviceStatusImport => ({
  schema_version: deviceStatusSchema, context: 'ledger', request_id: 'shared-status', base_revision: revision,
  data_origin: 'SYNTHETIC_INTEGRATION', source_label: 'shared HTTP fixture', provenance_note: 'Synthetic test data, not observations',
  records: [{ device_id: 'D1', node_id: 'N1', model_id: 'M1', status: null, alert: null, observed_at: null, unknown_reasons: ['Not provided'] }],
});
const statusReceipt = (): DeviceStatusReceipt => ({
  schema_version: deviceStatusSchema, request_id: 'shared-status', snapshot_id: snapshotId, snapshot_revision: snapshotRevision,
  resource_revision: revision, imported_at: stamp, total: 1, content_hash: 'b'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION',
});
const statusPage = () => ({
  schema_version: deviceStatusSchema, snapshot_id: snapshotId, snapshot_revision: snapshotRevision, resource_revision: revision,
  page: 1, page_size: 20, total: 1, items: [{ ...statusInput().records[0]!, availability: 'ACTIVE' }],
});
const tracePage = () => ({
  schema_version: deviceTraceSchema, page: 1, page_size: 20, total: 1,
  items: [{ request_id: null, device_id: 'D1', kind: 'RETAINED_BASELINE', base_revision: null, revision: sourceRevision,
    created_at: stamp, actor_id: null, changed: false, changed_fields: [], data_origin: 'SYNTHETIC_INTEGRATION' }],
});
const restoreInput = (): RestoreInput => ({
  schema_version: deviceTraceSchema, context: 'ledger', base_revision: revision, source_revision: sourceRevision, source_request_id: null,
});
const restoreProposal = (): RestoreProposal => ({
  schema_version: deviceTraceSchema, base_revision: revision, source_revision: sourceRevision, source_request_id: null,
  device_id: 'D1', model_id: 'M1', compatible: true,
  changes: [{ field: 'antenna_height_m', before: 20, after: 21, known: true }], patch: { antenna_height_m: 21 },
  blocked_fields: ['status', 'alert', 'ports', 'availability'], warnings: ['Preview only'],
});
const sourceVersion = (actorId: string): SpectrumSourceVersion => ({
  schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'shared-source', configRevision: 'SPV-' + hash, contentHash: hash,
  draft: { name: 'shared source', protocolHint: null, endpoint: null, intervalSeconds: null, minKhz: 6000, maxKhz: 8000, enabled: false, provenanceNote: 'Synthetic test data' },
  createdAt: stamp, actorId,
});
const sourcePage = (actorId: string) => ({
  schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', page: 1, pageSize: 20, total: 1,
  items: [{ ...sourceVersion(actorId), latestOfflineCheck: null }],
});
const sourceInput = () => ({ requestId: 'shared-source-save', sourceId: 'shared-source', baseConfigRevision: null, draft: sourceVersion('alpha').draft });
const sourceReceipt = (actorId: string) => ({
  requestId: 'shared-source-save', operationType: 'SOURCE_SAVE', sourceId: 'shared-source', configRevision: 'SPV-' + hash,
  changed: true, actorId, committedAt: stamp, source: sourceVersion(actorId), check: null,
});
const workbenchContext = (): WorkbenchContext => ({
  task_id: 'T1', resource_revision: revision, source_options: [], scene_count: 0, run_count: 0,
  active_run_ids: [], data_origin: 'SYNTHETIC_INTEGRATION', interference_sources: [],
  capabilities: {
    scene_save: { enabled: false, reasons: ['No source'] }, analyze: { enabled: false, reasons: ['No source'] },
    cancel: { enabled: false, reasons: ['No source'] }, preview: { enabled: false, reasons: ['No source'] },
    adopt_replan: { enabled: false, reasons: ['No source'] },
  },
});
const runInput = () => ({ request_id: 'shared-run', task_id: 'T1', plan_id: 'P1', plan_version: 'V1', resource_revision: revision,
  scene_id: 'SC1', scene_version_id: 'SV1', snapshot_hash: hash });
const runReceipt = (actorId: string): WriteReceipt => ({
  request_id: 'shared-run', operation: 'SUBMIT_ANALYSIS', actor_id: actorId, task_id: 'T1', object_type: 'RUN', object_id: 'RUN1',
  accepted_version: 1, changed: true, status: 'ACCEPTED', source_hash: hash, data_origin: 'SYNTHETIC_INTEGRATION', accepted_at: stamp,
});

interface FactoryCase {
  name: FactoryName; path: string; run: (http: HttpModule) => Promise<unknown>; data: (actorId: string) => unknown;
}
const readCases: (FactoryCase & { query: Record<string, string> })[] = [
  { name: 'deviceStatuses', path: '/device-status/snapshots/' + snapshotId + '/devices',
    query: { context: 'ledger', snapshot_revision: snapshotRevision, status_filter: 'UNKNOWN', page: '1', page_size: '20' },
    run: http => http.collaborationHttp.deviceStatuses.queryDevices({ context: 'ledger', snapshot_id: snapshotId, snapshot_revision: snapshotRevision, status_filter: 'UNKNOWN', page: 1, page_size: 20 }), data: statusPage },
  { name: 'deviceTraces', path: '/device-traces/D1/history',
    query: { context: 'ledger', resource_revision: revision, page: '1', page_size: '20' },
    run: http => http.collaborationHttp.deviceTraces.queryHistory({ context: 'ledger', device_id: 'D1', resource_revision: revision }), data: tracePage },
  { name: 'spectrumSources', path: '/spectrum/sources', query: { page: '1', page_size: '20', search: 'shared', enabled: 'false' },
    run: http => http.collaborationHttp.spectrumSources.querySources({ page: 1, pageSize: 20, search: 'shared', enabled: false }), data: sourcePage },
  { name: 'interferenceWorkbench', path: '/interference/workbench', query: { task_id: 'T1' },
    run: http => http.collaborationHttp.interferenceWorkbench.getContext({ task_id: 'T1' }), data: workbenchContext },
];
const writeCases: (FactoryCase & { body: () => unknown })[] = [
  { name: 'deviceStatuses', path: '/device-status/imports', body: statusInput,
    run: http => http.collaborationHttp.deviceStatuses.importSnapshot(statusInput()), data: statusReceipt },
  { name: 'deviceTraces', path: '/device-traces/D1/restore-preview', body: restoreInput,
    run: http => http.collaborationHttp.deviceTraces.previewRestore('D1', restoreInput()), data: restoreProposal },
  { name: 'spectrumSources', path: '/spectrum/sources', body: () => ({ schemaVersion: 1, ...sourceInput() }),
    run: http => http.collaborationHttp.spectrumSources.saveSource(sourceInput()), data: sourceReceipt },
  { name: 'interferenceWorkbench', path: '/interference/workbench/runs', body: runInput,
    run: http => http.collaborationHttp.interferenceWorkbench.submitRun(runInput()), data: runReceipt },
];

// 使用真实入口、工厂、认证和解码器；只有 fetch 响应是桩，不是 live 或浏览器 Cookie 验收。
describe('shared resource HTTP entry and authentication lifecycle', () => {
  let http: HttpModule | undefined;
  let state: { identity: ReturnType<typeof identity> | null; csrfSession?: string; csrfCount: number };
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let replies: Map<string, () => Response | Promise<Response>>;

  function entry() {
    if (!http) throw new Error('HTTP entry has not loaded');
    return http;
  }
  function calls() {
    return fetcher.mock.calls.map(([input, init]) => {
      const url = new URL(input instanceof Request ? input.url : String(input), origin);
      return { path: url.pathname.slice(baseUrl.length), query: Object.fromEntries(url.searchParams),
        method: init?.method ?? 'GET', headers: new Headers(init?.headers), init };
    });
  }
  const businessCalls = () => calls().filter(call => !call.path.startsWith('/auth/'));

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('VITE_DATA_MODE', 'http');
    vi.stubEnv('VITE_SAMPLE_DATA', 'false');
    vi.stubEnv('VITE_API_BASE_URL', baseUrl);
    vi.stubGlobal('location', { origin });
    state = { identity: identity(), csrfCount: 0 };
    replies = new Map();
    for (const spec of readCases) replies.set('GET ' + spec.path, () => response(spec.data(state.identity?.account_id ?? 'missing')));
    for (const spec of writeCases) replies.set('POST ' + spec.path, () => response(spec.data(state.identity?.account_id ?? 'missing')));
    fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), origin);
      if (url.origin !== origin || !url.pathname.startsWith(baseUrl + '/')) throw new Error('Unexpected HTTP origin or base URL');
      const path = url.pathname.slice(baseUrl.length);
      if (path === '/auth/session') return response(state.identity);
      if (path === '/auth/csrf') return response({ csrf_token: 'shared-csrf-' + ++state.csrfCount,
        session_id: state.csrfSession ?? state.identity?.session_id ?? null });
      const reply = replies.get((init?.method ?? 'GET') + ' ' + path);
      if (!reply) throw new Error('Unexpected shared HTTP request: ' + path);
      return reply();
    });
    vi.stubGlobal('fetch', fetcher);
    http = await import('../src/services/http');
  });

  afterEach(() => {
    http?.releaseHttpSessionBinding();
    http = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('exports the complete four factory method sets without requesting data during import', () => {
    expect(Object.isFrozen(entry().collaborationHttp)).toBe(true);
    for (const name of Object.keys(factoryMethods) as FactoryName[]) {
      const client = entry().collaborationHttp[name];
      expect(Object.keys(client).sort()).toEqual([...factoryMethods[name]].sort());
      for (const method of Object.values(client)) expect(typeof method).toBe('function');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(readCases)('$name uses its real factory path and the current shared session', async spec => {
    expect(await spec.run(entry())).toEqual(spec.data('alpha'));
    expect(calls().map(call => call.path)).toEqual(['/auth/session', spec.path]);
    const sent = businessCalls()[0]!;
    expect(sent.method).toBe('GET');
    expect(sent.query).toEqual(spec.query);
    expect(sent.headers.get('X-Session-Id')).toBe(identity().session_id);
    expect(sent.headers.has('X-CSRF-Token')).toBe(false);
    expect(sent.init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(sent.init?.signal).toBeInstanceOf(AbortSignal);
    expect((await entry().httpService.getSession())?.id).toBe('alpha');
  });

  it('deduplicates one pending session read across httpService and all four namespaces', async () => {
    const shared = entry();
    const [actor, ...results] = await Promise.all([shared.httpService.getSession(), ...readCases.map(spec => spec.run(shared))]);
    expect(actor).toMatchObject({ sessionId: identity().session_id, id: 'alpha' });
    expect(results).toEqual(readCases.map(spec => spec.data('alpha')));
    expect(calls().filter(call => call.path === '/auth/session')).toHaveLength(1);
    expect(businessCalls()).toHaveLength(4);
    expect(businessCalls().every(call => call.headers.get('X-Session-Id') === identity().session_id)).toBe(true);
    expect(calls().some(call => call.path === '/auth/csrf')).toBe(false);
  });

  it('shares the authentication lifecycle across POST factories and obtains a fresh CSRF challenge per operation', async () => {
    for (const [index, spec] of writeCases.entries()) {
      const start = calls().length;
      expect(await spec.run(entry())).toEqual(spec.data('alpha'));
      expect(calls().slice(start).map(call => call.path)).toEqual(['/auth/session', '/auth/csrf', spec.path]);
      const sent = businessCalls().at(-1)!;
      expect(sent.method).toBe('POST');
      expect(sent.headers.get('X-Session-Id')).toBe(identity().session_id);
      expect(sent.headers.get('X-CSRF-Token')).toBe('shared-csrf-' + (index + 1));
      expect(sent.headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(String(sent.init?.body))).toEqual(spec.body());
    }
    expect(state.csrfCount).toBe(4);
  });

  it('freezes every namespace on a changed session, then release rebinds the same clients without logging out', async () => {
    const shared = entry();
    const clients = shared.collaborationHttp;
    await shared.httpService.getSession();
    state.identity = identity('beta');
    await expect(readCases[0]!.run(shared)).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(businessCalls()).toHaveLength(0);
    const frozenCount = calls().length;
    for (const spec of readCases) await expect(spec.run(shared)).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await expect(shared.httpService.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(calls()).toHaveLength(frozenCount);
    shared.releaseHttpSessionBinding();
    expect(calls()).toHaveLength(frozenCount);
    expect((await shared.httpService.getSession())?.id).toBe('beta');
    for (const spec of readCases) expect(await spec.run(shared)).toEqual(spec.data('beta'));
    expect(shared.collaborationHttp).toBe(clients);
    expect(businessCalls().every(call => call.headers.get('X-Session-Id') === identity('beta').session_id)).toBe(true);
    expect(calls().some(call => call.path === '/auth/logout')).toBe(false);
  });

  it('a mismatched POST CSRF session freezes all clients before any business write', async () => {
    state.csrfSession = identity('beta').session_id;
    await expect(writeCases[0]!.run(entry())).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(businessCalls()).toHaveLength(0);
    const frozenCount = calls().length;
    for (const spec of readCases) await expect(spec.run(entry())).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await expect(entry().httpService.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(calls()).toHaveLength(frozenCount);
    entry().releaseHttpSessionBinding();
    state.identity = identity('beta');
    delete state.csrfSession;
    expect(await writeCases[0]!.run(entry())).toEqual(statusReceipt());
    expect(businessCalls()).toHaveLength(1);
    expect(businessCalls()[0]!.headers.get('X-Session-Id')).toBe(identity('beta').session_id);
    expect(businessCalls()[0]!.headers.get('X-CSRF-Token')).toBe('shared-csrf-2');
  });

  it('release invalidates an in-flight old read instead of applying its late response', async () => {
    let finish!: (value: Response) => void;
    replies.set('GET /spectrum/sources', () => new Promise(resolve => { finish = resolve; }));
    const pending = entry().collaborationHttp.spectrumSources.querySources({ page: 1, pageSize: 20 });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await vi.waitFor(() => expect(businessCalls()).toHaveLength(1));
    entry().releaseHttpSessionBinding();
    state.identity = identity('beta');
    expect((await entry().httpService.getSession())?.id).toBe('beta');
    finish(response(sourcePage('alpha')));
    await rejected;
    replies.set('GET /spectrum/sources', () => response(sourcePage('beta')));
    expect(await entry().collaborationHttp.spectrumSources.querySources({ page: 1, pageSize: 20 })).toEqual(sourcePage('beta'));
    expect(businessCalls().at(-1)!.headers.get('X-Session-Id')).toBe(identity('beta').session_id);
  });

  it('does not send business requests or substitute mock data without a session', async () => {
    state.identity = null;
    for (const spec of readCases) await expect(spec.run(entry())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(businessCalls()).toHaveLength(0);
    expect(calls().every(call => call.path === '/auth/session')).toBe(true);
  });

  it.each(readCases)('$name propagates transport failure without local mock fallback', async spec => {
    replies.set('GET ' + spec.path, () => { throw new TypeError('shared transport offline'); });
    await expect(spec.run(entry())).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'shared transport offline' });
    expect(businessCalls()).toHaveLength(1);
    expect(businessCalls()[0]!.path).toBe(spec.path);
  });

  it('propagates a server permission denial with trace identity rather than falling back', async () => {
    replies.set('GET /interference/workbench', () => response({ reason: 'test denial' }, 1104, 403));
    await expect(entry().collaborationHttp.interferenceWorkbench.getContext({ task_id: 'T1' })).rejects.toMatchObject({
      code: 'FORBIDDEN', status: 403, requestId: 'shared-http-trace', data: { reason: 'test denial' },
    });
    expect(businessCalls()).toHaveLength(1);
  });

  it('does not retry a failed POST or replace it with a local success', async () => {
    replies.set('POST /device-status/imports', () => { throw new TypeError('write result unknown'); });
    await expect(entry().collaborationHttp.deviceStatuses.importSnapshot(statusInput())).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(calls().map(call => call.path)).toEqual(['/auth/session', '/auth/csrf', '/device-status/imports']);
    expect(JSON.parse(String(businessCalls()[0]!.init?.body))).toEqual(statusInput());
    expect(state.csrfCount).toBe(1);
  });
});
