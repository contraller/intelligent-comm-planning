import { describe, expect, it, vi } from 'vitest';
import { effectScope, reactive } from 'vue';
import { getPresetResultDetails, getVariantResultDetails } from '../src/services/planning-result-details-mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { assertPlanningCandidateScreening } from '../src/services/planning-candidates-validation';
import { candidateValue, candidateRejections, filterCandidates } from '../src/services/planning-candidates-display';
import { usePlanningCandidates } from '../src/composables/usePlanningCandidates';

const sample = () => getPresetResultDetails('balanced', planningPresets[0].input)!.candidateScreening!;
describe('候选部署点只读结果', () => {
  it('服务统计与返回条数不同仍保留，评分不转百分比或推断等级', () => {
    const data = sample(); data.candidateCount = 1137; data.deployableCount = 1117; data.candidates = data.candidates!.slice(0, 1);
    for (const score of [0, 0.82, 85.17]) { data.candidates[0].score = score; expect(() => assertPlanningCandidateScreening(data)).not.toThrow(); expect(candidateValue(score)).toBe(String(score)); }
    data.rejectedStats = { other: 9999, slope: 0 }; expect(() => assertPlanningCandidateScreening(data)).not.toThrow();
    expect(candidateRejections(data)).toEqual([{ id: 'other', label: 'other', count: 9999 }, { id: 'slope', label: '坡度', count: 0 }]);
    expect(data.candidates[0].recommendationLevel).toBe('A');
  });
  it.each(['duplicate', 'longitude', 'latitude', 'coordinate-null-part', 'missing', 'boolean', 'slope', 'count', 'fraction', 'unsafe', 'nan', 'source', 'stats'])(
    '拒绝损坏字段而不改写原响应：%s', kind => {
      const data = sample(), row = data.candidates![0];
      if (kind === 'duplicate') data.candidates!.push(structuredClone(row));
      if (kind === 'longitude') row.coordinate = [181, 37];
      if (kind === 'latitude') row.coordinate = [114, -91];
      if (kind === 'coordinate-null-part') row.coordinate = [null, 37] as never;
      if (kind === 'missing') delete (row as Partial<typeof row>).score;
      if (kind === 'boolean') row.isDeployable = 'true' as never;
      if (kind === 'slope') row.slopeDeg = 91;
      if (kind === 'count') data.candidateCount = -1;
      if (kind === 'fraction') row.visibleNodeCount = 0.5;
      if (kind === 'unsafe') data.candidateCount = Number.MAX_SAFE_INTEGER + 1;
      if (kind === 'nan') row.score = NaN;
      if (kind === 'source') data.sourceLabel = '';
      if (kind === 'stats') data.rejectedStats = { slope: -1 };
      const before = structuredClone(data); expect(() => assertPlanningCandidateScreening(data)).toThrow('候选部署点'); expect(data).toEqual(before);
    });
  it('未知角色/等级可展示，空值、false及0不互相替代，不补坐标', () => {
    const data = sample(), row = data.candidates![0]; row.candidateRole = 'FUTURE_ROLE'; row.recommendationLevel = 'S'; row.elevationM = -50; row.coordinate = null;
    expect(() => assertPlanningCandidateScreening(data)).not.toThrow();
    const before = structuredClone(data); expect(filterCandidates(data.candidates!, 'future', 'all')).toEqual([row]);
    expect(filterCandidates(data.candidates!, '', 'no').map(r => r.siteId)).toEqual(['CS-DEMO-03']);
    expect(filterCandidates(data.candidates!, '', 'unknown').map(r => r.siteId)).toEqual(['CS-DEMO-04']); expect(data).toEqual(before);
    data.candidates = null; data.rejectedStats = null; data.candidateCount = null; expect(() => assertPlanningCandidateScreening(data)).not.toThrow();
    data.candidates = []; data.rejectedStats = {}; expect(() => assertPlanningCandidateScreening(data)).not.toThrow();
  });
  it('新变体明确未提供，旧版本与副本保持独立', () => {
    const old = getPresetResultDetails('balanced', planningPresets[0].input, 'planning-result-details-demo-1')!;
    expect(old).not.toHaveProperty('candidateScreening'); expect(getVariantResultDetails('balanced:NODE_REDEPLOY', planningPresets[0].input).candidateScreening).toBeNull();
    const data = sample(); data.candidates![0].coordinate![0] = 0; expect(sample().candidates![0].coordinate![0]).toBe(114.88);
  });
});

function controller() {
  const state = reactive({ owner: 'task/job/1', active: true, readable: true, generation: 1, screening: sample() });
  const locate = vi.fn(), scope = effectScope();
  const value = scope.run(() => usePlanningCandidates({ screening: () => state.screening, owner: () => state.owner,
    active: () => state.active, readable: () => state.readable, generation: () => state.generation, locate }))!;
  return { state, locate, scope, value };
}
describe('候选显示生命周期', () => {
  it('筛选清除隐藏选择；关层保留详情及定位且不自动恢复', () => {
    const s = controller(), row = s.value.view.value.rows[0], actions = s.value.view.value.actions;
    actions.select(row); actions.visible({ target: { checked: false } } as never);
    expect(s.value.view.value.selected?.siteId).toBe(row.siteId); expect(s.value.frame.value.visible).toBe(false);
    const current = s.value.view.value; current.actions.locate(current.rows[0]); expect(s.locate).toHaveBeenCalledWith([114.88, 37.21]); expect(s.value.frame.value.visible).toBe(false);
    current.actions.filter({ target: { value: 'no' } } as never); expect(s.value.view.value.selected).toBeNull(); expect(s.value.view.value.notice).toContain('已清除');
    actions.select(row); expect(s.value.view.value.selected).toBeNull(); s.scope.stop();
  });
  it.each(['owner', 'active', 'readable', 'generation', 'data', 'unmount'] as const)('%s 往返后旧行/闭包/地图事件都失效', kind => {
    const s = controller(), old = s.value.view.value, row = old.rows[0]; old.actions.select(row);
    if (kind === 'owner') { s.state.owner = 'other'; s.state.owner = 'task/job/1'; }
    if (kind === 'active') { s.state.active = false; s.state.active = true; }
    if (kind === 'readable') { s.state.readable = false; s.state.readable = true; }
    if (kind === 'generation') s.state.generation++;
    if (kind === 'data') s.state.screening.candidates![0].coordinate = [114, 37];
    if (kind === 'unmount') s.scope.stop();
    old.actions.locate(row); s.value.view.value.actions.select(row); s.value.selectMap(row); expect(s.locate).not.toHaveBeenCalled();
    if (kind !== 'unmount') { expect(s.value.view.value.selected).toBeNull(); const current = s.value.view.value; current.actions.select(current.rows[0]); expect(s.value.view.value.selected?.siteId).toBe(row.siteId); }
    s.scope.stop();
  });
});
