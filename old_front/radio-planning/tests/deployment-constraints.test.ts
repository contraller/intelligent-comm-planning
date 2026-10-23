import { describe, expect, it } from 'vitest';
import { emptyDeploymentConstraints, deploymentConstraintIssues, deploymentSignature, readDeploymentConstraints } from '../src/services/deployment-constraints';
import { inputSignature, validatePlanningInput } from '../src/services/planning-validation';
import { readTaskInput } from '../src/services/task-api-validation';
import { planningPresets } from '../src/services/planning-preset-catalog';
import { initialResources } from '../src/mocks/resource-presets';
import { input } from './fixtures/planning-api';

// 格式边界独立于业务筛选，0、空值及任务区域外合法坐标不得被推断或裁剪。
describe('部署条件契约与比较', () => {
  it('旧输入不补字段；显式空对象与未设置不同', () => {
    const old = input(); expect(readTaskInput(old)).not.toHaveProperty('deploymentConstraints');
    expect(readTaskInput({...old,deploymentConstraints:null}).deploymentConstraints).toBeNull();
    expect(inputSignature(old)).toEqual(inputSignature({...old,deploymentConstraints:null}));
    expect(inputSignature(old)).not.toEqual(inputSignature({...old,deploymentConstraints:emptyDeploymentConstraints()}));
  });
  it('原始值及内环原样保留，集合排序只在比较副本进行', () => {
    const value = {...emptyDeploymentConstraints(),maxSlopeDeg:0,roadMaxDistanceM:0,minSiteSpacingM:0,elevationRangeM:[-100,0] as [number,number],allowedLandcover:['自定义','林地'],losRequiredNodeIds:['N3','N1'],forcedInclude:[{lon:170,lat:-70}],forcedExcludePolygons:[{type:'Polygon' as const,coordinates:[[[114,37],[115,37],[115,38],[114,37]],[[114.2,37.1],[114.3,37.1],[114.3,37.2],[114.2,37.1]]] as [number,number][][]}]};
    const before=structuredClone(value); expect(deploymentConstraintIssues(value)).toEqual([]); expect(readDeploymentConstraints(value)).toEqual(value);
    expect(deploymentSignature(value)).toEqual(deploymentSignature({...value,allowedLandcover:[...value.allowedLandcover].reverse(),losRequiredNodeIds:[...value.losRequiredNodeIds].reverse()}));expect(value).toEqual(before);
  });
  it.each([
    {maxSlopeDeg:91},{maxSlopeDeg:NaN},{gridStepM:0},{roadMaxDistanceM:-1},{elevationRangeM:[0,null]},
    {allowedLandcover:[]},{allowedLandcover:['草地','草地']},{losRequiredNodeIds:['A','A']},
    {forcedInclude:[{lon:181,lat:0}]},{forcedExcludePolygons:[{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1]]]}]},
    {forcedInclude:Array.from({length:101},()=>({lon:0,lat:0}))},
  ])('拒绝坏字段 %j，保存和回读都不能静默补默认', patch => {
    const value={...emptyDeploymentConstraints(),...patch};expect(deploymentConstraintIssues(value).length).toBeGreaterThan(0);
    expect(()=>readTaskInput({...input(),deploymentConstraints:value})).toThrow();
  });
  it('任意已保存节点可作为通视条件，无需成为任务参与节点或配置设备', () => {
    const value=structuredClone(planningPresets[0].input),resources=initialResources();
    resources.stations.push({...resources.stations[0],id:'LOS-ONLY'});
    value.deploymentConstraints={...emptyDeploymentConstraints(),losRequiredNodeIds:['LOS-ONLY']};
    expect(validatePlanningInput(value,resources)).toEqual([]);expect(value.stationIds).not.toContain('LOS-ONLY');
    value.deploymentConstraints.losRequiredNodeIds=['MISSING'];expect(validatePlanningInput(value,resources).some(i=>i.field.endsWith('losRequiredNodeIds'))).toBe(true);
  });
});
