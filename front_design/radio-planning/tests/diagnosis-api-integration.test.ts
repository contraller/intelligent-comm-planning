import { describe, expect, it } from 'vitest';
import { createFaultHttp } from '../src/services/fault-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';

describe('SR5 两段联调流程', () => {
  it('同一提交编号重试返回同一任务；诊断成功后再提交影响并得到报告', async () => {
    const calls: string[] = [];
    const receipts = new Map<string, string>();
    let diagnosed = false, impacted = false;
    const request: AuthenticatedRequest = async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === '/fault/diagnose' || path === '/fault/impact') {
        if (path === '/fault/impact' && !diagnosed) throw new Error('诊断尚未成功');
        const taskId = receipts.get(body.request_id) ?? (path === '/fault/diagnose' ? 'D-1' : 'I-1');
        const replayed = receipts.has(body.request_id);
        receipts.set(body.request_id, taskId);
        return { task_id: taskId, request_id: body.request_id, replayed } as never;
      }
      if (path.startsWith('/fault/analyses/')) {
        const withImpact = path.includes('impact_task_id=I-1');
        diagnosed = true;
        if (withImpact) impacted = true;
        return { task_id: 'TS-1', plan_id: 'P-1', diagnose_task_id: 'D-1', impact_task_id: withImpact ? 'I-1' : null,
          state: withImpact ? 'SUCCESS' : 'DIAGNOSIS_READY', progress: withImpact ? 1 : .5,
          phases: [{ name: '故障诊断', status: 'SUCCESS', progress: 1 }, { name: '影响分析', status: withImpact ? 'SUCCESS' : 'WAITING', progress: withImpact ? 1 : 0 }],
          diagnosis_ready: true, impact_ready: withImpact, report_ready: withImpact, error: null,
          source: { plan_revision: 'R-1', resource_revision: 'RES-1' },
          scenario: { scenario_id: 'FS-1', version_id: 'FSV-1', version_no: 1, scenario_name: '节点故障', faults: [] },
          diagnosis: { data_source: 'CONSTRUCTED', fusion_mode: 'TWO_WAY_DEGRADED', results: [] },
          impact: withImpact ? { affected_nodes: [], affected_links: [], summary: { affected_node_count: 0, affected_link_count: 0, total_bandwidth_loss_kbps: 0 } } : null,
          suggestions: { suggestions: [] }, report: withImpact ? { data_source: 'CONSTRUCTED', generated_at: '2026-10-21T00:00:00Z' } : null } as never;
      }
      throw new Error(`unexpected ${path}`);
    };
    const api = createFaultHttp(request);
    const first = await api.diagnose('TS-1', 'P-1', 'FS-1', 'FSV-1', 'REQ-D');
    const retry = await api.diagnose('TS-1', 'P-1', 'FS-1', 'FSV-1', 'REQ-D');
    expect(retry).toMatchObject({ taskId: first.taskId, replayed: true });
    expect((await api.analysis('TS-1', first.taskId)).state).toBe('DIAGNOSIS_READY');
    const impact = await api.impact('TS-1', 'P-1', first.taskId, 'REQ-I');
    const view = await api.analysis('TS-1', first.taskId, impact.taskId);
    expect(impacted).toBe(true);
    expect(view).toMatchObject({ state: 'SUCCESS', diagnosisReady: true, impactReady: true, reportReady: true });
    expect(calls).toEqual([
      'POST /fault/diagnose', 'POST /fault/diagnose', 'GET /fault/analyses/D-1?task_id=TS-1',
      'POST /fault/impact', 'GET /fault/analyses/D-1?task_id=TS-1&impact_task_id=I-1',
    ]);
  });
});
