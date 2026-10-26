import { describe, expect, it } from 'vitest';
import { readRouting, routingIssues, routingSignature, routingStrategies, routingSummary } from '../src/services/planning-routing';
import { inputSignature, matchPreset, validatePlanningInput } from '../src/services/planning-validation';
import { readResponseTaskInput } from '../src/services/task-api-validation';
import { planningPresets } from '../src/services/planning-preset-catalog';
import { initialResources } from '../src/mocks/resource-presets';
import { routingPlanningPresets } from '../src/mocks/planning-routing-presets';
import { input } from './fixtures/planning-api';

// 条件比较与传输值分开验证，避免显式 false 在兼容旧输入时丢失。
describe('逐需求路由条件边界', () => {
  it('缺失需求对象仍返回原结构错误，不被附加路由校验中断', () => {
    const value=input();value.demands=[null as any];
    expect(validatePlanningInput(value,initialResources())).toContainEqual({objectId:'DEMAND',field:'id',message:'需求 ID 缺失或重复'});
  });
  it.each(routingStrategies.flatMap(s => [null, true, false].map(needBackup => ({routeStrategy:s.value,needBackup}))))('保留策略与备份 $routeStrategy / $needBackup', routing => {
    const value=input(); Object.assign(value.demands[0],routing);
    expect(routingIssues(value.demands[0])).toEqual([]); expect(readResponseTaskInput(value)).toEqual(value);
  });
  it.each(['BAD', '', 1, ['MIN_DELAY'], {}])('拒绝非法策略 %s', routeStrategy => {
    expect(()=>readRouting({routeStrategy})).toThrow();
    const value=input();Object.assign(value.demands[0],{routeStrategy});expect(()=>readResponseTaskInput(value)).toThrow();
  });
  it.each(['false','true',0,1,[],{}])('拒绝非布尔备份 %s', needBackup => expect(()=>readRouting({needBackup})).toThrow());
  it('旧输入不回填，null只在比较时视为未指定', () => {
    const a=input(),b=input(); Object.assign(b.demands[0],{routeStrategy:null,needBackup:null});
    expect(readResponseTaskInput(a).demands[0]).not.toHaveProperty('needBackup');
    expect(readResponseTaskInput(b).demands[0].needBackup).toBeNull();
    expect(inputSignature(a)).toEqual(inputSignature(b)); expect(b.demands[0]).toHaveProperty('routeStrategy',null);
    b.demands[0].needBackup=false;expect(inputSignature(a)).not.toEqual(inputSignature(b));
    expect(routingSignature(b.demands[0])).toEqual({needBackup:false});expect(routingSummary(b.demands[0])).toContain('不请求备份');
  });
  it('同一需求重排或改编号仍匹配，改变请求不能借用旧结果', () => {
    const value=structuredClone(routingPlanningPresets[0].input),resources=initialResources();
    value.demands.reverse();value.demands.forEach((d,i)=>d.id='NEW-'+i);
    expect(matchPreset(value,resources,planningPresets).id).toBe('routing-balanced');
    value.demands[0].needBackup=false;expect(()=>matchPreset(value,resources,planningPresets)).toThrow(/暂无预生成/);
  });
  it('旧档位无新增条件仍可匹配，不改原预设输入', () => {
    const value=structuredClone(planningPresets[0].input),before=JSON.stringify(planningPresets[0]);
    expect(matchPreset(value,initialResources(),planningPresets).id).toBe(value.presetId);
    value.demands[0].routeStrategy='MIN_DELAY';expect(()=>matchPreset(value,initialResources(),planningPresets)).toThrow();
    expect(JSON.stringify(planningPresets[0])).toBe(before);
  });
});
