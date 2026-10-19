import { afterEach, describe, expect, it, vi } from 'vitest';
import { sr4Live } from '../src/services/sr4-live';

afterEach(() => vi.unstubAllGlobals());

describe('SR4 integration request binding', () => {
  it('saves task and interference rows, then submits the returned snapshot', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, message: 'success', data: {
        snapshot_id: 'SR4-new', task_id: 'TS-0001', dataset_revision: 'abc',
        interference_sources: [{ interference_id: 'IF-0001', lon: 114, lat: 37 }],
        task_demands: [{ demand_id: 'CD-0001', task_id: 'TS-0001' }],
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, message: 'success', data: {
        task_id: 'tsk-123',
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 2002, message: 'running', data: {
        task_id: 'tsk-123', status: 'RUNNING', progress: 0.7,
      } }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const sources = [{ interference_id: 'IF-0001', name: 'source', lon: 114, lat: 37,
      center_freq_khz: 3587, tx_power_dbm: 50, active: 'true' }];
    const demands = [{ demand_id: 'CD-0001', task_id: 'TS-0001', src_node_id: 'A',
      dst_node_id: 'B', priority: 'P1', is_mandatory: 'true', required_rate_kbps: 10,
      min_reliability: 0.95 }];
    const saved = await sr4Live.save('TS-0001', 'SR4-old', sources, demands);
    await sr4Live.run('TS-0001', saved.snapshot_id);
    const status = await sr4Live.job('tsk-123');

    expect(status.code).toBe(2002);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expected_snapshot_id: 'SR4-old', interference_sources: sources, task_demands: demands,
    });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      task_id: 'TS-0001', snapshot_id: 'SR4-new',
    });
    expect(fetcher.mock.calls[2][0]).toBe('/api/v1/plan/tasks/tsk-123');
  });

  it('does not treat stale snapshot rejection as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 3003, message: 'Snapshot changed', data: null,
    }), { status: 200 })));
    await expect(sr4Live.run('TS-0001', 'SR4-old')).rejects.toThrow('Snapshot changed');
  });
});
