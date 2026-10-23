import { describe,expect,it } from 'vitest';
import { planningOptionIssues,planningOptionsSignature,readPlanningOption,readFrequencyResources } from '../src/services/planning-options';
import { inputSignature } from '../src/services/planning-validation';
import { readResponseTaskInput } from '../src/services/task-api-validation';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { input } from './fixtures/planning-api';
const options=()=>structuredClone(optionsPlanningPresets[0].input);
describe('频率与部署输入边界',()=>{
  it.each([0,1,200])('指定新增部署 %i 合法，类别相等边界合法',count=>{const value=options();value.deploymentSolve={mode:'FIXED_COUNT',fixedCount:count,solutionCount:2};value.frequencyConstraints!.filters[0].rangeKhz=[6000,6000];expect(planningOptionIssues(value)).toEqual([]);expect(readResponseTaskInput(value)).toEqual(value);});
  it.each([-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('非法部署数量 %s 不变成默认值',count=>{expect(planningOptionIssues({deploymentSolve:{mode:'FIXED_COUNT',fixedCount:count,solutionCount:1}})).not.toEqual([]);});
  it.each([0,-1,1.2,NaN])('备选数量 %s 必须是正整数',count=>{expect(planningOptionIssues({deploymentSolve:{mode:'MIN_COUNT',fixedCount:null,solutionCount:count}})).not.toEqual([]);});
  it.each([[0,3],[-1,3],[5,4],[NaN,5],[3,Infinity]])('坏范围 %s / %s 拒绝',(a,b)=>{const value=options();value.frequencyConstraints!.filters[0].rangeKhz=[a,b];expect(planningOptionIssues(value)).not.toEqual([]);});
  it('未知频点保留，重复类别和重复频点拒绝',()=>{const value=options(),row=value.frequencyConstraints!.filters[0];row.excludeFreqIds=['FQ-EXTERNAL'];expect(readResponseTaskInput(value).frequencyConstraints).toEqual(value.frequencyConstraints);row.excludeFreqIds.push('FQ-EXTERNAL');expect(planningOptionIssues(value)).not.toEqual([]);row.excludeFreqIds=[];value.frequencyConstraints!.filters.push(structuredClone(row));expect(planningOptionIssues(value)).not.toEqual([]);});
  it('旧输入无字段不回填，显式空值保留，坏结构拒绝',()=>{expect(readResponseTaskInput(input())).not.toHaveProperty('frequencyConstraints');expect(readPlanningOption('deploymentSolve',null)).toBeNull();expect(()=>readPlanningOption('deploymentSolve',undefined)).toThrow();expect(planningOptionIssues({frequencyConstraints:{filters:[]}})).not.toEqual([]);});
  it('新增条件始终参与预设匹配，排序只发生在比较副本',()=>{const a=options(),b=options();b.frequencyConstraints!.filters[0].excludeFreqIds.push('FQ-NEW');expect(inputSignature(a,false)).not.toBe(inputSignature(b,false));const before=JSON.stringify(b);planningOptionsSignature(b);expect(JSON.stringify(b)).toBe(before);b.deploymentSolve!.solutionCount=3;expect(inputSignature(a,false)).not.toBe(inputSignature(b,false));});
  it('频点布尔值不强转，空目录和未提供分开',()=>{expect(readFrequencyResources(null)).toBeNull();expect(readFrequencyResources([])).toEqual([]);expect(()=>readFrequencyResources([{freqId:'A',deviceClass:'HF',centerFreqKhz:3000,bandwidthKhz:3,channelNo:null,isAvailable:'false',occupiedBy:null,reuseMinDistanceM:null,adjacentGuardKhz:null,note:null}])).toThrow();});
});
