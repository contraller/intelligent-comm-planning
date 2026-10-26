import { createPlanningMock } from '../../src/services/planning-mock';
import { createInterferenceMock } from '../../src/services/interference-mock';
import { createDiagnosisMock } from '../../src/services/diagnosis-mock';
import { createResourceMock } from '../../src/services/resource-mock';
import { planningPresets } from '../../src/mocks/planning-presets';
import { interferenceScenarios } from '../../src/mocks/interference-presets';
import type { CountermeasureType, InterferenceScenarioId } from '../../src/types/interference';
import { TestStorage } from './storage';
import { savedRequest } from './tasks';

// 所有新测试通过真实保存/确认流程准备输入，不手工伪造可执行网络。
export async function interferenceFixture(networkId = 'balanced', supplied?: TestStorage) {
  const storage = supplied ?? new TestStorage(), resource = createResourceMock(() => storage);
  let time = Date.parse('2026-10-05T00:00:00Z');
  const planning = createPlanningMock(() => storage, resource.read, () => time);
  const submitted = await planning.submitPlanning(await savedRequest(storage, {
    baseRevision: 'initial', requestId: 'p-submit', taskId: null, parentPlanVersionId: null,
    input: structuredClone(planningPresets.find(row => row.id === networkId)!.input),
  }));
  time += 10000;
  const saved = await planning.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id,
    requestId: 'p-save', name: '干扰分析网络', note: '' });
  const confirmed = await planning.confirmPlanVersion({ baseRevision: saved.workspace.revision, planId: saved.plan.id, requestId: 'p-confirm' });
  const service = createInterferenceMock(() => storage, resource.read, () => time);
  const diagnosis = createDiagnosisMock(() => storage, resource.read, () => time);
  const advance = (ms = 10000) => { time += ms; };
  const request = async (scenarioId: InterferenceScenarioId = 'single') => ({
    baseRevision: (await planning.loadPlanningWorkspace()).workspace.revision, baseResourceRevision: resource.read().meta.revision,
    requestId: crypto.randomUUID(), planId: confirmed.plan.id, scenarioId,
    interferenceIds: interferenceScenarios.find(row => row.id === scenarioId)!.sources.map(row => row.id),
  });
  const submit = async (scenarioId: InterferenceScenarioId = 'single') => service.submitInterferenceAnalysis(await request(scenarioId));
  const adopt = async (analysisId: string, measureId: CountermeasureType = 'FREQ_ADJUST', requestId: string = crypto.randomUUID()) =>
    service.adoptInterferenceMeasure({ baseRevision: (await planning.loadPlanningWorkspace()).workspace.revision, analysisId, measureId, requestId });
  const confirm = async (planId: string) => planning.confirmPlanVersion({
    baseRevision: (await planning.loadPlanningWorkspace()).workspace.revision, planId, requestId: crypto.randomUUID(),
  });
  return { storage, resource, planning, service, diagnosis, plan: confirmed.plan, request, submit, adopt, confirm, advance };
}
