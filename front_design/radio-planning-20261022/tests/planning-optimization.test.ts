import { describe,expect,it } from 'vitest';
import { assertPlanningOptimization,optimizationChart,optimizationConclusion } from '../src/services/planning-optimization';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { getPresetResultDetails } from '../src/services/planning-result-details-mock';
import type { PlanningOptimization } from '../src/types/planning-result-details';
const context={links:[{id:'L1',a:'N1',b:'N2',deviceA:'E1',deviceB:'E2',frequencyKhz:3000}],demandIds:['D1']} as Parameters<typeof assertPlanningOptimization>[1];
const value=():PlanningOptimization=>({sourceLabel:'服务分析',tradeoff:[{id:'P1',survivabilityPercent:0,totalRadiatedPowerW:0,meetsConstraints:false,description:null}],criticalBridges:[{linkId:'L1',affectedDemandIds:['D1'],survivabilityAfterFailurePercent:0,explanation:'服务声明'}]});
describe('只读优化分析',()=>{
  it('0和false保留，未知结论中性且不从数值推算',()=>{expect(()=>assertPlanningOptimization(value(),context)).not.toThrow();expect(optimizationConclusion(false)).toBe('不满足全部硬约束');expect(optimizationConclusion(null)).toBe('未提供结论');expect(optimizationChart(value()).series[0].data[0].value).toEqual([0,0]);});
  it.each(['link','demand','duplicate','percent','power','conclusion'])('错误关联或字段 %s 拒绝',kind=>{const v:any=value();if(kind==='link')v.criticalBridges[0].linkId='outside';if(kind==='demand')v.criticalBridges[0].affectedDemandIds=['outside'];if(kind==='duplicate')v.tradeoff.push({...v.tradeoff[0]});if(kind==='percent')v.tradeoff[0].survivabilityPercent=101;if(kind==='power')v.tradeoff[0].totalRadiatedPowerW=-1;if(kind==='conclusion')v.tradeoff[0].meetsConstraints='true';expect(()=>assertPlanningOptimization(v,context)).toThrow();});
  it('未提供与空集合均合法但不补记录，图不拟合',()=>{for(const absent of [null,[]]){const v={sourceLabel:'服务',tradeoff:absent,criticalBridges:absent};assertPlanningOptimization(v,context);expect(optimizationChart(v).series[0].data).toEqual([]);}expect(optimizationChart(value()).series[0]).toMatchObject({smooth:false,connectNulls:false});});
  it('桥参考场景的拓扑、主路由和关键链路保持关联',()=>{const preset=optionsPlanningPresets.find(p=>p.id==='options-bridge')!,details=getPresetResultDetails(preset.id,preset.input)!;expect(preset.result!.links.map(l=>l.id)).toEqual(['LINK-A','LINK-C']);expect(preset.result!.configuration.routes.every(r=>r.linkIds.every(id=>preset.result!.links.some(l=>l.id===id)))).toBe(true);expect(details.optimization?.criticalBridges?.map(row=>row.linkId)).toEqual(['LINK-A','LINK-C']);expect(details.optimization?.tradeoff).toBeNull();});
});
