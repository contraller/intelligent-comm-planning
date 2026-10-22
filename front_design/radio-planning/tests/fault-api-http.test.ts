import { describe, expect, it, vi } from 'vitest';
import { createFaultHttp } from '../src/services/fault-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import type { FaultScenarioInput } from '../src/types/fault-api';

const source = { task_id: 'TS-1', plan_id: 'P-1', revision: 'R-1', resource_revision: 'RES-1', name: '方案', version: 'V1', state: 'CONFIRMED' };
const scenario = { scenario_id: 'FS-1', task_id: 'TS-1', archived: false, version_id: 'FSV-1', version_no: 1,
  plan_id: 'P-1', plan_revision: 'R-1', resource_revision: 'RES-1', saved_at: '2026-10-21T00:00:00Z',
  scenario_name: '节点故障', description: '', faults: [{ object_type: 'NODE', object_id: 'N-1', fault_type: 'HW_FAILURE', symptom_ids: [] }] };

describe('SR5 正式 HTTP 适配', () => {
  it('只接受当前确认方案，并保持无方案原因', async () => {
    const request = vi.fn<AuthenticatedRequest>(async () => ({ items: [], total: 0, reason: '资源版本已变化' }) as never);
    const api = createFaultHttp(request as unknown as AuthenticatedRequest);
    expect(await api.sources('TS-1')).toEqual({ items: [], reason: '资源版本已变化' });
    expect(request.mock.calls[0][0]).toBe('/fault/plan-sources?task_id=TS-1');
    request.mockResolvedValueOnce({ items: [source], total: 1, reason: null } as never);
    expect((await api.sources('TS-1')).items[0].planId).toBe('P-1');
    request.mockResolvedValueOnce({ items: [{ ...source, state: 'REFERENCE' }], total: 1, reason: null } as never);
    await expect(api.sources('TS-1')).rejects.toMatchObject({ code: 'INVALID_FAULT_RESPONSE' });
  });

  it('场景请求显式使用 planning，并校验绑定的方案与版本', async () => {
    const request = vi.fn<AuthenticatedRequest>(async (path) => path.includes('/validate')
      ? { valid: true, plan_id: 'P-1', fault_count: 1 } as never
      : path.endsWith('/fault/scenarios') ? scenario as never : { total: 1, items: [scenario] } as never);
    const api = createFaultHttp(request as unknown as AuthenticatedRequest);
    const input: FaultScenarioInput = { scenario_name: '节点故障', description: '', faults: [{ object_type: 'NODE', object_id: 'N-1', fault_type: 'HW_FAILURE', symptom_ids: [] }] };
    await api.validate('TS-1', 'P-1', input);
    expect(await api.save('TS-1', 'P-1', input)).toMatchObject({ scenarioId: 'FS-1', versionId: 'FSV-1' });
    expect((await api.scenarios('TS-1'))[0].versionNo).toBe(1);
    expect(request.mock.calls[2][0]).toBe('/fault/scenarios?context=planning&task_id=TS-1&include_archived=true');
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toMatchObject({ context: 'planning', task_id: 'TS-1', plan_id: 'P-1' });
  });

  it('任务提交使用不同幂等编号，统一结果必须绑定同一诊断', async () => {
    const view = { task_id: 'TS-1', plan_id: 'P-1', diagnose_task_id: 'D-1', impact_task_id: null,
      state: 'DIAGNOSIS_READY', progress: .5, phases: [], diagnosis_ready: true, impact_ready: false, report_ready: false,
      error: null, source: { plan_revision: 'R-1', resource_revision: 'RES-1' },
      scenario: { scenario_id: 'FS-1', version_id: 'FSV-1', version_no: 1, scenario_name: '节点故障', faults: scenario.faults },
      diagnosis: { data_source: 'CONSTRUCTED', fusion_mode: 'TWO_WAY_DEGRADED', results: [] }, impact: null, suggestions: { suggestions: [] }, report: null };
    const request = vi.fn<AuthenticatedRequest>(async (path) => path === '/fault/diagnose'
      ? { task_id: 'D-1', request_id: 'REQ-D', replayed: false } as never
      : path === '/fault/impact' ? { task_id: 'I-1', request_id: 'REQ-I', replayed: false } as never
        : view as never);
    const api = createFaultHttp(request as unknown as AuthenticatedRequest);
    expect((await api.diagnose('TS-1', 'P-1', 'FS-1', 'FSV-1', 'REQ-D')).taskId).toBe('D-1');
    expect((await api.analysis('TS-1', 'D-1')).diagnosisReady).toBe(true);
    expect((await api.impact('TS-1', 'P-1', 'D-1', 'REQ-I')).taskId).toBe('I-1');
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ context: 'planning', request_id: 'REQ-D', task_id: 'TS-1', plan_id: 'P-1', scenario_id: 'FS-1', scenario_version_id: 'FSV-1' });
    expect(JSON.parse(String(request.mock.calls[2][1]?.body))).toMatchObject({ context: 'planning', request_id: 'REQ-I', diagnose_task_id: 'D-1', consider_backup_route: true });
    expect(request.mock.calls[1][0]).toBe('/fault/analyses/D-1?task_id=TS-1');
    request.mockResolvedValueOnce({ ...view, diagnose_task_id: 'D-OTHER' } as never);
    await expect(api.analysis('TS-1', 'D-1')).rejects.toMatchObject({ code: 'INVALID_FAULT_RESPONSE' });
  });
});
