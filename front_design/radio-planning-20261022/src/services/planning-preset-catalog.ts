import { planningPresets as originalPresets } from '../mocks/planning-presets';
import { deploymentAssetSources, deploymentPlanningPresets } from '../mocks/deployment-constraint-presets';
import { optionsAssetSources, optionsPlanningPresets } from '../mocks/planning-options-presets';
import { routingAssetSources, routingPlanningPresets } from '../mocks/planning-routing-presets';

// 共享完整目录，避免新作业使关联模块读取整个规划库时误判损坏。
export const planningPresets = [...originalPresets, ...deploymentPlanningPresets, ...optionsPlanningPresets, ...routingPlanningPresets];
export const coveragePresetId = (id: string): string => Object.hasOwn(routingAssetSources, id) ? routingAssetSources[id] : Object.hasOwn(optionsAssetSources, id) ? optionsAssetSources[id] : Object.hasOwn(deploymentAssetSources, id) ? deploymentAssetSources[id] : id;
