import { describe, expect, it } from 'vitest';
import { TestStorage } from './helpers/storage';
import { reactive } from 'vue';
import { readPendingConfiguration, savePendingConfiguration, clearPendingConfiguration } from '../src/services/device-configuration-pending';
import { deviceConfigurationSchema } from '../src/services/device-configuration-decode';
const request = () => ({ schema_version: deviceConfigurationSchema, context: 'ledger' as const, request_id: 'pending-one',
  base_revision: 'resource-1111111111111111', device_id: 'D1', model_id: 'M1', values: { tx_power_dbm: 20, work_freq_khz: 3000 } });
describe('configuration pending persistence', () => {
  it('accepts a Vue reactive request while persisting only detached wire fields', () => {
    const storage = new TestStorage(), value = reactive(request());
    savePendingConfiguration('A', value, storage); value.values.tx_power_dbm = 45;
    expect(readPendingConfiguration('A', storage)?.values.tx_power_dbm).toBe(20);
  });
  it('isolates accounts and stores a detached exact request without credentials', () => {
    const storage = new TestStorage(), input = request();
    savePendingConfiguration('A', input, storage); input.values.tx_power_dbm = 99;
    expect(readPendingConfiguration('A', storage)?.values.tx_power_dbm).toBe(20);
    expect(readPendingConfiguration('B', storage)).toBeNull();
    expect(storage.getItem('device-configuration-pending-a1:A')).not.toContain('csrf');
  });
  it('never overwrites a different pending request and only clears the matching id', () => {
    const storage = new TestStorage(); savePendingConfiguration('A', request(), storage);
    expect(() => savePendingConfiguration('A', { ...request(), request_id: 'other' }, storage)).toThrow();
    clearPendingConfiguration('A', 'other', storage); expect(readPendingConfiguration('A', storage)).toEqual(request());
    clearPendingConfiguration('A', 'pending-one', storage); expect(readPendingConfiguration('A', storage)).toBeNull();
  });
  it('fails closed on corrupt storage without removing evidence', () => {
    const storage = new TestStorage(); storage.setItem('device-configuration-pending-a1:A', '{invalid');
    expect(() => readPendingConfiguration('A', storage)).toThrow();
    expect(storage.getItem('device-configuration-pending-a1:A')).toBe('{invalid');
    expect(() => savePendingConfiguration('A', request(), { getItem: () => null, setItem: () => { throw Error('quota'); } })).toThrow();
  });
});
