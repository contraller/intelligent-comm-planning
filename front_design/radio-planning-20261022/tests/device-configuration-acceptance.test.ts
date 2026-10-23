import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { useDeviceConfigurationAcceptanceStore, type DeviceConfigurationClient } from '../src/stores/device-configuration-acceptance';
import { acceptanceMessage, deviceConfigurationSchema as schema, type ConfigurationAcceptanceContext, type ConfigurationSubmissionInput } from '../src/services/device-configuration-decode';
import { ApiError } from '../src/services/types';
const revision = 'resource-1111111111111111';
export function acceptanceContext(): ConfigurationAcceptanceContext {
  return { schema_version: schema, context: 'ledger', resource_revision: revision, resource_content_hash: 'a'.repeat(64),
    device: { device_id: 'D1', node_id: 'N1', model_id: 'M1', availability: 'ACTIVE', source_values: { tx_power_dbm: 20, work_freq_khz: 3000 } },
    model: { model_id: 'M1', freq_min_khz: 2000, freq_max_khz: 30000, tx_power_max_dbm: 50 },
    provenance: { data_origin: 'SYNTHETIC_INTEGRATION', resource_source: '构造数据', source_files: { 'device.csv': { path: 'data/device.csv', sha256: 'b'.repeat(64) } } },
    protocol: { port_options: null, mode_options: null, confirmation: '待确认' } };
}
function receipt(input: ConfigurationSubmissionInput, account: string) {
  const ctx = acceptanceContext();
  return { schema_version: schema, configuration_id: 'DC-' + 'c'.repeat(32), request_id: input.request_id, request_digest: 'd'.repeat(64),
    context: 'ledger' as const, device_id: input.device_id, model_id: input.model_id, base_revision: input.base_revision,
    resource_content_hash: ctx.resource_content_hash, requested_values: input.values, device_snapshot: ctx.device, model_constraints: ctx.model, provenance: ctx.provenance,
    actor: { account_id: account, display_name: '测试账号', role_id: 'editor', identity_revision: 'test-identity', integration_mode: true as const },
    accepted_at: '2026-10-23T10:00:00.000000Z', status: 'ACCEPTED' as const, receipt_scope: 'SYSTEM_ACCEPTANCE' as const,
    dispatch_status: 'NOT_DISPATCHED' as const, device_execution_status: 'UNKNOWN' as const, applied_values: null, online: null, effective: null, device_reported_at: null, message: acceptanceMessage };
}
let pinia: ReturnType<typeof createPinia>;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
async function setup() {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const client = {
    loadContext: vi.fn().mockResolvedValue(acceptanceContext()),
    validateRequest: vi.fn().mockImplementation(async input => ({ valid: true, context: acceptanceContext(), requested_values: input.values })),
    submitRequest: vi.fn().mockImplementation(async input => receipt(input, auth.identity!.id)),
    getRequest: vi.fn(), queryHistory: vi.fn().mockResolvedValue({ schema_version: schema, context: 'ledger', items: [], total: 0, page: 1, page_size: 20 }),
  } satisfies DeviceConfigurationClient;
  const config = useDeviceConfigurationAcceptanceStore(), storage = new TestStorage();
  config.bind(client, storage); await config.open({ deviceId: 'D1', resourceRevision: revision, editable: true });
  return { config, client, auth, storage };
}
describe('system acceptance state', () => {
  it('invalidates validation on edits and never promotes acceptance to execution', async () => {
    const { config, client } = await setup(); await config.validate(); expect(config.validated).toBe(true);
    config.frequency = '3500'; expect(config.validated).toBe(false); await config.submit(); expect(client.submitRequest).not.toHaveBeenCalled();
    await config.validate(); await config.submit();
    expect(config.acceptance?.status).toBe('ACCEPTED'); expect(config.acceptance?.dispatch_status).toBe('NOT_DISPATCHED');
    expect(config.acceptance?.online).toBeNull(); expect(config.pending).toBeNull();
  });
  it('preserves exact id/content after timeout and only permits resend after original 404', async () => {
    const { config, client } = await setup(); client.submitRequest.mockRejectedValueOnce(new Error('timeout'));
    await config.validate(); await config.submit(); const original = JSON.parse(JSON.stringify(config.pending!));
    expect(original.request_id).toBeTruthy(); await config.resend(); expect(client.submitRequest).toHaveBeenCalledTimes(1);
    client.getRequest.mockRejectedValueOnce(new ApiError('not found', 'CONFIGURATION_NOT_FOUND'));
    await config.verify(); expect(config.notFound).toBe(true); await config.resend();
    expect(client.submitRequest.mock.calls[1]![0]).toEqual(original); expect(config.pending).toBeNull();
  });
  it('ignores late context on target switch and forwards cancellation signal', async () => {
    const { config, client } = await setup(); let done!: (value: ConfigurationAcceptanceContext) => void;
    client.loadContext.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const old = config.open({ deviceId: 'D1', resourceRevision: revision, editable: true });
    const signal = client.loadContext.mock.calls.at(-1)![1]?.signal;
    expect(config.close()).toBe(false); config.cancel(); expect(config.close()).toBe(true); done(acceptanceContext()); await old;
    expect(signal?.aborted).toBe(true); expect(config.data).toBeNull();
  });
  it('does not clear pending on a wrong-content original-id response', async () => {
    const { config, client, auth } = await setup(); client.submitRequest.mockRejectedValueOnce(new Error('timeout'));
    await config.validate(); await config.submit();
    client.getRequest.mockResolvedValue(receipt({ ...config.pending!, values: { tx_power_dbm: 49, work_freq_khz: 3000 } }, auth.identity!.id));
    await config.verify(); expect(config.pending).not.toBeNull(); expect(config.error).toContain('不符');
  });
  it('account switch cancels reads and cannot display another account pending', async () => {
    const { config, client, auth } = await setup(); client.submitRequest.mockRejectedValueOnce(new Error('timeout'));
    await config.validate(); await config.submit(); expect(config.pending).not.toBeNull();
    auth.identity = { ...auth.identity!, id: 'other-account', sessionId: 'other-session' };
    expect(config.pending).toBeNull(); expect(config.acceptance).toBeNull(); expect(config.data).toBeNull();
  });
  it('refuses unsaved drafts and pending closure until explicit discard or preserve-original action', async () => {
    const { config, client } = await setup(); config.power = '21';
    expect(config.dirty).toBe(true); expect(config.close()).toBe(false); expect(config.visible).toBe(true);
    expect(config.discardDraft()).toBe(true); expect(config.dirty).toBe(false);
    client.submitRequest.mockRejectedValueOnce(new Error('timeout')); await config.validate(); await config.submit();
    const id = config.pending?.request_id; expect(config.close()).toBe(false); expect(config.visible).toBe(true);
    expect(config.closeKeepingPending()).toBe(true); expect(config.visible).toBe(false); expect(config.pending?.request_id).toBe(id);
    await config.open({ deviceId: 'D1', resourceRevision: revision, editable: true });
    expect(config.pending?.request_id).toBe(id); expect(config.data?.resource_revision).toBe(revision);
  });
});
