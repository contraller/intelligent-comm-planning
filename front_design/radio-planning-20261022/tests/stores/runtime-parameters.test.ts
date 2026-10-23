import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import type { Ref } from 'vue';
import { useRuntimeParametersStore } from '../../src/stores/runtime-parameters';
import { RUNTIME_PARAMETERS_VERSION } from '../../src/types/runtime-parameters';
import type { RuntimeParametersSnapshot } from '../../src/types/runtime-parameters';

const wire = (revision = 'SYS-1', epoch = 'epoch-one', p1 = 30): RuntimeParametersSnapshot => ({
  version: RUNTIME_PARAMETERS_VERSION, epoch, revision, values: { 'PAR-01': p1, 'PAR-02': 15 },
});
const deferred = () => {
  let resolve!: (value: RuntimeParametersSnapshot) => void, reject!: (error: unknown) => void;
  const promise = new Promise<RuntimeParametersSnapshot>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('runtime parameters singleton', () => {
  let store: ReturnType<typeof useRuntimeParametersStore>, session: Ref<string | null>;
  let read: ReturnType<typeof vi.fn<(input?: { readonly signal?: AbortSignal }) => Promise<RuntimeParametersSnapshot>>>;
  beforeEach(() => {
    setActivePinia(createPinia()); session = ref<string | null>('ACC-one:SID-one:G-1');
    read = vi.fn(async () => wire()); store = useRuntimeParametersStore();
    store.bind({ getRuntimeParameters: read }, () => session.value);
  });
  afterEach(() => store.$dispose());

  it('binds one shared instance without requests, defaults, or application claims', () => {
    expect(useRuntimeParametersStore()).toBe(store);
    expect(store.snapshot).toBeNull(); expect(store.loading).toBe(false); expect(store.error).toBeNull();
    expect(store.applications).toEqual([]); expect(read).not.toHaveBeenCalled();
    expect(store.reportApplied('http.timeout', 'epoch-one', 'SYS-1')).toBe(false);
    expect(() => store.bind({ getRuntimeParameters: read }, () => session.value)).toThrowError(expect.objectContaining({ code: 'RUNTIME_PARAMETERS_ALREADY_BOUND' }));
  });
  it('does not request while unbound or anonymous', async () => {
    store.unbind(); expect(await store.refresh()).toBeNull();
    session.value = null; store.bind({ getRuntimeParameters: read }, () => session.value);
    expect(await store.refresh()).toBeNull(); expect(read).not.toHaveBeenCalled();
    expect(store.snapshot).toBeNull();
  });
  it('makes a snapshot reactive after consumers first read an unbound instance', async () => {
    store.unbind(); expect(store.snapshot).toBeNull();
    store.bind({ getRuntimeParameters: read }, () => session.value);
    await store.refresh(); expect(store.snapshot).toEqual(wire());
  });
  it('refreshes explicitly after same-tab changes, with frozen snapshots and no automatic application', async () => {
    const raw = wire(); read.mockResolvedValueOnce(raw);
    const first = await store.refresh();
    expect(first).toEqual(raw); expect(first).not.toBe(raw); expect(store.snapshot).toBe(first);
    expect(store.applications).toEqual([]);
    Object.assign(raw.values, { 'PAR-01': 99 });
    expect(first!.values['PAR-01']).toBe(30);
    expect(Object.isFrozen(first!.values)).toBe(true);
    expect(() => Object.assign(store.snapshot!.values, { 'PAR-01': 99 })).toThrow(TypeError);
    read.mockResolvedValueOnce(wire('SYS-2', 'epoch-one', 60));
    expect(read).toHaveBeenCalledTimes(1);
    await store.refresh(); expect(store.snapshot?.values['PAR-01']).toBe(60); expect(read).toHaveBeenCalledTimes(2);
  });
  it('clears configuration and markers synchronously when the same account relogs', async () => {
    await store.refresh(); store.reportApplied('http.timeout', 'epoch-one', 'SYS-1');
    session.value = 'ACC-one:SID-two:G-2';
    expect(store.snapshot).toBeNull(); expect(store.applications).toEqual([]); expect(store.error).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await store.refresh(); expect(store.snapshot).not.toBeNull();
  });
  it('aborts and drops late old-actor success after account switch or logout', async () => {
    const late = deferred(); read.mockReturnValueOnce(late.promise);
    const pending = store.refresh(), signal = read.mock.calls[0]![0]!.signal!;
    session.value = 'ACC-two:SID-three:G-3';
    expect(signal.aborted).toBe(true); expect(store.snapshot).toBeNull(); expect(store.loading).toBe(false);
    late.resolve(wire()); expect(await pending).toBeNull();
    expect(store.snapshot).toBeNull(); session.value = null;
    expect(await store.refresh()).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('drops late old-actor errors without poisoning the new session', async () => {
    const late = deferred(); read.mockReturnValueOnce(late.promise);
    const pending = store.refresh(); session.value = 'ACC-two:SID-two:G-2';
    await store.refresh(); late.reject(new Error('old actor failure'));
    expect(await pending).toBeNull(); expect(store.error).toBeNull(); expect(store.snapshot).toEqual(wire());
  });
  it('keeps only the newest refresh and does not let the old finally clear loading', async () => {
    const old = deferred(), fresh = deferred(); read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = store.refresh(), second = store.refresh();
    expect(read.mock.calls[0]![0]!.signal!.aborted).toBe(true);
    old.resolve(wire('SYS-1')); expect(await first).toBeNull(); expect(store.loading).toBe(true);
    fresh.resolve(wire('SYS-2')); expect(await second).toEqual(wire('SYS-2'));
    expect(store.snapshot?.revision).toBe('SYS-2'); expect(store.loading).toBe(false);
  });
  it('cannot overwrite a new snapshot with an older late response', async () => {
    const old = deferred(), fresh = deferred(); read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = store.refresh(), second = store.refresh();
    fresh.resolve(wire('SYS-3')); await second; old.resolve(wire('SYS-2')); await first;
    expect(store.snapshot?.revision).toBe('SYS-3');
  });
  it('supports explicit cancellation without late writes or a fallback default', async () => {
    const late = deferred(); read.mockReturnValueOnce(late.promise);
    const pending = store.refresh(); store.cancel(); late.resolve(wire());
    expect(await pending).toBeNull(); expect(store.loading).toBe(false); expect(store.snapshot).toBeNull(); expect(store.error).toBeNull();
  });
  it('makes damaged or failed current configuration unavailable, including old local markers', async () => {
    await store.refresh(); store.reportApplied('http.timeout', 'epoch-one', 'SYS-1');
    read.mockResolvedValueOnce({ ...wire(), values: { 'PAR-01': 0, 'PAR-02': 15 } });
    await expect(store.refresh()).rejects.toMatchObject({ code: 'INVALID_RUNTIME_PARAMETERS_RESPONSE' });
    expect(store.snapshot).toBeNull(); expect(store.applications).toEqual([]);
    read.mockRejectedValueOnce(new Error('offline'));
    await expect(store.refresh()).rejects.toThrow('offline'); expect(store.snapshot).toBeNull();
    await store.refresh(); expect(store.error).toBeNull(); expect(store.snapshot).toEqual(wire());
  });
  it.each([wire('SYS-1'), wire('SYS-2', 'epoch-one', 90)])('rejects regression or contradictory values at one revision', async bad => {
    read.mockResolvedValueOnce(wire('SYS-2')); await store.refresh();
    read.mockResolvedValueOnce(bad);
    await expect(store.refresh()).rejects.toMatchObject({ code: 'INVALID_RUNTIME_PARAMETERS_RESPONSE' });
    expect(store.snapshot).toBeNull();
  });
  it('allows a new epoch without treating its lower revision as a rollback', async () => {
    read.mockResolvedValueOnce(wire('SYS-9')); await store.refresh();
    store.reportApplied('http.timeout', 'epoch-one', 'SYS-9');
    read.mockResolvedValueOnce(wire('SYS-1', 'epoch-two')); await store.refresh();
    expect(store.snapshot?.epoch).toBe('epoch-two'); expect(store.applications).toEqual([]);
  });
  it('records only matching successful application facts within this tab', async () => {
    await store.refresh();
    expect(store.reportApplied('', 'epoch-one', 'SYS-1')).toBe(false);
    expect(store.reportApplied('http.timeout', 'old-epoch', 'SYS-1')).toBe(false);
    expect(store.reportApplied('http.timeout', 'epoch-one', 'SYS-2')).toBe(false);
    expect(store.reportApplied('http.timeout', 'epoch-one', 'SYS-1')).toBe(true);
    expect(store.reportApplied('gis.device-status-directory', 'epoch-one', 'SYS-1')).toBe(true);
    expect(store.reportApplied('http.timeout', 'epoch-one', 'SYS-1')).toBe(true);
    expect(store.applications).toHaveLength(2); expect(Object.isFrozen(store.applications)).toBe(true);
    expect(Object.isFrozen(store.applications[0])).toBe(true);
    store.clearApplied('http.timeout'); expect(store.applications.map(item => item.consumer)).toEqual(['gis.device-status-directory']);
    await store.refresh(); expect(store.applications).toHaveLength(1);
    read.mockResolvedValueOnce(wire('SYS-2')); await store.refresh(); expect(store.applications).toEqual([]);
  });
  it('does not report applied while a refresh is pending', async () => {
    await store.refresh(); const late = deferred(); read.mockReturnValueOnce(late.promise);
    const pending = store.refresh(); expect(store.reportApplied('http.timeout', 'epoch-one', 'SYS-1')).toBe(false);
    late.resolve(wire()); await pending;
  });
  it('clears, aborts and permits safe explicit rebinding after unbind', async () => {
    const late = deferred(); read.mockReturnValueOnce(late.promise);
    const pending = store.refresh(); store.unbind();
    expect(read.mock.calls[0]![0]!.signal!.aborted).toBe(true);
    late.resolve(wire()); expect(await pending).toBeNull(); expect(await store.refresh()).toBeNull();
    store.bind({ getRuntimeParameters: read }, () => session.value); await store.refresh(); expect(store.snapshot).toEqual(wire());
  });
  it('disposal stops ownership observation and pending responses', async () => {
    const late = deferred(); read.mockReturnValueOnce(late.promise);
    const pending = store.refresh(); store.$dispose(); late.resolve(wire());
    expect(await pending).toBeNull(); expect(store.snapshot).toBeNull();
    expect(await store.refresh()).toBeNull(); expect(read).toHaveBeenCalledTimes(1);
  });
});
